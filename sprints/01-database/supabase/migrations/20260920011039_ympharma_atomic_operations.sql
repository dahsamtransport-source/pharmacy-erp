create function ym_private.cart(p_items jsonb) returns jsonb language plpgsql set search_path='' as $$
declare x jsonb; result jsonb;
begin
 if p_items is null or jsonb_typeof(p_items)<>'array' then raise exception 'INVALID_ITEMS'; end if;
 if jsonb_array_length(p_items) not between 1 and 200 then raise exception 'INVALID_ITEM_COUNT'; end if;
 for x in select value from jsonb_array_elements(p_items) loop
  if jsonb_typeof(x)<>'object' or x-'unit_id'-'quantity'<>'{}'::jsonb
   or coalesce(x->>'quantity','') !~ '^[1-9][0-9]{0,5}$' or x->>'unit_id' is null
  then raise exception 'INVALID_ITEM'; end if;
  perform (x->>'unit_id')::uuid;
 end loop;
 select jsonb_agg(jsonb_build_object('unit_id',(value->>'unit_id')::uuid,'quantity',(value->>'quantity')::bigint)
  order by (value->>'unit_id')::uuid) into result from jsonb_array_elements(p_items);
 if (select count(distinct value->>'unit_id') from jsonb_array_elements(result))<>jsonb_array_length(result)
 then raise exception 'DUPLICATE_UNIT'; end if;
 return result;
end $$;
create function ym_private.begin_operation(p_org uuid,p_request uuid,p_kind text,p_payload jsonb) returns uuid
language plpgsql set search_path='' as $$
declare o ym.operations;
begin
 if p_request is null then raise exception 'REQUEST_ID_REQUIRED'; end if;
 select * into o from ym.operations where org_id=p_org and request_id=p_request;
 if found then
  if o.actor_id<>auth.uid() or o.kind<>p_kind or o.payload<>p_payload then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  if o.result_id is null then raise exception 'INCOMPLETE_OPERATION'; end if;
  return o.result_id;
 end if;
 insert into ym.operations(org_id,request_id,actor_id,kind,payload) values(p_org,p_request,auth.uid(),p_kind,p_payload);
 return null;
end $$;
create function ym_private.end_operation(p_org uuid,p_request uuid,p_result uuid,p_action text) returns void
language plpgsql set search_path='' as $$
begin
 update ym.operations set result_id=p_result where org_id=p_org and request_id=p_request;
 insert into ym.audit_events(org_id,actor_id,action,entity_id) values(p_org,auth.uid(),p_action,p_result);
end $$;
create function ym_private.check_warehouse(p_org uuid,p_warehouse uuid) returns void
language plpgsql set search_path='' as $$
begin
 if not exists(select 1 from ym.warehouses where org_id=p_org and id=p_warehouse and active)
 then raise exception 'WAREHOUSE_UNAVAILABLE'; end if;
end $$;
create function ym_private.check_period(p_org uuid) returns void language plpgsql set search_path='' as $$
begin
 if not exists(select 1 from ym.periods where org_id=p_org
  and month=date_trunc('month',ym_private.business_date(p_org)::timestamp)::date and not closed)
 then raise exception 'PERIOD_NOT_OPEN'; end if;
end $$;
create function ym_private.journal_line(p_org uuid,p_journal uuid,p_purpose text,p_amount numeric,p_debit boolean)
returns void language plpgsql set search_path='' as $$
declare a uuid; expected_kind text;
begin
 if p_amount=0 then return; end if;
 expected_kind:=case p_purpose when 'payables' then 'liability' when 'revenue' then 'income' when 'cogs' then 'expense' else 'asset' end;
 select m.account_id into a from ym.account_mappings m join ym.accounts ac on ac.org_id=m.org_id and ac.id=m.account_id
 where m.org_id=p_org and m.purpose=p_purpose and ac.kind=expected_kind and ac.active and ac.postable;
 if a is null then raise exception 'ACCOUNT_MAPPING_REQUIRED: %',p_purpose; end if;
 insert into ym.journal_lines(org_id,journal_id,account_id,debit,credit)
 values(p_org,p_journal,a,case when p_debit then p_amount else 0 end,case when p_debit then 0 else p_amount end);
