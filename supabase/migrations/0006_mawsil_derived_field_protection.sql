-- Mawsil derived-field protection
-- Use PostgreSQL column privileges rather than trigger identity heuristics.
-- SECURITY DEFINER transaction RPCs can maintain derived balances; authenticated
-- clients can edit profile/catalog fields but cannot forge balances or stock.

drop trigger if exists customer_balance_guard on public.customers;
drop function if exists public.prevent_customer_balance_tamper();

drop trigger if exists supplier_balance_guard on public.suppliers;
drop function if exists public.prevent_supplier_balance_tamper();

-- Customers: balance is derived from committed sales/payments.
revoke insert, update on public.customers from authenticated;
grant insert (merchant_id,name,phone,credit_limit) on public.customers to authenticated;
grant update (name,phone,credit_limit) on public.customers to authenticated;

-- Suppliers: balance is derived from committed purchases/payments.
revoke insert, update, delete on public.suppliers from authenticated;
grant insert (merchant_id,name,phone) on public.suppliers to authenticated;
grant update (name,phone) on public.suppliers to authenticated;

drop policy if exists suppliers_tenant_access on public.suppliers;
drop policy if exists suppliers_read on public.suppliers;
drop policy if exists suppliers_insert on public.suppliers;
drop policy if exists suppliers_update on public.suppliers;
drop policy if exists suppliers_delete on public.suppliers;

create policy suppliers_read on public.suppliers
for select to authenticated
using ((select public.is_merchant_member(merchant_id)));

create policy suppliers_insert on public.suppliers
for insert to authenticated
with check ((select public.has_merchant_role(merchant_id,array['owner','manager','inventory'])));

create policy suppliers_update on public.suppliers
for update to authenticated
using ((select public.has_merchant_role(merchant_id,array['owner','manager','inventory'])))
with check ((select public.has_merchant_role(merchant_id,array['owner','manager','inventory'])));

create policy suppliers_delete on public.suppliers
for delete to authenticated
using ((select public.has_merchant_role(merchant_id,array['owner','manager'])));

-- Products: stock_quantity is legacy/cache only and must never be client-authored.
-- Inventory truth is SUM(inventory_movements.quantity_delta).
revoke insert, update on public.products from authenticated;
grant insert (
  merchant_id,name,sku,unit,sale_price,cost_price,reorder_level,barcode,active,semantic_tags
) on public.products to authenticated;
grant update (
  name,sku,unit,sale_price,cost_price,reorder_level,barcode,active,semantic_tags
) on public.products to authenticated;

comment on column public.products.stock_quantity is
  'Deprecated derived/cache field. Inventory source of truth is inventory_movements; authenticated clients have no write privilege.';

comment on column public.customers.balance is
  'Derived debt balance maintained only by Transaction Engine SECURITY DEFINER RPCs.';

comment on column public.suppliers.balance is
  'Derived supplier balance maintained only by Transaction Engine SECURITY DEFINER RPCs.';
