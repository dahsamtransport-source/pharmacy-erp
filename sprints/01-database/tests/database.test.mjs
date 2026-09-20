import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, migrate, fixture, uuid, native } from './harness.mjs';
let db, f;
before(async () => { db = await openDatabase(); await migrate(db); });
after(async () => { if (db) await db.close(); });
beforeEach(async () => { f = await fixture(db); });
const scalar = async (sql, args=[]) => Object.values((await db.query(sql,args)).rows[0])[0];
const qty = async () => Number(await scalar('select coalesce(sum(quantity),0) from ym.batches where org_id=$1',[f.org]));

test('01 all tables have RLS; no PUBLIC entrypoint/helper or anonymous schema access', async () => {
 assert.equal(Number(await scalar("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='ym' and c.relkind='r' and not c.relrowsecurity")),0);
 assert.equal(await scalar("select has_schema_privilege('anon','ym_api','usage')"),false);
 assert.equal(await scalar("select has_schema_privilege('service_role','ym_private','usage')"),false);
 assert.equal(await scalar("select has_function_privilege('authenticated','ym_private.dispense(uuid,uuid,uuid,uuid,bigint)','execute')"),false);
 assert.equal(await scalar("select has_function_privilege('anon','ym_api.expire_reservations(uuid)','execute')"),false);
});
test('02 purchase and sale compute totals and balanced four-line sale journal', async () => {
 await f.purchase(); const sale=await f.sale(3);
 assert.equal(await qty(),17);
 assert.equal(Number(await scalar('select total from ym.invoices where org_id=$1 and id=$2',[f.org,sale])),30);
 const r=await db.query('select sum(debit) d,sum(credit) c,count(*) n from ym.journal_lines where org_id=$1 and journal_id=(select id from ym.journals where org_id=$1 and invoice_id=$2)',[f.org,sale]);
 assert.equal(r.rows[0].d,r.rows[0].c); assert.equal(Number(r.rows[0].n),4); assert.equal(Number(r.rows[0].d),42);
 assert.equal(Number(await scalar('select inventory_value from ym.valuations where org_id=$1',[f.org])),68);
});
test('03 FEFO consumes nearest expiry and traces exact batches', async () => {
 await f.purchase(10); await f.purchase(2,{batch:'EARLY',expiry:'2098-01-01'}); const sale=await f.sale(3);
 const rows=(await db.query('select b.batch_number,a.quantity from ym.allocations a join ym.batches b on b.org_id=a.org_id and b.id=a.batch_id join ym.invoice_lines l on l.org_id=a.org_id and l.id=a.line_id where l.org_id=$1 and l.invoice_id=$2 order by b.batch_number',[f.org,sale])).rows;
 assert.deepEqual(rows.map(r=>[r.batch_number,Number(r.quantity)]),[['EARLY',2],['LATE',1]]);
});
test('04 packs convert to base units; average cost includes distinct receipts', async () => {
 await f.purchase(1,{unit:f.box,cost:40}); await f.purchase(10,{batch:'OTHER',cost:6});
 await f.sale(1,{items:[{unit_id:f.box,quantity:1}]});
 assert.equal(await qty(),10);
 assert.equal(Number(await scalar('select inventory_value from ym.valuations where org_id=$1',[f.org])),50);
});
test('05 shortage rolls back invoice, prior batch decrements, operation, journal, audit and outbox', async () => {
 await f.purchase(2); const request=uuid();
 await assert.rejects(f.sale(3,{request}),/INSUFFICIENT/);
 assert.equal(await qty(),2);
 assert.equal(Number(await scalar('select count(*) from ym.operations where org_id=$1 and request_id=$2',[f.org,request])),0);
 assert.equal(Number(await scalar('select count(*) from ym.invoices where org_id=$1',[f.org])),1);
 assert.equal(Number(await scalar('select count(*) from ym.outbox where org_id=$1',[f.org])),1);
});
test('06 failure on later cart line restores earlier line stock', async () => {
 await f.purchase(5);
 await assert.rejects(f.sale(1,{items:[{unit_id:f.unit,quantity:1},{unit_id:f.box,quantity:1}]}),/INSUFFICIENT/);
 assert.equal(await qty(),5);
 assert.equal(Number(await scalar("select count(*) from ym.invoices where org_id=$1 and kind='sale'",[f.org])),0);
});
test('07 same request returns existing invoice, changed payload or actor is rejected', async () => {
 await f.purchase(); const request=uuid(); const id=await f.sale(2,{request});
 assert.equal(await f.sale(2,{request}),id); assert.equal(await qty(),18);
 await assert.rejects(f.sale(3,{request}),/IDEMPOTENCY_CONFLICT/);
 await assert.rejects(f.sale(2,{request,actor:f.manager}),/IDEMPOTENCY_CONFLICT/);
});
test('08 supplier duplicate reference cannot create a second invoice', async () => {
 const request=uuid(); const id=await f.purchase(2,{request,reference:' INV-1 '});
 assert.equal(await f.purchase(2,{request,reference:'inv-1'}),id);
 await assert.rejects(f.purchase(2,{reference:'inv-1'}),/purchase_supplier_duplicate/);
 assert.equal(await qty(),2);
});
test('09 client price, negative/fractional quantities, empty carts and duplicate units rejected', async () => {
 await f.purchase();
 for(const items of [[],[{unit_id:f.unit,quantity:-1}],[{unit_id:f.unit,quantity:0.5}],[{unit_id:f.unit,quantity:1,price:0}], [...f.cart(1),...f.cart(1)]])
  await assert.rejects(f.sale(1,{items}),/INVALID|DUPLICATE/);
 assert.equal(await qty(),20);
});
test('10 expired, quarantined and recalled stock cannot be dispensed', async () => {
 await f.purchase(3); await db.query('update ym.batches set expiry_date=current_date where org_id=$1',[f.org]);
 await assert.rejects(f.sale(),/INSUFFICIENT_AVAILABLE_STOCK/);
 await db.query("update ym.batches set expiry_date='2099-12-31',status='quarantine' where org_id=$1",[f.org]);
 await assert.rejects(f.sale(),/INSUFFICIENT_AVAILABLE_STOCK/);
 await db.query("update ym.batches set status='recalled' where org_id=$1",[f.org]);
 await assert.rejects(f.sale(),/INSUFFICIENT_AVAILABLE_STOCK/);
});
test('11 reserved stock unavailable to POS; cancellation releases it exactly once', async () => {
 await f.purchase(3); const reservation=await f.reserve(2);
 await assert.rejects(f.sale(2),/INSUFFICIENT_AVAILABLE_STOCK/); await f.sale(1);
 for(let i=0;i<2;i++) await db.user(f.cashier,()=>db.query('select ym_api.cancel_reservation($1,$2)',[f.org,reservation]));
 await f.sale(2); assert.equal(await qty(),0);
});
test('12 reservation fulfillment is atomic and cannot be repeated with another request', async () => {
 await f.purchase(3); const reservation=await f.reserve(2); const request=uuid();
 const id=await f.sale(2,{request,reservation}); assert.equal(await f.sale(2,{request,reservation}),id);
 await assert.rejects(f.sale(2,{reservation}),/INVALID_RESERVATION/);
 assert.equal(Number(await scalar('select sum(reserved) from ym.batches where org_id=$1',[f.org])),0);
});
test('13 reservation expiration releases holds and expired fulfillment fails', async () => {
 await f.purchase(3); const reservation=await f.reserve(2);
 await db.query("update ym.reservations set expires_at=clock_timestamp()-interval '1 minute' where org_id=$1",[f.org]);
 await assert.rejects(f.sale(2,{reservation}),/INVALID_RESERVATION/);
 await db.user(f.cashier,()=>db.query('select ym_api.expire_reservations($1)',[f.org]));
 await f.sale(3); assert.equal(await qty(),0);
});
test('14 cashier cannot read cost, purchases, financial views, or other tenant', async () => {
 await f.purchase(); await f.sale();
 await db.user(f.cashier,async()=>{
  for(const table of ['ym.valuations','ym.journals','ym.journal_lines','ym.accounts','ym_api.trial_balance','ym_api.income_statement'])
   assert.equal(Number(await scalar(`select count(*) from ${table}`)),0,table);
  assert.equal(Number(await scalar("select count(*) from ym.invoices where kind='purchase'")),0);
  assert.equal(Number(await scalar('select count(*) from ym.invoice_lines')),1);
  assert.equal(Number(await scalar('select count(*) from ym.organizations')),1);
 });
 await db.user(f.outsider,async()=>{ assert.equal(Number(await scalar('select count(*) from ym.invoices')),0); });
 await assert.rejects(f.sale(1,{actor:f.outsider}),/FORBIDDEN/);
});
test('15 direct DML, forged role metadata, anonymous RPC, and helper execution are denied', async () => {
 await f.purchase();
 await assert.rejects(db.user(f.cashier,()=>db.exec("update ym.members set role='owner'")),/permission denied/);
 await assert.rejects(db.user(f.owner,()=>db.exec('delete from ym.invoices')),/permission denied/);
 await assert.rejects(db.user(f.cashier,()=>db.query('select ym_private.dispense($1,$2,$3,$4,1)',[f.org,f.warehouse,f.product,uuid()])),/permission denied/);
 await assert.rejects(db.user(null,()=>db.query('select ym_api.expire_reservations($1)',[f.org]),'anon'),/permission denied/);
 await assert.rejects(db.user(f.cashier,async()=>{
  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({user_metadata:{role:'owner'}})]);
  await db.query('select ym_api.set_period_closed($1,current_date,true)',[f.org]);
 }),/FORBIDDEN/);
});
test('16 deactivated membership immediately loses RPC and row access', async () => {
 await f.purchase(); await db.query('update ym.members set active=false where org_id=$1 and user_id=$2',[f.org,f.cashier]);
 await assert.rejects(f.sale(),/FORBIDDEN/);
 await db.user(f.cashier,async()=>assert.equal(Number(await scalar('select count(*) from ym.batches')),0));
});
test('17 closed periods reject new sales; retries return previous committed result', async () => {
 await f.purchase(); const request=uuid(); const id=await f.sale(1,{request});
 await db.user(f.accountant,()=>db.query("select ym_api.set_period_closed($1,date_trunc('month',current_date)::date,true)",[f.org]));
 await assert.rejects(f.sale(),/PERIOD_NOT_OPEN/); assert.equal(await f.sale(1,{request}),id);
});
test('18 batch expiry collision rolls back repeated receipt', async () => {
 await f.purchase(3);
 await assert.rejects(f.purchase(2,{expiry:'2098-01-01'}),/BATCH_EXPIRY_CONFLICT/);
 assert.equal(await qty(),3);
});
test('19 missing account mapping rolls back stock and journal', async () => {
 await f.purchase(); await db.query("delete from ym.account_mappings where org_id=$1 and purpose='cogs'",[f.org]);
 await assert.rejects(f.sale(),/ACCOUNT_MAPPING_REQUIRED/); assert.equal(await qty(),20);
});
test('20 posted journals, line appends, and audit rewrites are immutable even through owner SQL', async () => {
 await f.purchase();
 await assert.rejects(db.query("update ym.journals set description='tampered' where org_id=$1",[f.org]),/IMMUTABLE/);
 await assert.rejects(db.query("delete from ym.audit_events where org_id=$1",[f.org]),/IMMUTABLE/);
 await assert.rejects(db.query('insert into ym.journal_lines(org_id,journal_id,account_id,debit) select $1,id,$2,1 from ym.journals where org_id=$1',[f.org,f.accounts.cash]),/IMMUTABLE/);
});
test('21 chart hierarchy rejects cycles and reporting classifications of used accounts', async () => {
 const root=uuid(); const child=uuid();
 for(const [id,parent,code] of [[root,null,'A'],[child,root,'B']])
  await db.user(f.accountant,()=>db.query('select ym_api.save_account($1,$2,$3,$3,\'asset\',$4,false)',[f.org,id,code,parent]));
 await assert.rejects(db.user(f.accountant,()=>db.query("select ym_api.save_account($1,$2,'A','A','asset',$3,false)",[f.org,root,child])),/ACCOUNT_CYCLE/);
 await f.purchase();
 await assert.rejects(db.user(f.accountant,()=>db.query("select ym_api.save_account($1,$2,'inventory','Inventory','expense')",[f.org,f.accounts.inventory])),/USED_ACCOUNT_CLASSIFICATION/);
});
test('22 reports agree with posted ledger, COGS and currency', async () => {
 await f.purchase(10); await f.sale(3);
 await db.user(f.accountant,async()=>{
  const row=(await db.query('select sum(debit) d,sum(credit) c from ym_api.trial_balance where org_id=$1',[f.org])).rows[0];
  assert.equal(row.d,row.c);
  assert.equal(Number(await scalar('select sum(net_income_effect) from ym_api.income_statement where org_id=$1',[f.org])),18);
  assert.equal(await scalar('select distinct currency from ym_api.income_statement where org_id=$1',[f.org]),'YER');
 });
});
test('23 prescription review is server-stored and basket-bound; controlled drug sales blocked', async () => {
 await f.purchase(); await db.query('update ym.products set requires_prescription=true where org_id=$1',[f.org]);
 const request=uuid(); await assert.rejects(f.sale(1,{request}),/PHARMACIST_REVIEW_REQUIRED/);
 await assert.rejects(db.user(f.cashier,()=>db.query('select ym_api.review_prescription($1,$2,$3,$4,\'fixture-rx\')',[f.org,request,f.warehouse,JSON.stringify(f.cart(1))])),/FORBIDDEN/);
 await db.user(f.pharmacist,()=>db.query('select ym_api.review_prescription($1,$2,$3,$4,\'fixture-rx\')',[f.org,request,f.warehouse,JSON.stringify(f.cart(1))]));
 await assert.rejects(f.sale(2,{request}),/PHARMACIST_REVIEW_REQUIRED/);
 await f.sale(1,{request});
 await db.query('update ym.products set controlled=true where org_id=$1',[f.org]);
 await assert.rejects(f.sale(),/CONTROLLED_DRUG_WORKFLOW/);
});
async function insurance({cap=25,bps=2000,approval=null}={}) {
 const policy=uuid(),enrollment=uuid();
 await db.query("insert into ym.insurance_policies(org_id,id,insurer_id,name,copay_bps,requires_approval_above) values($1,$2,$3,'Test only',$4,$5)",[f.org,policy,f.insurer,bps,approval]);
 await db.query("insert into ym.enrollments values($1,$2,$3,$4,'2020-01-01','2099-12-31',$5)",[f.org,enrollment,policy,f.customer,cap]);
 return {policy,enrollment,options:{payment:'insurance',customer:f.customer,enrollment}};
}
test('24 insurance uses basis points and cumulative term cap, balances cash and receivables', async () => {
 await f.purchase(); const ins=await insurance(); await f.sale(2,ins.options); const last=await f.sale(2,ins.options);
 assert.equal(Number(await scalar('select sum(claim_amount) from ym.claims where org_id=$1',[f.org])),25);
 assert.equal(Number(await scalar('select patient_due from ym.invoices where org_id=$1 and id=$2',[f.org,last])),11);
});
test('25 insurer preapproval cannot be supplied by cashier; exclusions stay patient-pay', async () => {
 await f.purchase(); const ins=await insurance({approval:10}); const request=uuid();
 await assert.rejects(f.sale(2,{...ins.options,request}),/INSURER_APPROVAL_REQUIRED/);
 await db.user(f.manager,()=>db.query("select ym_api.record_insurer_approval($1,$2,$3,'AUTH-TEST',16,clock_timestamp()+interval '1 hour')",[f.org,ins.enrollment,request]));
 await f.sale(2,{...ins.options,request});
 await db.query('insert into ym.insurance_exclusions values($1,$2,$3)',[f.org,ins.policy,f.product]);
 const id=await f.sale(2,ins.options);
 assert.equal(Number(await scalar('select patient_due from ym.invoices where org_id=$1 and id=$2',[f.org,id])),20);
});
test('26 minimum stock uses configured threshold and excludes expired/reserved stock', async () => {
 await f.purchase(5); await db.query('insert into ym.reorder_rules values($1,$2,$3,2,10)',[f.org,f.warehouse,f.product]);
 await f.reserve(3);
 await db.user(f.cashier,async()=>assert.equal(Number(await scalar('select available from ym_api.low_stock where org_id=$1',[f.org])),2));
});
test('27 unit conversion cannot change after creation', async () => {
 await assert.rejects(db.user(f.inventory,()=>db.query("select ym_api.save_unit($1,$2,$3,'piece',2,10)",[f.org,f.unit,f.product])),/UNIT_CONVERSION_IMMUTABLE/);
});
test('28 cross-company FK rejects attaching another company warehouse or unit', async () => {
 const other=await fixture(db);
 await assert.rejects(db.query('insert into ym.batches(org_id,warehouse_id,product_id,batch_number,expiry_date) values($1,$2,$3,\'CROSS\',\'2099-12-31\')',[f.org,other.warehouse,f.product]),/foreign key/);
 await assert.rejects(f.sale(1,{items:[{unit_id:other.unit,quantity:1}]}),/UNIT_UNAVAILABLE/);
});
test('29 reservation of mixed units of one product preserves one batch allocation', async () => {
 await f.purchase(20); const items=[{unit_id:f.unit,quantity:1},{unit_id:f.box,quantity:1}];
 const reservation=await f.reserve(1,uuid(),items); await f.sale(1,{items,reservation}); assert.equal(await qty(),9);
});
test('30 outbox reuses DOCUMENT_UUID and starts pending; no external posting', async () => {
 await f.purchase(); const request=uuid(); await f.sale(1,{request}); await f.sale(1,{request});
 const row=(await db.query('select status,payload from ym.outbox where org_id=$1 and document_uuid=$2',[f.org,request])).rows[0];
 assert.equal(row.status,'pending'); assert.equal(row.payload.external_reference,request);
});
test('31 downgraded cashier cannot read purchase cost through idempotency payload', async () => {
 await f.purchase(); await db.query("update ym.members set role='cashier' where org_id=$1 and user_id=$2",[f.org,f.inventory]);
 await db.user(f.inventory,async()=>assert.equal(Number(await scalar("select count(*) from ym.operations where kind='purchase'")),0));
});
test('32 a draft/unbalanced journal cannot survive COMMIT', async () => {
 await f.purchase(); await db.exec('begin');
 try {
  const invoice=uuid(); const journal=uuid();
  await db.query("insert into ym.invoices(org_id,id,document_uuid,kind,warehouse_id,actor_id,currency,document_date,payment_method,total) values($1,$2,$3,'sale',$4,$5,'YER',current_date,'cash',1)",[f.org,invoice,uuid(),f.warehouse,f.cashier]);
  await db.query("insert into ym.journals(org_id,id,invoice_id,document_date,period_month,currency,cost_center_id,description) values($1,$2,$3,current_date,date_trunc('month',current_date)::date,'YER',$4,'invalid fixture')",[f.org,journal,invoice,f.center]);
  await db.query('insert into ym.journal_lines(org_id,journal_id,account_id,debit) values($1,$2,$3,1)',[f.org,journal,f.accounts.cash]);
  await db.query("update ym.journals set status='posted' where org_id=$1 and id=$2",[f.org,journal]);
  await assert.rejects(db.exec('commit'),/UNBALANCED_OR_UNPOSTED/);
 } finally { await db.exec('rollback'); }
 assert.equal(Number(await scalar("select count(*) from ym.invoices where org_id=$1 and kind='sale'",[f.org])),0);
});
test('33 same purchase request survives supplier deactivation without a duplicate', async () => {
 const request=uuid(); const id=await f.purchase(2,{request,reference:'RETRY'});
 await db.query('update ym.parties set active=false where org_id=$1 and id=$2',[f.org,f.supplier]);
 assert.equal(await f.purchase(2,{request,reference:'RETRY'}),id);
});

