import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
export const uuid = randomUUID;
export const native = Boolean(process.env.YMPHARMA_TEST_DATABASE_URL);
export async function openDatabase() {
  let backend;
  if (native) {
    const url = new URL(process.env.YMPHARMA_TEST_DATABASE_URL);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/ympharma_test' || process.env.YMPHARMA_DISPOSABLE_TEST_DB !== 'yes') {
      throw new Error('Tests require an explicitly disposable localhost /ympharma_test database.');
    }
    backend = new pg.Client({ connectionString: url.toString() });
    await backend.connect();
  } else backend = new PGlite();
  const safe = async (fn) => { try { return await fn(); } catch(e) { throw new Error(e.message); } };
  const db = {
    query: (sql, args = []) => safe(() => backend.query(sql, args)),
    exec: (sql) => safe(() => native ? backend.query(sql) : backend.exec(sql)),
    close: () => native ? backend.end() : backend.close(),
  };
  db.user = async (id, callback, role = 'authenticated') => {
    if (!['authenticated', 'anon'].includes(role)) throw new Error('Test role not allowed');
    await db.exec('begin');
    try {
      await db.exec(`set local role ${role}`);
      await db.query("select set_config('request.jwt.claim.sub',$1,true)", [id ?? '']);
      const result = await callback(db);
      await db.exec('commit');
      return result;
    } catch (error) {
      await db.exec('rollback');
      throw error;
    }
  };
  return db;
}
export async function migrate(db) {
  // Test-only auth fixture. Never ship this stub to Supabase; real auth.uid() is supplied there.
  await db.exec(`
    drop schema if exists ym_api cascade;
    drop schema if exists ym_private cascade;
    drop schema if exists ym cascade;
    create schema if not exists auth;
    create table if not exists auth.users(id uuid primary key);
    do $$ begin if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if; end $$;
    create or replace function auth.uid() returns uuid language sql stable as
    'select nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
    grant usage on schema auth to authenticated,anon;
    grant execute on function auth.uid() to authenticated,anon;
  `);
  const folder = new URL('../supabase/migrations/', import.meta.url);
  for (const name of (await readdir(folder)).filter(n => n.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(name, folder), 'utf8'));
  }
}
export async function fixture(db) {
  const f = { org: uuid(), warehouse: uuid(), center: uuid(), product: uuid(), unit: uuid(), box: uuid(), supplier: uuid(), customer: uuid(), insurer: uuid() };
  for (const role of ['owner', 'manager', 'accountant', 'cashier', 'pharmacist', 'inventory', 'outsider']) {
    f[role] = uuid();
    await db.query('insert into auth.users(id) values($1)', [f[role]]);
  }
  await db.query("insert into ym.organizations values($1,'Test pharmacy','YER','Asia/Aden')", [f.org]);
  for (const role of ['owner', 'manager', 'accountant', 'cashier', 'pharmacist', 'inventory']) {
    await db.query('insert into ym.members values($1,$2,$3,true)', [f.org, f[role], role]);
  }
  await db.query("insert into ym.cost_centers values($1,$2,'PHARMACY','Pharmacy')", [f.org, f.center]);
  await db.query("insert into ym.warehouses values($1,$2,'Main',$3,true)", [f.org, f.warehouse, f.center]);
  await db.query("insert into ym.products(org_id,id,sku,trade_name) values($1,$2,'TEST','Synthetic test product')", [f.org, f.product]);
  await db.query("insert into ym.units(org_id,id,product_id,name,factor,selling_price,barcode) values($1,$2,$3,'piece',1,10,'TEST'),($1,$4,$3,'box',10,90,'BOX')", [f.org, f.unit, f.product, f.box]);
  for (const kind of ['supplier', 'customer', 'insurer']) await db.query('insert into ym.parties(org_id,id,name,kind) values($1,$2,$3,$3)', [f.org, f[kind], kind]);
  f.accounts = {};
  for (const purpose of ['cash','bank','inventory','cogs','revenue','payables','insurance_receivable']) {
    const id = uuid(); f.accounts[purpose] = id;
    const kind = purpose === 'payables' ? 'liability' : purpose === 'cogs' ? 'expense' : purpose === 'revenue' ? 'income' : 'asset';
    await db.query('insert into ym.accounts(org_id,id,code,name,kind) values($1,$2,$3,$3,$4)', [f.org, id, purpose, kind]);
    await db.query('insert into ym.account_mappings values($1,$2,$3)', [f.org, purpose, id]);
  }
  await db.query("insert into ym.periods values($1,date_trunc('month',current_date)::date,false)", [f.org]);
  f.cart = quantity => [{unit_id: f.unit, quantity}];
  f.purchase = async (quantity = 20, { request = uuid(), batch = 'LATE', cost = 4, expiry = '2099-12-31', reference = uuid(), unit = f.unit } = {}) => db.user(f.inventory, async () => {
    const r = await db.query('select ym_api.receive_purchase_order($1,$2,$3,$4,$5,$6::jsonb) id', [f.org, request, f.warehouse, f.supplier, reference,
      JSON.stringify([{unit_id:unit, quantity, unit_cost:cost, batch_number:batch, expiry_date:expiry}])]);
    return r.rows[0].id;
  });
  f.sale = async (quantity = 1, { request = uuid(), items = f.cart(quantity), payment = 'cash', customer = null, enrollment = null, reservation = null, actor = f.cashier } = {}) => db.user(actor, async () => {
    const r = await db.query('select ym_api.process_pharmacy_sale($1,$2,$3,$4::jsonb,$5,$6,$7,$8) id', [f.org,request,f.warehouse,JSON.stringify(items),payment,customer,enrollment,reservation]);
    return r.rows[0].id;
  });
  f.reserve = async (quantity = 1, request = uuid(), items = f.cart(quantity)) => db.user(f.cashier, async () => {
    return (await db.query('select ym_api.reserve_online_order($1,$2,$3,$4::jsonb) id',[f.org,request,f.warehouse,JSON.stringify(items)])).rows[0].id;
  });
  return f;
}
