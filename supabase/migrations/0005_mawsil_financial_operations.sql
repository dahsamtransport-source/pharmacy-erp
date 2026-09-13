-- Mawsil Transaction Engine v1.1
-- Atomic purchase, customer payment, expense and inventory adjustment operations.
-- Also protects derived financial balances from direct authenticated writes.

-- Preserve profile edits while preventing direct balance tampering.
create or replace function public.prevent_customer_balance_tamper()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user in ('authenticated','anon') and new.balance is distinct from old.balance then
    raise exception 'CUSTOMER_BALANCE_IS_DERIVED';
  end if;
  return new;
end;
$$;

drop trigger if exists customer_balance_guard on public.customers;
create trigger customer_balance_guard
before update on public.customers
for each row execute function public.prevent_customer_balance_tamper();

create or replace function public.prevent_supplier_balance_tamper()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user in ('authenticated','anon') and new.balance is distinct from old.balance then
    raise exception 'SUPPLIER_BALANCE_IS_DERIVED';
  end if;
  return new;
end;
$$;

drop trigger if exists supplier_balance_guard on public.suppliers;
create trigger supplier_balance_guard
before update on public.suppliers
for each row execute function public.prevent_supplier_balance_tamper();

-- Purchases are committed atomically with stock and supplier debt.
create or replace function public.commit_purchase(
  p_merchant_id uuid,
  p_supplier_id uuid,
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
  v_operation_id uuid;
  v_existing public.transaction_operations;
  v_purchase_id uuid;
  v_item jsonb;
  v_product uuid;
  v_qty numeric(14,3);
  v_price numeric(14,2);
  v_discount numeric(14,2);
  v_unit text;
  v_total numeric(14,2) := 0;
  v_approval public.approval_requests;
  v_result jsonb;
begin
  if v_user is null then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;

  v_role := public.current_merchant_role(p_merchant_id);
  if v_role is null or v_role not in ('owner','manager','inventory') then
    raise exception 'PURCHASE_FORBIDDEN' using errcode='42501';
  end if;

  if p_idempotency_key is null or length(trim(p_idempotency_key)) < 8 then
    raise exception 'IDEMPOTENCY_KEY_REQUIRED';
  end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items)=0 then
    raise exception 'PURCHASE_ITEMS_REQUIRED';
  end if;

  if p_paid is null or p_paid < 0 then raise exception 'INVALID_PAID_AMOUNT'; end if;

  if not exists(select 1 from public.currencies where code=p_currency_code) then
    raise exception 'INVALID_CURRENCY';
  end if;

  if p_supplier_id is not null and not exists(
    select 1 from public.suppliers s
    where s.id=p_supplier_id and s.merchant_id=p_merchant_id
  ) then
    raise exception 'SUPPLIER_TENANT_MISMATCH';
  end if;

  v_payload := jsonb_build_object(
    'merchant_id',p_merchant_id,'supplier_id',p_supplier_id,'items',p_items,
    'paid',p_paid,'currency_code',p_currency_code,'operation_type','purchase.commit'
  );
  v_hash := encode(digest(v_payload::text,'sha256'),'hex');

  insert into public.transaction_operations(
    merchant_id,idempotency_key,operation_type,payload_hash,payload,status,actor_user_id,approval_id
  ) values(
    p_merchant_id,p_idempotency_key,'purchase.commit',v_hash,v_payload,'processing',v_user,p_approval_id
  )
  on conflict (merchant_id,idempotency_key) do nothing
  returning id into v_operation_id;

  if v_operation_id is null then
    select * into v_existing from public.transaction_operations
    where merchant_id=p_merchant_id and idempotency_key=p_idempotency_key
    for update;

    if v_existing.payload_hash<>v_hash then raise exception 'IDEMPOTENCY_PAYLOAD_MISMATCH'; end if;
    if v_existing.status='committed' then return v_existing.result; end if;
    raise exception 'IDEMPOTENCY_OPERATION_IN_PROGRESS';
  end if;

  if p_approval_id is not null then
    select * into v_approval from public.approval_requests where id=p_approval_id for update;
    if not found
       or v_approval.merchant_id<>p_merchant_id
       or v_approval.status<>'approved'
       or v_approval.consumed_at is not null
       or (v_approval.expires_at is not null and v_approval.expires_at<=now())
       or v_approval.payload_hash is distinct from v_hash then
      raise exception 'VALID_APPROVAL_REQUIRED';
    end if;
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    begin
      v_product := (v_item->>'product_id')::uuid;
      v_qty := (v_item->>'quantity')::numeric;
      v_price := (v_item->>'unit_price')::numeric;
      v_discount := coalesce((v_item->>'discount')::numeric,0);
    exception when others then
      raise exception 'INVALID_PURCHASE_ITEM';
    end;

    if v_qty<=0 or v_price<0 or v_discount<0 or v_discount>(v_qty*v_price) then
      raise exception 'INVALID_PURCHASE_ITEM_VALUES';
    end if;

    select p.unit into v_unit from public.products p
    where p.id=v_product and p.merchant_id=p_merchant_id and p.active=true;
    if not found then raise exception 'PRODUCT_TENANT_MISMATCH_OR_INACTIVE'; end if;

    perform pg_advisory_xact_lock(hashtextextended(p_merchant_id::text||':'||v_product::text,0));
    v_total := v_total + round((v_qty*v_price)-v_discount,2);
  end loop;

  if p_paid>v_total then raise exception 'PAID_EXCEEDS_TOTAL'; end if;

  insert into public.purchases(
    merchant_id,supplier_id,currency_code,total,paid,status,idempotency_key,created_by
  ) values(
    p_merchant_id,p_supplier_id,p_currency_code,v_total,p_paid,'received',p_idempotency_key,v_user
  ) returning id into v_purchase_id;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_product := (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'quantity')::numeric;
    v_price := (v_item->>'unit_price')::numeric;
    v_discount := coalesce((v_item->>'discount')::numeric,0);

    select p.unit into v_unit from public.products p
    where p.id=v_product and p.merchant_id=p_merchant_id;

    insert into public.purchase_items(purchase_id,product_id,quantity,unit_price,discount)
    values(v_purchase_id,v_product,v_qty,v_price,v_discount);

    insert into public.inventory_movements(
      merchant_id,product_id,quantity_delta,unit,reason,reference_id,idempotency_key,created_by
    ) values(
      p_merchant_id,v_product,v_qty,v_unit,'purchase',v_purchase_id,
      p_idempotency_key||':stock:'||v_product::text,v_user
    );
  end loop;

  if p_supplier_id is not null and (v_total-p_paid)>0 then
    update public.suppliers
      set balance=balance+(v_total-p_paid)
    where id=p_supplier_id and merchant_id=p_merchant_id;
  end if;

  if p_approval_id is not null then
    update public.approval_requests set consumed_at=now(),operation_id=v_operation_id
    where id=p_approval_id;
  end if;

  v_result := jsonb_build_object(
    'operation_id',v_operation_id,'purchase_id',v_purchase_id,'status','committed',
    'total',v_total,'paid',p_paid,'debt',v_total-p_paid,'currency_code',p_currency_code
  );

  update public.transaction_operations
  set status='committed',result=v_result,committed_at=now()
  where id=v_operation_id;

  insert into public.audit_logs(
    merchant_id,action,entity_type,entity_id,payload,actor_user_id,actor_role,request_id,approval_id
  ) values(
    p_merchant_id,'purchase.committed','purchase',v_purchase_id,
    jsonb_build_object('operation_id',v_operation_id,'payload_hash',v_hash,'total',v_total,'paid',p_paid),
    v_user,v_role,p_idempotency_key,p_approval_id
  );

  return v_result;
