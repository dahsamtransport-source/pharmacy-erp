-- REVIEW BASELINE: install only in an empty disposable Supabase/PostgreSQL 15+ database.
-- Not a migration of the legacy public.* ledger. See README.md for cutover gates.
create schema ym;
create schema ym_private;
create schema ym_api;
revoke all on schema ym, ym_private, ym_api from public, anon, authenticated, service_role;
alter default privileges in schema ym revoke all on tables from public, anon, authenticated, service_role;
alter default privileges in schema ym_private revoke execute on functions from public, anon, authenticated, service_role;
alter default privileges in schema ym_api revoke execute on functions from public, anon, authenticated, service_role;

create table ym.organizations (
 id uuid primary key default gen_random_uuid(), name text not null check(length(name) between 1 and 200),
 currency text not null check(currency ~ '^[A-Z]{3}$'), timezone text not null default 'Asia/Aden'
);
create table ym.members (
 org_id uuid not null references ym.organizations, user_id uuid not null references auth.users,
 role text not null check(role in ('owner','manager','accountant','cashier','pharmacist','inventory')),
 active boolean not null default true, primary key(org_id,user_id)
);
create index members_user on ym.members(user_id,org_id) where active;
create table ym.cost_centers (
 org_id uuid not null references ym.organizations, id uuid not null default gen_random_uuid(),
 code text not null, name text not null, primary key(org_id,id), unique(org_id,code)
);
create table ym.warehouses (
 org_id uuid not null references ym.organizations, id uuid not null default gen_random_uuid(),
 name text not null, cost_center_id uuid not null, active boolean not null default true,
 primary key(org_id,id), foreign key(org_id,cost_center_id) references ym.cost_centers
);
create table ym.products (
 org_id uuid not null references ym.organizations, id uuid not null default gen_random_uuid(),
 sku text not null, trade_name text not null, scientific_name text, active_ingredient text,
 strength text, dosage_form text, manufacturer text, origin_country text, medical_category text,
 requires_prescription boolean not null default false, controlled boolean not null default false,
 active boolean not null default true, primary key(org_id,id), unique(org_id,sku)
);
create table ym.drug_alternatives (
 org_id uuid not null, drug_id uuid not null, alternative_id uuid not null,
 reviewed_by uuid not null references auth.users, source text not null,
 primary key(org_id,drug_id,alternative_id), check(drug_id < alternative_id),
 foreign key(org_id,drug_id) references ym.products, foreign key(org_id,alternative_id) references ym.products
);
create table ym.units (
 org_id uuid not null, id uuid not null default gen_random_uuid(), product_id uuid not null,
 name text not null, factor bigint not null check(factor between 1 and 1000000), barcode text,
 selling_price numeric(18,2) not null check(selling_price between 0.01 and 100000000),
 active boolean not null default true, primary key(org_id,id), unique(org_id,product_id,name),
 unique(org_id,barcode), foreign key(org_id,product_id) references ym.products
);
create table ym.reorder_rules (
 org_id uuid not null, warehouse_id uuid not null, product_id uuid not null,
 minimum bigint not null check(minimum >= 0), target bigint not null check(target >= minimum),
 primary key(org_id,warehouse_id,product_id), foreign key(org_id,warehouse_id) references ym.warehouses,
 foreign key(org_id,product_id) references ym.products
);
create table ym.batches (
 org_id uuid not null, id uuid not null default gen_random_uuid(), warehouse_id uuid not null,
 product_id uuid not null, batch_number text not null check(length(batch_number) between 1 and 100),
 expiry_date date not null, quantity bigint not null default 0 check(quantity >= 0),
 reserved bigint not null default 0 check(reserved >= 0 and reserved <= quantity),
 status text not null default 'available' check(status in ('available','quarantine','recalled')),
 primary key(org_id,id), unique(org_id,warehouse_id,product_id,batch_number),
 foreign key(org_id,warehouse_id) references ym.warehouses, foreign key(org_id,product_id) references ym.products
);
create index batches_fefo on ym.batches(org_id,warehouse_id,product_id,expiry_date,id)
 where status='available' and quantity>0;
