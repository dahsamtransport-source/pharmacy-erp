-- Read-only account drilldown. Existing journal/account indexes are reused.
-- SECURITY INVOKER preserves RLS; no posting, approval or data mutation occurs.
create function ym_api.account_ledger(p_org uuid,p_account uuid,p_from date,p_to date,p_center uuid default null)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb; a ym.accounts%rowtype; o ym.organizations%rowtype;
begin
 if not ym_private.has_role(p_org,array['owner','manager','accountant']) then
  raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to)
  or p_from<date '1900-01-01' or p_to>date '9999-12-31' or p_from>p_to or p_to-p_from>366 then
  raise exception 'INVALID_REPORT_PERIOD'; end if;
 select * into a from ym.accounts where org_id=p_org and id=p_account and postable;
 if not found then raise exception 'LEDGER_ACCOUNT_UNAVAILABLE'; end if;
 select * into o from ym.organizations where id=p_org;
 if p_center is not null and not exists(select 1 from ym.cost_centers where org_id=p_org and id=p_center) then
  raise exception 'INVALID_REPORT_CENTER'; end if;
 if exists(select 1 from ym_api.ledger l where l.org_id=p_org and l.account_id=p_account
  and l.document_date<=p_to and (p_center is null or l.cost_center_id=p_center) and l.currency<>o.currency) then
  raise exception 'REPORT_CURRENCY_MISMATCH'; end if;

 with eligible as materialized (
  select l.journal_id,l.document_date,i.created_at,i.document_uuid,j.description,
   sum(l.debit) debit,sum(l.credit) credit
  from ym_api.ledger l
  join ym.journals j on j.org_id=l.org_id and j.id=l.journal_id
  join ym.invoices i on i.org_id=l.org_id and i.id=l.invoice_id
  where l.org_id=p_org and l.account_id=p_account and l.document_date<=p_to
   and (p_center is null or l.cost_center_id=p_center)
  group by l.journal_id,l.document_date,i.created_at,i.document_uuid,j.description
 ), totals as (
  select coalesce(sum(debit-credit) filter(where document_date<p_from),0) opening,
   coalesce(sum(debit) filter(where document_date>=p_from),0) debit,
   coalesce(sum(credit) filter(where document_date>=p_from),0) credit,
   coalesce(sum(debit-credit),0) closing,
   count(*) filter(where document_date>=p_from) count
  from eligible
 ), activity as (
  select e.*,(select opening from totals)+sum(e.debit-e.credit) over(
   order by e.document_date,e.created_at,e.journal_id rows between unbounded preceding and current row) balance
  from eligible e where document_date>=p_from
 )
 select case when t.count>1000 then jsonb_build_object('too_large',true) else jsonb_build_object(
  'org_id',p_org,'organization_name',o.name,'currency',o.currency,
  'account',jsonb_build_object('id',a.id,'code',a.code,'name',a.name,'kind',a.kind),
  'from',p_from,'to',p_to,'center_id',p_center,'generated_at',statement_timestamp(),
  'opening',t.opening::numeric(30,2)::text,'debit',t.debit::numeric(30,2)::text,
  'credit',t.credit::numeric(30,2)::text,'closing',t.closing::numeric(30,2)::text,'count',t.count,
  'entries',coalesce((select jsonb_agg(jsonb_build_object(
   'journal_id',e.journal_id,'document_uuid',e.document_uuid,'document_date',e.document_date,
   'description',e.description,'debit',e.debit::numeric(30,2)::text,'credit',e.credit::numeric(30,2)::text,
   'balance',e.balance::numeric(30,2)::text) order by e.document_date,e.created_at,e.journal_id) from activity e),'[]'::jsonb)
 ) end into result from totals t;
 if result ? 'too_large' then raise exception 'LEDGER_RANGE_TOO_LARGE'; end if;
 return result;
end $$;
revoke all on function ym_api.account_ledger(uuid,uuid,date,date,uuid) from public,anon,service_role;
grant execute on function ym_api.account_ledger(uuid,uuid,date,date,uuid) to authenticated;