end $$;
create function ym_private.post_invoice(p_org uuid,p_invoice uuid,p_cost numeric,p_claim numeric default 0) returns void
language plpgsql set search_path='' as $$
declare inv ym.invoices; j uuid; cc uuid;
begin
 select * into strict inv from ym.invoices where org_id=p_org and id=p_invoice;
 select cost_center_id into cc from ym.warehouses where org_id=p_org and id=inv.warehouse_id;
 insert into ym.journals(org_id,invoice_id,document_date,period_month,currency,cost_center_id,description)
 values(p_org,p_invoice,inv.document_date,date_trunc('month',inv.document_date::timestamp)::date,inv.currency,cc,inv.kind)
 returning id into j;
 if inv.kind='purchase' then
  perform ym_private.journal_line(p_org,j,'inventory',inv.total,true);
  perform ym_private.journal_line(p_org,j,'payables',inv.total,false);
 else
  perform ym_private.journal_line(p_org,j,case when inv.payment_method='bank' then 'bank' else 'cash' end,inv.total-p_claim,true);
  perform ym_private.journal_line(p_org,j,'insurance_receivable',p_claim,true);
  perform ym_private.journal_line(p_org,j,'revenue',inv.total,false);
  perform ym_private.journal_line(p_org,j,'cogs',p_cost,true);
  perform ym_private.journal_line(p_org,j,'inventory',p_cost,false);
 end if;
 update ym.journals set status='posted' where org_id=p_org and id=j;
 -- Transactional outbox only: no network call or claim of external ERP posting.
 insert into ym.outbox(org_id,document_uuid,invoice_id,payload)
 values(p_org,inv.document_uuid,p_invoice,jsonb_build_object('schema_version',1,'external_reference',inv.document_uuid,
  'kind',inv.kind,'currency',inv.currency,'date',inv.document_date,'total',inv.total,'journal_id',j,'cost_center_id',cc));
end $$;