test('34 DOCUMENT_UUID is globally unique, including another organization', async () => {
 await f.purchase(); const request=uuid(); await f.sale(1,{request});
 const other=await fixture(db); await other.purchase(3);
 await assert.rejects(other.sale(1,{request}),/invoices_document_uuid_key/);
 assert.equal(Number(await scalar('select sum(quantity) from ym.batches where org_id=$1',[other.org])),3);
});
test('35 workspace context exposes only active memberships of the caller',async()=>{
 const data=await db.user(f.cashier,()=>scalar('select ym_api.workspace_context()'));
 assert.equal(data.length,1);assert.equal(data[0].role,'cashier');assert.equal(data[0].id,f.org);
 const outsider=await db.user(f.outsider,()=>scalar('select ym_api.workspace_context()'));assert.deepEqual(outsider,[]);
});
test('36 dashboard cashier metrics cover their sales, not the manager sales',async()=>{
 await f.purchase();await f.sale(2);await f.sale(3,{actor:f.manager});
 const d=await db.user(f.cashier,()=>scalar('select ym_api.dashboard_snapshot($1,$2)',[f.org,f.warehouse]));
 assert.equal(d.scope,'mine');assert.equal(Number(d.today_total),20);assert.equal(d.recent.length,1);
 const all=await db.user(f.owner,()=>scalar('select ym_api.dashboard_snapshot($1,$2)',[f.org,f.warehouse]));assert.equal(Number(all.today_total),50);
});
test('37 catalog returns unit-specific availability without cost fields',async()=>{
 await f.purchase();await f.reserve(3);
 const units=await db.user(f.cashier,()=>scalar('select ym_api.search_units($1,$2,\'BOX\',0)',[f.org,f.warehouse]));
 assert.equal(units.length,1);assert.equal(units[0].factor,10);assert.equal(units[0].available_base,17);
 assert.equal('cost_price' in units[0],false);assert.equal('inventory_value' in units[0],false);
 await assert.rejects(db.user(f.outsider,()=>scalar('select ym_api.search_units($1,$2)',[f.org,f.warehouse])),/FORBIDDEN/);
});
test('38 receipt lookup obeys invoice RLS; stable reference resolves a committed sale',async()=>{
 await f.purchase();const request=uuid();const sale=await f.sale(2,{request});
 const receipt=await db.user(f.cashier,()=>scalar('select ym_api.receipt_by_request($1,$2)',[f.org,request]));
 assert.equal(receipt.id,sale);assert.equal(Number(receipt.total),20);assert.equal(receipt.lines.length,1);
 const hidden=await f.sale(1,{actor:f.manager});
 await assert.rejects(db.user(f.cashier,()=>scalar('select ym_api.invoice_receipt($1,$2)',[f.org,hidden])),/INVOICE_NOT_FOUND/);
});
test('39 financial read contract denies cashier and preserves exact decimal totals',async()=>{
 await f.purchase();await f.sale(2);
 await assert.rejects(db.user(f.cashier,()=>scalar('select ym_api.financial_report($1,current_date,current_date)',[f.org])),/FORBIDDEN/);
 const r=await db.user(f.accountant,()=>scalar('select ym_api.financial_report($1,current_date,current_date)',[f.org]));
 assert.equal(r.accounts.find(x=>x.code==='revenue').credit,'20.00');
 assert.equal(r.accounts.find(x=>x.code==='cogs').debit,'8.00');
});
test('40 supplier options are restricted and invoker RPCs remain closed to anonymous',async()=>{
 await assert.rejects(db.user(f.cashier,()=>scalar('select ym_api.supplier_options($1)',[f.org])),/FORBIDDEN/);
 const suppliers=await db.user(f.inventory,()=>scalar('select ym_api.supplier_options($1)',[f.org]));assert.equal(suppliers.length,1);
 assert.equal(await scalar("select has_function_privilege('anon','ym_api.dashboard_snapshot(uuid,uuid)','execute')"),false);
 assert.equal(await scalar("select prosecdef from pg_proc where oid='ym_api.dashboard_snapshot(uuid,uuid)'::regprocedure"),false);
});
test('41 inventory-role dashboard never synthesizes a sales zero or reads financial metrics',async()=>{
 await f.purchase();await f.sale(2);
 const d=await db.user(f.inventory,()=>scalar('select ym_api.dashboard_snapshot($1,$2)',[f.org,f.warehouse]));
 assert.equal(d.today_total,null);assert.equal(d.yesterday_total,null);assert.ok(d.series.every(x=>x.total===null));
});

