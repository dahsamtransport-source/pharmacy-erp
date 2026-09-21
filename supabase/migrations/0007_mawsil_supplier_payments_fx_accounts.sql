-- Mawsil Transaction Engine v1.2
-- Supplier settlement, purchase reversal, exchange-rate governance and an
-- immutable financial-account ledger. All monetary/stock mutations remain RPC-only.

alter table public.merchants
  add column if not exists reporting_currency_code text references public.currencies(code);

update public.merchants
set reporting_currency_code = case
  when currency_code in ('YER_OLD','YER_NEW','SAR','USD') then currency_code
  else 'YER_NEW'
end
where reporting_currency_code is null;

alter table public.merchants
  alter column reporting_currency_code set default 'YER_NEW',
  alter column reporting_currency_code set not null;

create table if not exists public.supplier_payments (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  account_id uuid references public.financial_accounts(id) on delete restrict,
  amount numeric(14,2) not null check (amount > 0),
  currency_code text not null references public.currencies(code),
  exchange_rate numeric(18,8) not null check (exchange_rate > 0),
  reporting_amount numeric(18,2) not null check (reporting_amount > 0),
  method text not null check (method in ('cash','wallet','bank','other')),
  reference text,
  idempotency_key text not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (merchant_id,idempotency_key)
);

create table if not exists public.financial_account_entries (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  account_id uuid not null references public.financial_accounts(id) on delete restrict,
  operation_id uuid not null references public.transaction_operations(id) on delete restrict,
  direction text not null check (direction in ('inflow','outflow')),
  entry_type text not null check (entry_type in (
    'customer_payment','supplier_payment','sale_receipt','purchase_payment',
    'expense','refund','adjustment'
  )),
  amount numeric(14,2) not null check (amount > 0),
  currency_code text not null references public.currencies(code),
  exchange_rate numeric(18,8) not null check (exchange_rate > 0),
  reporting_amount numeric(18,2) not null check (reporting_amount > 0),
  reference_id uuid,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (operation_id,account_id,entry_type)
);

create index if not exists supplier_payments_supplier_created_idx
  on public.supplier_payments(supplier_id,created_at desc);
create index if not exists account_entries_account_created_idx
  on public.financial_account_entries(account_id,created_at desc);

alter table public.supplier_payments enable row level security;
alter table public.financial_account_entries enable row level security;

create policy supplier_payments_read on public.supplier_payments
for select to authenticated
using ((select public.is_merchant_member(merchant_id)));

create policy financial_account_entries_read on public.financial_account_entries
for select to authenticated
using ((select public.is_merchant_member(merchant_id)));

revoke insert,update,delete on public.supplier_payments from authenticated;
revoke insert,update,delete on public.financial_account_entries from authenticated;

-- Exchange rates are historical facts: clients can read them, but only the
-- controlled RPC may append one. Existing rows are never silently edited.
drop policy if exists exchange_tenant_access on public.exchange_rates;
drop policy if exists exchange_rates_read on public.exchange_rates;
create policy exchange_rates_read on public.exchange_rates
for select to authenticated
using ((select public.is_merchant_member(merchant_id)));
revoke insert,update,delete on public.exchange_rates from authenticated;