create function ym_private.receive_purchase_order(p_org uuid,p_request uuid,p_warehouse uuid,p_supplier uuid,p_reference text,p_items jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare result uuid; x jsonb; u ym.units; b ym.batches; line uuid; base bigint; amount numeric; total numeric:=0;
 normalized jsonb; payload jsonb; unit_cost numeric; qty bigint; expiry date;
begin
 perform ym_private.require_role(p_org,array['owner','manager','inventory']);
 if p_reference is null or length(btrim(p_reference)) not between 1 and 100 then raise exception 'SUPPLIER_REFERENCE_REQUIRED'; end if;
 if p_items is null or jsonb_typeof(p_items)<>'array' then raise exception 'INVALID_ITEMS'; end if;
 if jsonb_array_length(p_items) not between 1 and 200 then raise exception 'INVALID_ITEM_COUNT'; end if;
 normalized:='[]'::jsonb;
 for x in select value from jsonb_array_elements(p_items) loop
  if jsonb_typeof(x)<>'object' or x-'unit_id'-'quantity'-'unit_cost'-'batch_number'-'expiry_date'<>'{}'::jsonb
   or coalesce(x->>'quantity','') !~ '^[1-9][0-9]{0,5}$'
   or coalesce(x->>'unit_cost','') !~ '^[0-9]{1,8}(\.[0-9]{1,4})?$'
   or x->>'unit_id' is null or coalesce(length(btrim(x->>'batch_number')),0) not between 1 and 100
   or coalesce(x->>'expiry_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  then raise exception 'INVALID_PURCHASE_ITEM'; end if;
  expiry:=(x->>'expiry_date')::date;
  normalized:=normalized||jsonb_build_array(jsonb_build_object('unit_id',(x->>'unit_id')::uuid,
   'quantity',(x->>'quantity')::bigint,'unit_cost',(x->>'unit_cost')::numeric,
   'batch_number',btrim(x->>'batch_number'),'expiry_date',expiry));
 end loop;
 payload:=jsonb_build_object('warehouse',p_warehouse,'supplier',p_supplier,'reference',lower(btrim(p_reference)),'items',normalized);
 result:=ym_private.begin_operation(p_org,p_request,'purchase',payload);
 if result is not null then return result; end if;
 perform ym_private.check_warehouse(p_org,p_warehouse);
 if not exists(select 1 from ym.parties where org_id=p_org and id=p_supplier and kind='supplier' and active)
 then raise exception 'SUPPLIER_UNAVAILABLE'; end if;
 perform ym_private.check_period(p_org);
 for x in select value from jsonb_array_elements(normalized) loop
  select * into u from ym.units where org_id=p_org and id=(x->>'unit_id')::uuid and active;
  if not found or not exists(select 1 from ym.products where org_id=p_org and id=u.product_id and active)
  then raise exception 'UNIT_UNAVAILABLE'; end if;
  if (x->>'expiry_date')::date<=ym_private.business_date(p_org) then raise exception 'EXPIRED_PURCHASE'; end if;
  total:=total+round((x->>'quantity')::bigint*(x->>'unit_cost')::numeric,2);
 end loop;
 insert into ym.invoices(org_id,document_uuid,kind,warehouse_id,party_id,supplier_reference,actor_id,currency,document_date,payment_method,total)
 select p_org,p_request,'purchase',p_warehouse,p_supplier,btrim(p_reference),auth.uid(),currency,ym_private.business_date(p_org),'credit_purchase',total
 from ym.organizations where id=p_org returning id into result;
 for x in select value from jsonb_array_elements(normalized) loop
  select * into strict u from ym.units where org_id=p_org and id=(x->>'unit_id')::uuid;
  qty:=(x->>'quantity')::bigint; base:=qty*u.factor; unit_cost:=(x->>'unit_cost')::numeric;
  amount:=round(qty*unit_cost,2); expiry:=(x->>'expiry_date')::date;
  insert into ym.batches(org_id,warehouse_id,product_id,batch_number,expiry_date)
  values(p_org,p_warehouse,u.product_id,x->>'batch_number',expiry) on conflict do nothing;
  select * into strict b from ym.batches where org_id=p_org and warehouse_id=p_warehouse and product_id=u.product_id
   and batch_number=x->>'batch_number' for update;
  if b.expiry_date<>expiry then raise exception 'BATCH_EXPIRY_CONFLICT'; end if;
  if b.status<>'available' then raise exception 'BATCH_BLOCKED'; end if;
  update ym.batches set quantity=quantity+base where org_id=p_org and id=b.id;
  insert into ym.valuations(org_id,warehouse_id,product_id,quantity,inventory_value)
  values(p_org,p_warehouse,u.product_id,base,amount) on conflict(org_id,warehouse_id,product_id)
  do update set quantity=ym.valuations.quantity+excluded.quantity,inventory_value=ym.valuations.inventory_value+excluded.inventory_value;
  insert into ym.invoice_lines(org_id,invoice_id,product_id,unit_id,quantity,factor,base_quantity,unit_price,line_total)
  values(p_org,result,u.product_id,u.id,qty,u.factor,base,unit_cost,amount) returning id into line;
  insert into ym.allocations values(p_org,line,b.id,base);
  insert into ym.movements(org_id,batch_id,line_id,quantity_delta) values(p_org,b.id,line,base);
 end loop;
 perform ym_private.post_invoice(p_org,result,0);
 perform ym_private.end_operation(p_org,p_request,result,'purchase.posted');
 return result;
end $$;

-- All dispensing is internal to a complete financial transaction. No public FEFO-only RPC.
create function ym_private.dispense(p_org uuid,p_warehouse uuid,p_product uuid,p_line uuid,p_quantity bigint)
returns numeric language plpgsql set search_path='' as $$
declare b ym.batches; remaining bigint:=p_quantity; take bigint; v ym.valuations; cost numeric;
begin
 if p_quantity<=0 then raise exception 'INVALID_QUANTITY'; end if;
 select * into v from ym.valuations where org_id=p_org and warehouse_id=p_warehouse and product_id=p_product for update;
 if not found or v.quantity<p_quantity then raise exception 'INSUFFICIENT_STOCK'; end if;
 for b in select * from ym.batches where org_id=p_org and warehouse_id=p_warehouse and product_id=p_product
  and status='available' and expiry_date>ym_private.business_date(p_org) and quantity>reserved
  order by expiry_date,id for update loop
  take:=least(remaining,b.quantity-b.reserved);
  update ym.batches set quantity=quantity-take where org_id=p_org and id=b.id;
  insert into ym.allocations values(p_org,p_line,b.id,take);
  insert into ym.movements(org_id,batch_id,line_id,quantity_delta) values(p_org,b.id,p_line,-take);
  remaining:=remaining-take; exit when remaining=0;
 end loop;
 if remaining<>0 then raise exception 'INSUFFICIENT_AVAILABLE_STOCK'; end if;
 cost:=case when p_quantity=v.quantity then v.inventory_value else round(v.inventory_value*p_quantity/v.quantity,2) end;
 update ym.valuations set quantity=quantity-p_quantity,inventory_value=inventory_value-cost
 where org_id=p_org and warehouse_id=p_warehouse and product_id=p_product;
 return cost;
end $$;
create function ym_private.release_hold(p_org uuid,p_reservation uuid,p_status text) returns void
language plpgsql set search_path='' as $$
declare a record;
begin
 for a in select * from ym.reservation_allocations where org_id=p_org and reservation_id=p_reservation loop
  update ym.batches set reserved=reserved-a.quantity where org_id=p_org and id=a.batch_id;
 end loop;
 update ym.reservations set status=p_status where org_id=p_org and id=p_reservation;
end $$;
create function ym_private.reserve_online_order(p_org uuid,p_request uuid,p_warehouse uuid,p_items jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare cart jsonb; result uuid; x jsonb; u ym.units; b ym.batches; remaining bigint; take bigint;
begin
 perform ym_private.require_role(p_org,array['owner','manager','cashier','pharmacist']);
 cart:=ym_private.cart(p_items);
 result:=ym_private.begin_operation(p_org,p_request,'reserve',jsonb_build_object('warehouse',p_warehouse,'items',cart));
 if result is not null then return result; end if;
 perform ym_private.check_warehouse(p_org,p_warehouse);
 insert into ym.reservations(org_id,warehouse_id,actor_id,items,expires_at)
 values(p_org,p_warehouse,auth.uid(),cart,clock_timestamp()+interval '15 minutes') returning id into result;
 for x in select value from jsonb_array_elements(cart) loop
  select * into u from ym.units where org_id=p_org and id=(x->>'unit_id')::uuid and active;
  if not found or not exists(select 1 from ym.products where org_id=p_org and id=u.product_id and active and not controlled)
  then raise exception 'UNIT_UNAVAILABLE'; end if;
  remaining:=(x->>'quantity')::bigint*u.factor;
  for b in select * from ym.batches where org_id=p_org and warehouse_id=p_warehouse and product_id=u.product_id
    and status='available' and expiry_date>ym_private.business_date(p_org) and quantity>reserved
    order by expiry_date,id for update loop
   take:=least(remaining,b.quantity-b.reserved);
   update ym.batches set reserved=reserved+take where org_id=p_org and id=b.id;
   insert into ym.reservation_allocations values(p_org,result,b.id,take)
    on conflict(org_id,reservation_id,batch_id) do update set quantity=ym.reservation_allocations.quantity+excluded.quantity;
   remaining:=remaining-take; exit when remaining=0;
  end loop;
  if remaining<>0 then raise exception 'INSUFFICIENT_AVAILABLE_STOCK'; end if;
 end loop;
 perform ym_private.end_operation(p_org,p_request,result,'reservation.created');
 return result;
end $$;
create function ym_private.cancel_reservation(p_org uuid,p_reservation uuid) returns void
language plpgsql security definer set search_path='' as $$
declare r ym.reservations;
begin
 perform ym_private.require_role(p_org,array['owner','manager','cashier','pharmacist']);
 select * into r from ym.reservations where org_id=p_org and id=p_reservation for update;
 if not found then raise exception 'RESERVATION_NOT_FOUND'; end if;
 if r.actor_id<>auth.uid() and not ym_private.has_role(p_org,array['owner','manager']) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if r.status<>'held' then return; end if;
 perform ym_private.release_hold(p_org,p_reservation,'cancelled');
 insert into ym.audit_events(org_id,actor_id,action,entity_id) values(p_org,auth.uid(),'reservation.cancelled',p_reservation);
end $$;
create function ym_private.expire_reservations(p_org uuid) returns integer
language plpgsql security definer set search_path='' as $$
declare r record; n integer:=0;
begin
 perform ym_private.require_role(p_org,array['owner','manager','cashier','pharmacist']);
 for r in select id from ym.reservations where org_id=p_org and status='held' and expires_at<=clock_timestamp() for update loop
  perform ym_private.release_hold(p_org,r.id,'expired'); n:=n+1;
  insert into ym.audit_events(org_id,actor_id,action,entity_id) values(p_org,auth.uid(),'reservation.expired',r.id);
 end loop;
 return n;
end $$;

create function ym_private.review_prescription(p_org uuid,p_request uuid,p_warehouse uuid,p_items jsonb,p_document_reference text)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform ym_private.require_role(p_org,array['pharmacist']);
 perform ym_private.check_warehouse(p_org,p_warehouse);
 insert into ym.prescription_reviews(org_id,request_id,warehouse_id,items,pharmacist_id,valid_until,document_reference)
 values(p_org,p_request,p_warehouse,ym_private.cart(p_items),auth.uid(),clock_timestamp()+interval '30 minutes',p_document_reference);
 insert into ym.audit_events(org_id,actor_id,action,entity_id) values(p_org,auth.uid(),'prescription.reviewed',p_request);
end $$;
create function ym_private.process_pharmacy_sale(p_org uuid,p_request uuid,p_warehouse uuid,p_items jsonb,
 p_payment text default 'cash',p_customer uuid default null,p_enrollment uuid default null,p_reservation uuid default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare cart jsonb; result uuid; x jsonb; u ym.units; prod ym.products; line uuid; total numeric:=0; cost numeric:=0;
 claim numeric:=0; covered numeric:=0; available numeric; due numeric; need_review boolean:=false;
 enrollment ym.enrollments; policy ym.insurance_policies; r ym.reservations;
begin
 perform ym_private.require_role(p_org,array['owner','manager','cashier','pharmacist']);
 cart:=ym_private.cart(p_items);
 if p_payment is null or p_payment not in ('cash','bank','insurance') then raise exception 'UNSUPPORTED_PAYMENT'; end if;
 if (p_payment='insurance')<>(p_enrollment is not null) then raise exception 'ENROLLMENT_MISMATCH'; end if;
 result:=ym_private.begin_operation(p_org,p_request,'sale',jsonb_build_object('warehouse',p_warehouse,'items',cart,
  'payment',p_payment,'customer',p_customer,'enrollment',p_enrollment,'reservation',p_reservation));
 if result is not null then return result; end if;
 perform ym_private.check_warehouse(p_org,p_warehouse); perform ym_private.check_period(p_org);
 if p_customer is not null and not exists(select 1 from ym.parties where org_id=p_org and id=p_customer and kind='customer' and active)
 then raise exception 'CUSTOMER_UNAVAILABLE'; end if;
 if p_reservation is not null then
  select * into r from ym.reservations where org_id=p_org and id=p_reservation for update;
  if not found or r.status<>'held' or r.expires_at<=clock_timestamp() or r.items<>cart or r.warehouse_id<>p_warehouse
  then raise exception 'INVALID_RESERVATION'; end if;
  if r.actor_id<>auth.uid() and not ym_private.has_role(p_org,array['owner','manager']) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  -- Atomic release + fresh FEFO validates current batch status/expiry. Failure restores the hold.
  perform ym_private.release_hold(p_org,p_reservation,'fulfilled');
 end if;
 if p_enrollment is not null then
  select * into enrollment from ym.enrollments where org_id=p_org and id=p_enrollment for update;
  if not found or p_customer is null or enrollment.patient_id<>p_customer
    or ym_private.business_date(p_org) not between enrollment.valid_from and enrollment.valid_to
  then raise exception 'INVALID_ENROLLMENT'; end if;
  select * into policy from ym.insurance_policies where org_id=p_org and id=enrollment.policy_id and active;
  if not found then raise exception 'POLICY_UNAVAILABLE'; end if;
 end if;
 for x in select value from jsonb_array_elements(cart) loop
  select * into u from ym.units where org_id=p_org and id=(x->>'unit_id')::uuid and active;
  if not found then raise exception 'UNIT_UNAVAILABLE'; end if;
  select * into strict prod from ym.products where org_id=p_org and id=u.product_id;
  if not prod.active then raise exception 'PRODUCT_INACTIVE'; end if;
  if prod.controlled then raise exception 'CONTROLLED_DRUG_WORKFLOW_NOT_CONFIGURED'; end if;
  need_review:=need_review or prod.requires_prescription;
  total:=total+round(u.selling_price*(x->>'quantity')::bigint,2);
  if p_enrollment is not null and not exists(select 1 from ym.insurance_exclusions
   where org_id=p_org and policy_id=policy.id and product_id=prod.id)
  then covered:=covered+round(u.selling_price*(x->>'quantity')::bigint,2); end if;
 end loop;
 need_review:=need_review or exists(select 1 from ym.drug_interactions di where di.org_id=p_org and di.severity='major'
  and di.drug_a_id in (select product_id from ym.units where org_id=p_org and id in(select (value->>'unit_id')::uuid from jsonb_array_elements(cart)))
  and di.drug_b_id in (select product_id from ym.units where org_id=p_org and id in(select (value->>'unit_id')::uuid from jsonb_array_elements(cart))));
 if need_review and not exists(select 1 from ym.prescription_reviews pr
   join ym.members m on m.org_id=pr.org_id and m.user_id=pr.pharmacist_id and m.active and m.role='pharmacist'
   where pr.org_id=p_org and pr.request_id=p_request and pr.items=cart and pr.warehouse_id=p_warehouse
   and pr.valid_until>clock_timestamp()) then raise exception 'PHARMACIST_REVIEW_REQUIRED'; end if;
 if p_enrollment is not null then
  select greatest(0,enrollment.coverage_limit-coalesce(sum(claim_amount),0)) into available
   from ym.claims where org_id=p_org and enrollment_id=p_enrollment;
  -- Cap applies across this enrollment term; rejected/unpaid claims still consume it.
  claim:=least(available,round(covered*(10000-policy.copay_bps)/10000,2));
  if policy.requires_approval_above is not null and covered>policy.requires_approval_above
   and not exists(select 1 from ym.insurance_approvals where org_id=p_org and enrollment_id=p_enrollment
     and request_id=p_request and approved_amount>=claim and valid_until>clock_timestamp())
  then raise exception 'INSURER_APPROVAL_REQUIRED'; end if;
 end if;
 due:=total-claim;
 insert into ym.invoices(org_id,document_uuid,kind,warehouse_id,party_id,actor_id,currency,document_date,payment_method,total,patient_due)
 select p_org,p_request,'sale',p_warehouse,p_customer,auth.uid(),currency,ym_private.business_date(p_org),p_payment,total,due
 from ym.organizations where id=p_org returning id into result;
 for x in select value from jsonb_array_elements(cart) loop
  select * into strict u from ym.units where org_id=p_org and id=(x->>'unit_id')::uuid;
  insert into ym.invoice_lines(org_id,invoice_id,product_id,unit_id,quantity,factor,base_quantity,unit_price,line_total)
  values(p_org,result,u.product_id,u.id,(x->>'quantity')::bigint,u.factor,(x->>'quantity')::bigint*u.factor,
   u.selling_price,round(u.selling_price*(x->>'quantity')::bigint,2)) returning id into line;
  cost:=cost+ym_private.dispense(p_org,p_warehouse,u.product_id,line,(x->>'quantity')::bigint*u.factor);
 end loop;
 if claim>0 then
  insert into ym.claims(org_id,invoice_id,enrollment_id,patient_due,claim_amount) values(p_org,result,p_enrollment,due,claim);
 end if;
 perform ym_private.post_invoice(p_org,result,cost,claim);
 perform ym_private.end_operation(p_org,p_request,result,'sale.posted');
 return result;
end $$;

create function ym_private.set_period_closed(p_org uuid,p_month date,p_closed boolean) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform ym_private.require_role(p_org,array['owner','manager','accountant']);
 if p_month is null or extract(day from p_month)<>1 or p_closed is null then raise exception 'INVALID_PERIOD'; end if;
 insert into ym.periods values(p_org,p_month,p_closed) on conflict(org_id,month) do update set closed=excluded.closed;
 insert into ym.audit_events(org_id,actor_id,action,details) values(p_org,auth.uid(),'period.changed',jsonb_build_object('month',p_month,'closed',p_closed));
end $$;
