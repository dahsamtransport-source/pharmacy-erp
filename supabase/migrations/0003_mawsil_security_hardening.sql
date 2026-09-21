-- Mawsil security hardening: move sensitive mutations from member-level access to role-aware access.

create or replace function public.is_merchant_member(target_merchant uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.merchant_members m
    where m.merchant_id = target_merchant
      and m.user_id = (select auth.uid())
  );
$$;

create or replace function public.has_merchant_role(target_merchant uuid, allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.merchant_members m
    where m.merchant_id = target_merchant
      and m.user_id = (select auth.uid())
      and m.role = any(allowed_roles)
  );
$$;

-- Merchant profile and membership administration.
drop policy if exists merchant_self_access on public.merchants;
create policy merchant_read_access on public.merchants
for select to authenticated
using ((select public.is_merchant_member(id)));
create policy merchant_manage_access on public.merchants
for update to authenticated
using ((select public.has_merchant_role(id, array['owner','manager'])))
with check ((select public.has_merchant_role(id, array['owner','manager'])));

-- Products: all members can read; only inventory/management roles can mutate catalog data.
drop policy if exists products_tenant_access on public.products;
create policy products_read on public.products
for select to authenticated
using ((select public.is_merchant_member(merchant_id)));
create policy products_insert on public.products
for insert to authenticated
with check ((select public.has_merchant_role(merchant_id, array['owner','manager','inventory'])));
create policy products_update on public.products
for update to authenticated
using ((select public.has_merchant_role(merchant_id, array['owner','manager','inventory'])))
with check ((select public.has_merchant_role(merchant_id, array['owner','manager','inventory'])));
create policy products_delete on public.products
for delete to authenticated
using ((select public.has_merchant_role(merchant_id, array['owner','manager'])));

-- Customers remain readable to staff, but destructive changes require management.
drop policy if exists customers_tenant_access on public.customers;
create policy customers_read on public.customers
for select to authenticated
using ((select public.is_merchant_member(merchant_id)));
create policy customers_insert on public.customers
for insert to authenticated
with check ((select public.has_merchant_role(merchant_id, array['owner','manager','staff'])));
create policy customers_update on public.customers
for update to authenticated
using ((select public.has_merchant_role(merchant_id, array['owner','manager','staff'])))
with check ((select public.has_merchant_role(merchant_id, array['owner','manager','staff'])));
create policy customers_delete on public.customers
for delete to authenticated
using ((select public.has_merchant_role(merchant_id, array['owner','manager'])));

-- Sales: staff may create sales; only management may modify/delete existing sales.
drop policy if exists sales_tenant_access on public.sales;
create policy sales_read on public.sales
for select to authenticated
using ((select public.is_merchant_member(merchant_id)));
create policy sales_insert on public.sales
for insert to authenticated
with check ((select public.has_merchant_role(merchant_id, array['owner','manager','staff'])));
create policy sales_update on public.sales
for update to authenticated
using ((select public.has_merchant_role(merchant_id, array['owner','manager'])))
with check ((select public.has_merchant_role(merchant_id, array['owner','manager'])));
create policy sales_delete on public.sales
for delete to authenticated
using ((select public.has_merchant_role(merchant_id, array['owner','manager'])));

-- Inventory ledger: only inventory/management roles may write movements.
drop policy if exists inventory_tenant_access on public.inventory_movements;
create policy inventory_read on public.inventory_movements
for select to authenticated
using ((select public.is_merchant_member(merchant_id)));
create policy inventory_insert on public.inventory_movements
for insert to authenticated
with check ((select public.has_merchant_role(merchant_id, array['owner','manager','inventory'])));
create policy inventory_update on public.inventory_movements
for update to authenticated
using ((select public.has_merchant_role(merchant_id, array['owner','manager'])))
with check ((select public.has_merchant_role(merchant_id, array['owner','manager'])));
create policy inventory_delete on public.inventory_movements
for delete to authenticated
using ((select public.has_merchant_role(merchant_id, array['owner','manager'])));

