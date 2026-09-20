import { expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/pharmacy/contracts";
import { AccountLedger } from "@/features/pharmacy/AccountLedger";
import {
  ledgerSchema,
  ledgerCsv,
  type AccountLedger as Ledger,
} from "@/lib/pharmacy/ledger";
import { ApiFailure, pharmacyApi } from "@/lib/pharmacy/api";
import { ids, apiFixture } from "./fixtures";

export const ledgerFixture = (): Ledger => ({
  org_id: ids.org,
  organization_name: "منشأة اختبار مصطنعة",
  currency: "YER",
  account: { id: ids.unit, code: "1110", name: "الصندوق", kind: "asset" },
  from: "2026-09-01",
  to: "2026-09-20",
  center_id: null,
  generated_at: "2026-09-20T12:00:00+00:00",
  opening: "100.00",
  debit: "30.00",
  credit: "20.00",
  closing: "110.00",
  count: 2,
  entries: [
    {
      journal_id: ids.invoice,
      document_uuid: ids.request,
      document_date: "2026-09-01",
      description: "حركة اختبار مدينة",
      debit: "30.00",
      credit: "0.00",
      balance: "130.00",
    },
    {
      journal_id: ids.product,
      document_uuid: ids.warehouse,
      document_date: "2026-09-20",
      description: "حركة اختبار دائنة",
      debit: "0.00",
      credit: "20.00",
      balance: "110.00",
    },
  ],
});
const range = {
  from: "2026-09-01",
  to: "2026-09-20",
  center: null,
  includeZero: false,
};

it("ledger validates running arithmetic, duplicate entries and inclusive business dates", () => {
  expect(ledgerSchema.safeParse(ledgerFixture()).success).toBe(true);
  const mutations: ((r: Ledger) => void)[] = [
    (r) => {
      r.entries[0].balance = "130.01";
    },
    (r) => {
      r.closing = "111.00";
    },
    (r) => {
      r.debit = "30.01";
    },
    (r) => {
      r.entries[1].journal_id = r.entries[0].journal_id;
    },
    (r) => {
      r.entries[0].document_date = "2026-08-31";
    },
    (r) => {
      r.entries[1].document_date = "2026-09-21";
    },
    (r) => {
      r.entries.reverse();
    },
    (r) => {
      r.entries[0].debit = "-30.00";
    },
    (r) => {
      r.count = 3;
    },
    (r) => {
      r.opening = "NaN";
    },
  ];
  for (const mutate of mutations) {
    const r = ledgerFixture();
    mutate(r);
    expect(ledgerSchema.safeParse(r).success).toBe(false);
  }
});

it("empty history and large signed balances retain exact decimals", () => {
  const r = ledgerFixture();
  r.entries = [];
  r.count = 0;
  r.debit = r.credit = "0.00";
  r.opening = r.closing = "-90071992547409.93";
  expect(ledgerSchema.parse(r).closing).toBe("-90071992547409.93");
});

it("ledger CSV keeps Arabic, precision and references while neutralizing spreadsheet formulas", () => {
  const r = ledgerFixture();
  r.account.code = "=HYPERLINK(1)";
  r.entries[0].description = "\t@SUM(1)";
  r.entries[1].description = 'بيان "اختبار"';
  const csv = ledgerCsv(r);
  expect(csv.startsWith("\uFEFF")).toBe(true);
  expect(csv).toContain('"\'=HYPERLINK(1)"');
  expect(csv).toContain('"\'\t@SUM(1)"');
  expect(csv).toContain('بيان ""اختبار""');
  expect(csv).toContain(ids.request);
  expect(csv).toContain('"110.00"');
});

it("ledger adapter sends scope and rejects snapshots belonging to a different account or period", async () => {
  const rpc = vi.fn().mockResolvedValue({ data: ledgerFixture(), error: null });
  const client = {
    schema: vi.fn(() => ({ rpc })),
  } as unknown as SupabaseClient<Database>;
  const api = pharmacyApi(client);
  await api.ledger(ids.org, ids.unit, range);
  expect(rpc).toHaveBeenCalledWith("account_ledger", {
    p_org: ids.org,
    p_account: ids.unit,
    p_from: range.from,
    p_to: range.to,
    p_center: null,
  });
  for (const patch of [
    { org_id: ids.warehouse },
    { account: { ...ledgerFixture().account, id: ids.product } },
    { center_id: ids.product },
    { to: "2026-09-21" },
  ]) {
    rpc.mockResolvedValueOnce({
      data: { ...ledgerFixture(), ...patch },
      error: null,
    });
    await expect(api.ledger(ids.org, ids.unit, range)).rejects.toBeInstanceOf(
      ApiFailure,
    );
  }
});

it("ledger dialog shows references and recovers from a safe server error", async () => {
  const api = apiFixture();
  vi.mocked(api.ledger)
    .mockRejectedValueOnce(new ApiFailure("LEDGER_RANGE_TOO_LARGE"))
    .mockResolvedValue(ledgerFixture());
  render(
    <AccountLedger
      api={api}
      org={ids.org}
      account={ids.unit}
      range={range}
      onClose={vi.fn()}
    />,
  );
  const retry = await screen.findByRole("button", { name: "إعادة المحاولة" });
  expect(
    screen.queryByRole("button", { name: "تصدير كشف الحساب CSV" }),
  ).toBeNull();
  fireEvent.click(retry);
  await screen.findByText("حركة اختبار مدينة");
  expect(screen.getByText(ids.request)).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "تصدير كشف الحساب CSV" }),
  ).toBeTruthy();
  await waitFor(() => expect(api.ledger).toHaveBeenCalledTimes(2));
});