// Synthetic posted journal fixtures allow boundary dates without changing immutable real transactions.
async function reportJournal({date='2026-01-15',debit=f.accounts.cash,credit=f.accounts.revenue,amount='10.00',center=f.center,currency='YER',beforePost}={}) {
 const invoice=uuid(),journal=uuid(); await db.exec('begin');
 try {
  await db.query("insert into ym.periods values($1,date_trunc('month',$2::date)::date,false) on conflict do nothing",[f.org,date]);
  await db.query("insert into ym.invoices(org_id,id,document_uuid,kind,warehouse_id,actor_id,currency,document_date,payment_method,total) values($1,$2,$3,'sale',$4,$5,$6,$7,'cash',$8)",[f.org,invoice,uuid(),f.warehouse,f.owner,currency,date,amount]);
  await db.query("insert into ym.journals(org_id,id,invoice_id,document_date,period_month,currency,cost_center_id,description) values($1,$2,$3,$4,date_trunc('month',$4::date)::date,$5,$6,'Synthetic report fixture')",[f.org,journal,invoice,date,currency,center]);
  await db.query('insert into ym.journal_lines(org_id,journal_id,account_id,debit,credit) values($1,$2,$3,$5,0),($1,$2,$4,0,$5)',[f.org,journal,debit,credit,amount]);
  if(beforePost) {await db.query("select set_config('request.jwt.claim.sub',$1,true)",[f.accountant]);await beforePost();}
  await db.query("update ym.journals set status='posted' where org_id=$1 and id=$2",[f.org,journal]);
  await db.exec('commit');
 } catch(e) {await db.exec('rollback');throw e;}
 return journal;
}
const statement = (from='2026-01-01',to='2026-01-31',center=null,zero=false,actor=f.accountant,org=f.org) => db.user(actor,()=>scalar('select ym_api.financial_report_v2($1,$2,$3,$4,$5)',[org,from,to,center,zero]));
test('42 financial statement reconciles real purchase, FEFO sale, COGS and normal balances',async()=>{
 await f.purchase();await f.sale(3);
 const today=await scalar('select current_date::text');const r=await statement(today,today);
 assert.equal(r.income.revenue,'30.00');assert.equal(r.income.cost_of_sales,'12.00');assert.equal(r.income.net_income,'18.00');
 assert.equal(r.totals.debit,'122.00');assert.equal(r.totals.credit,'122.00');assert.equal(r.totals.balanced,true);
 assert.equal(r.posted_journal_count,2);assert.equal(r.accounts.find(a=>a.code==='payables').normal_balance,'80.00');
});
test('43 business-date boundaries include the last day, separate opening and exclude future entries',async()=>{
 await reportJournal({date:'2025-12-31',amount:'100.00'});
 await reportJournal({date:'2026-01-01',amount:'50.00'});
 await reportJournal({date:'2026-01-31',debit:f.accounts.cogs,credit:f.accounts.cash,amount:'20.00'});
 await reportJournal({date:'2026-02-01',amount:'999.00'});
 const r=await statement();const cash=r.accounts.find(a=>a.code==='cash');
 assert.equal(cash.opening,'100.00');assert.equal(cash.debit,'50.00');assert.equal(cash.credit,'20.00');assert.equal(cash.closing,'130.00');
 assert.equal(r.income.revenue,'50.00');assert.equal(r.income.net_income,'30.00');assert.equal(r.posted_journal_count,2);
 assert.equal(r.totals.opening_debit,'100.00');assert.equal(r.totals.closing_debit,'150.00');
});
test('44 an empty ledger is distinct from a completed balanced ledger; zero accounts are optional',async()=>{
 const r=await statement();assert.equal(r.totals.has_data,false);assert.equal(r.accounts.length,0);assert.equal(r.posted_journal_count,0);
 const all=await statement('2026-01-01','2026-01-31',null,true);assert.equal(all.accounts.length,7);assert.equal(all.totals.has_data,false);
});
test('45 financial RPCs deny non-finance roles and anonymous execution',async()=>{
 for(const role of ['cashier','pharmacist','inventory','outsider']) {
  await assert.rejects(statement('2026-01-01','2026-01-31',null,false,f[role]),/FORBIDDEN/);
  await assert.rejects(db.user(f[role],()=>scalar('select ym_api.financial_report_options($1)',[f.org])),/FORBIDDEN/);
 }
 for(const fn of ['ym_api.financial_report_options(uuid)','ym_api.financial_report_v2(uuid,date,date,uuid,boolean)']) {
  assert.equal(await scalar('select has_function_privilege(\'anon\',$1,\'execute\')',[fn]),false);
  assert.equal(await scalar('select prosecdef from pg_proc where oid=$1::regprocedure',[fn]),false);
 }
});
test('46 financial queries reject another organization and revoked memberships',async()=>{
 const other=await fixture(db);
 await assert.rejects(statement('2026-01-01','2026-01-31',null,false,f.owner,other.org),/FORBIDDEN/);
 await db.query('update ym.members set active=false where org_id=$1 and user_id=$2',[f.org,f.accountant]);
 await assert.rejects(statement(),/FORBIDDEN/);
});
test('47 cost-center filter scopes balances, income, opening and journal counts',async()=>{
 const center=uuid();await db.query("insert into ym.cost_centers values($1,$2,'TRANSPORT','Transport')",[f.org,center]);
 await reportJournal({amount:'10.00'});await reportJournal({amount:'90.00',center});
 await reportJournal({amount:'50.00',center,date:'2025-12-31'});
 const r=await statement('2026-01-01','2026-01-31',center);
 assert.equal(r.cost_center.id,center);assert.equal(r.income.revenue,'90.00');assert.equal(r.totals.opening_debit,'50.00');assert.equal(r.posted_journal_count,1);
 const centers=await db.user(f.manager,()=>scalar('select ym_api.financial_report_options($1)',[f.org]));assert.equal(centers.length,2);
});
test('48 invalid dates, excessive ranges, foreign center and null option are rejected',async()=>{
 for(const [from,to] of [[null,'2026-01-01'],['2026-02-01','2026-01-01'],['2024-01-01','2026-01-01'],['2026-01-01','infinity']]) await assert.rejects(statement(from,to),/INVALID_REPORT_PERIOD/);
 await assert.rejects(statement('2026-01-01','2026-01-31',uuid()),/INVALID_REPORT_CENTER/);
 await assert.rejects(statement('2026-01-01','2026-01-31',null,null),/INVALID_REPORT_PERIOD/);
});
test('49 report keeps sub-cent-free precision beyond JavaScript safe minor-unit integers',async()=>{
 await reportJournal({amount:'90071992547409.11'});await reportJournal({amount:'0.10'});await reportJournal({amount:'0.20'});
 const r=await statement();assert.equal(r.totals.debit,'90071992547409.41');assert.equal(r.income.net_income,'90071992547409.41');
});
test('50 contra revenue and expense reversals retain the correct signs',async()=>{
 await reportJournal({amount:'100.00'});await reportJournal({debit:f.accounts.revenue,credit:f.accounts.cash,amount:'120.00'});
 await reportJournal({debit:f.accounts.cash,credit:f.accounts.cogs,amount:'5.00'});
 const r=await statement();assert.equal(r.income.revenue,'-20.00');assert.equal(r.income.cost_of_sales,'-5.00');assert.equal(r.income.net_income,'-15.00');
 assert.equal(r.accounts.find(a=>a.code==='revenue').normal_balance,'-20.00');
});
test('51 unposted in-flight journals never enter reports',async()=>{
 await reportJournal({beforePost:async()=>{
  const r=await scalar("select ym_api.financial_report_v2($1,'2026-01-01','2026-01-31')",[f.org]);
  assert.equal(r.totals.has_data,false);assert.equal(r.posted_journal_count,0);
 }});
 assert.equal((await statement()).posted_journal_count,1);
});
test('52 mixed currencies are rejected instead of silently combined',async()=>{
 await reportJournal({currency:'USD'});await assert.rejects(statement(),/REPORT_CURRENCY_MISMATCH/);
});
test('53 inactive accounts retain history; group accounts do not double count',async()=>{
 await reportJournal();await db.query('update ym.accounts set active=false where org_id=$1 and id=$2',[f.org,f.accounts.revenue]);
 await db.query("insert into ym.accounts(org_id,code,name,kind,postable) values($1,'GROUP','Parent','income',false)",[f.org]);
 const r=await statement('2026-01-01','2026-01-31',null,true);assert.equal(r.income.revenue,'10.00');assert.ok(r.accounts.some(a=>a.id===f.accounts.revenue));assert.ok(!r.accounts.some(a=>a.code==='GROUP'));
});
test('54 missing or misclassified COGS mapping cannot generate misleading gross profit',async()=>{
 await db.query("delete from ym.account_mappings where org_id=$1 and purpose='cogs'",[f.org]);
 await assert.rejects(statement(),/REPORT_ACCOUNT_MAPPING_REQUIRED/);
 await db.query("insert into ym.account_mappings values($1,'cogs',$2)",[f.org,f.accounts.cash]);
 await assert.rejects(statement(),/REPORT_ACCOUNT_MAPPING_REQUIRED/);
});

