-- Forward-only P0 repair. Historical migrations are retained unchanged.
-- Deliberately single-currency until per-currency debt/settlement ledgers exist.
-- Merchant-row locking serializes financial RPCs within one tenant (not globally).
create schema if not exists mawsil_private;
revoke all on schema mawsil_private from public, anon, authenticated;

create or replace function mawsil_private.payload_hash(p_payload jsonb)
returns text language sql immutable strict set search_path = '' as $$
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_payload::text,'UTF8')),'hex');
$$;

create or replace function mawsil_private.valid_number(p_value numeric, p_scale integer)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p_value::text not in ('NaN','Infinity','-Infinity')
    and abs(p_value)<1000000000000 and p_value=round(p_value,p_scale),false);
$$;

create or replace function public.current_stock(target_merchant uuid, target_product uuid)
returns numeric language plpgsql volatile security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.is_merchant_member(target_merchant) then
    raise exception 'MERCHANT_ACCESS_DENIED' using errcode='42501';
  end if;
  if not exists(select 1 from public.products where id=target_product and merchant_id=target_merchant) then
    raise exception 'PRODUCT_TENANT_MISMATCH';
  end if;
  return (select coalesce(sum(quantity_delta),0) from public.inventory_movements
    where merchant_id=target_merchant and product_id=target_product);
end;
$$;

