-- Sprint 2 read contracts. SECURITY INVOKER deliberately preserves Sprint 1 RLS.
create function ym_api.workspace_context() returns jsonb language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'name',o.name,'currency',o.currency,'timezone',o.timezone,'role',m.role,
 'warehouses',(select coalesce(jsonb_agg(jsonb_build_object('id',w.id,'name',w.name) order by w.name),'[]') from ym.warehouses w where w.org_id=o.id and w.active)) order by o.name),'[]')
 from ym.organizations o join ym.members m on m.org_id=o.id where m.user_id=(select auth.uid()) and m.active;
$$;
create function ym_api.dashboard_snapshot(p_org uuid,p_warehouse uuid) returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare d date; r text; sales_visible boolean; today_total numeric; yesterday_total numeric; series jsonb; recent jsonb; lows jsonb; expiries jsonb;
begin
 if not ym_private.has_role(p_org,array['owner','manager','accountant','cashier','pharmacist','inventory']) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if not exists(select 1 from ym.warehouses where org_id=p_org and id=p_warehouse and active) then raise exception 'WAREHOUSE_UNAVAILABLE'; end if;
 select (statement_timestamp() at time zone o.timezone)::date,m.role into d,r from ym.organizations o join ym.members m on m.org_id=o.id where o.id=p_org and m.user_id=auth.uid();
 sales_visible:=r<>'inventory';
 select coalesce(sum(total) filter(where document_date=d),0),coalesce(sum(total) filter(where document_date=d-1),0)
 into today_total,yesterday_total from ym.invoices where org_id=p_org and warehouse_id=p_warehouse and kind='sale' and document_date between d-1 and d;
 select jsonb_agg(jsonb_build_object('date',day::date,'total',case when sales_visible then amount::text else null end) order by day)
 into series from (select day,coalesce(sum(i.total),0) amount from generate_series((d-6)::timestamp,d::timestamp,interval '1 day') day
 left join ym.invoices i on i.org_id=p_org and i.warehouse_id=p_warehouse and i.kind='sale' and i.document_date=day::date group by day) q;
 select coalesce(jsonb_agg(to_jsonb(q)),'[]') into recent from (
 select id,document_uuid,kind,document_date,total::text total,currency from ym.invoices where org_id=p_org and warehouse_id=p_warehouse order by created_at desc,id limit 6) q;
 select coalesce(jsonb_agg(to_jsonb(q)),'[]') into lows from (select product_id,trade_name,available,minimum,target from ym_api.low_stock where org_id=p_org and warehouse_id=p_warehouse order by available,trade_name limit 6) q;
 select coalesce(jsonb_agg(to_jsonb(q)),'[]') into expiries from (select batch_id,trade_name,batch_number,expiry_date,quantity,expired,status from ym_api.expiring_soon where org_id=p_org and warehouse_id=p_warehouse order by expiry_date,batch_id limit 6) q;
 return jsonb_build_object('business_date',d,'scope',case when r in ('cashier','pharmacist') then 'mine' when r='inventory' then 'inventory' else 'organization' end,
 'today_total',case when sales_visible then today_total::text else null end,'yesterday_total',case when sales_visible then yesterday_total::text else null end,
 'expiring_count',(select count(*) from ym_api.expiring_soon where org_id=p_org and warehouse_id=p_warehouse and not expired),
 'expired_count',(select count(*) from ym_api.expiring_soon where org_id=p_org and warehouse_id=p_warehouse and expired),
 'low_stock_count',(select count(*) from ym_api.low_stock where org_id=p_org and warehouse_id=p_warehouse),
 'series',series,'recent',recent,'low_stock',lows,'expiring',expiries);
end $$;
create function ym_api.search_units(p_org uuid,p_warehouse uuid,p_search text default '',p_offset integer default 0) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
 if not ym_private.has_role(p_org,array['owner','manager','accountant','cashier','pharmacist','inventory']) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if p_search is null or length(p_search)>120 or p_offset is null or p_offset not between 0 and 10000 then raise exception 'INVALID_SEARCH'; end if;
 if not exists(select 1 from ym.warehouses where org_id=p_org and id=p_warehouse and active) then raise exception 'WAREHOUSE_UNAVAILABLE'; end if;
 select coalesce(jsonb_agg(to_jsonb(q)),'[]') into result from (
 select u.id unit_id,p.id product_id,p.trade_name,u.name unit_name,u.factor,u.barcode,u.selling_price::text selling_price,p.requires_prescription,p.controlled,
 coalesce((select sum(b.quantity-b.reserved) from ym.batches b where b.org_id=p_org and b.warehouse_id=p_warehouse and b.product_id=p.id and b.status='available'
 and b.expiry_date>(statement_timestamp() at time zone o.timezone)::date),0) available_base
 from ym.units u join ym.products p on p.org_id=u.org_id and p.id=u.product_id join ym.organizations o on o.id=u.org_id
 where u.org_id=p_org and u.active and p.active and (p_search='' or strpos(lower(p.trade_name),lower(p_search))>0
 or strpos(lower(coalesce(p.scientific_name,'')),lower(p_search))>0 or u.barcode=p_search or p.sku=p_search)
 order by (u.barcode=p_search) desc nulls last,p.trade_name,u.id limit 30 offset p_offset) q;
 return result;
