-- Retained legacy RPC: owner execution must not bypass merchant membership.
create or replace function public.current_stock(target_merchant uuid, target_product uuid)
returns numeric language plpgsql stable security definer set search_path='' as $$
begin
 if not coalesce(public.is_merchant_member(target_merchant),false) then
  raise exception 'MERCHANT_ACCESS_DENIED' using errcode='42501';
 end if;
 return (select coalesce(sum(m.quantity_delta),0)::numeric
  from public.inventory_movements m
  where m.merchant_id=target_merchant and m.product_id=target_product);
end $$;
revoke all on function public.current_stock(uuid,uuid) from public;
grant execute on function public.current_stock(uuid,uuid) to authenticated;
