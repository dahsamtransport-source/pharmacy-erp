import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// This harness never connects to a cloud database or reuses an application database.
export async function createNativeTestDatabase() {
  const raw = process.env.MAWSIL_TEST_DATABASE_URL;
  if (!raw) throw new Error('MAWSIL_TEST_DATABASE_URL is required for --postgres');
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.pathname !== '/postgres' || url.search) {
    throw new Error('Use an explicit loopback /postgres test-server URL without query parameters');
  }
  const { Client } = await import('pg');
  const admin = new Client({ connectionString: raw, connectionTimeoutMillis: 5000 });
  await admin.connect();
  const name = 'mawsil_test_' + randomUUID().replaceAll('-', '');
  let created = false;
  let client;
  try {
    await admin.query('CREATE DATABASE "' + name + '"');
    created = true;
    url.pathname = '/' + name;
    const connect = async () => {
      const connection = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
      await connection.connect();
      await connection.query("set statement_timeout = '15s'; set lock_timeout = '10s';");
      return connection;
    };
    client = await connect();
    return {
      query: (sql, values) => client.query(sql, values),
      exec: (sql) => client.query(sql),
      connect,
      close: async () => {
        await client.end();
        try { await admin.query('DROP DATABASE "' + name + '"'); }
        finally { await admin.end(); }
      },
    };
  } catch (error) {
    await client?.end();
    try { if (created) await admin.query('DROP DATABASE "' + name + '"'); }
    finally { await admin.end(); }
    throw error;
  }
}

async function waitForLock(db, pid) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await db.query('select wait_event_type from pg_stat_activity where pid=$1', [pid]);
    if (rows[0]?.wait_event_type === 'Lock') return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('The second independent session did not wait on the transaction lock');
}

export async function testConcurrentTransactions(db, ids) {
  for (const scenario of ['last-stock', 'same-key', 'rollback']) {
    const product = randomUUID();
    await db.query(`insert into public.products(id,merchant_id,name,unit) values ($1,$2,$3,'piece')`,
      [product, ids.merchant, scenario]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [ids.owner]);
    await db.query('select public.commit_purchase($1,null,$2::jsonb,10,\'YER_NEW\',$3,null)',
      [ids.merchant, JSON.stringify([{ product_id: product, quantity: 1, unit_price: 10 }]), 'seed-' + scenario]);
    const a = await db.connect();
    const b = await db.connect();
    try {
      for (const connection of [a, b]) {
        await connection.query('begin; set local role authenticated;');
        await connection.query("select set_config('request.jwt.claim.sub',$1,true)", [ids.owner]);
      }
      const pid = (await b.query('select pg_backend_pid() pid')).rows[0].pid;
      const sql = 'select public.commit_sale($1,null,$2::jsonb,10,\'YER_NEW\',$3,null) result';
      const args = [ids.merchant, JSON.stringify([{ product_id: product, quantity: 1, unit_price: 10 }]), 'race-a-' + scenario];
      const first = (await a.query(sql, args)).rows[0].result;
      const pending = b.query(sql, [...args.slice(0, 2), scenario === 'same-key' ? args[2] : 'race-b-' + scenario])
        .then((value) => ({ value }), (error) => ({ error }));
      await waitForLock(db, pid);
      await a.query(scenario === 'rollback' ? 'rollback' : 'commit');
      const second = await pending;
      if (scenario === 'last-stock') {
        assert.match(second.error?.message ?? '', /INSUFFICIENT_STOCK/);
        await b.query('rollback');
      } else {
        if (second.error) throw second.error;
        if (scenario === 'same-key') assert.deepEqual(second.value.rows[0].result, first);
        else assert.notEqual(second.value.rows[0].result.sale_id, first.sale_id);
        await b.query('commit');
      }
      const check = await db.query(`select
        (select count(*)::int from public.sale_items where product_id=$1) sales,
        (select sum(quantity_delta)::float8 from public.inventory_movements where product_id=$1) stock`, [product]);
      assert.deepEqual(check.rows[0], { sales: 1, stock: 0 });
      console.log('independent-session race passed:', scenario);
    } finally {
      await Promise.all([a.query('rollback').catch(() => {}), b.query('rollback').catch(() => {})]);
      await Promise.all([a.end(), b.end()]);
    }
  }
}
