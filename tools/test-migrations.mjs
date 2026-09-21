import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createNativeTestDatabase, testConcurrentTransactions } from './test-postgres.mjs';

const native = process.argv.includes('--postgres');
const db = native ? await createNativeTestDatabase() : new PGlite();
const ids = {
  owner: '10000000-0000-0000-0000-000000000001',
  outsider: '10000000-0000-0000-0000-000000000002',
  staff: '10000000-0000-0000-0000-000000000003',
  inventory: '10000000-0000-0000-0000-000000000004',
  merchant: '20000000-0000-0000-0000-000000000001',
  otherMerchant: '20000000-0000-0000-0000-000000000002',
  supplier: '30000000-0000-0000-0000-000000000001',
  returnSupplier: '30000000-0000-0000-0000-000000000002',
  customer: '60000000-0000-0000-0000-000000000001',
  product: '40000000-0000-0000-0000-000000000001',
  account: '50000000-0000-0000-0000-000000000001',
};
let rejectionChecks = 0;

async function expectError(label, action, expected) {
  try {
    await action();
    assert.fail(`${label}: expected an error`);
  } catch (error) {
    assert.match(String(error.message), expected, label);
    rejectionChecks += 1;
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
    do $$ begin
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
      if exists(select 1 from pg_roles where rolname in ('anon','authenticated')
        and (rolsuper or rolbypassrls or rolcreatedb or rolcreaterole or rolcanlogin)) then
        raise exception 'UNSAFE_TEST_ROLES';
      end if;
    end $$;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    grant usage on schema auth to authenticated,anon;
    grant execute on function auth.uid() to authenticated,anon;
    alter default privileges in schema public grant all on tables to authenticated;
    alter default privileges in schema public grant usage,select on sequences to authenticated;
  `);

  const migrationNames = (await readdir('supabase/migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();

  for (const name of migrationNames) {
    let sql = await readFile(`supabase/migrations/${name}`, 'utf8');
    if (!native && name === '0001_mawsil_core.sql') {
      sql = sql.replace(
        'create extension if not exists pgcrypto with schema extensions;',
        '-- PGlite only: pgcrypto is unavailable. No replacement/stub is installed.',
      );
    }
    await db.exec(sql);
    console.log(`migration ok: ${name}`);
  }
  assert.equal((await db.query(`select encode(sha256(convert_to('abc','UTF8')),'hex') hash`)).rows[0].hash,
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  if (!native) assert.equal((await db.query(`select to_regprocedure('extensions.digest(text,text)') digest`)).rows[0].digest, null);

  await db.exec(`
    insert into auth.users(id) values ('${ids.owner}'),('${ids.outsider}'),('${ids.staff}'),('${ids.inventory}');
    insert into public.merchants(id,name,reporting_currency_code)
      values ('${ids.merchant}','Mawsil Test','YER_NEW'),
             ('${ids.otherMerchant}','Other Merchant','YER_NEW');
    insert into public.merchant_members(merchant_id,user_id,role)
      values ('${ids.merchant}','${ids.owner}','owner'),
             ('${ids.otherMerchant}','${ids.outsider}','owner'),
             ('${ids.merchant}','${ids.staff}','staff'),
             ('${ids.merchant}','${ids.inventory}','inventory');
    insert into public.suppliers(id,merchant_id,name)
      values ('${ids.supplier}','${ids.merchant}','Test Supplier'),
             ('${ids.returnSupplier}','${ids.merchant}','Return Supplier');
    insert into public.customers(id,merchant_id,name,credit_limit)
      values ('${ids.customer}','${ids.merchant}','Test Customer',1000);
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
      '${ids.merchant}','${ids.returnSupplier}',
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
    /OPERATION_FORBIDDEN/,
  );

  await expectError('stock RPC must not leak another tenant',
    () => db.query('select public.current_stock($1,$2)', [ids.merchant, ids.product]), /MERCHANT_ACCESS_DENIED/);
  for (const name of ['reverse_sale', 'reverse_purchase']) {
    await expectError('nonmember reversal ' + name,
      () => db.query(`select public.${name}($1,$2,'outsider-reversal','invalid reversal',null)`,
        [ids.merchant, purchaseId]), /OPERATION_FORBIDDEN/);
  }
  await asUser(ids.owner);

  const items = JSON.stringify([{ product_id: ids.product, quantity: 1, unit_price: 100 }]);
  const saleSql = 'select public.commit_sale($1,$2,$3::jsonb,$4,$5,$6,null) result';
  const saleArgs = [ids.merchant, ids.customer, items, 0, 'YER_NEW', 'sale-credit-0001'];
  const sale = (await db.query(saleSql, saleArgs)).rows[0].result;
  assert.equal(sale.debt, 100);
  const customerPaymentSql = "select public.record_customer_payment($1,$2,100,'YER_NEW','cash','CP-1','customer-pay-0001',null) result";
  const customerPaymentArgs = [ids.merchant, ids.customer];
  const customerPayment = (await db.query(customerPaymentSql, customerPaymentArgs)).rows[0].result;
  assert.equal(customerPayment.remaining_debt, 0);
  assert.deepEqual((await db.query(customerPaymentSql, customerPaymentArgs)).rows[0].result, customerPayment);
  assert.deepEqual((await db.query(saleSql, saleArgs)).rows[0].result, sale);

  async function approve(action, payload) {
    const row = (await db.query('select public.request_transaction_approval($1,$2,$3::jsonb) id',
      [ids.merchant, action, JSON.stringify({ merchant_id: ids.merchant, operation_type: action, ...payload })])).rows[0];
    await db.query("select public.review_transaction_approval($1,'approved')", [row.id]);
    return row.id;
  }
  const settledApproval = await approve('sale.reverse', { sale_id: sale.sale_id, reason: 'return after settlement' });
  await expectError('settled sale requires refund accounting',
    () => db.query('select public.reverse_sale($1,$2,$3,$4,$5)',
      [ids.merchant, sale.sale_id, 'settled-sale-return', 'return after settlement', settledApproval]),
    /SETTLED_REVERSAL_REQUIRES_REFUND_ENGINE/);

  await expectError('anonymous credit sale',
    () => db.query(saleSql, [ids.merchant, null, items, 0, 'YER_NEW', 'anonymous-credit']),
    /CREDIT_CUSTOMER_REQUIRED/);
  await db.query('select public.set_customer_credit_limit($1,$2,50)', [ids.merchant, ids.customer]);
  await expectError('credit limit enforced',
    () => db.query(saleSql, [...saleArgs.slice(0,5), 'over-credit-limit']), /CREDIT_LIMIT_EXCEEDED/);
  await db.query('select public.set_customer_credit_limit($1,$2,1000)', [ids.merchant, ids.customer]);
  await expectError('cross-currency balance mixing is blocked',
    () => db.query(saleSql, [ids.merchant, ids.customer, items, 0, 'SAR', 'cross-currency-sale']),
    /MULTI_CURRENCY_NOT_READY/);
  await expectError('duplicate product lines rejected atomically',
    () => db.query(saleSql, [ids.merchant, ids.customer, JSON.stringify([...JSON.parse(items), ...JSON.parse(items)]), 0, 'YER_NEW', 'duplicate-lines']),
    /DUPLICATE_OR_MISSING_PRODUCT/);
  for (const paid of ['NaN', 'Infinity', '-Infinity', '-1', '0.001', null]) {
    await expectError('invalid paid ' + paid,
      () => db.query(saleSql, [ids.merchant, ids.customer, items, paid, 'YER_NEW', 'invalid-paid-' + paid]), /INVALID_PAID_AMOUNT/);
  }
  for (const amount of ['NaN', 'Infinity', '-1', '0', '0.001', null]) {
    await expectError('invalid expense ' + amount,
      () => db.query("select public.record_expense($1,'rent',$2,'YER_NEW',null,$3,null)",
        [ids.merchant, amount, 'invalid-expense-' + amount]), /INVALID_EXPENSE_AMOUNT/);
  }
  await expectError('missing quantity rejected',
    () => db.query(saleSql, [ids.merchant, ids.customer, JSON.stringify([{ product_id: ids.product, unit_price: 1 }]), 0, 'YER_NEW', 'missing-quantity']),
    /INVALID_ITEM/);
  await expectError('consumed approval cannot authorize new operation',
    () => db.query(`select public.record_supplier_payment(
      '${ids.merchant}','${ids.supplier}','${ids.account}',400,'YER_NEW',1,
      'cash','SP-1','supplier-payment-0002','${approvalId}')`), /VALID_APPROVAL_REQUIRED/);
  await expectError('null approval decision rejected',
    () => db.query('select public.review_transaction_approval($1,null)', [settledApproval]), /INVALID_APPROVAL_DECISION/);
  await expectError('approval payload/action must match',
    () => db.query("select public.request_transaction_approval($1,'expense.record','{}'::jsonb)", [ids.merchant]), /INVALID_APPROVAL_PAYLOAD/);
  const adjustment = { product_id: ids.product, quantity_delta: -1, reason: 'adjustment' };
  const adjustmentApproval = await approve('inventory.adjust', adjustment);
  const adjustmentSql = "select public.adjust_inventory($1,$2,-1,'adjustment','stock-adjust-0001',$3) result";
  const adjustmentArgs = [ids.merchant, ids.product, adjustmentApproval];
  const adjusted = (await db.query(adjustmentSql, adjustmentArgs)).rows[0].result;
  assert.equal(adjusted.stock_after, 8);
  assert.deepEqual((await db.query(adjustmentSql, adjustmentArgs)).rows[0].result, adjusted);
  const expiryApproval = await approve('inventory.adjust', { ...adjustment, quantity_delta: 1, reason: 'expiry' });
  await expectError('expiry cannot increase stock',
    () => db.query("select public.adjust_inventory($1,$2,1,'expiry','invalid-expiry-0001',$3)",
      [ids.merchant, ids.product, expiryApproval]), /INVALID_EXPIRY_DIRECTION/);
  const openingApproval = await approve('inventory.adjust', { ...adjustment, quantity_delta: 1, reason: 'opening' });
  await expectError('opening stock cannot be added twice',
    () => db.query("select public.adjust_inventory($1,$2,1,'opening','invalid-opening-0001',$3)",
      [ids.merchant, ids.product, openingApproval]), /OPENING_BALANCE_ALREADY_EXISTS/);

  const expiring = await approve('inventory.adjust', adjustment);
  await asAdmin();
  await db.query("update public.approval_requests set expires_at=now()-interval '1 minute' where id=$1", [expiring]);
  await asUser(ids.owner);
  await expectError('expired approval',
    () => db.query("select public.adjust_inventory($1,$2,-1,'adjustment','expired-approval-0001',$3)",
      [ids.merchant, ids.product, expiring]), /VALID_APPROVAL_REQUIRED/);
  const tampered = await approve('inventory.adjust', adjustment);
  await asAdmin();
  await db.query("update public.approval_requests set payload_hash='forged' where id=$1", [tampered]);
  await asUser(ids.owner);
  await expectError('tampered approval digest',
    () => db.query("select public.adjust_inventory($1,$2,-1,'adjustment','tampered-approval-0001',$3)",
      [ids.merchant, ids.product, tampered]), /VALID_APPROVAL_REQUIRED/);
  for (const statement of [
    'delete from public.customers',
    'delete from public.suppliers',
    'truncate public.inventory_movements cascade',
    'update public.customers set balance=500',
    'update public.customers set credit_limit=5000',
    "update public.products set unit='carton'",
    "update public.financial_accounts set currency_code='SAR'",
    "update public.merchants set reporting_currency_code='SAR'",
    "update public.audit_logs set action='forged'",
    'delete from public.audit_logs',
    "select mawsil_private.execute_operation('{}','private-bypass',null)",
  ]) {
    await expectError('direct write/private engine blocked: ' + statement,
      () => db.exec(statement), /permission denied/);
  }
  await expectError('invalid exchange rate',
    () => db.query("select public.record_exchange_rate($1,'SAR','YER_NEW','NaN','manual',now())", [ids.merchant]), /INVALID_EXCHANGE_RATE/);
  const beforeFailure = (await db.query("select count(*)::int n from public.transaction_operations")).rows[0].n;
  await expectError('out of stock rolls back operation',
    () => db.query(saleSql, [ids.merchant, ids.customer, JSON.stringify([{ product_id: ids.product, quantity: 100, unit_price: 1 }]), 0, 'YER_NEW', 'insufficient-stock']),
    /INSUFFICIENT_STOCK/);
  assert.equal((await db.query("select count(*)::int n from public.transaction_operations")).rows[0].n, beforeFailure);
  assert.equal(Number((await db.query('select public.current_stock($1,$2) stock', [ids.merchant, ids.product])).rows[0].stock), 8);

  await asUser(ids.staff);
  await expectError('staff cannot change credit limit',
    () => db.query('select public.set_customer_credit_limit($1,$2,10000)', [ids.merchant, ids.customer]), /CREDIT_LIMIT_FORBIDDEN/);
  await expectError('staff cannot reuse owner operation',
    () => db.query(saleSql, saleArgs), /IDEMPOTENCY_ACTOR_MISMATCH/);
  await expectError('staff cannot purchase',
    () => db.query("select public.commit_purchase($1,$2,$3::jsonb,0,'YER_NEW','staff-purchase-0001',null)", [ids.merchant, ids.supplier, items]),
    /OPERATION_FORBIDDEN/);
  await expectError('staff cannot review approval',
    () => db.query("select public.review_transaction_approval($1,'approved')", [expiryApproval]), /APPROVAL_REVIEW_FORBIDDEN/);
  await asUser(ids.inventory);
  await expectError('inventory role cannot sell',
    () => db.query(saleSql, [...saleArgs.slice(0,5), 'inventory-role-sale']), /OPERATION_FORBIDDEN/);
  await expectError('approval cannot be executed by a different requester',
    () => db.query("select public.adjust_inventory($1,$2,1,'expiry','wrong-requester-0001',$3)",
      [ids.merchant, ids.product, expiryApproval]), /VALID_APPROVAL_REQUIRED/);
  await asUser(ids.owner);
  await db.exec('begin isolation level repeatable read');
  await expectError('fixed transaction snapshot rejected',
    () => db.query(saleSql, [...saleArgs.slice(0,5), 'fixed-snapshot-sale']), /UNSUPPORTED_TRANSACTION_ISOLATION/);
  await db.exec('rollback');
  await asAdmin();
  await db.exec(`
    create function public.test_fail_audit() returns trigger language plpgsql as $$
    begin
      if new.request_id='forced-audit-failure' then raise exception 'TEST_AUDIT_FAILURE'; end if;
      return new;
    end $$;
    create trigger test_fail_audit before insert on public.audit_logs for each row execute function public.test_fail_audit();
  `);
  await asUser(ids.owner);
  const beforeRollback = (await db.query(`select
    (select count(*)::int from public.sales) sales,
    (select count(*)::int from public.sale_items) items,
    (select count(*)::int from public.transaction_operations) operations,
    (select count(*)::int from public.inventory_movements) movements,
    (select balance from public.customers where id='${ids.customer}') balance`)).rows[0];
  await expectError('failure at final audit write rolls back all preceding writes',
    () => db.query(saleSql, [...saleArgs.slice(0,5), 'forced-audit-failure']), /TEST_AUDIT_FAILURE/);
  const afterRollback = (await db.query(`select
    (select count(*)::int from public.sales) sales,
    (select count(*)::int from public.sale_items) items,
    (select count(*)::int from public.transaction_operations) operations,
    (select count(*)::int from public.inventory_movements) movements,
    (select balance from public.customers where id='${ids.customer}') balance`)).rows[0];
  assert.deepEqual(afterRollback, beforeRollback);
  await asAdmin();
  await db.exec(`drop trigger test_fail_audit on public.audit_logs; drop function public.test_fail_audit();`);
  const returnCustomer = '60000000-0000-0000-0000-000000000002';
  await db.query('insert into public.customers(id,merchant_id,name,credit_limit) values ($1,$2,$3,1000)',
    [returnCustomer, ids.merchant, 'Return Customer']);
  await asUser(ids.owner);
  const unpaidSale = (await db.query(saleSql, [ids.merchant, returnCustomer, items, 0, 'YER_NEW', 'unpaid-return-sale'])).rows[0].result;
  const saleReturnApproval = await approve('sale.reverse', { sale_id: unpaidSale.sale_id, reason: 'unpaid return' });
  const saleReturnSql = "select public.reverse_sale($1,$2,'sale-reversal-0001','unpaid return',$3) result";
  const saleReturnArgs = [ids.merchant, unpaidSale.sale_id, saleReturnApproval];
  const saleReturn = (await db.query(saleReturnSql, saleReturnArgs)).rows[0].result;
  assert.equal(saleReturn.sale_status, 'reversed');
  assert.deepEqual((await db.query(saleReturnSql, saleReturnArgs)).rows[0].result, saleReturn);
  assert.equal(Number((await db.query('select balance from public.customers where id=$1', [returnCustomer])).rows[0].balance), 0);
  assert.equal(Number((await db.query('select public.current_stock($1,$2) stock', [ids.merchant, ids.product])).rows[0].stock), 8);
  await asUser('');
  await expectError('authenticated role without JWT user',
    () => db.query(saleSql, saleArgs), /AUTH_REQUIRED/);
  await db.exec('set role anon');
  await expectError('anonymous RPC permission',
    () => db.query(saleSql, saleArgs), /permission denied/);


  await asAdmin();
  await expectError('audit trigger also rejects privileged row mutation',
    () => db.exec("update public.audit_logs set action='forged'"), /audit_logs are immutable/);
  if (native) await testConcurrentTransactions(db, ids);
  console.log('Expected rejection checks passed:', rejectionChecks);
  console.log(native
    ? 'Native PostgreSQL checks passed, including independent-session races; Supabase integration is still a separate release gate.'
    : 'PGlite single-session checks passed with native SHA-256 (no pgcrypto stub). Concurrency and Supabase are NOT tested by this run.');
} finally {
  await db.close();
}
