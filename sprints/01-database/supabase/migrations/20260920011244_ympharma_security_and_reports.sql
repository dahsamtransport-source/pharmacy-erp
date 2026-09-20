create function ym_private.save_product(p_org uuid,p_id uuid,p_sku text,p_name text,p_requires_prescription boolean default false,p_controlled boolean default false)
returns uuid language plpgsql security definer set search_path='' as $$
declare result uuid:=coalesce(p_id,gen_random_uuid());
begin
 perform ym_private.require_role(p_org,array['owner','manager','inventory']);
 if coalesce(length(btrim(p_sku)),0) not between 1 and 100 or coalesce(length(btrim(p_name)),0) not between 1 and 200 then raise exception 'INVALID_PRODUCT'; end if;
 insert into ym.products(org_id,id,sku,trade_name,requires_prescription,controlled)
 values(p_org,result,btrim(p_sku),btrim(p_name),p_requires_prescription,p_controlled)
 on conflict(org_id,id) do update set sku=excluded.sku,trade_name=excluded.trade_name,
 requires_prescription=excluded.requires_prescription,controlled=excluded.controlled;
 insert into ym.audit_events(org_id,actor_id,action,entity_id) values(p_org,auth.uid(),'product.saved',result);
 return result;
end $$;
create function ym_private.save_unit(p_org uuid,p_id uuid,p_product uuid,p_name text,p_factor bigint,p_price numeric,p_barcode text default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare result uuid:=coalesce(p_id,gen_random_uuid()); old_unit ym.units;
begin
 perform ym_private.require_role(p_org,array['owner','manager','inventory']);
 if p_price is null or p_price<>round(p_price,2) or coalesce(length(btrim(p_name)),0) not between 1 and 100 then raise exception 'INVALID_UNIT'; end if;
 select * into old_unit from ym.units where org_id=p_org and id=result;
 if found and (old_unit.product_id<>p_product or old_unit.factor<>p_factor) then raise exception 'UNIT_CONVERSION_IMMUTABLE'; end if;
 insert into ym.units(org_id,id,product_id,name,factor,selling_price,barcode)
 values(p_org,result,p_product,btrim(p_name),p_factor,p_price,p_barcode)
 on conflict(org_id,id) do update set name=excluded.name,selling_price=excluded.selling_price,barcode=excluded.barcode;
 insert into ym.audit_events(org_id,actor_id,action,entity_id,details) values(p_org,auth.uid(),'unit.saved',result,
  jsonb_build_object('previous_price',old_unit.selling_price,'price',p_price));
 return result;
end $$;
create function ym_private.set_batch_status(p_org uuid,p_batch uuid,p_status text) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform ym_private.require_role(p_org,array['owner','manager','pharmacist','inventory']);
 if p_status is null or p_status not in ('available','quarantine','recalled') then raise exception 'INVALID_BATCH_STATUS'; end if;
 update ym.batches set status=p_status where org_id=p_org and id=p_batch;
 if not found then raise exception 'BATCH_NOT_FOUND'; end if;
 insert into ym.audit_events(org_id,actor_id,action,entity_id,details) values(p_org,auth.uid(),'batch.status_changed',p_batch,jsonb_build_object('status',p_status));
end $$;
create function ym_private.record_insurer_approval(p_org uuid,p_enrollment uuid,p_request uuid,p_number text,p_amount numeric,p_until timestamptz)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform ym_private.require_role(p_org,array['owner','manager']);
 if p_until is null or p_until<=clock_timestamp() or p_amount<>round(p_amount,2) then raise exception 'INVALID_APPROVAL'; end if;
 insert into ym.insurance_approvals values(p_org,p_enrollment,p_request,p_number,p_amount,p_until,auth.uid());
 insert into ym.audit_events(org_id,actor_id,action,entity_id) values(p_org,auth.uid(),'insurer.approval_recorded',p_request);
end $$;
create function ym_private.save_account(p_org uuid,p_id uuid,p_code text,p_name text,p_kind text,p_parent uuid default null,p_postable boolean default true)
returns uuid language plpgsql security definer set search_path='' as $$
declare result uuid:=coalesce(p_id,gen_random_uuid()); old_account ym.accounts;
begin
 perform ym_private.require_role(p_org,array['owner','manager','accountant']);
 if coalesce(length(btrim(p_code)),0) not between 1 and 30 or coalesce(length(btrim(p_name)),0) not between 1 and 200 then raise exception 'INVALID_ACCOUNT'; end if;
 if p_parent is not null then
  if not exists(select 1 from ym.accounts where org_id=p_org and id=p_parent and not postable and kind=p_kind and active)
  then raise exception 'INVALID_ACCOUNT_PARENT'; end if;
  if exists(with recursive parents as (
   select id,parent_id from ym.accounts where org_id=p_org and id=p_parent
   union select a.id,a.parent_id from ym.accounts a join parents p on a.id=p.parent_id where a.org_id=p_org
  ) select 1 from parents where id=result) then raise exception 'ACCOUNT_CYCLE'; end if;
 end if;
 select * into old_account from ym.accounts where org_id=p_org and id=result;
 if found and exists(select 1 from ym.journal_lines where org_id=p_org and account_id=result)
  and (old_account.kind<>p_kind or not p_postable) then raise exception 'USED_ACCOUNT_CLASSIFICATION_IMMUTABLE'; end if;
 if exists(select 1 from ym.accounts where org_id=p_org and parent_id=result and kind<>p_kind) then raise exception 'ACCOUNT_CHILD_CLASSIFICATION'; end if;
 if p_postable and exists(select 1 from ym.accounts where org_id=p_org and parent_id=result) then raise exception 'GROUP_ACCOUNT_NOT_POSTABLE'; end if;
 insert into ym.accounts(org_id,id,code,name,kind,parent_id,postable)
 values(p_org,result,p_code,p_name,p_kind,p_parent,p_postable)
 on conflict(org_id,id) do update set code=excluded.code,name=excluded.name,kind=excluded.kind,parent_id=excluded.parent_id,postable=excluded.postable;
 insert into ym.audit_events(org_id,actor_id,action,entity_id) values(p_org,auth.uid(),'account.saved',result);
 return result;
end $$;

-- Enable RLS for EVERY table; tables have no application DML grants.
do $$ declare t record; begin
 for t in select tablename from pg_tables where schemaname='ym' loop
  execute format('alter table ym.%I enable row level security',t.tablename);
  execute format('revoke all on ym.%I from public, anon, authenticated, service_role',t.tablename);
 end loop;
end $$;
grant usage on schema ym,ym_api,ym_private to authenticated;
grant select on all tables in schema ym to authenticated;
revoke all on all sequences in schema ym from public,anon,authenticated,service_role;

-- Catalog and quantities contain no cost fields or credentials.
do $$ declare t text; begin
 foreach t in array array['cost_centers','warehouses','products','drug_alternatives','units','reorder_rules','batches'] loop
  execute format('create policy member_read on ym.%I for select to authenticated using ((select ym_private.has_role(org_id,array[''owner'',''manager'',''accountant'',''cashier'',''pharmacist'',''inventory''])))',t);
 end loop;
 foreach t in array array['accounts','account_mappings','periods','journals','journal_lines','audit_events','outbox'] loop
  execute format('create policy finance_read on ym.%I for select to authenticated using ((select ym_private.has_role(org_id,array[''owner'',''manager'',''accountant''])))',t);
 end loop;
 foreach t in array array['insurance_policies','insurance_exclusions','enrollments','insurance_approvals'] loop
  execute format('create policy insurance_read on ym.%I for select to authenticated using ((select ym_private.has_role(org_id,array[''owner'',''manager'',''accountant'',''cashier'',''pharmacist''])))',t);
 end loop;
 foreach t in array array['drug_interactions','prescription_reviews'] loop
  execute format('create policy clinical_read on ym.%I for select to authenticated using ((select ym_private.has_role(org_id,array[''owner'',''manager'',''pharmacist''])))',t);
 end loop;
end $$;
create policy organization_read on ym.organizations for select to authenticated using((select ym_private.has_role(id,array['owner','manager','accountant','cashier','pharmacist','inventory'])));
create policy members_read on ym.members for select to authenticated using(user_id=(select auth.uid()) or (select ym_private.has_role(org_id,array['owner','manager'])));
create policy valuation_read on ym.valuations for select to authenticated using((select ym_private.has_role(org_id,array['owner','manager','accountant','inventory'])));
create policy parties_read on ym.parties for select to authenticated using(
 (select ym_private.has_role(org_id,array['owner','manager','accountant','cashier','pharmacist']))
 or (kind='supplier' and (select ym_private.has_role(org_id,array['inventory']))));
create policy invoice_read on ym.invoices for select to authenticated using(
 (select ym_private.has_role(org_id,array['owner','manager','accountant']))
 or (kind='purchase' and (select ym_private.has_role(org_id,array['inventory'])))
 or (kind='sale' and actor_id=(select auth.uid()) and (select ym_private.has_role(org_id,array['cashier','pharmacist']))));
create policy invoice_line_read on ym.invoice_lines for select to authenticated using(exists(select 1 from ym.invoices i where i.org_id=invoice_lines.org_id and i.id=invoice_lines.invoice_id));
create policy allocation_read on ym.allocations for select to authenticated using(exists(select 1 from ym.invoice_lines l where l.org_id=allocations.org_id and l.id=allocations.line_id));
create policy movement_read on ym.movements for select to authenticated using(exists(select 1 from ym.invoice_lines l where l.org_id=movements.org_id and l.id=movements.line_id));
create policy operation_read on ym.operations for select to authenticated using(
 (select ym_private.has_role(org_id,array['owner','manager','accountant'])) or (actor_id=(select auth.uid()) and
 ((kind<>'purchase' and (select ym_private.has_role(org_id,array['cashier','pharmacist']))) or (select ym_private.has_role(org_id,array['inventory'])))));
create policy reservation_read on ym.reservations for select to authenticated using(
 (select ym_private.has_role(org_id,array['owner','manager'])) or (actor_id=(select auth.uid()) and
 (select ym_private.has_role(org_id,array['cashier','pharmacist']))));
create policy reservation_allocation_read on ym.reservation_allocations for select to authenticated using(
 exists(select 1 from ym.reservations r where r.org_id=reservation_allocations.org_id and r.id=reservation_allocations.reservation_id));
create policy claim_read on ym.claims for select to authenticated using(exists(select 1 from ym.invoices i where i.org_id=claims.org_id and i.id=claims.invoice_id));

-- SECURITY INVOKER views preserve underlying table RLS (PostgreSQL 15+).
create view ym_api.trial_balance with (security_invoker=true,security_barrier=true) as
 select a.org_id,a.id account_id,a.code,a.name,a.kind,o.currency,
 coalesce(sum(l.debit),0) debit,coalesce(sum(l.credit),0) credit,
 greatest(coalesce(sum(l.debit-l.credit),0),0) debit_balance,
 greatest(coalesce(sum(l.credit-l.debit),0),0) credit_balance
 from ym.accounts a join ym.organizations o on o.id=a.org_id
 left join (ym.journal_lines l join ym.journals j on j.org_id=l.org_id and j.id=l.journal_id and j.status='posted')
 on l.org_id=a.org_id and l.account_id=a.id
 group by a.org_id,a.id,a.code,a.name,a.kind,o.currency;
-- Daily grain deliberately allows date/cost-center filtering without summing mixed currencies.
create view ym_api.income_statement with (security_invoker=true,security_barrier=true) as
 select a.org_id,j.document_date,j.cost_center_id,j.currency,a.id account_id,a.code,a.name,a.kind,
 sum(case when a.kind='income' then l.credit-l.debit else l.debit-l.credit end) amount,
 sum(l.credit-l.debit) net_income_effect
 from ym.accounts a join ym.journal_lines l on l.org_id=a.org_id and l.account_id=a.id
 join ym.journals j on j.org_id=l.org_id and j.id=l.journal_id
 where j.status='posted' and a.kind in ('income','expense')
 group by a.org_id,j.document_date,j.cost_center_id,j.currency,a.id,a.code,a.name,a.kind;
create view ym_api.ledger with (security_invoker=true,security_barrier=true) as
 select j.org_id,j.id journal_id,j.document_date,j.currency,j.cost_center_id,l.account_id,l.debit,l.credit,j.invoice_id
 from ym.journals j join ym.journal_lines l on l.org_id=j.org_id and l.journal_id=j.id where j.status='posted';
create view ym_api.low_stock with (security_invoker=true,security_barrier=true) as
 select r.org_id,r.warehouse_id,p.id product_id,p.trade_name,r.minimum,r.target,
 coalesce(sum(b.quantity-b.reserved) filter(where b.status='available' and b.expiry_date>(statement_timestamp() at time zone o.timezone)::date),0) available
 from ym.reorder_rules r join ym.products p on p.org_id=r.org_id and p.id=r.product_id and p.active
 join ym.organizations o on o.id=r.org_id
 left join ym.batches b on b.org_id=r.org_id and b.warehouse_id=r.warehouse_id and b.product_id=r.product_id
 group by r.org_id,r.warehouse_id,p.id,p.trade_name,r.minimum,r.target
 having coalesce(sum(b.quantity-b.reserved) filter(where b.status='available' and b.expiry_date>(statement_timestamp() at time zone o.timezone)::date),0)<=r.minimum;
create view ym_api.expiring_soon with (security_invoker=true,security_barrier=true) as
 select b.org_id,b.warehouse_id,b.id batch_id,p.trade_name,b.batch_number,b.expiry_date,b.quantity,b.reserved,b.status,
 b.expiry_date<=(statement_timestamp() at time zone o.timezone)::date as expired
 from ym.batches b join ym.products p on p.org_id=b.org_id and p.id=b.product_id
 join ym.organizations o on o.id=b.org_id
 where b.quantity>0 and b.expiry_date<=(statement_timestamp() at time zone o.timezone)::date+90;

-- Expose only these wrappers through PostgREST's ym_api schema. Private entrypoints
-- remain role-checked even when invoked via a direct authenticated SQL connection.
create function ym_api.process_pharmacy_sale(p_org uuid,p_request uuid,p_warehouse uuid,p_items jsonb,
 p_payment text default 'cash',p_customer uuid default null,p_enrollment uuid default null,p_reservation uuid default null)
returns uuid language sql security invoker set search_path='' as $$
 select ym_private.process_pharmacy_sale(p_org,p_request,p_warehouse,p_items,p_payment,p_customer,p_enrollment,p_reservation); $$;
create function ym_api.receive_purchase_order(p_org uuid,p_request uuid,p_warehouse uuid,p_supplier uuid,p_reference text,p_items jsonb)
returns uuid language sql security invoker set search_path='' as $$ select ym_private.receive_purchase_order(p_org,p_request,p_warehouse,p_supplier,p_reference,p_items); $$;
create function ym_api.reserve_online_order(p_org uuid,p_request uuid,p_warehouse uuid,p_items jsonb)
returns uuid language sql security invoker set search_path='' as $$ select ym_private.reserve_online_order(p_org,p_request,p_warehouse,p_items); $$;
create function ym_api.cancel_reservation(p_org uuid,p_reservation uuid) returns void language sql security invoker set search_path='' as $$ select ym_private.cancel_reservation(p_org,p_reservation); $$;
create function ym_api.expire_reservations(p_org uuid) returns integer language sql security invoker set search_path='' as $$ select ym_private.expire_reservations(p_org); $$;
create function ym_api.review_prescription(p_org uuid,p_request uuid,p_warehouse uuid,p_items jsonb,p_document_reference text)
returns void language sql security invoker set search_path='' as $$ select ym_private.review_prescription(p_org,p_request,p_warehouse,p_items,p_document_reference); $$;
create function ym_api.set_period_closed(p_org uuid,p_month date,p_closed boolean) returns void language sql security invoker set search_path='' as $$ select ym_private.set_period_closed(p_org,p_month,p_closed); $$;
create function ym_api.save_product(p_org uuid,p_id uuid,p_sku text,p_name text,p_requires_prescription boolean default false,p_controlled boolean default false)
returns uuid language sql security invoker set search_path='' as $$ select ym_private.save_product(p_org,p_id,p_sku,p_name,p_requires_prescription,p_controlled); $$;
create function ym_api.save_unit(p_org uuid,p_id uuid,p_product uuid,p_name text,p_factor bigint,p_price numeric,p_barcode text default null)
returns uuid language sql security invoker set search_path='' as $$ select ym_private.save_unit(p_org,p_id,p_product,p_name,p_factor,p_price,p_barcode); $$;
create function ym_api.set_batch_status(p_org uuid,p_batch uuid,p_status text) returns void language sql security invoker set search_path='' as $$ select ym_private.set_batch_status(p_org,p_batch,p_status); $$;
create function ym_api.record_insurer_approval(p_org uuid,p_enrollment uuid,p_request uuid,p_number text,p_amount numeric,p_until timestamptz)
returns void language sql security invoker set search_path='' as $$ select ym_private.record_insurer_approval(p_org,p_enrollment,p_request,p_number,p_amount,p_until); $$;
create function ym_api.save_account(p_org uuid,p_id uuid,p_code text,p_name text,p_kind text,p_parent uuid default null,p_postable boolean default true)
returns uuid language sql security invoker set search_path='' as $$ select ym_private.save_account(p_org,p_id,p_code,p_name,p_kind,p_parent,p_postable); $$;

-- Revoke every helper, then explicitly grant only checked entrypoints and the RLS helper.
revoke execute on all functions in schema ym_private,ym_api from public,anon,authenticated,service_role;
grant execute on function ym_private.has_role(uuid,text[]) to authenticated;
do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='ym_private' and p.proname in ('process_pharmacy_sale','receive_purchase_order','reserve_online_order',
 'cancel_reservation','expire_reservations','review_prescription','set_period_closed','save_product','save_unit','set_batch_status','record_insurer_approval','save_account')
 loop execute format('grant execute on function %s to authenticated',f.signature); end loop;
end $$;
grant execute on all functions in schema ym_api to authenticated;
grant select on all tables in schema ym_api to authenticated;