-- Cost data has its own RLS boundary. No cost column in cashier-readable batches/products.
create table ym.valuations (
 org_id uuid not null, warehouse_id uuid not null, product_id uuid not null,
 quantity bigint not null default 0 check(quantity >= 0),
 inventory_value numeric(18,2) not null default 0 check(inventory_value >= 0),
 primary key(org_id,warehouse_id,product_id), check(quantity > 0 or inventory_value=0),
 foreign key(org_id,warehouse_id) references ym.warehouses, foreign key(org_id,product_id) references ym.products
);
create table ym.parties (
 org_id uuid not null references ym.organizations, id uuid not null default gen_random_uuid(),
 name text not null, kind text not null check(kind in ('customer','supplier','insurer')),
 active boolean not null default true, primary key(org_id,id)
);
create table ym.accounts (
 org_id uuid not null references ym.organizations, id uuid not null default gen_random_uuid(),
 code text not null, name text not null, parent_id uuid,
 kind text not null check(kind in ('asset','liability','equity','income','expense')),
 postable boolean not null default true, active boolean not null default true,
 primary key(org_id,id), unique(org_id,code), check(id is distinct from parent_id),
 foreign key(org_id,parent_id) references ym.accounts
);
create index accounts_parent on ym.accounts(org_id,parent_id);
create table ym.account_mappings (
 org_id uuid not null references ym.organizations,
 purpose text not null check(purpose in ('cash','bank','inventory','cogs','revenue','payables','insurance_receivable')),
 account_id uuid not null, primary key(org_id,purpose), foreign key(org_id,account_id) references ym.accounts
);
create table ym.periods (
 org_id uuid not null references ym.organizations, month date not null check(extract(day from month)=1),
 closed boolean not null default false, primary key(org_id,month)
);
create table ym.invoices (
 org_id uuid not null, id uuid not null default gen_random_uuid(), document_uuid uuid not null,
 kind text not null check(kind in ('sale','purchase')), warehouse_id uuid not null, party_id uuid,
 supplier_reference text, actor_id uuid not null references auth.users,
 currency text not null, document_date date not null, created_at timestamptz not null default clock_timestamp(),
 payment_method text not null check(payment_method in ('cash','bank','insurance','credit_purchase')),
 total numeric(18,2) not null check(total>0), patient_due numeric(18,2),
 primary key(org_id,id), unique(org_id,document_uuid), unique(document_uuid),
 foreign key(org_id,warehouse_id) references ym.warehouses, foreign key(org_id,party_id) references ym.parties,
 check((kind='purchase' and party_id is not null and supplier_reference is not null and payment_method='credit_purchase')
    or (kind='sale' and supplier_reference is null and payment_method <> 'credit_purchase')),
 check(patient_due is null or patient_due between 0 and total)
);
create unique index purchase_supplier_duplicate on ym.invoices(org_id,party_id,lower(btrim(supplier_reference))) where kind='purchase';
create index invoices_date on ym.invoices(org_id,document_date,kind);
create index invoices_actor on ym.invoices(org_id,actor_id,created_at);
create table ym.invoice_lines (
 org_id uuid not null, id uuid not null default gen_random_uuid(), invoice_id uuid not null,
 product_id uuid not null, unit_id uuid not null, quantity bigint not null check(quantity>0),
 factor bigint not null check(factor>0), base_quantity bigint not null check(base_quantity=quantity*factor),
 unit_price numeric(18,4) not null check(unit_price>=0), line_total numeric(18,2) not null check(line_total>=0),
 primary key(org_id,id), foreign key(org_id,invoice_id) references ym.invoices,
 foreign key(org_id,product_id) references ym.products, foreign key(org_id,unit_id) references ym.units
);
create index invoice_lines_invoice on ym.invoice_lines(org_id,invoice_id);
create table ym.allocations (
 org_id uuid not null, line_id uuid not null, batch_id uuid not null, quantity bigint not null check(quantity>0),
 primary key(org_id,line_id,batch_id), foreign key(org_id,line_id) references ym.invoice_lines,
 foreign key(org_id,batch_id) references ym.batches
);
create index allocations_batch on ym.allocations(org_id,batch_id);
create table ym.movements (
 org_id uuid not null, id uuid not null default gen_random_uuid(), batch_id uuid not null, line_id uuid not null,
 quantity_delta bigint not null check(quantity_delta<>0), created_at timestamptz not null default clock_timestamp(),
 primary key(org_id,id), unique(org_id,line_id,batch_id),
 foreign key(org_id,batch_id) references ym.batches, foreign key(org_id,line_id) references ym.invoice_lines
);
create index movements_batch on ym.movements(org_id,batch_id,created_at);
create table ym.journals (
 org_id uuid not null, id uuid not null default gen_random_uuid(), invoice_id uuid not null,
 document_date date not null, period_month date not null, currency text not null, cost_center_id uuid not null,
 status text not null default 'draft' check(status in ('draft','posted')),
 description text not null, primary key(org_id,id), unique(org_id,invoice_id),
 foreign key(org_id,invoice_id) references ym.invoices, foreign key(org_id,period_month) references ym.periods,
 foreign key(org_id,cost_center_id) references ym.cost_centers,
 check(period_month=date_trunc('month',document_date::timestamp)::date)
);
create index journals_date on ym.journals(org_id,document_date,cost_center_id);
create table ym.journal_lines (
 org_id uuid not null, id uuid not null default gen_random_uuid(), journal_id uuid not null, account_id uuid not null,
 debit numeric(18,2) not null default 0, credit numeric(18,2) not null default 0,
 primary key(org_id,id), check((debit>0 and credit=0) or (credit>0 and debit=0)),
 foreign key(org_id,journal_id) references ym.journals, foreign key(org_id,account_id) references ym.accounts
);
create index journal_lines_journal on ym.journal_lines(org_id,journal_id);
create index journal_lines_account on ym.journal_lines(org_id,account_id,journal_id);
create table ym.operations (
 org_id uuid not null references ym.organizations, request_id uuid not null,
 actor_id uuid not null references auth.users, kind text not null, payload jsonb not null,
 result_id uuid, primary key(org_id,request_id)
);
create table ym.reservations (
 org_id uuid not null, id uuid not null default gen_random_uuid(), warehouse_id uuid not null,
 actor_id uuid not null references auth.users, items jsonb not null,
 status text not null default 'held' check(status in ('held','fulfilled','cancelled','expired')),
 expires_at timestamptz not null, created_at timestamptz not null default clock_timestamp(),
 primary key(org_id,id), foreign key(org_id,warehouse_id) references ym.warehouses
);
create index reservations_expiry on ym.reservations(org_id,expires_at) where status='held';
create table ym.reservation_allocations (
 org_id uuid not null, reservation_id uuid not null, batch_id uuid not null, quantity bigint not null check(quantity>0),
 primary key(org_id,reservation_id,batch_id), foreign key(org_id,reservation_id) references ym.reservations,
 foreign key(org_id,batch_id) references ym.batches
);
create table ym.insurance_policies (
 org_id uuid not null, id uuid not null default gen_random_uuid(), insurer_id uuid not null,
 name text not null, copay_bps integer not null check(copay_bps between 0 and 10000),
 requires_approval_above numeric(18,2) check(requires_approval_above>=0), active boolean not null default true,
 primary key(org_id,id), foreign key(org_id,insurer_id) references ym.parties
);
create table ym.insurance_exclusions (
 org_id uuid not null, policy_id uuid not null, product_id uuid not null, primary key(org_id,policy_id,product_id),
 foreign key(org_id,policy_id) references ym.insurance_policies, foreign key(org_id,product_id) references ym.products
);
create table ym.enrollments (
 org_id uuid not null, id uuid not null default gen_random_uuid(), policy_id uuid not null, patient_id uuid not null,
 valid_from date not null, valid_to date not null, coverage_limit numeric(18,2) not null check(coverage_limit>0),
 primary key(org_id,id), check(valid_to>=valid_from),
 foreign key(org_id,policy_id) references ym.insurance_policies, foreign key(org_id,patient_id) references ym.parties
);
create table ym.insurance_approvals (
 org_id uuid not null, enrollment_id uuid not null, request_id uuid not null,
 approval_number text not null check(length(approval_number)>0), approved_amount numeric(18,2) not null check(approved_amount>0),
 valid_until timestamptz not null, verified_by uuid not null references auth.users,
 primary key(org_id,enrollment_id,request_id), foreign key(org_id,enrollment_id) references ym.enrollments
);
create table ym.claims (
 org_id uuid not null, id uuid not null default gen_random_uuid(), invoice_id uuid not null, enrollment_id uuid not null,
 patient_due numeric(18,2) not null check(patient_due>=0), claim_amount numeric(18,2) not null check(claim_amount>0),
 status text not null default 'pending' check(status in ('pending','submitted','rejected','paid')),
 primary key(org_id,id), unique(org_id,invoice_id), foreign key(org_id,invoice_id) references ym.invoices,
 foreign key(org_id,enrollment_id) references ym.enrollments
);
create index claims_enrollment on ym.claims(org_id,enrollment_id);
create table ym.drug_interactions (
 org_id uuid not null, drug_a_id uuid not null, drug_b_id uuid not null,
 severity text not null check(severity in ('major','moderate','minor')), description text not null,
 source_uri text not null, source_version text not null, reviewed_by uuid not null references auth.users,
 reviewed_at timestamptz not null, primary key(org_id,drug_a_id,drug_b_id), check(drug_a_id<drug_b_id),
 foreign key(org_id,drug_a_id) references ym.products, foreign key(org_id,drug_b_id) references ym.products
);
create table ym.prescription_reviews (
 org_id uuid not null references ym.organizations, request_id uuid not null, warehouse_id uuid not null,
 items jsonb not null, pharmacist_id uuid not null references auth.users, valid_until timestamptz not null,
 document_reference text not null check(length(document_reference)>0), primary key(org_id,request_id),
 foreign key(org_id,warehouse_id) references ym.warehouses
);
create table ym.audit_events (
 org_id uuid not null references ym.organizations, id bigint generated always as identity,
 actor_id uuid references auth.users, action text not null, entity_id uuid, details jsonb not null default '{}',
 occurred_at timestamptz not null default clock_timestamp(), primary key(org_id,id)
);
create index audit_time on ym.audit_events(org_id,occurred_at);
create table ym.outbox (
 org_id uuid not null, document_uuid uuid not null, invoice_id uuid not null, payload jsonb not null,
 status text not null default 'pending' check(status in ('pending','lookup_required','confirmed','failed')),
 attempts integer not null default 0 check(attempts>=0), external_id text,
 created_at timestamptz not null default clock_timestamp(), primary key(org_id,document_uuid),
 unique(org_id,invoice_id), foreign key(org_id,invoice_id) references ym.invoices
);
create index outbox_pending on ym.outbox(created_at) where status in ('pending','lookup_required');

