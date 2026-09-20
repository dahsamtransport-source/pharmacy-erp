import { it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AnimatedDashboard from "@/AnimatedDashboard";
import {
  POS,
  PurchaseReceipt,
  ReceiptDialog,
} from "@/features/pharmacy/workflows";
import { Reports } from "@/features/pharmacy/data-views";
import {
  apiFixture,
  workspace,
  unit,
  ids,
  receipt,
  dashboard,
} from "./fixtures";
import { ApiFailure } from "@/lib/pharmacy/api";
it("dashboard shows unavailable metrics, never the supplied mock amounts", () => {
  render(
    <AnimatedDashboard
      loading={false}
      connected={false}
      canSell={false}
      navigate={vi.fn()}
      openReceipt={vi.fn()}
    />,
  );
  expect(screen.queryByText("12,500")).toBeNull();
  expect(screen.queryByText(/14%/)).toBeNull();
  expect(screen.getAllByText("—").length).toBeGreaterThan(2);
  expect(screen.getByText("لا توجد بيانات مبيعات للعرض")).toBeTruthy();
});
it("dashboard uses live scope, real supplied metrics, and navigates POS", () => {
  const navigate = vi.fn();
  render(
    <AnimatedDashboard
      data={dashboard}
      currency="YER"
      loading={false}
      connected
      canSell
      navigate={navigate}
      openReceipt={vi.fn()}
    />,
  );
  expect(screen.getByText("مبيعاتك اليوم")).toBeTruthy();
  expect(screen.getAllByText("12.25").length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: /فتح نقطة البيع/ }));
  expect(navigate).toHaveBeenCalledWith("pos");
});
it("POS sends only unit IDs and quantities and clears cart after receipt success", async () => {
  const api = apiFixture(),
    onReceipt = vi.fn();
  render(
    <POS
      api={api}
      workspace={workspace}
      warehouse={ids.warehouse}
      userId="test"
      onReceipt={onReceipt}
      notify={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: /صنف اختبار/ }));
  fireEvent.click(screen.getByRole("button", { name: "تسجيل البيع" }));
  await waitFor(() => expect(api.sell).toHaveBeenCalledTimes(1));
  const payload = vi.mocked(api.sell).mock.calls[0][2];
  expect(payload.items).toEqual([{ unit_id: ids.unit, quantity: 1 }]);
  expect(payload).not.toHaveProperty("total");
  expect(payload).not.toHaveProperty("approved");
  await waitFor(() => expect(onReceipt).toHaveBeenCalledWith(receipt));
  expect(screen.getByText("السلة فارغة")).toBeTruthy();
});
it("server rejection preserves cart and displays a meaningful error", async () => {
  const api = apiFixture();
  api.sell = vi
    .fn()
    .mockRejectedValue(new ApiFailure("المخزون غير كافٍ", true));
  render(
    <POS
      api={api}
      workspace={workspace}
      warehouse={ids.warehouse}
      userId="test"
      onReceipt={vi.fn()}
      notify={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: /صنف اختبار/ }));
  fireEvent.click(screen.getByRole("button", { name: "تسجيل البيع" }));
  expect(await screen.findByText("المخزون غير كافٍ")).toBeTruthy();
  expect(screen.getByLabelText("كمية صنف اختبار علبة")).toBeTruthy();
});
it("POS maintains separate cart rows for different units of the same product", async () => {
  const api = apiFixture();
  api.units = vi.fn().mockResolvedValue([
    unit,
    {
      ...unit,
      unit_id: ids.product,
      unit_name: "شريط",
      factor: 1,
      selling_price: "2.00",
    },
  ]);
  render(
    <POS
      api={api}
      workspace={workspace}
      warehouse={ids.warehouse}
      userId="test"
      onReceipt={vi.fn()}
      notify={vi.fn()}
    />,
  );
  const buttons = await screen.findAllByRole("button", { name: /صنف اختبار/ });
  buttons.forEach((button) => fireEvent.click(button));
  expect(screen.getAllByRole("spinbutton")).toHaveLength(2);
});
it("prescription and controlled units cannot be added through an unimplemented review flow", async () => {
  const api = apiFixture();
  api.units = vi
    .fn()
    .mockResolvedValue([{ ...unit, requires_prescription: true }]);
  render(
    <POS
      api={api}
      workspace={workspace}
      warehouse={ids.warehouse}
      userId="test"
      onReceipt={vi.fn()}
      notify={vi.fn()}
    />,
  );
  const button = await screen.findByRole("button", { name: /صنف اختبار/ });
  expect((button as HTMLButtonElement).disabled).toBe(true);
});
it("cashier cannot load financial report data", () => {
  const api = apiFixture();
  render(<Reports api={api} workspace={workspace} businessDate="2026-09-20" />);
  expect(screen.getByRole("alert").textContent).toContain(
    "للمالك والمدير والمحاسب",
  );
  expect(api.report).not.toHaveBeenCalled();
});
it("purchase uses real supplier choices and no hardcoded supplier IDs", async () => {
  const api = apiFixture();
  render(
    <PurchaseReceipt
      api={api}
      workspace={{ ...workspace, role: "inventory" }}
      warehouse={ids.warehouse}
      userId="test"
      onReceipt={vi.fn()}
      notify={vi.fn()}
    />,
  );
  expect(
    await screen.findByRole("option", { name: "مورد اختبار" }),
  ).toBeTruthy();
  expect(api.suppliers).toHaveBeenCalledWith(ids.org);
  expect(screen.queryByText("SUPPLIER_UUID_1")).toBeNull();
});
it("submits a purchase batch with exact cost and clears lines only after server confirmation", async () => {
  const api = apiFixture(),
    onReceipt = vi.fn();
  render(
    <PurchaseReceipt
      api={api}
      workspace={{ ...workspace, role: "inventory" }}
      warehouse={ids.warehouse}
      userId="purchase-test"
      onReceipt={onReceipt}
      notify={vi.fn()}
    />,
  );
  await screen.findByRole("option", { name: "مورد اختبار" });
  fireEvent.change(screen.getByLabelText("المورد"), {
    target: { value: ids.product },
  });
  fireEvent.change(screen.getByLabelText("رقم فاتورة المورد"), {
    target: { value: "SUP-100" },
  });
  fireEvent.click(await screen.findByRole("button", { name: /صنف اختبار/ }));
  fireEvent.change(screen.getByLabelText("رقم التشغيلة"), {
    target: { value: "BATCH-1" },
  });
  fireEvent.change(screen.getByLabelText("تاريخ الصلاحية"), {
    target: { value: "2030-12-31" },
  });
  fireEvent.change(screen.getByLabelText("عدد العبوات"), {
    target: { value: "3" },
  });
  fireEvent.change(screen.getByLabelText("تكلفة العبوة"), {
    target: { value: "1.2345" },
  });
  fireEvent.click(screen.getByRole("button", { name: "إضافة التشغيلة" }));
  fireEvent.click(
    screen.getByRole("button", { name: "اعتماد الاستلام وتسجيل القيد" }),
  );
  await waitFor(() => expect(api.purchase).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api.purchase).mock.calls[0][2]).toEqual({
    warehouse: ids.warehouse,
    supplier: ids.product,
    reference: "SUP-100",
    items: [
      {
        unit_id: ids.unit,
        quantity: 3,
        unit_cost: "1.2345",
        batch_number: "BATCH-1",
        expiry_date: "2030-12-31",
      },
    ],
  });
  await waitFor(() => expect(onReceipt).toHaveBeenCalledWith(receipt));
  expect(screen.getByText("أضف بنود الاستلام")).toBeTruthy();
});
it("receipt printing calls print only after user action, and states external ERP status honestly", () => {
  const print = vi.spyOn(window, "print").mockImplementation(() => {});
  render(<ReceiptDialog receipt={receipt} onClose={vi.fn()} />);
  expect(print).not.toHaveBeenCalled();
  expect(screen.getByText(/لا يؤكد الترحيل/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "طباعة المستند" }));
  expect(print).toHaveBeenCalledTimes(1);
});
