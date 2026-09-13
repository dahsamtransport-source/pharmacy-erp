-- Mawsil Transaction Engine v1
-- Database-enforced atomicity, idempotency, approval binding, immutable ledgers,
-- tenant-safe validation, and auditable execution.

create table if not exists public.transaction_operations (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  idempotency_key text not null,
  operation_type text not null,
  payload_hash text not null,
  payload jsonb not null,
  status text not null default 'processing'
    check (status in ('processing','committed','rejected','reversed','failed')),
  result jsonb,
  error_code text,
  actor_user_id uuid references auth.users(id),
  approval_id uuid,
  created_at timestamptz not null default now(),
  committed_at timestamptz,
  unique (merchant_id, idempotency_key)
);

create index if not exists transaction_operations_merchant_created_idx
  on public.transaction_operations(merchant_id, created_at desc);

alter table public.transaction_operations enable row level security;

drop policy if exists transaction_operations_read on public.transaction_operations;
create policy transaction_operations_read on public.transaction_operations
for select to authenticated
using ((select public.is_merchant_member(merchant_id)));

-- Approval requests become exact-payload capabilities that expire and can be consumed once.
alter table public.approval_requests
  add column if not exists payload jsonb,
  add column if not exists payload_hash text,
  add column if not exists expires_at timestamptz,
  add column if not exists consumed_at timestamptz,
  add column if not exists operation_id uuid references public.transaction_operations(id) on delete set null;

create unique index if not exists approval_operation_once_uq
  on public.approval_requests(operation_id)
  where operation_id is not null;

-- Strengthen audit context.
alter table public.audit_logs
  add column if not exists actor_user_id uuid references auth.users(id),
  add column if not exists actor_role text,
  add column if not exists request_id text,
  add column if not exists approval_id uuid references public.approval_requests(id) on delete set null;

-- Sales must have a tenant-scoped idempotency key once committed through the engine.
create unique index if not exists sales_merchant_idempotency_uq
  on public.sales(merchant_id, idempotency_key)
  where idempotency_key is not null;

-- Ledger/source-of-truth helpers.
create or replace function public.current_stock(target_merchant uuid, target_product uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(m.quantity_delta), 0)::numeric
  from public.inventory_movements m
  where m.merchant_id = target_merchant
    and m.product_id = target_product;
$$;

revoke all on function public.current_stock(uuid, uuid) from public;
grant execute on function public.current_stock(uuid, uuid) to authenticated;