create or replace function public.request_transaction_approval(
  p_merchant_id uuid, p_action text, p_payload jsonb, p_reason text default null,
  p_risk_level text default 'high', p_ttl_minutes integer default 30
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_role text:=public.current_merchant_role(p_merchant_id);
begin
  if auth.uid() is null or v_role is null then
    raise exception 'MERCHANT_ACCESS_DENIED' using errcode='42501';
  end if;
  if p_action is null or p_action not in ('sale.commit','purchase.commit','sale.reverse',
    'purchase.reverse','customer_payment.record','supplier_payment.record','expense.record','inventory.adjust')
    or jsonb_typeof(p_payload) is distinct from 'object'
    or p_payload->>'merchant_id' is distinct from p_merchant_id::text
    or p_payload->>'operation_type' is distinct from p_action
    or octet_length(p_payload::text)>65536 then raise exception 'INVALID_APPROVAL_PAYLOAD'; end if;
  if p_ttl_minutes is null or p_ttl_minutes not between 1 and 1440
    or p_risk_level is null or p_risk_level not in ('medium','high','critical') then
    raise exception 'INVALID_APPROVAL_OPTIONS';
  end if;
  insert into public.approval_requests(merchant_id,requested_by,action,risk_level,status,reason,
    payload,payload_hash,expires_at)
  values(p_merchant_id,auth.uid(),p_action,p_risk_level,'pending',p_reason,p_payload,
    mawsil_private.payload_hash(p_payload),clock_timestamp()+make_interval(mins=>p_ttl_minutes)) returning id into v_id;
  insert into public.audit_logs(merchant_id,action,entity_type,entity_id,payload,actor_user_id,actor_role,approval_id)
  values(p_merchant_id,'approval.requested','approval_request',v_id,
    jsonb_build_object('action',p_action,'payload_hash',mawsil_private.payload_hash(p_payload)),auth.uid(),v_role,v_id);
  return v_id;
end;
$$;

create or replace function public.review_transaction_approval(
  p_approval_id uuid, p_decision text, p_reason text default null
) returns public.approval_requests language plpgsql security definer set search_path = '' as $$
declare v_row public.approval_requests;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
  select * into v_row from public.approval_requests
    where id=p_approval_id and public.has_merchant_role(merchant_id,array['owner','manager']) for update;
  if not found then raise exception 'APPROVAL_REVIEW_FORBIDDEN' using errcode='42501'; end if;
  if p_decision is null or p_decision not in ('approved','rejected') then raise exception 'INVALID_APPROVAL_DECISION'; end if;
  if v_row.status<>'pending' then raise exception 'APPROVAL_NOT_PENDING'; end if;
  if v_row.expires_at is null or v_row.expires_at<=clock_timestamp() then p_decision:='expired'; end if;
  update public.approval_requests set status=p_decision,reviewed_by=auth.uid(),reviewed_at=clock_timestamp(),
    reason=coalesce(p_reason,reason) where id=p_approval_id returning * into v_row;
  insert into public.audit_logs(merchant_id,action,entity_type,entity_id,payload,actor_user_id,actor_role,approval_id)
  values(v_row.merchant_id,'approval.'||p_decision,'approval_request',v_row.id,
    jsonb_build_object('payload_hash',v_row.payload_hash),auth.uid(),public.current_merchant_role(v_row.merchant_id),v_row.id);
  return v_row;
end;
$$;

-- This internal entry point is not granted to API roles or exposed as an RPC.
create or replace function mawsil_private.execute_operation(
  p_payload jsonb, p_key text, p_approval uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_merchant uuid:=(p_payload->>'merchant_id')::uuid;
  v_kind text:=p_payload->>'operation_type';
  v_role text;
  v_currency text;
  v_existing public.transaction_operations;
  v_approval public.approval_requests;
  v_op uuid;
  v_hash text;
  v_entity uuid;
  v_party uuid;
  v_product uuid;
  v_account uuid;
  v_unit text;
  v_item jsonb;
  v_items jsonb:=p_payload->'items';
  v_qty numeric; v_price numeric; v_discount numeric;
  v_total numeric:=0; v_paid numeric; v_amount numeric; v_debt numeric;
  v_balance numeric; v_limit numeric; v_stock numeric; v_new_stock numeric;
  v_sale public.sales; v_purchase public.purchases;
  v_result jsonb;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
  v_role:=public.current_merchant_role(v_merchant);
  if v_role is null or not (
    v_role in ('owner','manager') or
    (v_role='staff' and v_kind in ('sale.commit','customer_payment.record')) or
    (v_role='inventory' and v_kind in ('purchase.commit','inventory.adjust'))
  ) then raise exception 'OPERATION_FORBIDDEN' using errcode='42501'; end if;
  if p_key is null or length(p_key) not between 8 and 160 or p_key<>trim(p_key) then
    raise exception 'IDEMPOTENCY_KEY_REQUIRED';
  end if;
  if octet_length(p_payload::text)>65536 then raise exception 'TRANSACTION_PAYLOAD_TOO_LARGE'; end if;
  v_hash:=mawsil_private.payload_hash(p_payload);
  -- A fixed snapshot could miss a preceding transaction after waiting on this lock.
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception 'UNSUPPORTED_TRANSACTION_ISOLATION';
  end if;
  -- All engine RPCs lock the same tenant row before any approval/party/product.
  select reporting_currency_code into v_currency from public.merchants where id=v_merchant for update;
  if not found then raise exception 'MERCHANT_ACCESS_DENIED' using errcode='42501'; end if;
  select * into v_existing from public.transaction_operations where merchant_id=v_merchant and idempotency_key=p_key;
  if found then
    if v_existing.operation_type is distinct from v_kind or v_existing.payload is distinct from p_payload then
      raise exception 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    end if;
    if v_existing.actor_user_id is distinct from auth.uid() then raise exception 'IDEMPOTENCY_ACTOR_MISMATCH' using errcode='42501'; end if;
    if v_existing.status in ('committed','reversed') and v_existing.result is not null then return v_existing.result; end if;
    raise exception 'IDEMPOTENCY_OPERATION_IN_PROGRESS';
  end if;
  -- Replays above remain valid even after a balance, stock or approval changes.
  if v_kind not in ('sale.commit','purchase.commit','sale.reverse','purchase.reverse',
    'customer_payment.record','supplier_payment.record','expense.record','inventory.adjust') then
    raise exception 'UNKNOWN_OPERATION';
  end if;
  if p_payload ? 'currency_code' and p_payload->>'currency_code' is distinct from v_currency then
    raise exception 'MULTI_CURRENCY_NOT_READY';
  end if;
  if exists(select 1 from public.sales where merchant_id=v_merchant and currency_code<>v_currency)
    or exists(select 1 from public.purchases where merchant_id=v_merchant and currency_code<>v_currency)
    or exists(select 1 from public.customer_payments where merchant_id=v_merchant and currency_code<>v_currency)
    or exists(select 1 from public.supplier_payments where merchant_id=v_merchant and currency_code<>v_currency) then
    raise exception 'LEGACY_CURRENCY_RECONCILIATION_REQUIRED';
  end if;

  if p_approval is not null or v_kind in ('sale.reverse','purchase.reverse','supplier_payment.record','inventory.adjust') then
    select * into v_approval from public.approval_requests where id=p_approval for update;
    if not found or v_approval.merchant_id is distinct from v_merchant
      or v_approval.requested_by is distinct from auth.uid()
      or v_approval.action is distinct from v_kind or v_approval.status<>'approved'
      or v_approval.reviewed_by is null or v_approval.consumed_at is not null or v_approval.operation_id is not null
      or v_approval.expires_at is null or v_approval.expires_at<=clock_timestamp()
      or v_approval.payload is distinct from p_payload
      or v_approval.payload_hash is distinct from mawsil_private.payload_hash(v_approval.payload) then
      raise exception 'VALID_APPROVAL_REQUIRED';
    end if;
  end if;
  insert into public.transaction_operations(merchant_id,idempotency_key,operation_type,payload_hash,payload,status,actor_user_id,approval_id)
  values(v_merchant,p_key,v_kind,v_hash,p_payload,'processing',auth.uid(),p_approval) returning id into v_op;

  if v_kind in ('sale.commit','purchase.commit') then
    if jsonb_typeof(v_items) is distinct from 'array' then raise exception 'ITEMS_REQUIRED'; end if;
    if jsonb_array_length(v_items) not between 1 and 100 then raise exception 'INVALID_ITEM_COUNT'; end if;
    if (select count(distinct (value->>'product_id')::uuid) from jsonb_array_elements(v_items))<>jsonb_array_length(v_items) then
      raise exception 'DUPLICATE_OR_MISSING_PRODUCT';
    end if;
    v_paid:=(p_payload->>'paid')::numeric;
    if not mawsil_private.valid_number(v_paid,2) or v_paid<0 then raise exception 'INVALID_PAID_AMOUNT'; end if;
    for v_item in select value from jsonb_array_elements(v_items) order by value->>'product_id' loop
      if jsonb_typeof(v_item) is distinct from 'object' or jsonb_typeof(v_item->'quantity') is distinct from 'number'
        or jsonb_typeof(v_item->'unit_price') is distinct from 'number' then raise exception 'INVALID_ITEM'; end if;
      v_product:=(v_item->>'product_id')::uuid; v_qty:=(v_item->>'quantity')::numeric;
      v_price:=(v_item->>'unit_price')::numeric; v_discount:=coalesce((v_item->>'discount')::numeric,0);
      if not mawsil_private.valid_number(v_qty,3) or not mawsil_private.valid_number(v_price,2)
        or not mawsil_private.valid_number(v_discount,2) or v_qty<=0 or v_price<0 or v_discount<0
        or v_discount>round(v_qty*v_price,2) or (v_kind='sale.commit' and v_discount<>0) then raise exception 'INVALID_ITEM_VALUES'; end if;
      select unit into v_unit from public.products where id=v_product and merchant_id=v_merchant and active for share;
      if not found then raise exception 'PRODUCT_TENANT_MISMATCH_OR_INACTIVE'; end if;
      if v_kind='sale.commit' and public.current_stock(v_merchant,v_product)<v_qty then raise exception 'INSUFFICIENT_STOCK'; end if;
      v_total:=v_total+round(v_qty*v_price,2)-v_discount;
    end loop;
    if v_paid>v_total then raise exception 'PAID_EXCEEDS_TOTAL'; end if;
    v_debt:=v_total-v_paid;
    if v_kind='sale.commit' then
      v_party:=(p_payload->>'customer_id')::uuid;
      if v_party is null and v_debt>0 then raise exception 'CREDIT_CUSTOMER_REQUIRED'; end if;
      if v_party is not null then
        select balance,credit_limit into v_balance,v_limit from public.customers where id=v_party and merchant_id=v_merchant for update;
        if not found then raise exception 'CUSTOMER_TENANT_MISMATCH'; end if;
        if v_debt>0 and v_balance+v_debt>v_limit then raise exception 'CREDIT_LIMIT_EXCEEDED'; end if;
      end if;
      insert into public.sales(merchant_id,customer_id,total,paid,status,currency_code,exchange_rate,idempotency_key,created_by)
      values(v_merchant,v_party,v_total,v_paid,'completed',v_currency,1,p_key,auth.uid()) returning id into v_entity;
      if v_party is not null then update public.customers set balance=balance+v_debt where id=v_party; end if;
    else
      v_party:=(p_payload->>'supplier_id')::uuid;
      if v_party is null and v_debt>0 then raise exception 'CREDIT_SUPPLIER_REQUIRED'; end if;
      if v_party is not null then
        perform 1 from public.suppliers where id=v_party and merchant_id=v_merchant for update;
        if not found then raise exception 'SUPPLIER_TENANT_MISMATCH'; end if;
      end if;
      insert into public.purchases(merchant_id,supplier_id,total,paid,status,currency_code,idempotency_key,created_by)
      values(v_merchant,v_party,v_total,v_paid,'received',v_currency,p_key,auth.uid()) returning id into v_entity;
      if v_party is not null then update public.suppliers set balance=balance+v_debt where id=v_party; end if;
    end if;
    for v_item in select value from jsonb_array_elements(v_items) loop
      v_product:=(v_item->>'product_id')::uuid; v_qty:=(v_item->>'quantity')::numeric;
      v_price:=(v_item->>'unit_price')::numeric; v_discount:=coalesce((v_item->>'discount')::numeric,0);
      select unit into v_unit from public.products where id=v_product and merchant_id=v_merchant;
      if v_kind='sale.commit' then
        insert into public.sale_items(sale_id,product_id,quantity,unit_price) values(v_entity,v_product,v_qty,v_price);
      else
        insert into public.purchase_items(purchase_id,product_id,quantity,unit_price,discount) values(v_entity,v_product,v_qty,v_price,v_discount);
      end if;
      insert into public.inventory_movements(merchant_id,product_id,quantity_delta,unit,reason,reference_id,idempotency_key,created_by)
      values(v_merchant,v_product,case when v_kind='sale.commit' then -v_qty else v_qty end,v_unit,
        case when v_kind='sale.commit' then 'sale' else 'purchase' end,v_entity,p_key||':stock:'||v_product,auth.uid());
    end loop;
    v_result:=jsonb_build_object(case when v_kind='sale.commit' then 'sale_id' else 'purchase_id' end,
      v_entity,'total',v_total,'paid',v_paid,'debt',v_debt,'currency_code',v_currency);

  elsif v_kind in ('customer_payment.record','supplier_payment.record') then
    v_amount:=(p_payload->>'amount')::numeric;
    if not mawsil_private.valid_number(v_amount,2) or v_amount<=0 then raise exception 'INVALID_PAYMENT_AMOUNT'; end if;
    if coalesce(p_payload->>'method','') not in ('cash','wallet','bank','other') then raise exception 'INVALID_PAYMENT_METHOD'; end if;
    if v_kind='customer_payment.record' then
      v_party:=(p_payload->>'customer_id')::uuid;
      select balance into v_balance from public.customers where id=v_party and merchant_id=v_merchant for update;
      if not found then raise exception 'CUSTOMER_TENANT_MISMATCH'; end if;
      if v_amount>v_balance then raise exception 'PAYMENT_EXCEEDS_DEBT'; end if;
      insert into public.customer_payments(merchant_id,customer_id,amount,currency_code,exchange_rate,method,reference,idempotency_key,created_by)
      values(v_merchant,v_party,v_amount,v_currency,1,p_payload->>'method',p_payload->>'reference',p_key,auth.uid()) returning id into v_entity;
      update public.customers set balance=balance-v_amount where id=v_party;
    else
      if (p_payload->>'exchange_rate')::numeric is distinct from 1::numeric then raise exception 'MULTI_CURRENCY_NOT_READY'; end if;
      v_party:=(p_payload->>'supplier_id')::uuid; v_account:=(p_payload->>'account_id')::uuid;
      select balance into v_balance from public.suppliers where id=v_party and merchant_id=v_merchant for update;
      if not found then raise exception 'SUPPLIER_TENANT_MISMATCH'; end if;
      if v_amount>v_balance then raise exception 'PAYMENT_EXCEEDS_SUPPLIER_DEBT'; end if;
      if v_account is not null then
        perform 1 from public.financial_accounts where id=v_account and merchant_id=v_merchant and currency_code=v_currency and active for share;
        if not found then raise exception 'ACCOUNT_TENANT_OR_CURRENCY_MISMATCH'; end if;
      end if;
      insert into public.supplier_payments(merchant_id,supplier_id,account_id,amount,currency_code,exchange_rate,reporting_amount,method,reference,idempotency_key,created_by)
      values(v_merchant,v_party,v_account,v_amount,v_currency,1,v_amount,p_payload->>'method',p_payload->>'reference',p_key,auth.uid()) returning id into v_entity;
      update public.suppliers set balance=balance-v_amount where id=v_party;
      if v_account is not null then
        insert into public.financial_account_entries(merchant_id,account_id,operation_id,direction,entry_type,amount,currency_code,exchange_rate,reporting_amount,reference_id,created_by)
        values(v_merchant,v_account,v_op,'outflow','supplier_payment',v_amount,v_currency,1,v_amount,v_entity,auth.uid());
      end if;
    end if;
    v_result:=jsonb_build_object(case when v_kind='customer_payment.record' then 'payment_id' else 'supplier_payment_id' end,
      v_entity,'amount',v_amount,'remaining_debt',v_balance-v_amount,'currency_code',v_currency);

  elsif v_kind in ('sale.reverse','purchase.reverse') then
    if coalesce(length(trim(p_payload->>'reason')),0)<3 then raise exception 'REVERSAL_REASON_REQUIRED'; end if;
    if v_kind='sale.reverse' then
      select * into v_sale from public.sales where id=(p_payload->>'sale_id')::uuid and merchant_id=v_merchant for update;
      if not found then raise exception 'SALE_NOT_FOUND'; end if;
      if v_sale.status<>'completed' then raise exception 'SALE_ALREADY_REVERSED'; end if;
      -- No payment allocations/refunds exist yet: fail closed instead of clipping balance to zero.
      if v_sale.paid>0 or exists(select 1 from public.customer_payments where merchant_id=v_merchant and customer_id=v_sale.customer_id) then
        raise exception 'SETTLED_REVERSAL_REQUIRES_REFUND_ENGINE';
      end if;
      v_entity:=v_sale.id; v_party:=v_sale.customer_id; v_debt:=v_sale.total;
      select balance into v_balance from public.customers where id=v_party and merchant_id=v_merchant for update;
      if v_party is not null and (not found or v_balance<v_debt) then raise exception 'DEBT_RECONCILIATION_REQUIRED'; end if;
      select jsonb_agg(jsonb_build_object('product_id',product_id,'quantity',quantity)) into v_items from public.sale_items where sale_id=v_entity;
    else
      select * into v_purchase from public.purchases where id=(p_payload->>'purchase_id')::uuid and merchant_id=v_merchant for update;
      if not found then raise exception 'PURCHASE_NOT_FOUND'; end if;
      if v_purchase.status<>'received' then raise exception 'PURCHASE_ALREADY_REVERSED'; end if;
      if v_purchase.paid>0 or exists(select 1 from public.supplier_payments where merchant_id=v_merchant and supplier_id=v_purchase.supplier_id) then
        raise exception 'SETTLED_REVERSAL_REQUIRES_REFUND_ENGINE';
      end if;
      v_entity:=v_purchase.id; v_party:=v_purchase.supplier_id; v_debt:=v_purchase.total;
      select balance into v_balance from public.suppliers where id=v_party and merchant_id=v_merchant for update;
      if v_party is not null and (not found or v_balance<v_debt) then raise exception 'DEBT_RECONCILIATION_REQUIRED'; end if;
      select jsonb_agg(jsonb_build_object('product_id',product_id,'quantity',quantity)) into v_items from public.purchase_items where purchase_id=v_entity;
    end if;
    if v_items is null then raise exception 'REVERSAL_ITEMS_REQUIRED'; end if;
    for v_item in select value from jsonb_array_elements(v_items) order by value->>'product_id' loop
      v_product:=(v_item->>'product_id')::uuid; v_qty:=(v_item->>'quantity')::numeric;
      select unit into v_unit from public.products where id=v_product and merchant_id=v_merchant for share;
      if not found then raise exception 'PRODUCT_TENANT_MISMATCH'; end if;
      if v_kind='purchase.reverse' and public.current_stock(v_merchant,v_product)<v_qty then raise exception 'PURCHASE_STOCK_ALREADY_CONSUMED'; end if;
      insert into public.inventory_movements(merchant_id,product_id,quantity_delta,unit,reason,reference_id,idempotency_key,created_by)
      values(v_merchant,v_product,case when v_kind='sale.reverse' then v_qty else -v_qty end,v_unit,'return',v_entity,p_key||':stock:'||v_product,auth.uid());
    end loop;
    if v_kind='sale.reverse' then
      update public.customers set balance=balance-v_debt where id=v_party;
      update public.sales set status='reversed' where id=v_entity;
    else
      update public.suppliers set balance=balance-v_debt where id=v_party;
      update public.purchases set status='cancelled' where id=v_entity;
    end if;
    v_result:=jsonb_build_object(case when v_kind='sale.reverse' then 'sale_id' else 'purchase_id' end,v_entity,
      case when v_kind='sale.reverse' then 'sale_status' else 'purchase_status' end,
      case when v_kind='sale.reverse' then 'reversed' else 'cancelled' end,'debt_reversed',v_debt,'currency_code',v_currency);

  elsif v_kind='inventory.adjust' then
    v_product:=(p_payload->>'product_id')::uuid; v_qty:=(p_payload->>'quantity_delta')::numeric;
    if not mawsil_private.valid_number(v_qty,3) or v_qty=0 then raise exception 'INVALID_ADJUSTMENT'; end if;
    if coalesce(p_payload->>'reason','') not in ('opening','adjustment','expiry') then raise exception 'INVALID_ADJUSTMENT_REASON'; end if;
    if p_payload->>'reason'='expiry' and v_qty>0 then raise exception 'INVALID_EXPIRY_DIRECTION'; end if;
    select unit into v_unit from public.products where id=v_product and merchant_id=v_merchant and active for share;
    if not found then raise exception 'PRODUCT_TENANT_MISMATCH_OR_INACTIVE'; end if;
    if p_payload->>'reason'='opening' and exists(select 1 from public.inventory_movements where merchant_id=v_merchant and product_id=v_product) then
      raise exception 'OPENING_BALANCE_ALREADY_EXISTS';
    end if;
    v_stock:=public.current_stock(v_merchant,v_product); v_new_stock:=v_stock+v_qty;
    if v_new_stock<0 then raise exception 'ADJUSTMENT_WOULD_MAKE_STOCK_NEGATIVE'; end if;
    insert into public.inventory_movements(merchant_id,product_id,quantity_delta,unit,reason,reference_id,idempotency_key,created_by)
    values(v_merchant,v_product,v_qty,v_unit,p_payload->>'reason',v_op,p_key,auth.uid()) returning id into v_entity;
    v_result:=jsonb_build_object('movement_id',v_entity,'stock_before',v_stock,'stock_after',v_new_stock);

  elsif v_kind='expense.record' then
    v_amount:=(p_payload->>'amount')::numeric;
    if not mawsil_private.valid_number(v_amount,2) or v_amount<=0 then raise exception 'INVALID_EXPENSE_AMOUNT'; end if;
    if coalesce(length(trim(p_payload->>'category')),0) not between 1 and 100 then raise exception 'EXPENSE_CATEGORY_REQUIRED'; end if;
    insert into public.expenses(merchant_id,category,amount,currency_code,note,idempotency_key,created_by)
    values(v_merchant,p_payload->>'category',v_amount,v_currency,p_payload->>'note',p_key,auth.uid()) returning id into v_entity;
    v_result:=jsonb_build_object('expense_id',v_entity,'amount',v_amount,'currency_code',v_currency);
  end if;
  v_result:=v_result||jsonb_build_object('operation_id',v_op,'status','committed');
  update public.transaction_operations set status='committed',result=v_result,committed_at=clock_timestamp() where id=v_op;
  if p_approval is not null then update public.approval_requests set consumed_at=clock_timestamp(),operation_id=v_op where id=p_approval; end if;
  insert into public.audit_logs(merchant_id,action,entity_type,entity_id,payload,actor_user_id,actor_role,request_id,approval_id)
  values(v_merchant,v_kind,'transaction_operation',v_op,jsonb_build_object('payload_hash',v_hash,'result',v_result),auth.uid(),v_role,p_key,p_approval);
  return v_result;
end;
$$;

revoke all on all functions in schema mawsil_private from public,anon,authenticated;

-- Preserve the public RPC signatures; all state changes now share one checked engine.
create or replace function public.commit_sale(p_merchant_id uuid, p_customer_id uuid, p_items jsonb, p_paid numeric, p_currency_code text, p_idempotency_key text, p_approval_id uuid default null)
returns jsonb language sql volatile security definer set search_path = '' as $$
  select mawsil_private.execute_operation(jsonb_build_object('merchant_id',p_merchant_id,'customer_id',p_customer_id,'items',p_items,'paid',p_paid,'currency_code',p_currency_code,'operation_type','sale.commit'),p_idempotency_key,p_approval_id);
$$;
revoke all on function public.commit_sale(uuid,uuid,jsonb,numeric,text,text,uuid) from public,anon,authenticated;
grant execute on function public.commit_sale(uuid,uuid,jsonb,numeric,text,text,uuid) to authenticated;

create or replace function public.commit_purchase(p_merchant_id uuid, p_supplier_id uuid, p_items jsonb, p_paid numeric, p_currency_code text, p_idempotency_key text, p_approval_id uuid default null)
returns jsonb language sql volatile security definer set search_path = '' as $$
  select mawsil_private.execute_operation(jsonb_build_object('merchant_id',p_merchant_id,'supplier_id',p_supplier_id,'items',p_items,'paid',p_paid,'currency_code',p_currency_code,'operation_type','purchase.commit'),p_idempotency_key,p_approval_id);
$$;
revoke all on function public.commit_purchase(uuid,uuid,jsonb,numeric,text,text,uuid) from public,anon,authenticated;
grant execute on function public.commit_purchase(uuid,uuid,jsonb,numeric,text,text,uuid) to authenticated;

create or replace function public.record_customer_payment(p_merchant_id uuid, p_customer_id uuid, p_amount numeric, p_currency_code text, p_method text, p_reference text, p_idempotency_key text, p_approval_id uuid default null)
returns jsonb language sql volatile security definer set search_path = '' as $$
  select mawsil_private.execute_operation(jsonb_build_object('merchant_id',p_merchant_id,'customer_id',p_customer_id,'amount',p_amount,'currency_code',p_currency_code,'method',p_method,'reference',p_reference,'operation_type','customer_payment.record'),p_idempotency_key,p_approval_id);
$$;
revoke all on function public.record_customer_payment(uuid,uuid,numeric,text,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.record_customer_payment(uuid,uuid,numeric,text,text,text,text,uuid) to authenticated;

create or replace function public.record_supplier_payment(p_merchant_id uuid, p_supplier_id uuid, p_account_id uuid, p_amount numeric, p_currency_code text, p_exchange_rate numeric, p_method text, p_reference text, p_idempotency_key text, p_approval_id uuid)
returns jsonb language sql volatile security definer set search_path = '' as $$
  select mawsil_private.execute_operation(jsonb_build_object('merchant_id',p_merchant_id,'supplier_id',p_supplier_id,'account_id',p_account_id,'amount',p_amount,'currency_code',p_currency_code,'exchange_rate',p_exchange_rate,'method',p_method,'reference',p_reference,'operation_type','supplier_payment.record'),p_idempotency_key,p_approval_id);
$$;
revoke all on function public.record_supplier_payment(uuid,uuid,uuid,numeric,text,numeric,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.record_supplier_payment(uuid,uuid,uuid,numeric,text,numeric,text,text,text,uuid) to authenticated;

create or replace function public.record_expense(p_merchant_id uuid, p_category text, p_amount numeric, p_currency_code text, p_note text, p_idempotency_key text, p_approval_id uuid default null)
returns jsonb language sql volatile security definer set search_path = '' as $$
  select mawsil_private.execute_operation(jsonb_build_object('merchant_id',p_merchant_id,'category',p_category,'amount',p_amount,'currency_code',p_currency_code,'note',p_note,'operation_type','expense.record'),p_idempotency_key,p_approval_id);
$$;
revoke all on function public.record_expense(uuid,text,numeric,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.record_expense(uuid,text,numeric,text,text,text,uuid) to authenticated;

create or replace function public.adjust_inventory(p_merchant_id uuid, p_product_id uuid, p_quantity_delta numeric, p_reason text, p_idempotency_key text, p_approval_id uuid)
returns jsonb language sql volatile security definer set search_path = '' as $$
  select mawsil_private.execute_operation(jsonb_build_object('merchant_id',p_merchant_id,'product_id',p_product_id,'quantity_delta',p_quantity_delta,'reason',p_reason,'operation_type','inventory.adjust'),p_idempotency_key,p_approval_id);
$$;
revoke all on function public.adjust_inventory(uuid,uuid,numeric,text,text,uuid) from public,anon,authenticated;
grant execute on function public.adjust_inventory(uuid,uuid,numeric,text,text,uuid) to authenticated;

create or replace function public.reverse_sale(p_merchant_id uuid, p_sale_id uuid, p_idempotency_key text, p_reason text, p_approval_id uuid)
returns jsonb language sql volatile security definer set search_path = '' as $$
  select mawsil_private.execute_operation(jsonb_build_object('merchant_id',p_merchant_id,'sale_id',p_sale_id,'reason',p_reason,'operation_type','sale.reverse'),p_idempotency_key,p_approval_id);
$$;
revoke all on function public.reverse_sale(uuid,uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.reverse_sale(uuid,uuid,text,text,uuid) to authenticated;

create or replace function public.reverse_purchase(p_merchant_id uuid, p_purchase_id uuid, p_idempotency_key text, p_reason text, p_approval_id uuid)
returns jsonb language sql volatile security definer set search_path = '' as $$
  select mawsil_private.execute_operation(jsonb_build_object('merchant_id',p_merchant_id,'purchase_id',p_purchase_id,'reason',p_reason,'operation_type','purchase.reverse'),p_idempotency_key,p_approval_id);
$$;
revoke all on function public.reverse_purchase(uuid,uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.reverse_purchase(uuid,uuid,text,text,uuid) to authenticated;

-- Table-level REVOKE does not remove previously granted column privileges.
revoke insert(credit_limit),update(credit_limit) on public.customers from authenticated;
revoke update(unit) on public.products from authenticated;
revoke insert,update on public.merchants from public,anon,authenticated;
grant update(name,phone) on public.merchants to authenticated;
revoke insert,update on public.financial_accounts from public,anon,authenticated;
grant insert(merchant_id,name,account_type,currency_code,active) on public.financial_accounts to authenticated;
grant update(name,active) on public.financial_accounts to authenticated;
-- Ancillary stock/settlement tables have no verified write engine yet.
revoke insert,update on public.product_units,public.product_batches,public.payment_reconciliations
  from public,anon,authenticated;
-- TRUNCATE bypasses RLS; DELETE can cascade away financial history.
revoke delete,truncate,references,trigger on public.merchants,public.customers,public.suppliers,
  public.products,public.sales,public.sale_items,public.purchases,public.purchase_items,
  public.inventory_movements,public.customer_payments,public.supplier_payments,public.expenses,
  public.transaction_operations,public.approval_requests,public.audit_logs,public.financial_accounts,
  public.financial_account_entries,public.exchange_rates,public.product_units,public.product_batches,
  public.payment_reconciliations from public,anon,authenticated;
revoke insert,update on public.audit_logs from public,anon,authenticated;

create or replace function public.set_customer_credit_limit(
  p_merchant_id uuid,p_customer_id uuid,p_credit_limit numeric
) returns void language plpgsql security definer set search_path = '' as $$
declare v_old numeric;
begin
  if auth.uid() is null or not public.has_merchant_role(p_merchant_id,array['owner','manager']) then
    raise exception 'CREDIT_LIMIT_FORBIDDEN' using errcode='42501';
  end if;
  if not mawsil_private.valid_number(p_credit_limit,2) or p_credit_limit<0 then raise exception 'INVALID_CREDIT_LIMIT'; end if;
  perform 1 from public.merchants where id=p_merchant_id for update;
  select credit_limit into v_old from public.customers where id=p_customer_id and merchant_id=p_merchant_id for update;
  if not found then raise exception 'CUSTOMER_TENANT_MISMATCH'; end if;
  update public.customers set credit_limit=p_credit_limit where id=p_customer_id;
  insert into public.audit_logs(merchant_id,action,entity_type,entity_id,payload,actor_user_id,actor_role)
  values(p_merchant_id,'customer.credit_limit_changed','customer',p_customer_id,
    jsonb_build_object('previous',v_old,'credit_limit',p_credit_limit),auth.uid(),public.current_merchant_role(p_merchant_id));
end;
$$;
revoke all on function public.set_customer_credit_limit(uuid,uuid,numeric) from public,anon,authenticated;
grant execute on function public.set_customer_credit_limit(uuid,uuid,numeric) to authenticated;

create or replace function public.record_exchange_rate(
  p_merchant_id uuid,p_base_currency text,p_quote_currency text,p_rate numeric,
  p_source text default 'manual',p_effective_at timestamptz default now()
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null or not public.has_merchant_role(p_merchant_id,array['owner','manager']) then
    raise exception 'EXCHANGE_RATE_FORBIDDEN' using errcode='42501';
  end if;
  if p_base_currency is null or p_quote_currency is null or p_base_currency=p_quote_currency
    or not mawsil_private.valid_number(p_rate,8) or p_rate<=0
    or p_effective_at is null or not isfinite(p_effective_at) then raise exception 'INVALID_EXCHANGE_RATE'; end if;
  if not exists(select 1 from public.currencies where code=p_base_currency)
    or not exists(select 1 from public.currencies where code=p_quote_currency) then raise exception 'INVALID_CURRENCY'; end if;
  insert into public.exchange_rates(merchant_id,base_currency,quote_currency,rate,effective_at,source)
  values(p_merchant_id,p_base_currency,p_quote_currency,p_rate,p_effective_at,
    coalesce(nullif(trim(p_source),''),'manual')) returning id into v_id;
  insert into public.audit_logs(merchant_id,action,entity_type,entity_id,payload,actor_user_id,actor_role)
  values(p_merchant_id,'exchange_rate.recorded','exchange_rate',v_id,
    jsonb_build_object('base_currency',p_base_currency,'quote_currency',p_quote_currency,'rate',p_rate,'effective_at',p_effective_at),
    auth.uid(),public.current_merchant_role(p_merchant_id));
  return v_id;
end;
$$;
