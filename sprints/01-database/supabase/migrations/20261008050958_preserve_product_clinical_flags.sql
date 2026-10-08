-- A metadata-only update must not remove dispensing restrictions.
-- NULL means preserve on update; new products retain the existing false defaults.
create or replace function ym_private.save_product(p_org uuid,p_id uuid,p_sku text,p_name text,p_requires_prescription boolean default null,p_controlled boolean default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare result uuid:=coalesce(p_id,gen_random_uuid());
begin
 perform ym_private.require_role(p_org,array['owner','manager','inventory']);
 if coalesce(length(btrim(p_sku)),0) not between 1 and 100 or coalesce(length(btrim(p_name)),0) not between 1 and 200 then raise exception 'INVALID_PRODUCT'; end if;
 insert into ym.products as existing(org_id,id,sku,trade_name,requires_prescription,controlled)
 values(p_org,result,btrim(p_sku),btrim(p_name),coalesce(p_requires_prescription,false),coalesce(p_controlled,false))
 on conflict(org_id,id) do update set sku=excluded.sku,trade_name=excluded.trade_name,
 requires_prescription=coalesce(p_requires_prescription,existing.requires_prescription),
 controlled=coalesce(p_controlled,existing.controlled);
 insert into ym.audit_events(org_id,actor_id,action,entity_id) values(p_org,auth.uid(),'product.saved',result);
 return result;
end $$;
create or replace function ym_api.save_product(p_org uuid,p_id uuid,p_sku text,p_name text,p_requires_prescription boolean default null,p_controlled boolean default null)
returns uuid language sql security invoker set search_path='' as $$ select ym_private.save_product(p_org,p_id,p_sku,p_name,p_requires_prescription,p_controlled); $$;