end;
$$;

revoke all on function public.commit_purchase(uuid,uuid,jsonb,numeric,text,text,uuid) from public;
grant execute on function public.commit_purchase(uuid,uuid,jsonb,numeric,text,text,uuid) to authenticated;

-- Customer payment atomically reduces debt and writes an immutable payment row.
create or replace function public.record_customer_payment(
  p_merchant_id uuid,
  p_customer_id uuid,
  p_amount numeric,
  p_currency_code text,
  p_method text,
  p_reference text,
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
  v_op uuid;
  v_existing public.transaction_operations;
  v_payment uuid;
  v_balance numeric(14,2);
  v_approval public.approval_requests;
  v_result jsonb;
begin
  if v_user is null then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
  v_role := public.current_merchant_role(p_merchant_id);
  if v_role is null or v_role not in ('owner','manager','staff') then
    raise exception 'PAYMENT_FORBIDDEN' using errcode='42501';
  end if;
  if p_amount<=0 then raise exception 'INVALID_PAYMENT_AMOUNT'; end if;
  if p_method not in ('cash','wallet','bank','other') then raise exception 'INVALID_PAYMENT_METHOD'; end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key))<8 then raise exception 'IDEMPOTENCY_KEY_REQUIRED'; end if;
  if not exists(select 1 from public.currencies where code=p_currency_code) then raise exception 'INVALID_CURRENCY'; end if;

  select balance into v_balance from public.customers
  where id=p_customer_id and merchant_id=p_merchant_id
  for update;
  if not found then raise exception 'CUSTOMER_TENANT_MISMATCH'; end if;
  if p_amount>v_balance then raise exception 'PAYMENT_EXCEEDS_DEBT'; end if;

  v_payload:=jsonb_build_object(
    'merchant_id',p_merchant_id,'customer_id',p_customer_id,'amount',p_amount,
    'currency_code',p_currency_code,'method',p_method,'reference',p_reference,
    'operation_type','customer_payment.record'
  );
  v_hash:=encode(digest(v_payload::text,'sha256'),'hex');

  insert into public.transaction_operations(
    merchant_id,idempotency_key,operation_type,payload_hash,payload,status,actor_user_id,approval_id
  ) values(
    p_merchant_id,p_idempotency_key,'customer_payment.record',v_hash,v_payload,'processing',v_user,p_approval_id
  )
  on conflict (merchant_id,idempotency_key) do nothing
  returning id into v_op;

  if v_op is null then
    select * into v_existing from public.transaction_operations
    where merchant_id=p_merchant_id and idempotency_key=p_idempotency_key for update;
    if v_existing.payload_hash<>v_hash then raise exception 'IDEMPOTENCY_PAYLOAD_MISMATCH'; end if;
    if v_existing.status='committed' then return v_existing.result; end if;
    raise exception 'IDEMPOTENCY_OPERATION_IN_PROGRESS';
  end if;

  if p_approval_id is not null then
    select * into v_approval from public.approval_requests where id=p_approval_id for update;
    if not found
       or v_approval.merchant_id<>p_merchant_id
       or v_approval.status<>'approved'
       or v_approval.consumed_at is not null
       or (v_approval.expires_at is not null and v_approval.expires_at<=now())
       or v_approval.payload_hash is distinct from v_hash then
      raise exception 'VALID_APPROVAL_REQUIRED';
    end if;
  end if;

  insert into public.customer_payments(
    merchant_id,customer_id,amount,currency_code,method,reference,idempotency_key,created_by
  ) values(
    p_merchant_id,p_customer_id,p_amount,p_currency_code,p_method,p_reference,p_idempotency_key,v_user
  ) returning id into v_payment;

  update public.customers set balance=balance-p_amount
  where id=p_customer_id and merchant_id=p_merchant_id;

  if p_approval_id is not null then
    update public.approval_requests set consumed_at=now(),operation_id=v_op where id=p_approval_id;
  end if;

  v_result:=jsonb_build_object(
    'operation_id',v_op,'payment_id',v_payment,'status','committed',
    'amount',p_amount,'remaining_debt',v_balance-p_amount,'currency_code',p_currency_code
  );

  update public.transaction_operations set status='committed',result=v_result,committed_at=now()
  where id=v_op;

  insert into public.audit_logs(
    merchant_id,action,entity_type,entity_id,payload,actor_user_id,actor_role,request_id,approval_id
  ) values(
    p_merchant_id,'customer_payment.recorded','customer_payment',v_payment,
    jsonb_build_object('operation_id',v_op,'payload_hash',v_hash,'amount',p_amount),
    v_user,v_role,p_idempotency_key,p_approval_id
  );

  return v_result;
