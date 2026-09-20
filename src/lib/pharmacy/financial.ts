import { z } from "zod";
import { decimalUnits, minorUnits } from "./money";

const moneyPattern = /^-?\d+(\.\d{1,2})?$/;
const money = z.string().regex(moneyPattern);
const nonnegativeMoney = money.refine(
  (value) => moneyPattern.test(value) && minorUnits(value) >= 0n,
);
const date = z.iso.date();
export const timezoneSchema = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
});
export function businessDateInZone(timezone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (name: string) => parts.find((p) => p.type === name)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export const centerSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
});
export type CostCenter = z.infer<typeof centerSchema>;
export const accountKinds = {
  asset: "أصول",
  liability: "التزامات",
  equity: "حقوق ملكية",
  income: "إيرادات",
  expense: "مصروفات",
} as const;
const balancesSchema = z.object({
  opening_debit: nonnegativeMoney,
  opening_credit: nonnegativeMoney,
  debit: nonnegativeMoney,
  credit: nonnegativeMoney,
  closing_debit: nonnegativeMoney,
  closing_credit: nonnegativeMoney,
});
export const statementAccountSchema = balancesSchema.extend({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  kind: z.enum(["asset", "liability", "equity", "income", "expense"]),
  is_cogs: z.boolean(),
  opening: money,
  closing: money,
  normal_balance: money,
});
export type StatementAccount = z.infer<typeof statementAccountSchema>;
const statementShape = z.object({
  org_id: z.uuid(),
  organization: z.string(),
  currency: z.string(),
  timezone: timezoneSchema,
  from: date,
  to: date,
  cost_center: centerSchema.nullable(),
  generated_at: z.iso.datetime({ offset: true }),
  include_zero: z.boolean(),
  posted_journal_count: z
    .number()
    .int()
    .nonnegative()
    .refine(Number.isSafeInteger),
  accounts: z.array(statementAccountSchema),
  totals: balancesSchema.extend({
    balanced: z.boolean(),
    has_data: z.boolean(),
  }),
  income: z.object({
    revenue: money,
    cost_of_sales: money,
    operating_expenses: money,
    gross_profit: money,
    net_income: money,
  }),
});
export type FinancialStatement = z.infer<typeof statementShape>;
export type FinancialTab = "trial" | "income";
export interface ReportRange {
  from: string;
  to: string;
  center: string | null;
  includeZero: boolean;
}

// A syntactically valid but internally inconsistent response must never show a green balance badge.
export const financialStatementSchema = statementShape.superRefine(
  (s, context) => {
    // Zod may run refinements after a regex issue; never feed invalid decimals to BigInt.
    if (!statementShape.safeParse(s).success) return;
    const fail = () =>
      context.addIssue({
        code: "custom",
        message: "Inconsistent financial statement",
      });
    let revenue = 0n,
      cogs = 0n,
      expenses = 0n;
    const fields = [
      "opening_debit",
      "opening_credit",
      "debit",
      "credit",
      "closing_debit",
      "closing_credit",
    ] as const;
    const totals = Object.fromEntries(fields.map((f) => [f, 0n])) as Record<
      (typeof fields)[number],
      bigint
    >;
    const seen = new Set<string>();
    for (const r of s.accounts) {
      if (seen.has(r.id)) fail();
      seen.add(r.id);
      const opening = minorUnits(r.opening),
        closing = minorUnits(r.closing);
      const movement = minorUnits(r.debit) - minorUnits(r.credit);
      if (
        opening + movement !== closing ||
        minorUnits(r.opening_debit) !== (opening > 0n ? opening : 0n) ||
        minorUnits(r.opening_credit) !== (opening < 0n ? -opening : 0n) ||
        minorUnits(r.closing_debit) !== (closing > 0n ? closing : 0n) ||
        minorUnits(r.closing_credit) !== (closing < 0n ? -closing : 0n) ||
        minorUnits(r.normal_balance) !==
          (["asset", "expense"].includes(r.kind) ? closing : -closing)
      )
        fail();
      for (const f of fields) totals[f] += minorUnits(r[f]);
      if (r.kind === "income") revenue -= movement;
      if (r.kind === "expense") {
        if (r.is_cogs) cogs += movement;
        else expenses += movement;
      }
    }
    for (const f of fields) if (totals[f] !== minorUnits(s.totals[f])) fail();
    const balanced =
      totals.opening_debit === totals.opening_credit &&
      totals.debit === totals.credit &&
      totals.closing_debit === totals.closing_credit;
    const hasData =
      totals.opening_debit +
        totals.opening_credit +
        totals.debit +
        totals.credit >
      0n;
    if (balanced !== s.totals.balanced || hasData !== s.totals.has_data) fail();
    const income = {
      revenue,
      cost_of_sales: cogs,
      operating_expenses: expenses,
      gross_profit: revenue - cogs,
      net_income: revenue - cogs - expenses,
    };
    for (const f of Object.keys(income) as (keyof typeof income)[])
      if (income[f] !== minorUnits(s.income[f])) fail();
  },
);

