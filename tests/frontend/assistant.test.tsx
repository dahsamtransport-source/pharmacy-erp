import { it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { Assistant } from "@/features/pharmacy/Assistant";
import { reviewSaleDraft, requestAssistant } from "@/lib/pharmacy/assistant";
import type { AssistantResult } from "@/lib/ai/contracts";
import { apiFixture, ids, unit, workspace } from "./fixtures";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/pharmacy/contracts";
const result: AssistantResult = {
  actor: ids.product,
  org: ids.org,
  warehouse: ids.warehouse,
  execution: "not_executed",
  requiresApproval: true,
  plan: {
    action: "sale",
    search: "",
    explanation: "راجع الطلب",
    payment: "cash",
    items: [{ search: "صنف", quantity: 2 }],
  },
  matches: [[unit]],
};
const props = () => ({
  api: apiFixture(),
  workspace,
  warehouse: ids.warehouse,
  userId: ids.product,
  onReceipt: vi.fn(),
  notify: vi.fn(),
  openInventory: vi.fn(),
  openReports: vi.fn(),
  ask: vi.fn().mockResolvedValue(result),
});
function ask() {
  fireEvent.change(screen.getByLabelText("طلب المساعد"), {
    target: { value: "بيع علبتين" },
  });
  fireEvent.click(screen.getByRole("button", { name: "تحضير الطلب" }));
}
it("requires explicit catalog selection and a separate POS submit; posts only IDs and quantities", async () => {
  const p = props();
  render(<Assistant {...p} />);
  ask();
  await screen.findByText("اقتراح المساعد — لم تُسجّل أي عملية");
  fireEvent.click(
    screen.getByRole("button", { name: "مراجعة المسودة في نقطة البيع" }),
  );
  expect(screen.getByRole("alert").textContent).toContain("حدّد العبوة");
  expect(p.api.sell).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("العبوة للبند 1"), {
    target: { value: ids.unit },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "مراجعة المسودة في نقطة البيع" }),
  );
  await screen.findByRole("button", { name: "تسجيل البيع" });
  expect(p.api.sell).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "تسجيل البيع" }));
  await waitFor(() => expect(p.api.sell).toHaveBeenCalledTimes(1));
  expect(vi.mocked(p.api.sell).mock.calls[0][2]).toEqual({
    warehouse: ids.warehouse,
    payment: "cash",
    items: [{ unit_id: ids.unit, quantity: 2 }],
  });
});
it("rejects restricted drugs, fabricated units, fractional quantities, excess stock and duplicates", () => {
  for (const altered of [
    { ...unit, controlled: true },
    { ...unit, requires_prescription: true },
    { ...unit, available_base: 0 },
  ])
    expect(() =>
      reviewSaleDraft(
        { ...result, matches: [[altered]] },
        [ids.unit],
        ["2"],
        "cash",
      ),
    ).toThrow();
  expect(() => reviewSaleDraft(result, [ids.request], ["2"], "cash")).toThrow();
  expect(() => reviewSaleDraft(result, [ids.unit], ["1.5"], "cash")).toThrow();
  expect(() => reviewSaleDraft(result, [ids.unit], ["2"], "")).toThrow();
  expect(() =>
    reviewSaleDraft(
      {
        ...result,
        plan: {
          ...result.plan,
          items: [...result.plan.items, ...result.plan.items],
        },
        matches: [[unit], [unit]],
      },
      [ids.unit, ids.unit],
      ["1", "1"],
      "cash",
    ),
  ).toThrow(/مكرر/);
});
it("aborts an outstanding request on identity remount and ignores its late result", async () => {
  let resolve!: (r: AssistantResult) => void;
  const p = props();
  p.ask.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const view = render(<Assistant key="A" {...p} />);
  ask();
  view.rerender(<Assistant key="B" {...props()} userId={ids.request} />);
  expect(p.ask.mock.calls[0][3].aborted).toBe(true);
  await act(async () => resolve(result));
  expect(screen.queryByText("راجع الطلب")).toBeNull();
});
it("opens actual inventory with the parsed query without any mutation", async () => {
  const p = props();
  p.ask.mockResolvedValue({
    ...result,
    plan: { ...result.plan, action: "inventory", search: "صنف", items: [] },
    matches: [],
  });
  render(<Assistant {...p} />);
  ask();
  fireEvent.click(
    await screen.findByRole("button", { name: "عرض المخزون الفعلي" }),
  );
  expect(p.openInventory).toHaveBeenCalledWith("صنف");
  expect(p.api.sell).not.toHaveBeenCalled();
});
it("pins the HTTP token and rejects a response after account switch", async () => {
  const getSession = vi
    .fn()
    .mockResolvedValueOnce({
      data: {
        session: { user: { id: ids.product }, access_token: "session-A" },
      },
      error: null,
    })
    .mockResolvedValueOnce({
      data: {
        session: { user: { id: ids.request }, access_token: "session-B" },
      },
      error: null,
    });
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify(result)));
  await expect(
    requestAssistant(
      { auth: { getSession } } as unknown as SupabaseClient<Database>,
      ids.product,
      ids.org,
      ids.warehouse,
      "بيع",
      new AbortController().signal,
    ),
  ).rejects.toThrow(/تغيّر/);
  expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({
    Authorization: "Bearer session-A",
  });
});
