-- Sprint 5: read-only financial statements over the existing posted ledger.
-- The old financial_report RPC remains available for older clients.
-- No public-schema SECURITY DEFINER endpoint or financial write path is added.

create index journals_posted_center_date
  on ym.journals(org_id, cost_center_id, document_date, id)
  where status = 'posted';

create function ym_api.financial_report_options(p_org uuid)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
begin
  if not ym_private.has_role(p_org, array['owner','manager','accountant']) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'code', c.code, 'name', c.name)
      order by c.code, c.id), '[]'::jsonb)
    from ym.cost_centers c where c.org_id = p_org
  );
end $$;

create function ym_api.financial_report_v2(
  p_org uuid, p_from date, p_to date,
  p_center uuid default null, p_include_zero boolean default false
) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  organization ym.organizations;
  center jsonb := null;
  result jsonb;
  journal_count bigint;
begin
  if not ym_private.has_role(p_org, array['owner','manager','accountant']) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to)
     or p_from < date '1900-01-01' or p_to > date '9999-12-31'
     or p_to < p_from or p_to - p_from > 366 or p_include_zero is null then
    raise exception 'INVALID_REPORT_PERIOD';
  end if;

  select * into strict organization from ym.organizations o where o.id = p_org;
  if not exists (
    select 1 from ym.account_mappings m join ym.accounts a
      on a.org_id = m.org_id and a.id = m.account_id
    where m.org_id = p_org and m.purpose = 'cogs' and a.kind = 'expense' and a.postable
  ) then raise exception 'REPORT_ACCOUNT_MAPPING_REQUIRED'; end if;
  if p_center is not null then
    select jsonb_build_object('id', c.id, 'code', c.code, 'name', c.name) into center
      from ym.cost_centers c where c.org_id = p_org and c.id = p_center;
    if center is null then raise exception 'INVALID_REPORT_CENTER'; end if;
  end if;

  -- Never silently combine currencies or omit an inconsistent posted journal.
  if exists (
    select 1 from ym.journals j where j.org_id = p_org and j.status = 'posted'
      and j.document_date <= p_to and (p_center is null or j.cost_center_id = p_center)
      and j.currency <> organization.currency
  ) then raise exception 'REPORT_CURRENCY_MISMATCH'; end if;

  select count(*) into journal_count from ym.journals j
    where j.org_id = p_org and j.status = 'posted'
      and j.document_date between p_from and p_to
      and (p_center is null or j.cost_center_id = p_center);

  -- document_date is a business date, set by the posting RPC in the org timezone.
  -- Inclusive date comparisons include the entire last day without UTC 23:59:59 gaps.
  with balances as materialized (
    select a.id, a.code, a.name, a.kind,
      coalesce(a.id = (select m.account_id from ym.account_mappings m
        where m.org_id = p_org and m.purpose = 'cogs'), false) as is_cogs,
      coalesce(sum(l.debit - l.credit) filter (where l.document_date < p_from), 0) as opening,
      coalesce(sum(l.debit) filter (where l.document_date >= p_from), 0) as debit,
      coalesce(sum(l.credit) filter (where l.document_date >= p_from), 0) as credit,
      coalesce(sum(l.debit - l.credit), 0) as closing
    from ym.accounts a
    left join ym_api.ledger l on l.org_id = a.org_id and l.account_id = a.id
      and l.document_date <= p_to and (p_center is null or l.cost_center_id = p_center)
    where a.org_id = p_org and a.postable
    group by a.id, a.code, a.name, a.kind
  ), totals as (
    select
      coalesce(sum(greatest(opening, 0)), 0) od,
      coalesce(sum(greatest(-opening, 0)), 0) oc,
      coalesce(sum(debit), 0) d, coalesce(sum(credit), 0) c,
      coalesce(sum(greatest(closing, 0)), 0) cd,
      coalesce(sum(greatest(-closing, 0)), 0) cc,
      coalesce(bool_or(opening <> 0 or debit <> 0 or credit <> 0), false) has_data,
      coalesce(sum(credit - debit) filter (where kind = 'income'), 0) revenue,
      coalesce(sum(debit - credit) filter (where kind = 'expense' and is_cogs), 0) cogs,
      coalesce(sum(debit - credit) filter (where kind = 'expense' and not is_cogs), 0) expenses
    from balances
  ) select jsonb_build_object(
    'org_id', p_org, 'organization', organization.name,
    'currency', organization.currency, 'timezone', organization.timezone,
    'from', p_from, 'to', p_to, 'cost_center', center,
    'generated_at', statement_timestamp(), 'include_zero', p_include_zero,
    'posted_journal_count', journal_count,
    'accounts', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', b.id, 'code', b.code, 'name', b.name, 'kind', b.kind, 'is_cogs', b.is_cogs,
        'opening', round(b.opening, 2)::text,
        'opening_debit', round(greatest(b.opening, 0), 2)::text,
        'opening_credit', round(greatest(-b.opening, 0), 2)::text,
        'debit', round(b.debit, 2)::text, 'credit', round(b.credit, 2)::text,
        'closing', round(b.closing, 2)::text,
        'closing_debit', round(greatest(b.closing, 0), 2)::text,
        'closing_credit', round(greatest(-b.closing, 0), 2)::text,
        'normal_balance', round(case when b.kind in ('asset','expense') then b.closing else -b.closing end, 2)::text
      ) order by b.code, b.id), '[]'::jsonb) from balances b
      where p_include_zero or b.opening <> 0 or b.debit <> 0 or b.credit <> 0
    ),
    'totals', jsonb_build_object(
      'opening_debit', round(t.od, 2)::text, 'opening_credit', round(t.oc, 2)::text,
      'debit', round(t.d, 2)::text, 'credit', round(t.c, 2)::text,
      'closing_debit', round(t.cd, 2)::text, 'closing_credit', round(t.cc, 2)::text,
      'balanced', t.od = t.oc and t.d = t.c and t.cd = t.cc, 'has_data', t.has_data
    ),
    'income', jsonb_build_object(
      'revenue', round(t.revenue, 2)::text, 'cost_of_sales', round(t.cogs, 2)::text,
      'operating_expenses', round(t.expenses, 2)::text,
      'gross_profit', round(t.revenue - t.cogs, 2)::text,
      'net_income', round(t.revenue - t.cogs - t.expenses, 2)::text
    )
  ) into result from totals t;
  return result;
end $$;

revoke execute on function ym_api.financial_report_options(uuid),
  ym_api.financial_report_v2(uuid,date,date,uuid,boolean) from public, anon, service_role;
grant execute on function ym_api.financial_report_options(uuid),
  ym_api.financial_report_v2(uuid,date,date,uuid,boolean) to authenticated;