-- Role membership comes from protected rows, never user-editable JWT metadata.
create function ym_private.has_role(p_org uuid, p_roles text[]) returns boolean
language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and exists(select 1 from ym.members
 where org_id=p_org and user_id=(select auth.uid()) and active and role=any(p_roles));
$$;
create function ym_private.require_role(p_org uuid,p_roles text[]) returns void
language plpgsql security definer set search_path='' as $$
begin
 if not ym_private.has_role(p_org,p_roles) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 -- Coarse, intentionally conservative single-organization serialization. All mutating
 -- RPCs take this lock before reading mutable catalog, periods, stock, or coverage.
 perform pg_advisory_xact_lock(hashtextextended(p_org::text,0));
end $$;
create function ym_private.business_date(p_org uuid) returns date
language sql stable set search_path='' as $$
 select (statement_timestamp() at time zone timezone)::date from ym.organizations where id=p_org;
$$;
create function ym_private.immutable() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'IMMUTABLE_RECORD' using errcode='42501'; end $$;
create function ym_private.balance_check() returns trigger language plpgsql set search_path='' as $$
declare j ym.journals; n integer; d numeric; c numeric;
begin
 if tg_table_name='journals' then j:=new;
 else select * into j from ym.journals where org_id=new.org_id and id=new.journal_id; end if;
 select * into j from ym.journals where org_id=j.org_id and id=j.id;
 select count(*),coalesce(sum(debit),0),coalesce(sum(credit),0) into n,d,c
 from ym.journal_lines where org_id=j.org_id and journal_id=j.id;
 if j.status<>'posted' or n<2 or d<>c then raise exception 'UNBALANCED_OR_UNPOSTED_JOURNAL'; end if;
 return null;
