import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

test('legacy migrations replay and block forged supplier balances and cross-tenant inserts', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec(`create role authenticated; create role anon; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to authenticated;
      grant execute on function auth.uid() to authenticated;
      alter default privileges in schema public grant all on tables to authenticated;`);
    const folder = new URL('../../../supabase/migrations/', import.meta.url);
    for (const file of (await readdir(folder)).filter(f => f.endsWith('.sql')).sort()) {
      await db.exec(await readFile(new URL(file, folder), 'utf8'));
    }
    const actor = '00000000-0000-4000-8000-000000000001';
    const org = '00000000-0000-4000-8000-000000000002';
    const other = '00000000-0000-4000-8000-000000000003';
    await db.exec(`insert into auth.users values ('${actor}');
      insert into merchants(id,name) values ('${org}','Own'),('${other}','Other');
      insert into merchant_members(merchant_id,user_id,role) values ('${org}','${actor}','inventory');
      set role authenticated; select set_config('request.jwt.claim.sub','${actor}',false);`);
    await db.query('insert into suppliers(merchant_id,name) values ($1,$2)', [org,'Allowed']);
    await assert.rejects(db.query('insert into suppliers(merchant_id,name) values ($1,$2)', [other,'Denied']), /row-level security/);
    await assert.rejects(db.query('insert into suppliers(merchant_id,name,balance) values ($1,$2,900)', [org,'Forged']), /permission denied/);
    await assert.rejects(db.query('update suppliers set balance=900'), /permission denied/);
    const result = await db.query('select name,balance from suppliers');
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].balance, '0.00');
  } finally { await db.close(); }
});
