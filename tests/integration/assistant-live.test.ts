import { describe, it, expect } from "vitest";
import { createClient, type Session } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { authorizeAssistant, claimAssistantBudget } from "@/lib/ai/authorize";
import {
  createAssistantHandler,
  createAssistantLimiter,
} from "@/lib/ai/request-handler";
import { assistantResultSchema, type AssistantPlan } from "@/lib/ai/contracts";
import { pharmacyApi } from "@/lib/pharmacy/api";
import { reviewSaleDraft } from "@/lib/pharmacy/assistant";
import type { Database } from "@/lib/pharmacy/contracts";

const raw = process.env.YMPHARMA_SMOKE_CONTEXT;
type Context = {
  org: string;
  warehouse: string;
  unit: string;
  accounts: Record<string, { id: string; session: Session }>;
};
const context: Context = raw ? JSON.parse(raw) : null;
const plan: AssistantPlan = {
  action: "sale",
  search: "",
  explanation: "مسودة تدريب",
  payment: "cash",
  items: [{ search: "TEST", quantity: 2 }],
};
function request(
  role: string,
  org = context.org,
  warehouse = context.warehouse,
) {
  return new Request("http://localhost/api/ai/orchestrate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${context.accounts[role].session.access_token}`,
    },
    body: JSON.stringify({ org, warehouse, input: "بيع قطعتين نقداً" }),
  });
}
function handler(output = plan) {
  return createAssistantHandler({
    enabled: () => true,
    authorize: authorizeAssistant,
    plan: async () => output,
    acquire: createAssistantLimiter(),
    claimBudget: claimAssistantBudget,
  });
}
async function employee(role: string) {
  const client = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
  const signed = await client.auth.setSession(context.accounts[role].session);
  expect(signed.error).toBeNull();
  return { client, api: pharmacyApi(client, context.accounts[role].id) };
}
describe.skipIf(!raw)(
  "real local Auth and PostgREST; deterministic planner only",
  () => {
    it("validates real sessions and six employee roles through workspace_context", async () => {
      for (const role of [
        "owner",
        "manager",
        "accountant",
        "cashier",
        "pharmacist",
        "inventory",
      ]) {
        const result = await authorizeAssistant(
          context.accounts[role].session.access_token,
          context.org,
          context.warehouse,
          AbortSignal.timeout(10000),
        );
        expect(result.actor).toBe(context.accounts[role].id);
        expect(result.workspace.role).toBe(role);
      }
    });
    it("denies a real outsider and foreign organization/warehouse before planning", async () => {
      let calls = 0;
      const route = createAssistantHandler({
        enabled: () => true,
        authorize: authorizeAssistant,
        plan: async () => {
          calls++;
          return plan;
        },
        acquire: createAssistantLimiter(),
        claimBudget: claimAssistantBudget,
      });
      for (const req of [
        request("outsider"),
        request("cashier", randomUUID()),
        request("cashier", context.org, randomUUID()),
      ])
        expect((await route(req)).status).toBe(403);
      expect(calls).toBe(0);
    });
    it("enforces real role boundaries for sales and financial reports", async () => {
      expect((await handler()(request("inventory"))).status).toBe(403);
      const reports = { ...plan, action: "reports" as const, items: [] };
      expect((await handler(reports)(request("cashier"))).status).toBe(403);
      expect((await handler(reports)(request("accountant"))).status).toBe(200);
    });
    it("catalog-backed draft changes no stock; reviewed sale commits exactly once", async () => {
      const { api } = await employee("cashier");
      const available = async () =>
        (await api.units(context.org, context.warehouse, "TEST")).find(
          (x) => x.unit_id === context.unit,
        )!.available_base;
      const before = await available();
      const response = await handler()(request("cashier"));
      expect(response.status).toBe(200);
      const result = assistantResultSchema.parse(await response.json());
      expect(result.execution).toBe("not_executed");
      expect(result.requiresApproval).toBe(true);
      expect(await available()).toBe(before);
      const draft = reviewSaleDraft(result, [context.unit], ["2"], "cash");
      const input = {
        warehouse: context.warehouse,
        payment: draft.payment,
        items: draft.lines.map((x) => ({
          unit_id: x.unit.unit_id,
          quantity: x.quantity,
        })),
      };
      const reference = randomUUID();
      const invoice = await api.sell(context.org, reference, input);
      expect(await api.sell(context.org, reference, input)).toBe(invoice);
      expect(await available()).toBe(before - 2);
      const receipt = await api.receipt(context.org, invoice);
      expect(receipt).toBeTruthy();
      const accountant = await employee("accountant");
      const day = new Date().toISOString().slice(0, 10);
      const statement = await accountant.api.statement(context.org, {
        from: day,
        to: day,
        center: null,
        includeZero: false,
      });
      expect(statement.posted_journal_count).toBe(2);
      expect(statement.totals.debit).toBe(statement.totals.credit);
    });
    it("rejects a stale mutation after switching to another real user session", async () => {
      const { client, api } = await employee("cashier");
      await client.auth.setSession(context.accounts.manager.session);
      await expect(
        api.sell(context.org, randomUUID(), {
          warehouse: context.warehouse,
          payment: "cash",
          items: [{ unit_id: context.unit, quantity: 1 }],
        }),
      ).rejects.toThrow("تغيّر الحساب");
    });
  },
);
