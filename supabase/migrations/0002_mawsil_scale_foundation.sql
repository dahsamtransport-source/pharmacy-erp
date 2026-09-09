create table if not exists public.merchant_members (
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'staff' check (role in ('owner','manager','staff','inventory')),
  created_at timestamptz not null default now(),
  primary key (merchant_id, user_id)
);

create table if not exists public.currencies (
  code text primary key,
  name text not null,
  decimals smallint not null default 2 check (decimals between 0 and 6)
);
insert into public.currencies(code,name,decimals) values
  ('YER_OLD','Yemeni rial - old issue',2),
  ('YER_NEW','Yemeni rial - new issue',2),
  ('SAR','Saudi riyal',2),
  ('USD','US dollar',2)
on conflict (code) do nothing;

create table if not exists public.exchange_rates (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  base_currency text not null references public.currencies(code),
  quote_currency text not null references public.currencies(code),
  rate numeric(18,8) not null check (rate > 0),
  effective_at timestamptz not null default now(),
  source text not null default 'manual',
  created_at timestamptz not null default now()
);

create table if not exists public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  quantity_delta numeric(14,3) not null,
  unit text not null,
  reason text not null check (reason in ('sale','purchase','adjustment','return','transfer','expiry','opening')),
  reference_id uuid,
  idempotency_key text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (merchant_id, idempotency_key)
);

create table if not exists public.product_units (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  unit_name text not null,
  conversion_to_base numeric(14,6) not null check (conversion_to_base > 0),
  barcode text,
  unique (product_id, unit_name),
  unique (merchant_id, barcode)
);

