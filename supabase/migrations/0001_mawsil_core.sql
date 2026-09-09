create extension if not exists pgcrypto;

create table if not exists public.merchants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  currency_code text not null default 'YER',
  created_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  name text not null,
  sku text,
  unit text not null default 'piece',
  sale_price numeric(14,2) not null default 0,
  cost_price numeric(14,2) not null default 0,
  stock_quantity numeric(14,3) not null default 0,
  reorder_level numeric(14,3) not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  name text not null,
  phone text,
  balance numeric(14,2) not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  name text not null,
  phone text,
  balance numeric(14,2) not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  total numeric(14,2) not null default 0,
  paid numeric(14,2) not null default 0,
  status text not null default 'completed',
  created_at timestamptz not null default now()
);

create table if not exists public.sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  quantity numeric(14,3) not null,
  unit_price numeric(14,2) not null,
  line_total numeric(14,2) generated always as (quantity * unit_price) stored
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  action text not null,
  entity_type text,
  entity_id uuid,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists products_merchant_idx on public.products(merchant_id);
create index if not exists customers_merchant_idx on public.customers(merchant_id);
create index if not exists suppliers_merchant_idx on public.suppliers(merchant_id);
create index if not exists sales_merchant_created_idx on public.sales(merchant_id, created_at desc);
create index if not exists audit_merchant_created_idx on public.audit_logs(merchant_id, created_at desc);
