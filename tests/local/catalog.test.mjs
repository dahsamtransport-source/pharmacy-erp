import test from "node:test";
import assert from "node:assert/strict";
import {
  openDatabase,
  migrate,
  uuid,
} from "../../sprints/01-database/tests/harness.mjs";
import { seedCatalog } from "../../scripts/local-catalog.mjs";
import { roles, org } from "../../scripts/local-support.mjs";

test("local catalog seed supports real role-scoped RPCs, is repeatable, and fabricates no transactions", async () => {
  // Deliberately disallow a native target here; the existing harness resets schemas.
  assert.equal(process.env.YMPHARMA_TEST_DATABASE_URL, undefined);
  const db = await openDatabase();
  try {
    await migrate(db);
    const state = {
      accounts: roles.map((role) => ({ role, id: uuid() })),
      ids: Object.fromEntries(
        ["center", "warehouse", "product", "unit", "supplier", "customer"].map(
          (key) => [key, uuid()],
        ),
      ),
    };
    for (const a of state.accounts)
      await db.query("insert into auth.users(id) values($1)", [a.id]);
    await seedCatalog(db, state);
    await seedCatalog(db, state);
    for (const [table, count] of [
      ["organizations", 1],
      ["members", 6],
      ["accounts", 7],
      ["account_mappings", 7],
      ["products", 1],
      ["units", 1],
      ["invoices", 0],
      ["batches", 0],
      ["journals", 0],
      ["audit_events", 2],
    ]) {
      const result = await db.query(
        `select count(*)::int count from ym.${table}`,
      );
      assert.equal(result.rows[0].count, count, table);
    }
    for (const a of state.accounts) {
      const result = await db.user(a.id, () =>
        db.query("select ym_api.workspace_context() context"),
      );
      assert.equal(result.rows[0].context[0].id, org);
      assert.equal(result.rows[0].context[0].role, a.role);
    }
    const owner = state.accounts.find((a) => a.role === "owner");
    const report = await db.user(owner.id, () =>
      db.query(
        "select ym_api.financial_report_v2($1,current_date,current_date,null,false) report",
        [org],
      ),
    );
    assert.equal(report.rows[0].report.totals.has_data, false);
    const cashier = state.accounts.find((a) => a.role === "cashier");
    await assert.rejects(
      db.user(cashier.id, () =>
        db.query("select ym_api.financial_report_options($1)", [org]),
      ),
      /FORBIDDEN/,
    );
    await db.query(
      "insert into ym.organizations values($1,'Other','YER','Asia/Aden')",
      [uuid()],
    );
    await assert.rejects(seedCatalog(db, state), /refuses other organizations/);
  } finally {
    await db.close();
  }
});