end $$;
create function ym_api.supplier_options(p_org uuid) returns jsonb language plpgsql stable security invoker set search_path='' as $$
begin
 if not ym_private.has_role(p_org,array['owner','manager','inventory']) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 return (select coalesce(jsonb_agg(to_jsonb(q)),'[]') from (select id,name from ym.parties where org_id=p_org and kind='supplier' and active order by name limit 500) q);
end $$;
create function ym_api.inventory_page(p_org uuid,p_warehouse uuid,p_search text default '',p_offset integer default 0) returns jsonb language plpgsql stable security invoker set search_path='' as $$
begin
 if not ym_private.has_role(p_org,array['owner','manager','accountant','cashier','pharmacist','inventory']) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if p_search is null or length(p_search)>120 or p_offset is null or p_offset not between 0 and 10000 then raise exception 'INVALID_SEARCH'; end if;
 return (select coalesce(jsonb_agg(to_jsonb(q)),'[]') from (
 select b.id,p.trade_name,b.batch_number,b.expiry_date,b.quantity,b.reserved,b.status,
 b.expiry_date<=(statement_timestamp() at time zone o.timezone)::date expired
 from ym.batches b join ym.products p on p.org_id=b.org_id and p.id=b.product_id join ym.organizations o on o.id=b.org_id
 where b.org_id=p_org and b.warehouse_id=p_warehouse and (p_search='' or strpos(lower(p.trade_name),lower(p_search))>0 or strpos(lower(b.batch_number),lower(p_search))>0)
 order by b.expiry_date,b.id limit 30 offset p_offset) q);
end $$;
create function ym_api.invoice_receipt(p_org uuid,p_id uuid) returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare i ym.invoices; result jsonb;
begin
 select * into i from ym.invoices where org_id=p_org and id=p_id;
 if not found then raise exception 'INVOICE_NOT_FOUND'; end if;
 select jsonb_build_object('id',i.id,'document_uuid',i.document_uuid,'kind',i.kind,'document_date',i.document_date,'currency',i.currency,'total',i.total::text,
 'payment_method',i.payment_method,'organization',(select name from ym.organizations where id=p_org),
 'lines',(select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'trade_name',p.trade_name,'unit_name',u.name,'quantity',l.quantity,'unit_price',l.unit_price::text,'total',l.line_total::text) order by l.id),'[]')
 from ym.invoice_lines l join ym.products p on p.org_id=l.org_id and p.id=l.product_id join ym.units u on u.org_id=l.org_id and u.id=l.unit_id where l.org_id=p_org and l.invoice_id=p_id)) into result;
 return result;
end $$;
create function ym_api.receipt_by_request(p_org uuid,p_request uuid) returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result uuid;
begin
 if not ym_private.has_role(p_org,array['owner','manager','accountant','cashier','pharmacist','inventory']) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 select id into result from ym.invoices where org_id=p_org and document_uuid=p_request;
 if result is null then return null; end if;
 return ym_api.invoice_receipt(p_org,result);
end $$;
create function ym_api.financial_report(p_org uuid,p_from date,p_to date) returns jsonb language plpgsql stable security invoker set search_path='' as $$
begin
 if not ym_private.has_role(p_org,array['owner','manager','accountant']) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>366 then raise exception 'INVALID_PERIOD'; end if;
 return jsonb_build_object('from',p_from,'to',p_to,'accounts',(
 select coalesce(jsonb_agg(to_jsonb(q) order by q.code),'[]') from (
 select a.id,a.code,a.name,a.kind,
 coalesce(sum(l.debit-l.credit) filter(where l.document_date<p_from),0)::text opening,
 coalesce(sum(l.debit) filter(where l.document_date between p_from and p_to),0)::text debit,
 coalesce(sum(l.credit) filter(where l.document_date between p_from and p_to),0)::text credit,
 coalesce(sum(l.debit-l.credit),0)::text closing
 from ym.accounts a left join ym_api.ledger l on l.org_id=a.org_id and l.account_id=a.id and l.document_date<=p_to
 where a.org_id=p_org and a.postable group by a.id,a.code,a.name,a.kind) q));
end $$;
revoke execute on function ym_api.workspace_context(),ym_api.dashboard_snapshot(uuid,uuid),ym_api.search_units(uuid,uuid,text,integer),ym_api.supplier_options(uuid),ym_api.inventory_page(uuid,uuid,text,integer),ym_api.invoice_receipt(uuid,uuid),ym_api.receipt_by_request(uuid,uuid),ym_api.financial_report(uuid,date,date) from public,anon,service_role;
grant execute on function ym_api.workspace_context(),ym_api.dashboard_snapshot(uuid,uuid),ym_api.search_units(uuid,uuid,text,integer),ym_api.supplier_options(uuid),ym_api.inventory_page(uuid,uuid,text,integer),ym_api.invoice_receipt(uuid,uuid),ym_api.receipt_by_request(uuid,uuid),ym_api.financial_report(uuid,date,date) to authenticated;
