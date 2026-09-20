import { z } from "zod";
import { minorUnits } from "./money";
import { validReportRange } from "./financial";

const moneyPattern = /^-?\d+(\.\d{1,2})?$/;
const money = z.string().regex(moneyPattern);
export const ledgerSchema = z
  .object({
    org_id: z.uuid(),
    organization_name: z.string(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    account: z.object({
      id: z.uuid(),
      code: z.string(),
      name: z.string(),
      kind: z.enum(["asset", "liability", "equity", "income", "expense"]),
    }),
    from: z.iso.date(),
    to: z.iso.date(),
    center_id: z.uuid().nullable(),
    generated_at: z.iso.datetime({ offset: true }),
    opening: money,
    debit: money,
    credit: money,
    closing: money,
    count: z.number().int().min(0).max(1000),
    entries: z
      .array(
        z.object({
          journal_id: z.uuid(),
          document_uuid: z.uuid(),
          document_date: z.iso.date(),
          description: z.string(),
          debit: money,
          credit: money,
          balance: money,
        }),
      )
      .max(1000),
  })
  .superRefine((r, ctx) => {
    const fail = () =>
      ctx.addIssue({
        code: "custom",
        message: "Invalid ledger arithmetic or scope",
      });
    if (
      !validReportRange({
        from: r.from,
        to: r.to,
        center: r.center_id,
        includeZero: false,
      })
    )
      fail();
    if (
      ![
        r.opening,
        r.debit,
        r.credit,
        r.closing,
        ...r.entries.flatMap((e) => [e.debit, e.credit, e.balance]),
      ].every((v) => moneyPattern.test(v))
    )
      return;
    let balance = minorUnits(r.opening),
      debit = 0n,
      credit = 0n;
    const ids = new Set<string>();
    let lastDate = r.from;
    for (const e of r.entries) {
      const d = minorUnits(e.debit),
        c = minorUnits(e.credit);
      if (
        d < 0n ||
        c < 0n ||
        d + c === 0n ||
        ids.has(e.journal_id) ||
        e.document_date < lastDate ||
        e.document_date > r.to
      )
        fail();
      ids.add(e.journal_id);
      lastDate = e.document_date;
      debit += d;
      credit += c;
      balance += d - c;
      if (balance !== minorUnits(e.balance)) fail();
    }
    if (
      r.count !== r.entries.length ||
      debit !== minorUnits(r.debit) ||
      credit !== minorUnits(r.credit) ||
      balance !== minorUnits(r.closing)
    )
      fail();
  });
export type AccountLedger = z.infer<typeof ledgerSchema>;

export function ledgerCsv(r: AccountLedger): string {
  // Text and money have separate escaping: account codes are never executable formulas.
  const text = (s: string) =>
    `"${(/^[\s\u0000-\u001f]*[=+\-@]/.test(s) ? "'" + s : s).replaceAll('"', '""')}"`;
  const number = (s: string) => {
    if (!moneyPattern.test(s)) throw new Error("Invalid amount");
    return `"${s}"`;
  };
  const lines = [
    [
      r.organization_name,
      r.currency,
      "دفتر الأستاذ",
      r.account.code,
      r.account.name,
    ]
      .map(text)
      .join(","),
    [r.from, r.to, r.center_id ?? "جميع مراكز التكلفة", r.generated_at]
      .map(text)
      .join(","),
    [text("رصيد أول المدة"), number(r.opening)].join(","),
    [
      "التاريخ",
      "مرجع المستند",
      "معرف القيد",
      "البيان",
      "مدين",
      "دائن",
      "الرصيد (مدين موجب/دائن سالب)",
    ]
      .map(text)
      .join(","),
    ...r.entries.map((e) =>
      [
        ...[e.document_date, e.document_uuid, e.journal_id, e.description].map(
          text,
        ),
        ...[e.debit, e.credit, e.balance].map(number),
      ].join(","),
    ),
    [
      text("الإجمالي"),
      "",
      "",
      "",
      number(r.debit),
      number(r.credit),
      number(r.closing),
    ].join(","),
  ];
  return "\uFEFF" + lines.join("\r\n");
}
export function downloadLedger(r: AccountLedger) {
  const url = URL.createObjectURL(
    new Blob([ledgerCsv(r)], { type: "text/csv;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `ledger-${r.account.id}-${r.from}-${r.to}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
