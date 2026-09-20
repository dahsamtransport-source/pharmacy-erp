-- psql-only, operator-run AFTER migrations in a disposable evaluation database.
-- Required -v arguments: owner_user_id, company_name, currency, timezone.
-- The owner must already exist in real Supabase Auth. Never put a password here.
\set ON_ERROR_STOP on
\if :{?owner_user_id}
\else
 \echo 'Missing owner_user_id'
 \quit 1
\endif
\if :{?company_name}
\else
 \echo 'Missing company_name'
 \quit 1
\endif
\if :{?currency}
\else
 \echo 'Missing confirmed currency'
 \quit 1
\endif
\if :{?timezone}
\else
 \echo 'Missing timezone'
 \quit 1
\endif
begin;
-- Force a timezone validation before inserting configuration.
select now() at time zone :'timezone';
select gen_random_uuid() as org_id \gset
insert into ym.organizations(id,name,currency,timezone) values(:'org_id',:'company_name',:'currency',:'timezone');
insert into ym.members(org_id,user_id,role) values(:'org_id',:'owner_user_id','owner');
insert into ym.cost_centers(org_id,code,name) values(:'org_id','PHARMACY','الصيدلية'),(:'org_id','TRANSPORT','النقل');
insert into ym.warehouses(org_id,name,cost_center_id)
select :'org_id','مخزن الصيدلية',id from ym.cost_centers where org_id=:'org_id' and code='PHARMACY';
insert into ym.accounts(org_id,code,name,kind,postable) values
(:'org_id','1000','الأصول','asset',false),(:'org_id','2000','الالتزامات','liability',false),
(:'org_id','3000','حقوق الملكية','equity',false),(:'org_id','4000','الإيرادات','income',false),
(:'org_id','5000','المصروفات','expense',false);
with definitions(code,name,kind,parent_code,purpose) as (values
 ('1110','الصندوق','asset','1000','cash'),('1120','البنك','asset','1000','bank'),
 ('1200','المخزون','asset','1000','inventory'),('1300','ذمم التأمين','asset','1000','insurance_receivable'),
 ('2100','ذمم الموردين','liability','2000','payables'),('4100','إيراد الصيدلية','income','4000','revenue'),
 ('5100','تكلفة البضاعة المباعة','expense','5000','cogs')
), created as (
 insert into ym.accounts(org_id,code,name,kind,parent_id)
 select :'org_id',d.code,d.name,d.kind,a.id from definitions d join ym.accounts a on a.org_id=:'org_id' and a.code=d.parent_code
 returning org_id,id,code
)
insert into ym.account_mappings select c.org_id,d.purpose,c.id from created c join definitions d on d.code=c.code;
insert into ym.periods(org_id,month) select :'org_id',date_trunc('month',(now() at time zone :'timezone'))::date;
insert into ym.audit_events(org_id,actor_id,action) values(:'org_id',:'owner_user_id','organization.bootstrapped');
commit;
select :'org_id' as created_organization_id;