create or replace function public.record_exchange_rate(
  p_merchant_id uuid,
  p_base_currency text,
  p_quote_currency text,
  p_rate numeric,
  p_source text default 'manual',
  p_effective_at timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_rate_id uuid;
begin
  if v_user is null or not public.has_merchant_role(p_merchant_id,array['owner','manager']) then
    raise exception 'EXCHANGE_RATE_FORBIDDEN' using errcode='42501';
  end if;
  if p_base_currency=p_quote_currency or p_rate is null or p_rate<=0 then
    raise exception 'INVALID_EXCHANGE_RATE';
  end if;
  if not exists(select 1 from public.currencies where code=p_base_currency)
     or not exists(select 1 from public.currencies where code=p_quote_currency) then
    raise exception 'INVALID_CURRENCY';
  end if;

  insert into public.exchange_rates(
    merchant_id,base_currency,quote_currency,rate,effective_at,source
  ) values(
    p_merchant_id,p_base_currency,p_quote_currency,p_rate,p_effective_at,
    coalesce(nullif(trim(p_source),''),'manual')
  ) returning id into v_rate_id;

  insert into public.audit_logs(
    merchant_id,action,entity_type,entity_id,payload,actor_user_id,actor_role
  ) values(
    p_merchant_id,'exchange_rate.recorded','exchange_rate',v_rate_id,
    jsonb_build_object(
      'base_currency',p_base_currency,'quote_currency',p_quote_currency,
      'rate',p_rate,'effective_at',p_effective_at
    ),v_user,public.current_merchant_role(p_merchant_id)
  );

  return v_rate_id;
end;
$$;

revoke all on function public.record_exchange_rate(uuid,text,text,numeric,text,timestamptz) from public;
grant execute on function public.record_exchange_rate(uuid,text,text,numeric,text,timestamptz) to authenticated;

create or replace function public.current_account_balance(
  p_merchant_id uuid,
  p_account_id uuid
)
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_merchant_member(p_merchant_id) then
    raise exception 'ACCOUNT_ACCESS_DENIED' using errcode='42501';
  end if;
  if not exists(
    select 1 from public.financial_accounts
    where id=p_account_id and merchant_id=p_merchant_id
  ) then
    raise exception 'ACCOUNT_TENANT_MISMATCH';
  end if;

  return (
    select coalesce(sum(
      case when direction='inflow' then reporting_amount else -reporting_amount end
    ),0)::numeric
    from public.financial_account_entries
    where merchant_id=p_merchant_id and account_id=p_account_id
  );
end;
$$;

revoke all on function public.current_account_balance(uuid,uuid) from public;
grant execute on function public.current_account_balance(uuid,uuid) to authenticated;

-- Money leaving the merchant requires a payload-bound approval.
create or replace function public.record_supplier_payment(
  p_merchant_id uuid,
  p_supplier_id uuid,
  p_account_id uuid,
  p_amount numeric,
  p_currency_code text,
  p_exchange_rate numeric,
  p_method text,
  p_reference text,
  p_idempotency_key text,
  p_approval_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_role text;
  v_reporting_currency text;
  v_balance numeric(14,2);
  v_reporting_amount numeric(18,2);
  v_payload jsonb;
  v_hash text;
  v_op uuid;
  v_existing public.transaction_operations;
  v_approval public.approval_requests;
  v_payment_id uuid;
  v_result jsonb;
begin
  v_role:=public.current_merchant_role(p_merchant_id);
  if v_user is null or v_role not in ('owner','manager') then
    raise exception 'SUPPLIER_PAYMENT_FORBIDDEN' using errcode='42501';
  end if;
  if p_amount is null or p_amount<=0 then raise exception 'INVALID_PAYMENT_AMOUNT'; end if;
  if p_method not in ('cash','wallet','bank','other') then raise exception 'INVALID_PAYMENT_METHOD'; end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key))<8 then
    raise exception 'IDEMPOTENCY_KEY_REQUIRED';
  end if;

  select reporting_currency_code into v_reporting_currency
  from public.merchants where id=p_merchant_id;
  if not found then raise exception 'MERCHANT_NOT_FOUND'; end if;
  if not exists(select 1 from public.currencies where code=p_currency_code) then
    raise exception 'INVALID_CURRENCY';
  end if;
  if (p_currency_code=v_reporting_currency and p_exchange_rate<>1)
     or p_exchange_rate is null or p_exchange_rate<=0 then
    raise exception 'INVALID_EXCHANGE_RATE';
  end if;

  if p_account_id is not null and not exists(
    select 1 from public.financial_accounts
    where id=p_account_id and merchant_id=p_merchant_id
      and currency_code=p_currency_code and active=true
  ) then
    raise exception 'ACCOUNT_TENANT_OR_CURRENCY_MISMATCH';
  end if;

  v_reporting_amount:=round(p_amount*p_exchange_rate,2);
  v_payload:=jsonb_build_object(
    'merchant_id',p_merchant_id,'supplier_id',p_supplier_id,'account_id',p_account_id,
    'amount',p_amount,'currency_code',p_currency_code,'exchange_rate',p_exchange_rate,
    'method',p_method,'reference',p_reference,'operation_type','supplier_payment.record'
  );
  v_hash:=encode(extensions.digest(v_payload::text,'sha256'),'hex');

  insert into public.transaction_operations(
    merchant_id,idempotency_key,operation_type,payload_hash,payload,status,actor_user_id,approval_id
  ) values(
    p_merchant_id,p_idempotency_key,'supplier_payment.record',v_hash,v_payload,
    'processing',v_user,p_approval_id
  ) on conflict (merchant_id,idempotency_key) do nothing returning id into v_op;

  if v_op is null then
    select * into v_existing from public.transaction_operations
    where merchant_id=p_merchant_id and idempotency_key=p_idempotency_key for update;
    if v_existing.payload_hash<>v_hash then raise exception 'IDEMPOTENCY_PAYLOAD_MISMATCH'; end if;
    if v_existing.status='committed' then return v_existing.result; end if;
    raise exception 'IDEMPOTENCY_OPERATION_IN_PROGRESS';
  end if;

  select * into v_approval from public.approval_requests
  where id=p_approval_id for update;
  if not found or v_approval.merchant_id<>p_merchant_id
     or v_approval.status<>'approved' or v_approval.consumed_at is not null
     or (v_approval.expires_at is not null and v_approval.expires_at<=now())
     or v_approval.payload_hash is distinct from v_hash then
    raise exception 'VALID_APPROVAL_REQUIRED';
  end if;

  select balance into v_balance from public.suppliers
  where id=p_supplier_id and merchant_id=p_merchant_id for update;
  if not found then raise exception 'SUPPLIER_TENANT_MISMATCH'; end if;
  if p_amount>v_balance then raise exception 'PAYMENT_EXCEEDS_SUPPLIER_DEBT'; end if;

  insert into public.supplier_payments(
    merchant_id,supplier_id,account_id,amount,currency_code,exchange_rate,
    reporting_amount,method,reference,idempotency_key,created_by
  ) values(
    p_merchant_id,p_supplier_id,p_account_id,p_amount,p_currency_code,p_exchange_rate,
    v_reporting_amount,p_method,p_reference,p_idempotency_key,v_user
  ) returning id into v_payment_id;

  update public.suppliers set balance=balance-p_amount
  where id=p_supplier_id and merchant_id=p_merchant_id;

  if p_account_id is not null then
    insert into public.financial_account_entries(
      merchant_id,account_id,operation_id,direction,entry_type,amount,currency_code,
      exchange_rate,reporting_amount,reference_id,created_by
    ) values(
      p_merchant_id,p_account_id,v_op,'outflow','supplier_payment',p_amount,
      p_currency_code,p_exchange_rate,v_reporting_amount,v_payment_id,v_user
    );
  end if;

  update public.approval_requests set consumed_at=now(),operation_id=v_op
  where id=p_approval_id;

  v_result:=jsonb_build_object(
    'operation_id',v_op,'supplier_payment_id',v_payment_id,'status','committed',
    'amount',p_amount,'remaining_debt',v_balance-p_amount,
    'currency_code',p_currency_code,'exchange_rate',p_exchange_rate,
    'reporting_amount',v_reporting_amount
  );
  update public.transaction_operations set status='committed',result=v_result,committed_at=now()
  where id=v_op;

  insert into public.audit_logs(
    merchant_id,action,entity_type,entity_id,payload,actor_user_id,actor_role,request_id,approval_id
  ) values(
    p_merchant_id,'supplier_payment.recorded','supplier_payment',v_payment_id,
    jsonb_build_object(
      'operation_id',v_op,'payload_hash',v_hash,'amount',p_amount,
      'currency_code',p_currency_code,'exchange_rate',p_exchange_rate
    ),v_user,v_role,p_idempotency_key,p_approval_id
  );
  return v_result;