const ledger=(account=f.accounts.cash,from='2026-01-01',to='2026-01-31',center=null,actor=f.accountant,org=f.org)=>db.user(actor,()=>scalar('select ym_api.account_ledger($1,$2,$3,$4,$5)',[org,account,from,to,center]));
test('55 ledger reconciles opening, debit, credit and running balances with trial balance',async()=>{
 await reportJournal({date:'2025-12-31',amount:'100.00'});
 await reportJournal({date:'2026-01-01',amount:'30.00'});
 await reportJournal({date:'2026-01-31',amount:'20.00',debit:f.accounts.revenue,credit:f.accounts.cash});
 await reportJournal({date:'2026-02-01',amount:'999.00'});
 const r=await ledger();const row=(await statement()).accounts.find(a=>a.id===f.accounts.cash);
 assert.equal(r.opening,row.opening);assert.equal(r.debit,row.debit);assert.equal(r.credit,row.credit);assert.equal(r.closing,row.closing);
 assert.deepEqual(r.entries.map(e=>e.balance),['130.00','110.00']);assert.equal(r.count,2);
 assert.ok(r.entries.every(e=>e.document_uuid&&e.journal_id));
});
test('56 ledger respects financial roles and organization scope',async()=>{
 for(const role of ['cashier','pharmacist','inventory','outsider']) await assert.rejects(ledger(undefined,undefined,undefined,null,f[role]),/FORBIDDEN/);
 for(const role of ['owner','manager','accountant']) assert.equal((await ledger(undefined,undefined,undefined,null,f[role])).count,0);
 const other=await fixture(db);
 await assert.rejects(ledger(other.accounts.cash),/LEDGER_ACCOUNT_UNAVAILABLE/);
 await assert.rejects(ledger(undefined,undefined,undefined,other.center),/INVALID_REPORT_CENTER/);
 assert.equal(await scalar("select has_function_privilege('anon','ym_api.account_ledger(uuid,uuid,date,date,uuid)','execute')"),false);
 assert.equal(await scalar("select prosecdef from pg_proc where oid='ym_api.account_ledger(uuid,uuid,date,date,uuid)'::regprocedure"),false);
});
test('57 ledger excludes unposted journals and honors center and date constraints',async()=>{
 await reportJournal({beforePost:async()=>{assert.equal((await scalar('select ym_api.account_ledger($1,$2,$3,$4,null)',[f.org,f.accounts.cash,'2026-01-01','2026-01-31'])).count,0);}});
 const center=uuid();await db.query("insert into ym.cost_centers values($1,$2,'LEDGER','Other')",[f.org,center]);
 await reportJournal({center,amount:'7.00'});
 assert.equal((await ledger(undefined,undefined,undefined,center)).debit,'7.00');
 for(const [from,to] of [['2026-02-01','2026-01-01'],['2020-01-01','2026-01-01'],['infinity','infinity']]) await assert.rejects(ledger(undefined,from,to),/INVALID_REPORT_PERIOD/);
});
test('58 ledger handles inactive history, reversals, exact large amounts and currency isolation',async()=>{
 await reportJournal({amount:'90071992547409.93',debit:f.accounts.revenue,credit:f.accounts.cash});
 await db.query('update ym.accounts set active=false where org_id=$1 and id=$2',[f.org,f.accounts.cash]);
 const r=await ledger();assert.equal(r.closing,'-90071992547409.93');assert.equal(r.entries[0].balance,r.closing);
 await db.query('update ym.accounts set active=true where org_id=$1 and id=$2',[f.org,f.accounts.cash]);
 await reportJournal({currency:'USD'});await assert.rejects(ledger(),/REPORT_CURRENCY_MISMATCH/);
});
test('59 empty ledger preserves opening balance without pretending there are period entries',async()=>{
 await reportJournal({date:'2025-12-31',amount:'12.25'});
 const r=await ledger();assert.equal(r.count,0);assert.deepEqual(r.entries,[]);assert.equal(r.opening,'12.25');assert.equal(r.closing,'12.25');
});
test('60 ledger rejects an oversized range instead of returning a truncated balance',async()=>{
 // Set-based synthetic fixtures retain every journal/balance constraint.
 await db.exec('begin');
 try {
  await db.query("insert into ym.periods values($1,'2026-01-01',false) on conflict do nothing",[f.org]);
  await db.query(`with docs as (
   insert into ym.invoices(org_id,document_uuid,kind,warehouse_id,actor_id,currency,document_date,payment_method,total)
   select $1,gen_random_uuid(),'sale',$2,$3,'YER','2026-01-15','cash',0.01 from generate_series(1,1000)
   returning id
  ) insert into ym.journals(org_id,invoice_id,document_date,period_month,currency,cost_center_id,description)
   select $1,id,'2026-01-15','2026-01-01','YER',$4,'Synthetic range fixture' from docs`,[f.org,f.warehouse,f.owner,f.center]);
  await db.query('insert into ym.journal_lines(org_id,journal_id,account_id,debit,credit) select org_id,id,$2,0.01,0 from ym.journals where org_id=$1',[f.org,f.accounts.cash]);
  await db.query('insert into ym.journal_lines(org_id,journal_id,account_id,debit,credit) select org_id,id,$2,0,0.01 from ym.journals where org_id=$1',[f.org,f.accounts.revenue]);
  await db.query("update ym.journals set status='posted' where org_id=$1",[f.org]);
  await db.exec('commit');
 } catch(e) {await db.exec('rollback');throw e;}
 // Refresh planner statistics explicitly after this test-only bulk load.
 await db.exec('analyze ym.members; analyze ym.invoices; analyze ym.journals; analyze ym.journal_lines');
 const r=await ledger();assert.equal(r.count,1000);assert.equal(r.closing,'10.00');
 await reportJournal({amount:'0.01'});
 await assert.rejects(ledger(),/LEDGER_RANGE_TOO_LARGE/);
});
