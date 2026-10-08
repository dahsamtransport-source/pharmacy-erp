-- Deferred triggers execute at COMMIT under the caller, after a SECURITY DEFINER
-- business RPC has returned. Cashier/inventory RLS intentionally hides journals;
-- applying that visibility filter to an integrity check falsely rejects valid posts.
-- This private trigger is an invariant check, not a data-access API. Keep RLS and
-- all caller grants unchanged; only its fixed aggregate reads use the owner context.
-- Existing deployments can have a newer definer implementation with financial
-- locks/role checks. This baseline repair must never replace that implementation.
do $migration$
begin
 if (select prosecdef from pg_proc where oid='ym_private.balance_check()'::regprocedure) then
  raise notice 'Existing definer balance guard retained; baseline repair not needed';
  return;
 end if;
 execute $ddl$
create or replace function ym_private.balance_check() returns trigger
language plpgsql security definer set search_path='' set row_security=off as $$
declare j ym.journals; target_org uuid; target_journal uuid; n bigint; d numeric; c numeric;
begin
 if tg_table_schema<>'ym' or tg_table_name not in ('journals','journal_lines') then
  raise exception 'INVALID_BALANCE_TRIGGER';
 end if;
 target_org:=new.org_id;
 if tg_table_name='journals' then target_journal:=new.id;
 else target_journal:=new.journal_id; end if;
 -- Always inspect final state, not the earlier draft image queued by the trigger.
 select * into j from ym.journals where org_id=target_org and id=target_journal;
 if not found or j.status is distinct from 'posted' then
  raise exception 'UNBALANCED_OR_UNPOSTED_JOURNAL';
 end if;
 select count(*),coalesce(sum(debit),0),coalesce(sum(credit),0) into n,d,c
 from ym.journal_lines where org_id=target_org and journal_id=target_journal;
 if n<2 or d<>c then raise exception 'UNBALANCED_OR_UNPOSTED_JOURNAL'; end if;
 return null;
end $$;
$ddl$;
revoke all on function ym_private.balance_check() from public,anon,authenticated,service_role;
comment on function ym_private.balance_check() is
 'Private deferred integrity trigger: reads complete journal at commit without granting journal visibility or mutation rights to callers.';
end $migration$;