end $$;
create constraint trigger journal_balance after insert or update on ym.journals
 deferrable initially deferred for each row execute function ym_private.balance_check();
create constraint trigger line_balance after insert on ym.journal_lines
 deferrable initially deferred for each row execute function ym_private.balance_check();
create function ym_private.journal_guard() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_table_name='journal_lines' then
  if (select status from ym.journals where org_id=new.org_id and id=new.journal_id)<>'draft'
  then raise exception 'POSTED_JOURNAL_IMMUTABLE'; end if;
  if not exists(select 1 from ym.accounts where org_id=new.org_id and id=new.account_id and active and postable)
  then raise exception 'ACCOUNT_NOT_POSTABLE'; end if;
 else
  if tg_op='UPDATE' and (old.status<>'draft' or new.status<>'posted' or
   (to_jsonb(new)-'status')<>(to_jsonb(old)-'status')) then raise exception 'POSTED_JOURNAL_IMMUTABLE'; end if;
  if exists(select 1 from ym.periods where org_id=new.org_id and month=new.period_month and closed)
  then raise exception 'PERIOD_CLOSED'; end if;
 end if; return new;
end $$;
create trigger journal_guard before insert or update on ym.journals for each row execute function ym_private.journal_guard();
create trigger journal_no_delete before delete on ym.journals for each row execute function ym_private.immutable();
create trigger journal_line_guard before insert on ym.journal_lines for each row execute function ym_private.journal_guard();
create trigger journal_line_no_change before update or delete on ym.journal_lines for each row execute function ym_private.immutable();
-- No application role, including owner, can rewrite these historical records.
do $$ declare t text; begin
 foreach t in array array['invoices','invoice_lines','allocations','movements','audit_events','prescription_reviews','insurance_approvals'] loop
  execute format('create trigger immutable_row before update or delete on ym.%I for each row execute function ym_private.immutable()',t);
 end loop;
end $$;
-- Secondary paths used by supplier statements, product traces and retention checks.
create index invoices_party on ym.invoices(org_id,party_id,document_date);
create index invoices_warehouse on ym.invoices(org_id,warehouse_id,document_date);
create index invoice_lines_product on ym.invoice_lines(org_id,product_id,invoice_id);
create index invoice_lines_unit on ym.invoice_lines(org_id,unit_id);
create index units_product on ym.units(org_id,product_id);
create index reservations_warehouse on ym.reservations(org_id,warehouse_id);
create index reservation_allocations_batch on ym.reservation_allocations(org_id,batch_id);
create index enrollments_patient on ym.enrollments(org_id,patient_id,valid_to);
create index enrollments_policy on ym.enrollments(org_id,policy_id);
create index insurance_policies_insurer on ym.insurance_policies(org_id,insurer_id);
create index insurance_exclusions_product on ym.insurance_exclusions(org_id,product_id);
create index drug_interactions_reverse on ym.drug_interactions(org_id,drug_b_id);
create index drug_alternatives_reverse on ym.drug_alternatives(org_id,alternative_id);
