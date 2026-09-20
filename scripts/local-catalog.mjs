import { org } from "./local-support.mjs";

// Operator-only seed for the isolated training database; no fabricated transactions.
export async function seedCatalog(db, state) {
  const other = await db.query(
    "select id from ym.organizations where id<>$1 limit 1",
    [org],
  );
  if (other.rowCount || other.rows.length)
    throw new Error("Training seed refuses other organizations.");
  const i = state.ids;
  await db.query("begin");
  await db.query(
    "insert into ym.organizations(id,name,currency,timezone) values($1,'YmPharma — منشأة تدريب محلية','YER','Asia/Aden') on conflict do nothing",
    [org],
  );
  for (const a of state.accounts)
    await db.query(
      "insert into ym.members(org_id,user_id,role,active) values($1,$2,$3,true) on conflict do nothing",
      [org, a.id, a.role],
    );
  await db.query(
    "insert into ym.cost_centers values($1,$2,'TRAINING','مركز تدريب') on conflict do nothing",
    [org, i.center],
  );
  await db.query(
    "insert into ym.warehouses values($1,$2,'مخزن تدريب',$3,true) on conflict do nothing",
    [org, i.warehouse, i.center],
  );
  await db.query(
    "insert into ym.products(org_id,id,sku,trade_name) values($1,$2,'TRAINING-001','صنف تدريب غير طبي') on conflict do nothing",
    [org, i.product],
  );
  await db.query(
    "insert into ym.units(org_id,id,product_id,name,factor,selling_price,barcode) values($1,$2,$3,'قطعة',1,10,'TRAINING-001') on conflict do nothing",
    [org, i.unit, i.product],
  );
  await db.query(
    "insert into ym.parties values($1,$2,'مورد تدريب','supplier',true),($1,$3,'عميل تدريب','customer',true) on conflict do nothing",
    [org, i.supplier, i.customer],
  );
  const definitions = [
    ["1110", "صندوق التدريب", "asset", "cash"],
    ["1120", "بنك التدريب", "asset", "bank"],
    ["1200", "مخزون التدريب", "asset", "inventory"],
    ["1300", "ذمم تأمين التدريب", "asset", "insurance_receivable"],
    ["2100", "ذمم موردي التدريب", "liability", "payables"],
    ["4100", "إيرادات التدريب", "income", "revenue"],
    ["5100", "تكلفة مبيعات التدريب", "expense", "cogs"],
  ];
  for (const [code, name, kind, purpose] of definitions) {
    await db.query(
      "insert into ym.accounts(org_id,code,name,kind) values($1,$2,$3,$4) on conflict do nothing",
      [org, code, name, kind],
    );
    await db.query(
      "insert into ym.account_mappings select org_id,$3,id from ym.accounts where org_id=$1 and code=$2 on conflict do nothing",
      [org, code, purpose],
    );
  }
  await db.query(
    "insert into ym.periods values($1,date_trunc('month',now() at time zone 'Asia/Aden')::date,false) on conflict do nothing",
    [org],
  );
  // Keep an audit record for every successful seed invocation, never delete earlier events.
  await db.query(
    "insert into ym.audit_events(org_id,actor_id,action) values($1,$2,'local.training.seed')",
    [org, state.accounts.find((a) => a.role === "owner").id],
  );
  await db.query("commit");
}
