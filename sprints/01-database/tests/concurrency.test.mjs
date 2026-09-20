import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, migrate, fixture, uuid, native } from './harness.mjs';
let db,f;
before(async()=>{ if(native) {db=await openDatabase(); await migrate(db);} });
after(async()=>{if(db) await db.close();});
beforeEach(async()=>{if(native) f=await fixture(db);});
async function begin(client,user) {
 await client.exec("begin; set local statement_timeout='10s'; set local lock_timeout='6s'; set local role authenticated");
 await client.query("select set_config('request.jwt.claim.sub',$1,true)",[user]);
}
async function waitBlocked(pid) {
 for(let i=0;i<40;i++) {
  const r=await db.query("select exists(select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock') blocked",[pid]);
  if(r.rows[0].blocked) return;
  await new Promise(resolve=>setTimeout(resolve,50));
 }
 throw new Error('Second connection never reached the expected database lock');
}
async function race(first, second, firstUser=f.cashier,secondUser=f.cashier) {
 const a=await openDatabase(), b=await openDatabase();
 try {
  await begin(a,firstUser); await begin(b,secondUser);
  const pid=(await b.query('select pg_backend_pid() pid')).rows[0].pid;
  const firstResult=await first(a);
  const pending=second(b).then(value=>({value}),error=>({error}));
  await waitBlocked(pid); // Prove overlap rather than relying on timing or Promise.all alone.
  await a.exec('commit');
  const secondResult=await pending;
  await b.exec(secondResult.error?'rollback':'commit');
  return [firstResult,secondResult];
 } finally {
  await a.exec('rollback'); await b.exec('rollback'); await a.close(); await b.close();
 }
}
const sale=(client,quantity=1,request=uuid(),extra={})=>client.query('select ym_api.process_pharmacy_sale($1,$2,$3,$4,$5,$6,$7) id',
 [f.org,request,f.warehouse,JSON.stringify(f.cart(quantity)),extra.payment??'cash',extra.customer??null,extra.enrollment??null]);
const quantity=async()=>Number((await db.query('select sum(quantity) n from ym.batches where org_id=$1',[f.org])).rows[0].n);
const nativeTest=(name,body)=>test(name,{skip:!native},body);
nativeTest('C1 simultaneous sale of the final unit: one commits, one fails, stock never negative',async()=>{
 await f.purchase(1); const [,b]=await race(c=>sale(c),c=>sale(c)); assert.match(b.error.message,/INSUFFICIENT/); assert.equal(await quantity(),0);
});
nativeTest('C2 simultaneous identical request: same invoice, one inventory deduction',async()=>{
 await f.purchase(5); const request=uuid(); const [a,b]=await race(c=>sale(c,2,request),c=>sale(c,2,request));
 assert.equal(a.rows[0].id,b.value.rows[0].id); assert.equal(await quantity(),3);
});
nativeTest('C3 same UUID with different payload is rejected after first commit',async()=>{
 await f.purchase(5); const request=uuid(); const [,b]=await race(c=>sale(c,2,request),c=>sale(c,1,request));
 assert.match(b.error.message,/IDEMPOTENCY_CONFLICT/); assert.equal(await quantity(),3);
});
nativeTest('C4 reservation competes with POS for final unit without overselling',async()=>{
 await f.purchase(1); const [,b]=await race(c=>c.query('select ym_api.reserve_online_order($1,$2,$3,$4)',[f.org,uuid(),f.warehouse,JSON.stringify(f.cart(1))]),c=>sale(c));
 assert.match(b.error.message,/INSUFFICIENT_AVAILABLE_STOCK/); assert.equal(await quantity(),1);
});
nativeTest('C5 concurrent receipts retain quantities and weighted-average value',async()=>{
 const receive=(c,cost)=>c.query('select ym_api.receive_purchase_order($1,$2,$3,$4,$5,$6)',[f.org,uuid(),f.warehouse,f.supplier,uuid(),JSON.stringify([{unit_id:f.unit,quantity:2,unit_cost:cost,batch_number:'B',expiry_date:'2099-12-31'}])]);
 const [,b]=await race(c=>receive(c,4),c=>receive(c,6),f.inventory,f.inventory); assert.ok(!b.error); assert.equal(await quantity(),4);
 assert.equal(Number((await db.query('select inventory_value from ym.valuations where org_id=$1',[f.org])).rows[0].inventory_value),20);
});
nativeTest('C6 simultaneous insurance claims cannot exceed enrollment term cap',async()=>{
 await f.purchase(5); const policy=uuid(),enrollment=uuid();
 await db.query("insert into ym.insurance_policies(org_id,id,insurer_id,name,copay_bps) values($1,$2,$3,'Synthetic',0)",[f.org,policy,f.insurer]);
 await db.query("insert into ym.enrollments values($1,$2,$3,$4,'2020-01-01','2099-12-31',15)",[f.org,enrollment,policy,f.customer]);
 const extra={payment:'insurance',customer:f.customer,enrollment};
 const [,b]=await race(c=>sale(c,1,uuid(),extra),c=>sale(c,1,uuid(),extra)); assert.ok(!b.error);
 assert.equal(Number((await db.query('select sum(claim_amount) n from ym.claims where org_id=$1',[f.org])).rows[0].n),15);
});
nativeTest('C7 closing the period serializes before a competing sale',async()=>{
 await f.purchase(5);
 const [,b]=await race(c=>c.query("select ym_api.set_period_closed($1,date_trunc('month',current_date)::date,true)",[f.org]),c=>sale(c),f.accountant,f.cashier);
 assert.match(b.error.message,/PERIOD_NOT_OPEN/); assert.equal(await quantity(),5);
});
nativeTest('C8 sale reads the committed server price after concurrent price change',async()=>{
 await f.purchase(5);
 const [,b]=await race(c=>c.query("select ym_api.save_unit($1,$2,$3,'piece',1,12)",[f.org,f.unit,f.product]),c=>sale(c),f.inventory,f.cashier);
 assert.ok(!b.error);
 assert.equal(Number((await db.query('select total from ym.invoices where org_id=$1 and id=$2',[f.org,b.value.rows[0].id])).rows[0].total),12);
});
