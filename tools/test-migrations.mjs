import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const ids = {
  owner: '10000000-0000-0000-0000-000000000001',
  outsider: '10000000-0000-0000-0000-000000000002',
  merchant: '20000000-0000-0000-0000-000000000001',
  otherMerchant: '20000000-0000-0000-0000-000000000002',
  supplier: '30000000-0000-0000-0000-000000000001',
  product: '40000000-0000-0000-0000-000000000001',
  account: '50000000-0000-0000-0000-000000000001',
};

async function expectError(label, action, expected) {
  try {
    await action();
    assert.fail(`${label}: expected an error`);
  } catch (error) {
    assert.match(String(error.message), expected, label);
  }
}

async function asUser(userId) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${userId}',false);`);
}

async function asAdmin() {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false);`);
}

try {
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    grant usage on schema auth to authenticated,anon;
    grant execute on function auth.uid() to authenticated,anon;
    alter default privileges in schema public grant select,insert,update,delete on tables to authenticated;
    alter default privileges in schema public grant usage,select on sequences to authenticated;
  `);

  const migrationNames = (await readdir('supabase/migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();

  for (const name of migrationNames) {
    let sql = await readFile(`supabase/migrations/${name}`, 'utf8');
    if (name === '0001_mawsil_core.sql') {
      sql = sql.replace(
        'create extension if not exists pgcrypto with schema extensions;',
        () => `create or replace function extensions.digest(value text, algorithm text)
         returns bytea language sql immutable as $$
           select decode(md5(value || algorithm),'hex')
         $$;`,
      );
    }
    await db.exec(sql);
    console.log(`migration ok: ${name}`);
  }

  await db.exec(`
    insert into auth.users(id) values ('${ids.owner}'),('${ids.outsider}');
    insert into public.merchants(id,name,reporting_currency_code)
      values ('${ids.merchant}','Mawsil Test','YER_NEW'),
             ('${ids.otherMerchant}','Other Merchant','YER_NEW');
    insert into public.merchant_members(merchant_id,user_id,role)
      values ('${ids.merchant}','${ids.owner}','owner'),
             ('${ids.otherMerchant}','${ids.outsider}','owner');
    insert into public.suppliers(id,merchant_id,name)
      values ('${ids.supplier}','${ids.merchant}','Test Supplier');
    insert into public.products(id,merchant_id,name,unit,sale_price,cost_price)
      values ('${ids.product}','${ids.merchant}','Test Product','piece',150,100);
    insert into public.financial_accounts(id,merchant_id,name,account_type,currency_code)
      values ('${ids.account}','${ids.merchant}','Cash','cash','YER_NEW');
  `);

  await asUser(ids.owner);
  const purchase = await db.query(`
    select public.commit_purchase(
      '${ids.merchant}','${ids.supplier}',
      '[{"product_id":"${ids.product}","quantity":10,"unit_price":100}]'::jsonb,
      0,'YER_NEW','purchase-0001',null
    ) as result
  `);
  const purchaseId = purchase.rows[0].result.purchase_id;
  assert.equal(purchase.rows[0].result.total, 1000);

  const purchaseRetry = await db.query(`
    select public.commit_purchase(
      '${ids.merchant}','${ids.supplier}',
      '[{"product_id":"${ids.product}","quantity":10,"unit_price":100}]'::jsonb,
      0,'YER_NEW','purchase-0001',null
    ) as result
  `);
  assert.equal(purchaseRetry.rows[0].result.purchase_id, purchaseId);

  const paymentPayload = `jsonb_build_object(
    'merchant_id','${ids.merchant}'::uuid,'supplier_id','${ids.supplier}'::uuid,
    'account_id','${ids.account}'::uuid,'amount',400::numeric,
    'currency_code','YER_NEW','exchange_rate',1::numeric,'method','cash',
    'reference','SP-1','operation_type','supplier_payment.record'
  )`;
  const approval = await db.query(`
    select public.request_transaction_approval(
      '${ids.merchant}','supplier_payment.record',${paymentPayload},'supplier settlement','high',30
    ) as id
  `);
  const approvalId = approval.rows[0].id;
  await db.query(`select public.review_transaction_approval('${approvalId}','approved','ok')`);

  const supplierPaymentSql = `select public.record_supplier_payment(
    '${ids.merchant}','${ids.supplier}','${ids.account}',400,'YER_NEW',1,
    'cash','SP-1','supplier-payment-0001','${approvalId}'
  ) as result`;
  const payment = await db.query(supplierPaymentSql);
  assert.equal(payment.rows[0].result.remaining_debt, 600);
  const paymentRetry = await db.query(supplierPaymentSql);
  assert.equal(paymentRetry.rows[0].result.supplier_payment_id, payment.rows[0].result.supplier_payment_id);

  const reversiblePurchase = await db.query(`
    select public.commit_purchase(
      '${ids.merchant}','${ids.supplier}',
      '[{"product_id":"${ids.product}","quantity":3,"unit_price":100}]'::jsonb,
      0,'YER_NEW','purchase-0002',null
    ) as result
  `);
  const reversiblePurchaseId = reversiblePurchase.rows[0].result.purchase_id;
  const reversalPayload = `jsonb_build_object(
    'merchant_id','${ids.merchant}'::uuid,
    'purchase_id','${reversiblePurchaseId}'::uuid,
    'reason','supplier return','operation_type','purchase.reverse'
  )`;
  const reversalApproval = await db.query(`
    select public.request_transaction_approval(
      '${ids.merchant}','purchase.reverse',${reversalPayload},'supplier return','high',30
    ) as id
  `);
  const reversalApprovalId = reversalApproval.rows[0].id;
  await db.query(`select public.review_transaction_approval('${reversalApprovalId}','approved','ok')`);
  const reversalSql = `select public.reverse_purchase(
    '${ids.merchant}','${reversiblePurchaseId}','purchase-reversal-0001',
    'supplier return','${reversalApprovalId}'
  ) as result`;
  const reversal = await db.query(reversalSql);
  assert.equal(reversal.rows[0].result.purchase_status, 'cancelled');
  const reversalRetry = await db.query(reversalSql);
  assert.equal(reversalRetry.rows[0].result.operation_id, reversal.rows[0].result.operation_id);

  await db.query(`select public.record_exchange_rate(
    '${ids.merchant}','SAR','YER_NEW',425,'manual','2026-09-21T00:00:00Z'
  )`);

  const counts = await db.query(`
    select
      (select count(*)::int from public.purchases) purchases,
      (select count(*)::int from public.supplier_payments) supplier_payments,
      (select count(*)::int from public.financial_account_entries) account_entries,
      (select public.current_stock('${ids.merchant}','${ids.product}')::float8) stock,
      (select balance::float8 from public.suppliers where id='${ids.supplier}') supplier_balance
  `);
  assert.deepEqual(counts.rows[0], {
    purchases: 2,
    supplier_payments: 1,
    account_entries: 1,
    stock: 10,
    supplier_balance: 600,
  });

  await expectError(
    'idempotency payload mismatch',
    () => db.query(`select public.record_supplier_payment(
      '${ids.merchant}','${ids.supplier}','${ids.account}',300,'YER_NEW',1,
      'cash','SP-1','supplier-payment-0001','${approvalId}'
    )`),
    /IDEMPOTENCY_PAYLOAD_MISMATCH/,
  );

  await expectError(
    'direct ledger mutation',
    () => db.exec(`insert into public.financial_account_entries(
      merchant_id,account_id,operation_id,direction,entry_type,amount,currency_code,
      exchange_rate,reporting_amount,created_by
    ) select '${ids.merchant}','${ids.account}',id,'inflow','adjustment',1,'YER_NEW',1,1,'${ids.owner}'
      from public.transaction_operations limit 1`),
    /permission denied/,
  );

  await asUser(ids.outsider);
  const hidden = await db.query(`select count(*)::int count from public.suppliers where merchant_id='${ids.merchant}'`);
  assert.equal(hidden.rows[0].count, 0);
  await expectError(
    'cross-tenant RPC',
    () => db.query(`select public.commit_purchase(
      '${ids.merchant}','${ids.supplier}',
      '[{"product_id":"${ids.product}","quantity":1,"unit_price":100}]'::jsonb,
      0,'YER_NEW','purchase-cross-tenant',null
    )`),
    /PURCHASE_FORBIDDEN/,
  );

  await asAdmin();
  console.log('database invariants ok: migrations, RLS, idempotency, approval binding, ledger writes');
} finally {
  await db.close();
}