end;
$$;

revoke all on function public.record_customer_payment(uuid,uuid,numeric,text,text,text,text,uuid) from public;
grant execute on function public.record_customer_payment(uuid,uuid,numeric,text,text,text,text,uuid) to authenticated;

-- Expenses are immutable financial operations.
create or replace function public.record_expense(
  p_merchant_id uuid,
  p_category text,
  p_amount numeric,
  p_currency_code text,
  p_note text,
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
  v_op uuid;
  v_existing public.transaction_operations;
  v_expense uuid;
  v_approval public.approval_requests;
  v_result jsonb;
begin
  if v_user is null then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
  v_role:=public.current_merchant_role(p_merchant_id);
  if v_role is null or v_role not in ('owner','manager') then
    raise exception 'EXPENSE_FORBIDDEN' using errcode='42501';
  end if;
  if p_amount<=0 then raise exception 'INVALID_EXPENSE_AMOUNT'; end if;
  if coalesce(length(trim(p_category)),0)=0 then raise exception 'EXPENSE_CATEGORY_REQUIRED'; end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key))<8 then raise exception 'IDEMPOTENCY_KEY_REQUIRED'; end if;
  if not exists(select 1 from public.currencies where code=p_currency_code) then raise exception 'INVALID_CURRENCY'; end if;

  v_payload:=jsonb_build_object(
    'merchant_id',p_merchant_id,'category',p_category,'amount',p_amount,
    'currency_code',p_currency_code,'note',p_note,'operation_type','expense.record'
  );
  v_hash:=encode(digest(v_payload::text,'sha256'),'hex');

  insert into public.transaction_operations(
    merchant_id,idempotency_key,operation_type,payload_hash,payload,status,actor_user_id,approval_id
  ) values(
    p_merchant_id,p_idempotency_key,'expense.record',v_hash,v_payload,'processing',v_user,p_approval_id
  )
  on conflict (merchant_id,idempotency_key) do nothing
  returning id into v_op;

  if v_op is null then
    select * into v_existing from public.transaction_operations
    where merchant_id=p_merchant_id and idempotency_key=p_idempotency_key for update;
    if v_existing.payload_hash<>v_hash then raise exception 'IDEMPOTENCY_PAYLOAD_MISMATCH'; end if;
    if v_existing.status='committed' then return v_existing.result; end if;
    raise exception 'IDEMPOTENCY_OPERATION_IN_PROGRESS';
  end if;

  if p_approval_id is not null then
    select * into v_approval from public.approval_requests where id=p_approval_id for update;
    if not found
       or v_approval.merchant_id<>p_merchant_id
       or v_approval.status<>'approved'
       or v_approval.consumed_at is not null
       or (v_approval.expires_at is not null and v_approval.expires_at<=now())
       or v_approval.payload_hash is distinct from v_hash then
      raise exception 'VALID_APPROVAL_REQUIRED';
    end if;
  end if;

  insert into public.expenses(
    merchant_id,category,amount,currency_code,note,created_by,idempotency_key
  ) values(
    p_merchant_id,p_category,p_amount,p_currency_code,p_note,v_user,p_idempotency_key
  ) returning id into v_expense;

  if p_approval_id is not null then
    update public.approval_requests set consumed_at=now(),operation_id=v_op where id=p_approval_id;
  end if;

  v_result:=jsonb_build_object(
    'operation_id',v_op,'expense_id',v_expense,'status','committed',
    'amount',p_amount,'currency_code',p_currency_code
  );

  update public.transaction_operations set status='committed',result=v_result,committed_at=now()
  where id=v_op;

  insert into public.audit_logs(
    merchant_id,action,entity_type,entity_id,payload,actor_user_id,actor_role,request_id,approval_id
  ) values(
    p_merchant_id,'expense.recorded','expense',v_expense,
    jsonb_build_object('operation_id',v_op,'payload_hash',v_hash,'amount',p_amount,'category',p_category),
    v_user,v_role,p_idempotency_key,p_approval_id
  );

  return v_result;
