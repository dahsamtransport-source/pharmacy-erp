-- Shared admission budget across all web-server replicas. Contains no prompts.
create table ym_private.assistant_request_windows (
 scope text primary key,
 started_at timestamptz not null,
 requests integer not null check(requests between 0 and 20)
);
alter table ym_private.assistant_request_windows enable row level security;
revoke all on ym_private.assistant_request_windows from public,anon,authenticated,service_role;

create function ym_api.claim_assistant_budget(p_org uuid,p_warehouse uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); stamp timestamptz; actor_scope text; count_global integer; count_actor integer;
begin
 if actor is null or not exists(select 1 from ym.members where org_id=p_org and user_id=actor and active)
 or not exists(select 1 from ym.warehouses where org_id=p_org and id=p_warehouse and active) then
  raise exception 'FORBIDDEN' using errcode='42501';
 end if;
 -- One short transaction serializes both counters, including first insertion.
 perform pg_catalog.pg_advisory_xact_lock(8230617048229::bigint);
 stamp:=clock_timestamp(); actor_scope:='actor:'||actor::text;
 delete from ym_private.assistant_request_windows where started_at<stamp-interval '1 hour';
 insert into ym_private.assistant_request_windows(scope,started_at,requests)
 values('global',stamp,0),(actor_scope,stamp,0) on conflict(scope) do nothing;
 update ym_private.assistant_request_windows set started_at=stamp,requests=0
 where scope in ('global',actor_scope) and started_at<=stamp-interval '1 minute';
 select requests into count_global from ym_private.assistant_request_windows where scope='global';
 select requests into count_actor from ym_private.assistant_request_windows where scope=actor_scope;
 if count_global>=20 or count_actor>=6 then return false; end if;
 update ym_private.assistant_request_windows set requests=requests+1 where scope in ('global',actor_scope);
 return true;
end $$;
revoke all on function ym_api.claim_assistant_budget(uuid,uuid) from public,anon,service_role;
grant execute on function ym_api.claim_assistant_budget(uuid,uuid) to authenticated;
comment on function ym_api.claim_assistant_budget(uuid,uuid) is
 'Authenticated active workspace admission only: six per actor and twenty globally per sixty-second window. No business mutations or prompt storage.';
