import { it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import FinancialReports from "@/FinancialReports";
import {
  financialStatementSchema,
  statementCsv,
  validReportRange,
  businessDateInZone,
  type FinancialStatement,
  type StatementAccount,
} from "@/lib/pharmacy/financial";
import { ApiFailure, pharmacyApi } from "@/lib/pharmacy/api";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/pharmacy/contracts";
import { ids, apiFixture, workspace } from "./fixtures";

const financeWorkspace = { ...workspace, role: "accountant" as const };
const zero = { opening: "0.00", opening_debit: "0.00", opening_credit: "0.00" };
const accounts: StatementAccount[] = [
  {
    ...zero,
    id: ids.unit,
    code: "1110",
    name: "الصندوق",
    kind: "asset",
    is_cogs: false,
    debit: "100.00",
    credit: "40.00",
    closing: "60.00",
    closing_debit: "60.00",
    closing_credit: "0.00",
    normal_balance: "60.00",
  },
  {
    ...zero,
    id: ids.product,
    code: "4100",
    name: "إيراد الصيدلية",
    kind: "income",
    is_cogs: false,
    debit: "0.00",
    credit: "100.00",
    closing: "-100.00",
    closing_debit: "0.00",
    closing_credit: "100.00",
    normal_balance: "100.00",
  },
  {
    ...zero,
    id: ids.invoice,
    code: "5100",
    name: "تكلفة الأدوية المباعة",
    kind: "expense",
    is_cogs: true,
    debit: "40.00",
    credit: "0.00",
    closing: "40.00",
    closing_debit: "40.00",
    closing_credit: "0.00",
    normal_balance: "40.00",
  },
];
const sample: FinancialStatement = {
  org_id: ids.org,
  organization: "منشأة التقارير للاختبار",
  currency: "YER",
  timezone: "Asia/Aden",
  from: "2026-09-01",
  to: "2026-09-20",
  cost_center: null,
  generated_at: "2026-09-20T12:00:00+00:00",
  include_zero: false,
  posted_journal_count: 2,
  accounts,
  totals: {
    opening_debit: "0.00",
    opening_credit: "0.00",
    debit: "140.00",
    credit: "140.00",
    closing_debit: "100.00",
    closing_credit: "100.00",
    balanced: true,
    has_data: true,
  },
  income: {
    revenue: "100.00",
    cost_of_sales: "40.00",
    operating_expenses: "0.00",
    gross_profit: "60.00",
    net_income: "60.00",
  },
};
function financeApi() {
  const api = apiFixture();
  vi.mocked(api.statement).mockResolvedValue(structuredClone(sample));
  return api;
}

it("trial balance opens the selected account ledger with the applied report scope", async () => {
  const api = financeApi();
  vi.mocked(api.ledger).mockResolvedValue({
    org_id: ids.org,
    organization_name: sample.organization,
    currency: sample.currency,
    account: { id: ids.unit, code: "1110", name: "الصندوق", kind: "asset" },
    from: sample.from,
    to: sample.to,
    center_id: null,
    generated_at: sample.generated_at,
    opening: "60.00",
    debit: "0.00",
    credit: "0.00",
    closing: "60.00",
    count: 0,
    entries: [],
  });
  mount(api);
  fireEvent.click(
    await screen.findByRole("button", { name: "كشف حركة الصندوق" }),
  );
  await screen.findByText("لا توجد حركة مرحّلة في الفترة");
  expect(api.ledger).toHaveBeenCalledWith(ids.org, ids.unit, {
    from: sample.from,
    to: sample.to,
    center: null,
    includeZero: false,
  });
  expect(screen.getByRole("dialog")).toBeTruthy();
});
const mount = (api = financeApi()) => {
  render(
    <FinancialReports
      api={api}
      workspace={financeWorkspace}
      businessDate="2026-09-20"
    />,
  );
  return api;
};
const rawApi = (data: unknown, error: unknown = null) => {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  const client = {
    schema: vi.fn(() => ({ rpc })),
  } as unknown as SupabaseClient<Database>;
  return { api: pharmacyApi(client), rpc };
};

it("initial business day uses the organization timezone across month boundaries", () => {
  expect(
    businessDateInZone("Asia/Aden", new Date("2026-02-28T22:30:00Z")),
  ).toBe("2026-03-01");
  expect(
    businessDateInZone("America/Los_Angeles", new Date("2026-03-01T01:30:00Z")),
  ).toBe("2026-02-28");
});
it("RPC adapter sends explicit financial scope and validates the server snapshot", async () => {
  const { api, rpc } = rawApi(sample);
  const range = {
    from: sample.from,
    to: sample.to,
    center: null,
    includeZero: false,
  };
  expect(await api.statement(ids.org, range)).toEqual(sample);
  expect(rpc).toHaveBeenCalledWith("financial_report_v2", {
    p_org: ids.org,
    p_from: sample.from,
    p_to: sample.to,
    p_center: null,
    p_include_zero: false,
  });
});
it("RPC adapter rejects a response for another organization or period", async () => {
  const range = {
    from: sample.from,
    to: sample.to,
    center: null,
    includeZero: false,
  };
  for (const data of [
    { ...sample, org_id: ids.warehouse },
    { ...sample, to: "2026-09-21" },
  ])
    await expect(rawApi(data).api.statement(ids.org, range)).rejects.toThrow(
      /غير متوافقة/,
    );
});
it("RPC errors do not expose raw upstream database messages", async () => {
  const { api } = rawApi(null, {
    code: "42501",
    message: "private database diagnostic",
  });
  await expect(
    api.statement(ids.org, {
      from: sample.from,
      to: sample.to,
      center: null,
      includeZero: false,
    }),
  ).rejects.toThrow("لا تملك صلاحية هذه العملية.");
});

it("validates exact balances and rejects wrong totals, rows and income", () => {
  expect(financialStatementSchema.safeParse(sample).success).toBe(true);
  const badTotal = structuredClone(sample);
  badTotal.totals.debit = "140.01";
  const badRow = structuredClone(sample);
  badRow.accounts[0].closing = "59.99";
  const badIncome = structuredClone(sample);
  badIncome.income.net_income = "61.00";
  for (const report of [badTotal, badRow, badIncome])
    expect(financialStatementSchema.safeParse(report).success).toBe(false);
});
it("rejects duplicate accounts and a forged balanced flag", () => {
  const duplicate = structuredClone(sample);
  duplicate.accounts.push(duplicate.accounts[0]);
  expect(financialStatementSchema.safeParse(duplicate).success).toBe(false);
  expect(
    financialStatementSchema.safeParse({
      ...sample,
      totals: { ...sample.totals, balanced: false },
    }).success,
  ).toBe(false);
});
it("malformed decimals and timezone produce validation errors instead of runtime crashes", () => {
  const bad = structuredClone(sample);
  bad.accounts[0].debit = "not-a-number";
  expect(() => financialStatementSchema.safeParse(bad)).not.toThrow();
  expect(financialStatementSchema.safeParse(bad).success).toBe(false);
  expect(
    financialStatementSchema.safeParse({ ...sample, timezone: "Invalid/Zone" })
      .success,
  ).toBe(false);
});
it("CSV preserves Arabic, precision, negative numbers and neutralizes formulas in text", () => {
  const report = structuredClone(sample);
  report.organization = ' =HYPERLINK("bad")';
  report.accounts[0].name = "@SUM(1,2)\nاسم";
  report.accounts[0].debit = "90071992547409.41";
  report.income.net_income = "-20.01";
  const trial = statementCsv(report, "trial"),
    income = statementCsv(report, "income");
  expect(trial.startsWith("\uFEFF")).toBe(true);
  expect(trial).toContain("' =HYPERLINK");
  expect(trial).toContain("'@SUM");
  expect(trial).toContain('""bad""');
  expect(trial).toContain('"90071992547409.41"');
  expect(income).toContain('"-20.01"');
});
it("validates calendar dates and bounded date intervals without UTC end-of-day timestamps", () => {
  const range = {
    from: "2026-09-01",
    to: "2026-09-20",
    center: null,
    includeZero: false,
  };
  expect(validReportRange(range)).toBe(true);
  for (const invalid of [
    { ...range, to: "2026-08-31" },
    { ...range, from: "2026-02-30" },
    { ...range, from: "2024-01-01" },
  ])
    expect(validReportRange(invalid)).toBe(false);
});
it("loads the organization report with all cost centers and shows server metadata", async () => {
  const api = mount();
  expect(await screen.findByText(sample.organization)).toBeTruthy();
  expect(api.statement).toHaveBeenCalledWith(ids.org, {
    from: "2026-09-01",
    to: "2026-09-20",
    center: null,
    includeZero: false,
  });
  expect(screen.getByText(/متوازنة عدديًا/)).toBeTruthy();
  expect(screen.queryByText("صيدلية المصلي - YmPharma")).toBeNull();
});
it("switches income tab without a second fetch and separates COGS from operating expenses", async () => {
  const api = mount();
  await screen.findByText(sample.organization);
  fireEvent.click(screen.getByRole("tab", { name: "قائمة الدخل" }));
  expect(screen.getByRole("heading", { name: "تكلفة المبيعات" })).toBeTruthy();
  expect(screen.getByText("تكلفة الأدوية المباعة")).toBeTruthy();
  expect(
    screen.getByRole("heading", { name: "المصروفات التشغيلية" }),
  ).toBeTruthy();
  expect(api.statement).toHaveBeenCalledTimes(1);
});
it("cannot print draft filters; after applying, printed metadata matches the returned period", async () => {
  const api = mount();
  await screen.findByText(sample.organization);
  const print = vi.spyOn(window, "print").mockImplementation(() => {});
  fireEvent.change(screen.getByLabelText("إلى تاريخ"), {
    target: { value: "2026-09-21" },
  });
  expect(
    (screen.getByRole("button", { name: "طباعة التقرير" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.getByText(/تغيّرت عوامل التصفية/)).toBeTruthy();
  expect(screen.getByText("2026-09-20")).toBeTruthy();
  vi.mocked(api.statement).mockResolvedValue({ ...sample, to: "2026-09-21" });
  fireEvent.click(screen.getByRole("button", { name: "تحديث التقرير" }));
  await screen.findByText("2026-09-21");
  fireEvent.click(screen.getByRole("button", { name: "طباعة التقرير" }));
  expect(print).toHaveBeenCalledTimes(1);
});
it("refresh button re-fetches even when the date range has not changed", async () => {
  const api = mount();
  await screen.findByText(sample.organization);
  fireEvent.click(screen.getByRole("button", { name: "تحديث التقرير" }));
  await waitFor(() => expect(api.statement).toHaveBeenCalledTimes(2));
});
it("cost center and zero-account filters are passed explicitly to the server", async () => {
  const api = financeApi();
  const center = { id: ids.request, code: "PH", name: "الصيدلية" };
  vi.mocked(api.reportOptions).mockResolvedValue([center]);
  mount(api);
  await screen.findByRole("option", { name: "PH · الصيدلية" });
  await screen.findByText(sample.organization);
  fireEvent.change(screen.getByLabelText("مركز التكلفة"), {
    target: { value: center.id },
  });
  fireEvent.click(screen.getByLabelText("إظهار الحسابات دون أرصدة أو حركة"));
  fireEvent.click(screen.getByRole("button", { name: "تحديث التقرير" }));
  await waitFor(() =>
    expect(api.statement).toHaveBeenLastCalledWith(ids.org, {
      from: "2026-09-01",
      to: "2026-09-20",
      center: center.id,
      includeZero: true,
    }),
  );
});
it("empty posted ledger never displays a success balance badge", async () => {
  const api = financeApi();
  vi.mocked(api.statement).mockResolvedValue({
    ...sample,
    accounts: [],
    posted_journal_count: 0,
    totals: {
      opening_debit: "0.00",
      opening_credit: "0.00",
      debit: "0.00",
      credit: "0.00",
      closing_debit: "0.00",
      closing_credit: "0.00",
      has_data: false,
      balanced: true,
    },
    income: {
      revenue: "0.00",
      cost_of_sales: "0.00",
      operating_expenses: "0.00",
      gross_profit: "0.00",
      net_income: "0.00",
    },
  });
  mount(api);
  expect(await screen.findByText(/لا توجد أرصدة أو حركات مرحّلة/)).toBeTruthy();
  expect(screen.queryByText(/متوازنة عدديًا/)).toBeNull();
});
it("network error hides printable report and supports retry", async () => {
  const api = financeApi();
  vi.mocked(api.statement).mockRejectedValueOnce(
    new ApiFailure("انقطع اتصال التقارير"),
  );
  mount(api);
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByText("انقطع اتصال التقارير")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "طباعة التقرير" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "إعادة المحاولة" }));
  expect(await screen.findByText(sample.organization)).toBeTruthy();
});
it("offline update does not submit another report query", async () => {
  const api = mount();
  await screen.findByText(sample.organization);
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  fireEvent(window, new Event("offline"));
  expect(
    (screen.getByRole("button", { name: "تحديث التقرير" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(api.statement).toHaveBeenCalledTimes(1);
});
it("finance user without a configured API sees an unconnected state, not a zero report", () => {
  render(
    <FinancialReports
      api={null}
      workspace={financeWorkspace}
      businessDate="2026-09-20"
    />,
  );
  expect(screen.getByText("خدمة التقارير غير متصلة")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "طباعة التقرير" })).toBeNull();
});