end;
$$;

revoke all on function public.record_expense(uuid,text,numeric,text,text,text,uuid) from public;
grant execute on function public.record_expense(uuid,text,numeric,text,text,text,uuid) to authenticated;

-- Controlled inventory adjustment; never edit stock_quantity directly.
create or replace function public.adjust_inventory(
  p_merchant_id uuid,
  p_product_id uuid,
  p_quantity_delta numeric,
  p_reason text,
  p_idempotency_key text,
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
  v_unit text;
  v_before numeric;
  v_after numeric;
  v_payload jsonb;
  v_hash text;
  v_op uuid;
  v_existing public.transaction_operations;
  v_approval public.approval_requests;
  v_movement uuid;
  v_result jsonb;
begin
  if v_user is null then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
  v_role:=public.current_merchant_role(p_merchant_id);
  if v_role is null or v_role not in ('owner','manager','inventory') then
    raise exception 'INVENTORY_ADJUSTMENT_FORBIDDEN' using errcode='42501';
  end if;
  if p_quantity_delta=0 then raise exception 'ZERO_ADJUSTMENT'; end if;
  if p_reason not in ('adjustment','expiry','opening') then raise exception 'INVALID_ADJUSTMENT_REASON'; end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key))<8 then raise exception 'IDEMPOTENCY_KEY_REQUIRED'; end if;

  select unit into v_unit from public.products
  where id=p_product_id and merchant_id=p_merchant_id and active=true;
  if not found then raise exception 'PRODUCT_TENANT_MISMATCH_OR_INACTIVE'; end if;

  v_payload:=jsonb_build_object(
    'merchant_id',p_merchant_id,'product_id',p_product_id,
    'quantity_delta',p_quantity_delta,'reason',p_reason,'operation_type','inventory.adjust'
  );
  v_hash:=encode(digest(v_payload::text,'sha256'),'hex');

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
    p_merchant_id,p_idempotency_key,'inventory.adjust',v_hash,v_payload,'processing',v_user,p_approval_id
  )
  on conflict (merchant_id,idempotency_key) do nothing
  returning id into v_op;

  if v_op is null then
    select * into v_existing from public.transaction_operations
    where merchant_id=p_merchant_id and idempotency_key=p_idempotency_key for update;
    if v_existing.payload_hash<>v_hash then raise exception 'IDEMPOTENCY_PAYLOAD_MISMATCH'; end if;
    if v_existing.status='committed' then return v_existing.result; end if;
    raise exception 'IDEMPOTENCY_OPERATION_IN_PROGRESS';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_merchant_id::text||':'||p_product_id::text,0));
  v_before:=public.current_stock(p_merchant_id,p_product_id);
  v_after:=v_before+p_quantity_delta;
  if v_after<0 then raise exception 'ADJUSTMENT_WOULD_MAKE_STOCK_NEGATIVE'; end if;

  insert into public.inventory_movements(
    merchant_id,product_id,quantity_delta,unit,reason,reference_id,idempotency_key,created_by
  ) values(
    p_merchant_id,p_product_id,p_quantity_delta,v_unit,p_reason,v_op,p_idempotency_key,v_user
  ) returning id into v_movement;

  update public.approval_requests set consumed_at=now(),operation_id=v_op where id=p_approval_id;

  v_result:=jsonb_build_object(
    'operation_id',v_op,'movement_id',v_movement,'status','committed',
    'stock_before',v_before,'stock_after',v_after,'quantity_delta',p_quantity_delta
  );

  update public.transaction_operations set status='committed',result=v_result,committed_at=now()
  where id=v_op;

  insert into public.audit_logs(
    merchant_id,action,entity_type,entity_id,payload,actor_user_id,actor_role,request_id,approval_id
  ) values(
    p_merchant_id,'inventory.adjusted','inventory_movement',v_movement,
    jsonb_build_object('operation_id',v_op,'payload_hash',v_hash,'stock_before',v_before,'stock_after',v_after),
    v_user,v_role,p_idempotency_key,p_approval_id
  );

  return v_result;
end;
$$;

revoke all on function public.adjust_inventory(uuid,uuid,numeric,text,text,uuid) from public;
grant execute on function public.adjust_inventory(uuid,uuid,numeric,text,text,uuid) to authenticated;