-- Purchases and expenses are financial operations.
drop policy if exists purchases_tenant_access on public.purchases;
create policy purchases_read on public.purchases
for select to authenticated
using ((select public.is_merchant_member(merchant_id)));
create policy purchases_insert on public.purchases
for insert to authenticated
with check ((select public.has_merchant_role(merchant_id, array['owner','manager','inventory'])));
create policy purchases_update on public.purchases
for update to authenticated
using ((select public.has_merchant_role(merchant_id, array['owner','manager','inventory'])))
with check ((select public.has_merchant_role(merchant_id, array['owner','manager','inventory'])));
create policy purchases_delete on public.purchases
for delete to authenticated
using ((select public.has_merchant_role(merchant_id, array['owner','manager'])));

drop policy if exists expenses_tenant_access on public.expenses;
create policy expenses_read on public.expenses
for select to authenticated
using ((select public.is_merchant_member(merchant_id)));
create policy expenses_insert on public.expenses
for insert to authenticated
with check ((select public.has_merchant_role(merchant_id, array['owner','manager'])));
create policy expenses_update on public.expenses
for update to authenticated
using ((select public.has_merchant_role(merchant_id, array['owner','manager'])))
with check ((select public.has_merchant_role(merchant_id, array['owner','manager'])));
create policy expenses_delete on public.expenses
for delete to authenticated
using ((select public.has_merchant_role(merchant_id, array['owner','manager'])));

-- Customer payments can be recorded by sales staff, but account reconciliation remains management-only.
drop policy if exists payments_tenant_access on public.customer_payments;
create policy payments_read on public.customer_payments
for select to authenticated
using ((select public.is_merchant_member(merchant_id)));
create policy payments_insert on public.customer_payments
for insert to authenticated
with check ((select public.has_merchant_role(merchant_id, array['owner','manager','staff'])));
create policy payments_update on public.customer_payments
for update to authenticated
using ((select public.has_merchant_role(merchant_id, array['owner','manager'])))
with check ((select public.has_merchant_role(merchant_id, array['owner','manager'])));
create policy payments_delete on public.customer_payments
for delete to authenticated
using ((select public.has_merchant_role(merchant_id, array['owner','manager'])));

drop policy if exists accounts_tenant_access on public.financial_accounts;
create policy accounts_read on public.financial_accounts
for select to authenticated
using ((select public.is_merchant_member(merchant_id)));
create policy accounts_manage on public.financial_accounts
for all to authenticated
using ((select public.has_merchant_role(merchant_id, array['owner','manager'])))
with check ((select public.has_merchant_role(merchant_id, array['owner','manager'])));

drop policy if exists reconciliation_tenant_access on public.payment_reconciliations;
create policy reconciliation_read on public.payment_reconciliations
for select to authenticated
using ((select public.is_merchant_member(merchant_id)));
create policy reconciliation_manage on public.payment_reconciliations
for all to authenticated
using ((select public.has_merchant_role(merchant_id, array['owner','manager'])))
with check ((select public.has_merchant_role(merchant_id, array['owner','manager'])));

-- Audit logs are intentionally read-only through the authenticated Data API.
drop policy if exists audit_tenant_access on public.audit_logs;
create policy audit_read on public.audit_logs
for select to authenticated
using ((select public.is_merchant_member(merchant_id)));

-- Approval requests: members can see their merchant's queue; only management can review.
drop policy if exists approvals_tenant_access on public.approval_requests;
create policy approvals_read on public.approval_requests
for select to authenticated
using ((select public.is_merchant_member(merchant_id)));
create policy approvals_create on public.approval_requests
for insert to authenticated
with check ((select public.is_merchant_member(merchant_id)) and requested_by = (select auth.uid()));
create policy approvals_review on public.approval_requests
for update to authenticated
using ((select public.has_merchant_role(merchant_id, array['owner','manager'])))
with check ((select public.has_merchant_role(merchant_id, array['owner','manager'])));