end;
$$;

revoke all on function public.record_supplier_payment(uuid,uuid,uuid,numeric,text,numeric,text,text,text,uuid) from public;
grant execute on function public.record_supplier_payment(uuid,uuid,uuid,numeric,text,numeric,text,text,text,uuid) to authenticated;

-- Purchase reversal is compensating: it never deletes purchase history. It is
-- refused if the purchased stock is no longer available or its debt was settled.
create or replace function public.reverse_purchase(
  p_merchant_id uuid,
  p_purchase_id uuid,
  p_idempotency_key text,
  p_reason text,
  p_approval_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid:=auth.uid();
  v_role text;
  v_purchase public.purchases;
  v_item record;
  v_supplier_balance numeric(14,2);
  v_debt numeric(14,2);
  v_payload jsonb;
  v_hash text;
  v_op uuid;
  v_existing public.transaction_operations;
  v_approval public.approval_requests;
  v_result jsonb;
begin
  v_role:=public.current_merchant_role(p_merchant_id);
  if v_user is null or v_role not in ('owner','manager') then
    raise exception 'PURCHASE_REVERSAL_FORBIDDEN' using errcode='42501';
  end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key))<8 then
    raise exception 'IDEMPOTENCY_KEY_REQUIRED';
  end if;
  if coalesce(length(trim(p_reason)),0)<3 then raise exception 'REVERSAL_REASON_REQUIRED'; end if;

  v_payload:=jsonb_build_object(
    'merchant_id',p_merchant_id,'purchase_id',p_purchase_id,'reason',p_reason,
    'operation_type','purchase.reverse'
  );
  v_hash:=encode(extensions.digest(v_payload::text,'sha256'),'hex');

  insert into public.transaction_operations(
    merchant_id,idempotency_key,operation_type,payload_hash,payload,status,actor_user_id,approval_id
  ) values(
    p_merchant_id,p_idempotency_key,'purchase.reverse',v_hash,v_payload,
    'processing',v_user,p_approval_id
  ) on conflict (merchant_id,idempotency_key) do nothing returning id into v_op;

  if v_op is null then
    select * into v_existing from public.transaction_operations
    where merchant_id=p_merchant_id and idempotency_key=p_idempotency_key for update;
    if v_existing.payload_hash<>v_hash then raise exception 'IDEMPOTENCY_PAYLOAD_MISMATCH'; end if;
    if v_existing.status='committed' then return v_existing.result; end if;
    raise exception 'IDEMPOTENCY_OPERATION_IN_PROGRESS';
  end if;

  select * into v_approval from public.approval_requests
  where id=p_approval_id for update;
  if not found or v_approval.merchant_id<>p_merchant_id
     or v_approval.status<>'approved' or v_approval.consumed_at is not null
     or (v_approval.expires_at is not null and v_approval.expires_at<=now())
     or v_approval.payload_hash is distinct from v_hash then
    raise exception 'VALID_APPROVAL_REQUIRED';
  end if;

  select * into v_purchase from public.purchases
  where id=p_purchase_id and merchant_id=p_merchant_id for update;
  if not found then raise exception 'PURCHASE_NOT_FOUND'; end if;
  if v_purchase.status='cancelled' then raise exception 'PURCHASE_ALREADY_REVERSED'; end if;

  v_debt:=v_purchase.total-v_purchase.paid;
  if v_purchase.supplier_id is not null and v_debt>0 then
    select balance into v_supplier_balance from public.suppliers
    where id=v_purchase.supplier_id and merchant_id=p_merchant_id for update;
    if not found then raise exception 'SUPPLIER_TENANT_MISMATCH'; end if;
    if v_supplier_balance<v_debt then raise exception 'PURCHASE_DEBT_ALREADY_SETTLED'; end if;
  end if;

  for v_item in
    select i.product_id,i.quantity,p.unit
    from public.purchase_items i
    join public.products p on p.id=i.product_id and p.merchant_id=p_merchant_id
    where i.purchase_id=p_purchase_id
    order by i.product_id
  loop
    perform pg_advisory_xact_lock(hashtextextended(p_merchant_id::text||':'||v_item.product_id::text,0));
    if public.current_stock(p_merchant_id,v_item.product_id)<v_item.quantity then
      raise exception 'PURCHASE_STOCK_ALREADY_CONSUMED';
    end if;
  end loop;

  for v_item in
    select i.product_id,i.quantity,p.unit
    from public.purchase_items i
    join public.products p on p.id=i.product_id and p.merchant_id=p_merchant_id
    where i.purchase_id=p_purchase_id
  loop
    insert into public.inventory_movements(
      merchant_id,product_id,quantity_delta,unit,reason,reference_id,idempotency_key,created_by
    ) values(
      p_merchant_id,v_item.product_id,-v_item.quantity,v_item.unit,'return',p_purchase_id,
      p_idempotency_key||':stock:'||v_item.product_id::text,v_user
    );
  end loop;

  if v_purchase.supplier_id is not null and v_debt>0 then
    update public.suppliers set balance=balance-v_debt
    where id=v_purchase.supplier_id and merchant_id=p_merchant_id;
  end if;
  update public.purchases set status='cancelled' where id=p_purchase_id;
  update public.approval_requests set consumed_at=now(),operation_id=v_op where id=p_approval_id;

  v_result:=jsonb_build_object(
    'operation_id',v_op,'purchase_id',p_purchase_id,'status','committed',
    'purchase_status','cancelled','debt_reversed',v_debt,
    'cash_refund_required',v_purchase.paid,'currency_code',v_purchase.currency_code
  );
  update public.transaction_operations set status='committed',result=v_result,committed_at=now()
  where id=v_op;

  insert into public.audit_logs(
    merchant_id,action,entity_type,entity_id,payload,actor_user_id,actor_role,request_id,approval_id
  ) values(
    p_merchant_id,'purchase.reversed','purchase',p_purchase_id,
    jsonb_build_object(
      'operation_id',v_op,'payload_hash',v_hash,'reason',p_reason,
      'debt_reversed',v_debt,'cash_refund_required',v_purchase.paid
    ),v_user,v_role,p_idempotency_key,p_approval_id
  );
  return v_result;
end;
$$;

revoke all on function public.reverse_purchase(uuid,uuid,text,text,uuid) from public;
grant execute on function public.reverse_purchase(uuid,uuid,text,text,uuid) to authenticated;

comment on table public.financial_account_entries is
  'Immutable ledger. Reporting amounts are frozen at each operation exchange-rate snapshot.';
comment on column public.merchants.reporting_currency_code is
  'Merchant reporting currency used for frozen operation-level FX conversion.';