create table if not exists public.product_batches (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  batch_number text,
  expiry_date date,
  quantity numeric(14,3) not null default 0,
  cost_price numeric(14,2) not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.purchases (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  supplier_id uuid references public.suppliers(id) on delete set null,
  currency_code text not null default 'YER_NEW' references public.currencies(code),
  total numeric(14,2) not null default 0,
  paid numeric(14,2) not null default 0,
  status text not null default 'received' check (status in ('draft','received','cancelled')),
  source_document_url text,
  idempotency_key text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (merchant_id, idempotency_key)
);

create table if not exists public.purchase_items (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references public.purchases(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  quantity numeric(14,3) not null check (quantity > 0),
  unit_price numeric(14,2) not null check (unit_price >= 0),
  discount numeric(14,2) not null default 0 check (discount >= 0)
);

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  category text not null,
  amount numeric(14,2) not null check (amount >= 0),
  currency_code text not null default 'YER_NEW' references public.currencies(code),
  note text,
  incurred_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  idempotency_key text,
  unique (merchant_id, idempotency_key)
);

create table if not exists public.customer_payments (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  amount numeric(14,2) not null check (amount > 0),
  currency_code text not null default 'YER_NEW' references public.currencies(code),
  exchange_rate numeric(18,8),
  method text not null default 'cash' check (method in ('cash','wallet','bank','other')),
  reference text,
  proof_url text,
  received_at timestamptz not null default now(),
  idempotency_key text not null,
  created_by uuid references auth.users(id),
  unique (merchant_id, idempotency_key)
);

create table if not exists public.financial_accounts (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  name text not null,
  account_type text not null check (account_type in ('cash','wallet','bank','other')),
  provider text,
  currency_code text not null default 'YER_NEW' references public.currencies(code),
  active boolean not null default true
);

create table if not exists public.payment_reconciliations (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  account_id uuid not null references public.financial_accounts(id) on delete cascade,
  external_reference text,
  amount numeric(14,2) not null,
  currency_code text not null references public.currencies(code),
  transaction_at timestamptz,
  raw_text text,
  proof_url text,
  matched_customer_id uuid references public.customers(id) on delete set null,
  status text not null default 'unmatched' check (status in ('unmatched','matched','ignored')),
  created_at timestamptz not null default now()
);

create table if not exists public.approval_requests (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  requested_by uuid references auth.users(id),
  action text not null,
  entity_type text,
  entity_id uuid,
  amount numeric(14,2),
  risk_level text not null default 'high' check (risk_level in ('medium','high','critical')),
  status text not null default 'pending' check (status in ('pending','approved','rejected','expired')),
  reason text,
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.offline_operations (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  idempotency_key text not null,
  operation_type text not null,
  payload jsonb not null,
  status text not null default 'queued' check (status in ('queued','processing','synced','failed')),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  synced_at timestamptz,
  unique (merchant_id, idempotency_key)
);

create table if not exists public.reorder_suggestions (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  suggested_quantity numeric(14,3) not null check (suggested_quantity > 0),
  reason jsonb not null default '{}'::jsonb,
  status text not null default 'draft' check (status in ('draft','approved','ordered','dismissed')),
  created_at timestamptz not null default now()
);

create table if not exists public.debt_reminders (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  channel text not null default 'whatsapp' check (channel in ('whatsapp','sms','manual')),
  scheduled_for timestamptz not null,
  sent_at timestamptz,
  status text not null default 'scheduled' check (status in ('scheduled','sent','failed','cancelled')),
  created_at timestamptz not null default now()
);

alter table public.customers add column if not exists credit_limit numeric(14,2) not null default 0;
alter table public.products add column if not exists barcode text;
alter table public.products add column if not exists active boolean not null default true;
alter table public.products add column if not exists semantic_tags text[] not null default '{}';
alter table public.sales add column if not exists currency_code text not null default 'YER_NEW' references public.currencies(code);
alter table public.sales add column if not exists exchange_rate numeric(18,8);
alter table public.sales add column if not exists idempotency_key text;
alter table public.sales add column if not exists created_by uuid references auth.users(id);

create unique index if not exists products_merchant_barcode_uq on public.products(merchant_id, barcode) where barcode is not null;
create index if not exists inventory_product_created_idx on public.inventory_movements(product_id, created_at desc);
create index if not exists batches_expiry_idx on public.product_batches(merchant_id, expiry_date);
create index if not exists purchases_merchant_created_idx on public.purchases(merchant_id, created_at desc);
create index if not exists expenses_merchant_date_idx on public.expenses(merchant_id, incurred_at desc);
create index if not exists payments_customer_date_idx on public.customer_payments(customer_id, received_at desc);
create index if not exists approvals_merchant_status_idx on public.approval_requests(merchant_id, status, created_at desc);
create index if not exists offline_status_idx on public.offline_operations(merchant_id, status, created_at);
create index if not exists reorder_status_idx on public.reorder_suggestions(merchant_id, status, created_at desc);

alter table public.merchants enable row level security;
alter table public.products enable row level security;
alter table public.customers enable row level security;
alter table public.suppliers enable row level security;
alter table public.sales enable row level security;
alter table public.sale_items enable row level security;
alter table public.audit_logs enable row level security;
alter table public.merchant_members enable row level security;
alter table public.exchange_rates enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.product_units enable row level security;
alter table public.product_batches enable row level security;
alter table public.purchases enable row level security;
alter table public.purchase_items enable row level security;
alter table public.expenses enable row level security;
alter table public.customer_payments enable row level security;
alter table public.financial_accounts enable row level security;
alter table public.payment_reconciliations enable row level security;
alter table public.approval_requests enable row level security;
alter table public.offline_operations enable row level security;
alter table public.reorder_suggestions enable row level security;
alter table public.debt_reminders enable row level security;

create or replace function public.is_merchant_member(target_merchant uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.merchant_members m where m.merchant_id = target_merchant and m.user_id = auth.uid()); $$;

create or replace function public.has_merchant_role(target_merchant uuid, allowed_roles text[])
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.merchant_members m where m.merchant_id = target_merchant and m.user_id = auth.uid() and m.role = any(allowed_roles)); $$;

create policy merchant_member_access on public.merchant_members for select to authenticated using (user_id = auth.uid());
create policy merchant_self_access on public.merchants for all to authenticated using (id in (select merchant_id from public.merchant_members where user_id = auth.uid())) with check (id in (select merchant_id from public.merchant_members where user_id = auth.uid()));

create policy products_tenant_access on public.products for all to authenticated using (public.is_merchant_member(merchant_id)) with check (public.is_merchant_member(merchant_id));
create policy customers_tenant_access on public.customers for all to authenticated using (public.is_merchant_member(merchant_id)) with check (public.is_merchant_member(merchant_id));
create policy suppliers_tenant_access on public.suppliers for all to authenticated using (public.is_merchant_member(merchant_id)) with check (public.is_merchant_member(merchant_id));
create policy sales_tenant_access on public.sales for all to authenticated using (public.is_merchant_member(merchant_id)) with check (public.is_merchant_member(merchant_id));
create policy audit_tenant_access on public.audit_logs for select to authenticated using (public.is_merchant_member(merchant_id));
create policy exchange_tenant_access on public.exchange_rates for all to authenticated using (public.is_merchant_member(merchant_id)) with check (public.is_merchant_member(merchant_id));
create policy inventory_tenant_access on public.inventory_movements for all to authenticated using (public.is_merchant_member(merchant_id)) with check (public.is_merchant_member(merchant_id));
create policy units_tenant_access on public.product_units for all to authenticated using (public.is_merchant_member(merchant_id)) with check (public.is_merchant_member(merchant_id));
create policy batches_tenant_access on public.product_batches for all to authenticated using (public.is_merchant_member(merchant_id)) with check (public.is_merchant_member(merchant_id));
create policy purchases_tenant_access on public.purchases for all to authenticated using (public.is_merchant_member(merchant_id)) with check (public.is_merchant_member(merchant_id));
create policy expenses_tenant_access on public.expenses for all to authenticated using (public.is_merchant_member(merchant_id)) with check (public.is_merchant_member(merchant_id));
create policy payments_tenant_access on public.customer_payments for all to authenticated using (public.is_merchant_member(merchant_id)) with check (public.is_merchant_member(merchant_id));
create policy accounts_tenant_access on public.financial_accounts for all to authenticated using (public.is_merchant_member(merchant_id)) with check (public.is_merchant_member(merchant_id));
create policy reconciliation_tenant_access on public.payment_reconciliations for all to authenticated using (public.is_merchant_member(merchant_id)) with check (public.is_merchant_member(merchant_id));
create policy approvals_tenant_access on public.approval_requests for all to authenticated using (public.is_merchant_member(merchant_id)) with check (public.is_merchant_member(merchant_id));
create policy offline_tenant_access on public.offline_operations for all to authenticated using (public.is_merchant_member(merchant_id)) with check (public.is_merchant_member(merchant_id));
create policy reorder_tenant_access on public.reorder_suggestions for all to authenticated using (public.is_merchant_member(merchant_id)) with check (public.is_merchant_member(merchant_id));
create policy reminders_tenant_access on public.debt_reminders for all to authenticated using (public.is_merchant_member(merchant_id)) with check (public.is_merchant_member(merchant_id));

create policy sale_items_tenant_access on public.sale_items for all to authenticated
using (exists (select 1 from public.sales s where s.id = sale_id and public.is_merchant_member(s.merchant_id)))
with check (exists (select 1 from public.sales s where s.id = sale_id and public.is_merchant_member(s.merchant_id)));
create policy purchase_items_tenant_access on public.purchase_items for all to authenticated
using (exists (select 1 from public.purchases p where p.id = purchase_id and public.is_merchant_member(p.merchant_id)))
with check (exists (select 1 from public.purchases p where p.id = purchase_id and public.is_merchant_member(p.merchant_id)));

create or replace function public.prevent_audit_mutation()
returns trigger language plpgsql as $$ begin raise exception 'audit_logs are immutable'; end; $$;
drop trigger if exists audit_logs_immutable on public.audit_logs;
create trigger audit_logs_immutable before update or delete on public.audit_logs for each row execute function public.prevent_audit_mutation();

create or replace function public.sync_sale_inventory()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into public.inventory_movements(merchant_id, product_id, quantity_delta, unit, reason, reference_id, idempotency_key, created_by)
    select s.merchant_id, i.product_id, -i.quantity, p.unit, 'sale', s.id, 'sale:' || s.id || ':item:' || i.id, s.created_by
    from public.sales s join public.products p on p.merchant_id=s.merchant_id join public.sale_items i on i.sale_id=s.id and i.product_id=p.id
    where s.id = new.sale_id;
  end if;
  return new;
end; $$;
drop trigger if exists sale_item_inventory_trigger on public.sale_items;
create trigger sale_item_inventory_trigger after insert on public.sale_items for each row execute function public.sync_sale_inventory();