export function validReportRange(range: ReportRange): boolean {
  if (!date.safeParse(range.from).success || !date.safeParse(range.to).success)
    return false;
  const days = (Date.parse(range.to) - Date.parse(range.from)) / 86400000;
  return (
    range.from >= "1900-01-01" &&
    range.to <= "9999-12-31" &&
    days >= 0 &&
    days <= 366
  );
}
export function accountPeriodAmount(row: StatementAccount): string {
  const net = minorUnits(row.debit) - minorUnits(row.credit);
  return decimalUnits(row.kind === "income" ? -net : net);
}
// Neutralize spreadsheet formulas in textual fields, including leading whitespace/control characters.
function csvText(value: string): string {
  const numericLiteral = /^-?\d+(\.\d{1,2})?$/.test(value);
  const safe =
    !numericLiteral && /^[\s\u0000-\u001f]*[=+\-@]/.test(value)
      ? `'${value}`
      : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
export function statementCsv(
  report: FinancialStatement,
  tab: FinancialTab,
): string {
  const lines: string[][] = [
    [report.organization, tab === "trial" ? "ميزان المراجعة" : "قائمة الدخل"],
    ["من", report.from, "إلى", report.to, "العملة", report.currency],
    ["مركز التكلفة", report.cost_center?.name ?? "جميع مراكز التكلفة"],
    ["وقت إعداد البيانات", report.generated_at],
  ];
  if (tab === "trial") {
    lines.push([
      "رمز الحساب",
      "اسم الحساب",
      "التصنيف",
      "افتتاحي مدين",
      "افتتاحي دائن",
      "حركة مدين",
      "حركة دائن",
      "ختامي مدين",
      "ختامي دائن",
    ]);
    for (const r of report.accounts)
      lines.push([
        r.code,
        r.name,
        accountKinds[r.kind],
        r.opening_debit,
        r.opening_credit,
        r.debit,
        r.credit,
        r.closing_debit,
        r.closing_credit,
      ]);
    const t = report.totals;
    lines.push([
      "",
      "الإجمالي",
      "",
      t.opening_debit,
      t.opening_credit,
      t.debit,
      t.credit,
      t.closing_debit,
      t.closing_credit,
    ]);
  } else {
    lines.push(["رمز الحساب", "اسم الحساب", "المجموعة", "المبلغ"]);
    for (const r of report.accounts.filter(
      (a) => a.kind === "income" || a.kind === "expense",
    ))
      lines.push([
        r.code,
        r.name,
        r.is_cogs ? "تكلفة المبيعات" : accountKinds[r.kind],
        accountPeriodAmount(r),
      ]);
    for (const [label, key] of [
      ["إجمالي الإيرادات", "revenue"],
      ["تكلفة المبيعات", "cost_of_sales"],
      ["مجمل الربح / الخسارة", "gross_profit"],
      ["المصروفات التشغيلية", "operating_expenses"],
      ["صافي الربح / الخسارة", "net_income"],
    ] as const)
      lines.push(["", label, "", report.income[key]]);
  }
  return (
    "\uFEFF" + lines.map((line) => line.map(csvText).join(",")).join("\r\n")
  );
}
export function downloadStatement(
  report: FinancialStatement,
  tab: FinancialTab,
): void {
  const url = URL.createObjectURL(
    new Blob([statementCsv(report, tab)], { type: "text/csv;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `ympharma-${tab}-${report.from}-${report.to}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