create or replace function public.current_merchant_role(target_merchant uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.role
  from public.merchant_members m
  where m.merchant_id = target_merchant
    and m.user_id = (select auth.uid())
  limit 1;
$$;

revoke all on function public.current_merchant_role(uuid) from public;
grant execute on function public.current_merchant_role(uuid) to authenticated;

-- Direct mutation of financial/inventory ledgers is forbidden to authenticated clients.
-- Mutations must occur through narrow SECURITY DEFINER RPCs below.
revoke insert, update, delete on public.sales from authenticated;
revoke insert, update, delete on public.sale_items from authenticated;
revoke insert, update, delete on public.inventory_movements from authenticated;
revoke insert, update, delete on public.purchases from authenticated;
revoke insert, update, delete on public.purchase_items from authenticated;
revoke insert, update, delete on public.customer_payments from authenticated;
revoke insert, update, delete on public.expenses from authenticated;
revoke insert, update, delete on public.approval_requests from authenticated;
revoke insert, update, delete on public.transaction_operations from authenticated;
revoke update, delete on public.audit_logs from authenticated;

-- Remove old direct-write policies for protected tables.
drop policy if exists sales_insert on public.sales;
drop policy if exists sales_update on public.sales;
drop policy if exists sales_delete on public.sales;
drop policy if exists inventory_insert on public.inventory_movements;
drop policy if exists inventory_update on public.inventory_movements;
drop policy if exists inventory_delete on public.inventory_movements;
drop policy if exists purchases_insert on public.purchases;
drop policy if exists purchases_update on public.purchases;
drop policy if exists purchases_delete on public.purchases;
drop policy if exists payments_insert on public.customer_payments;
drop policy if exists payments_update on public.customer_payments;
drop policy if exists payments_delete on public.customer_payments;
drop policy if exists expenses_insert on public.expenses;
drop policy if exists expenses_update on public.expenses;
drop policy if exists expenses_delete on public.expenses;
drop policy if exists approvals_create on public.approval_requests;
drop policy if exists approvals_review on public.approval_requests;

-- Disable the historical sale-item trigger: it reprocessed every item on each insert.
drop trigger if exists sale_item_inventory_trigger on public.sale_items;

-- Create an approval request bound to the canonical JSON payload hash.
create or replace function public.request_transaction_approval(
  p_merchant_id uuid,
  p_action text,
  p_payload jsonb,
  p_reason text default null,
  p_risk_level text default 'high',
  p_ttl_minutes integer default 30
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_id uuid;
  v_hash text;
begin
  if v_user is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  if not public.is_merchant_member(p_merchant_id) then
    raise exception 'MERCHANT_ACCESS_DENIED' using errcode = '42501';
  end if;

  if p_risk_level not in ('medium','high','critical') then
    raise exception 'INVALID_RISK_LEVEL';
  end if;

  if p_ttl_minutes < 1 or p_ttl_minutes > 1440 then
    raise exception 'INVALID_APPROVAL_TTL';
  end if;

  v_hash := encode(digest(coalesce(p_payload, '{}'::jsonb)::text, 'sha256'), 'hex');

  insert into public.approval_requests(
    merchant_id, requested_by, action, risk_level, status, reason,
    payload, payload_hash, expires_at
  )
  values(
    p_merchant_id, v_user, p_action, p_risk_level, 'pending', p_reason,
    coalesce(p_payload, '{}'::jsonb), v_hash, now() + make_interval(mins => p_ttl_minutes)
  )
  returning id into v_id;

  insert into public.audit_logs(
    merchant_id, action, entity_type, entity_id, payload, actor_user_id, actor_role, approval_id
  )
  values(
    p_merchant_id, 'approval.requested', 'approval_request', v_id,
    jsonb_build_object('action', p_action, 'risk_level', p_risk_level, 'payload_hash', v_hash),
    v_user, public.current_merchant_role(p_merchant_id), v_id
  );

  return v_id;
end;
$$;

revoke all on function public.request_transaction_approval(uuid,text,jsonb,text,text,integer) from public;
grant execute on function public.request_transaction_approval(uuid,text,jsonb,text,text,integer) to authenticated;

-- Management-only approval/rejection. Reviewer fields/status cannot be forged by table writes.
create or replace function public.review_transaction_approval(
  p_approval_id uuid,
  p_decision text,
  p_reason text default null
)
returns public.approval_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_row public.approval_requests;
begin
  select * into v_row
  from public.approval_requests
  where id = p_approval_id
  for update;

  if not found then
    raise exception 'APPROVAL_NOT_FOUND';
  end if;

  if v_user is null or not public.has_merchant_role(v_row.merchant_id, array['owner','manager']) then
    raise exception 'APPROVAL_REVIEW_FORBIDDEN' using errcode = '42501';
  end if;

  if v_row.status <> 'pending' then
    raise exception 'APPROVAL_NOT_PENDING';
  end if;

  if v_row.expires_at is not null and v_row.expires_at <= now() then
    update public.approval_requests
      set status='expired', reviewed_by=v_user, reviewed_at=now(),
          reason=coalesce(p_reason, reason)
    where id=p_approval_id
    returning * into v_row;
    return v_row;
  end if;

  if p_decision not in ('approved','rejected') then
    raise exception 'INVALID_APPROVAL_DECISION';
  end if;

  update public.approval_requests
    set status=p_decision,
        reviewed_by=v_user,
        reviewed_at=now(),
        reason=coalesce(p_reason, reason)
  where id=p_approval_id
  returning * into v_row;

  insert into public.audit_logs(
    merchant_id, action, entity_type, entity_id, payload,
    actor_user_id, actor_role, approval_id
  )
  values(
    v_row.merchant_id,
    case when p_decision='approved' then 'approval.approved' else 'approval.rejected' end,
    'approval_request', v_row.id,
    jsonb_build_object('payload_hash', v_row.payload_hash, 'reason', v_row.reason),
    v_user, public.current_merchant_role(v_row.merchant_id), v_row.id
  );

  return v_row;
end;
$$;

revoke all on function public.review_transaction_approval(uuid,text,text) from public;
grant execute on function public.review_transaction_approval(uuid,text,text) to authenticated;

-- Atomic sale commit.
-- p_items format: [{"product_id":"uuid","quantity":1.0,"unit_price":100.0}, ...]
create or replace function public.commit_sale(
  p_merchant_id uuid,
  p_customer_id uuid,
  p_items jsonb,
  p_paid numeric,
  p_currency_code text,
  p_idempotency_key text,
  p_approval_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_role text;
  v_payload jsonb;
  v_hash text;
  v_existing public.transaction_operations;
  v_operation_id uuid;
  v_sale_id uuid;
  v_total numeric(14,2) := 0;
  v_item jsonb;
  v_product uuid;
  v_qty numeric(14,3);
  v_price numeric(14,2);
  v_unit text;
  v_stock numeric;
  v_approval public.approval_requests;
  v_result jsonb;
begin
  if v_user is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  v_role := public.current_merchant_role(p_merchant_id);
  if v_role is null or v_role not in ('owner','manager','staff') then
    raise exception 'SALE_FORBIDDEN' using errcode = '42501';
  end if;

  if p_idempotency_key is null or length(trim(p_idempotency_key)) < 8 then
    raise exception 'IDEMPOTENCY_KEY_REQUIRED';
  end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'SALE_ITEMS_REQUIRED';
  end if;

  if p_paid is null or p_paid < 0 then
    raise exception 'INVALID_PAID_AMOUNT';
  end if;

  if not exists(select 1 from public.currencies c where c.code = p_currency_code) then
    raise exception 'INVALID_CURRENCY';
  end if;

  if p_customer_id is not null and not exists(
    select 1 from public.customers c
    where c.id = p_customer_id and c.merchant_id = p_merchant_id
  ) then
    raise exception 'CUSTOMER_TENANT_MISMATCH';
  end if;

  v_payload := jsonb_build_object(
    'merchant_id', p_merchant_id,
    'customer_id', p_customer_id,
    'items', p_items,
    'paid', p_paid,
    'currency_code', p_currency_code,
    'operation_type', 'sale.commit'
  );
  v_hash := encode(digest(v_payload::text, 'sha256'), 'hex');

  insert into public.transaction_operations(
    merchant_id, idempotency_key, operation_type, payload_hash, payload,
    status, actor_user_id, approval_id
  )
  values(
    p_merchant_id, p_idempotency_key, 'sale.commit', v_hash, v_payload,
    'processing', v_user, p_approval_id
  )
  on conflict (merchant_id, idempotency_key) do nothing
  returning id into v_operation_id;

  if v_operation_id is null then
    select * into v_existing
    from public.transaction_operations
    where merchant_id=p_merchant_id and idempotency_key=p_idempotency_key
    for update;

    if v_existing.payload_hash <> v_hash then
      raise exception 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    end if;

    if v_existing.status = 'committed' then
      return v_existing.result;
    end if;

    raise exception 'IDEMPOTENCY_OPERATION_IN_PROGRESS';
  end if;

  -- If an approval is supplied it must authorize this exact payload and may be consumed once.
  if p_approval_id is not null then
    select * into v_approval
    from public.approval_requests
    where id=p_approval_id
    for update;

    if not found or v_approval.merchant_id <> p_merchant_id then
      raise exception 'APPROVAL_INVALID';
    end if;
    if v_approval.status <> 'approved' then
      raise exception 'APPROVAL_NOT_APPROVED';
    end if;
    if v_approval.expires_at is not null and v_approval.expires_at <= now() then
      raise exception 'APPROVAL_EXPIRED';
    end if;
    if v_approval.consumed_at is not null or v_approval.operation_id is not null then
      raise exception 'APPROVAL_ALREADY_CONSUMED';
    end if;
    if v_approval.payload_hash is distinct from v_hash then
      raise exception 'APPROVAL_PAYLOAD_MISMATCH';
    end if;
  end if;

  -- Validate all items and lock inventory per product for concurrent safety.
  for v_item in select value from jsonb_array_elements(p_items)
  loop
    begin
      v_product := (v_item->>'product_id')::uuid;
      v_qty := (v_item->>'quantity')::numeric;
      v_price := (v_item->>'unit_price')::numeric;
    exception when others then
      raise exception 'INVALID_SALE_ITEM';
    end;

    if v_qty <= 0 or v_price < 0 then
      raise exception 'INVALID_SALE_ITEM_VALUES';
    end if;

    select p.unit into v_unit
    from public.products p
    where p.id=v_product and p.merchant_id=p_merchant_id and p.active=true;

    if not found then
      raise exception 'PRODUCT_TENANT_MISMATCH_OR_INACTIVE';
    end if;

    perform pg_advisory_xact_lock(
      hashtextextended(p_merchant_id::text || ':' || v_product::text, 0)
    );

    v_stock := public.current_stock(p_merchant_id, v_product);
    if v_stock < v_qty then
      raise exception 'INSUFFICIENT_STOCK';
    end if;

    v_total := v_total + round(v_qty * v_price, 2);
  end loop;

  if p_paid > v_total then
    raise exception 'PAID_EXCEEDS_TOTAL';
  end if;

  insert into public.sales(
    merchant_id, customer_id, total, paid, status,
    currency_code, idempotency_key, created_by
  )
  values(
    p_merchant_id, p_customer_id, v_total, p_paid, 'completed',
    p_currency_code, p_idempotency_key, v_user
  )
  returning id into v_sale_id;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_product := (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'quantity')::numeric;
    v_price := (v_item->>'unit_price')::numeric;

    select p.unit into v_unit
    from public.products p
    where p.id=v_product and p.merchant_id=p_merchant_id;

    insert into public.sale_items(sale_id, product_id, quantity, unit_price)
    values(v_sale_id, v_product, v_qty, v_price);

    insert into public.inventory_movements(
      merchant_id, product_id, quantity_delta, unit, reason,
      reference_id, idempotency_key, created_by
    )
    values(
      p_merchant_id, v_product, -v_qty, v_unit, 'sale',
      v_sale_id, p_idempotency_key || ':stock:' || v_product::text, v_user
    );
  end loop;

  if p_customer_id is not null and (v_total - p_paid) > 0 then
    update public.customers
      set balance = balance + (v_total - p_paid)
    where id=p_customer_id and merchant_id=p_merchant_id;

    if not found then
      raise exception 'CUSTOMER_UPDATE_FAILED';
    end if;
  end if;

  if p_approval_id is not null then
    update public.approval_requests
      set consumed_at=now(), operation_id=v_operation_id
    where id=p_approval_id;
  end if;

  v_result := jsonb_build_object(
    'operation_id', v_operation_id,
    'sale_id', v_sale_id,
    'status', 'committed',
    'total', v_total,
    'paid', p_paid,
    'debt', v_total - p_paid,
    'currency_code', p_currency_code
  );

  update public.transaction_operations
    set status='committed', result=v_result, committed_at=now()
  where id=v_operation_id;

  insert into public.audit_logs(
    merchant_id, action, entity_type, entity_id, payload,
    actor_user_id, actor_role, request_id, approval_id
  )
  values(
    p_merchant_id, 'sale.committed', 'sale', v_sale_id,
    jsonb_build_object(
      'operation_id', v_operation_id,
      'payload_hash', v_hash,
      'total', v_total,
      'paid', p_paid,
      'debt', v_total-p_paid,
      'currency_code', p_currency_code
    ),
    v_user, v_role, p_idempotency_key, p_approval_id
  );

  return v_result;
exception
  when others then
    -- The entire function is atomic. If any statement fails, sale/stock/debt writes roll back.
    raise;
end;
$$;

revoke all on function public.commit_sale(uuid,uuid,jsonb,numeric,text,text,uuid) from public;
grant execute on function public.commit_sale(uuid,uuid,jsonb,numeric,text,text,uuid) to authenticated;

-- Reversal is a compensating transaction; historical rows are never deleted or edited.
create or replace function public.reverse_sale(
  p_merchant_id uuid,
  p_sale_id uuid,
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
  v_user uuid := auth.uid();
  v_role text;
  v_sale public.sales;
  v_item record;
  v_op uuid;
  v_payload jsonb;
  v_hash text;
  v_approval public.approval_requests;
  v_result jsonb;
begin
  v_role := public.current_merchant_role(p_merchant_id);
  if v_user is null or v_role not in ('owner','manager') then
    raise exception 'REVERSAL_FORBIDDEN' using errcode='42501';
  end if;

  select * into v_sale
  from public.sales
  where id=p_sale_id and merchant_id=p_merchant_id
  for update;

  if not found then raise exception 'SALE_NOT_FOUND'; end if;
  if v_sale.status = 'reversed' then raise exception 'SALE_ALREADY_REVERSED'; end if;

  v_payload := jsonb_build_object(
    'merchant_id',p_merchant_id,'sale_id',p_sale_id,'reason',p_reason,'operation_type','sale.reverse'
  );
  v_hash := encode(digest(v_payload::text,'sha256'),'hex');

  select * into v_approval from public.approval_requests where id=p_approval_id for update;
  if not found
     or v_approval.merchant_id<>p_merchant_id
     or v_approval.status<>'approved'
     or v_approval.consumed_at is not null
     or (v_approval.expires_at is not null and v_approval.expires_at<=now())
     or v_approval.payload_hash is distinct from v_hash then
    raise exception 'VALID_APPROVAL_REQUIRED';
  end if;

  insert into public.transaction_operations(
    merchant_id,idempotency_key,operation_type,payload_hash,payload,status,actor_user_id,approval_id
  ) values(
    p_merchant_id,p_idempotency_key,'sale.reverse',v_hash,v_payload,'processing',v_user,p_approval_id
  )
  returning id into v_op;

  for v_item in
    select i.product_id,i.quantity,p.unit
    from public.sale_items i
    join public.products p on p.id=i.product_id and p.merchant_id=p_merchant_id
    where i.sale_id=p_sale_id
  loop
    perform pg_advisory_xact_lock(
      hashtextextended(p_merchant_id::text || ':' || v_item.product_id::text,0)
    );
    insert into public.inventory_movements(
      merchant_id,product_id,quantity_delta,unit,reason,reference_id,idempotency_key,created_by
    ) values(
      p_merchant_id,v_item.product_id,v_item.quantity,v_item.unit,'return',
      p_sale_id,p_idempotency_key || ':stock:' || v_item.product_id::text,v_user
    );
  end loop;

  if v_sale.customer_id is not null and (v_sale.total-v_sale.paid)>0 then
    update public.customers
      set balance = greatest(0, balance - (v_sale.total-v_sale.paid))
    where id=v_sale.customer_id and merchant_id=p_merchant_id;
  end if;

  update public.sales set status='reversed' where id=p_sale_id;

  update public.approval_requests
    set consumed_at=now(), operation_id=v_op
  where id=p_approval_id;

  v_result := jsonb_build_object(
    'operation_id',v_op,'sale_id',p_sale_id,'status','reversed','reason',p_reason
  );

  update public.transaction_operations
    set status='reversed',result=v_result,committed_at=now()
  where id=v_op;

  insert into public.audit_logs(
    merchant_id,action,entity_type,entity_id,payload,actor_user_id,actor_role,request_id,approval_id
  ) values(
    p_merchant_id,'sale.reversed','sale',p_sale_id,
    jsonb_build_object('operation_id',v_op,'payload_hash',v_hash,'reason',p_reason),
    v_user,v_role,p_idempotency_key,p_approval_id
  );

  return v_result;
end;
$$;

revoke all on function public.reverse_sale(uuid,uuid,text,text,uuid) from public;
grant execute on function public.reverse_sale(uuid,uuid,text,text,uuid) to authenticated;
