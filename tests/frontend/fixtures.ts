// Synthetic fixtures, only imported by tests. Never bundled into application routes.
import { vi } from "vitest";
import type {
  PharmacyApi,
  Workspace,
  Unit,
  Receipt,
  Dashboard,
} from "@/lib/pharmacy/contracts";
export const ids = {
  org: "11111111-1111-4111-8111-111111111111",
  warehouse: "22222222-2222-4222-8222-222222222222",
  unit: "33333333-3333-4333-8333-333333333333",
  product: "44444444-4444-4444-8444-444444444444",
  invoice: "55555555-5555-4555-8555-555555555555",
  request: "66666666-6666-4666-8666-666666666666",
};
export const workspace: Workspace = {
  id: ids.org,
  name: "منشأة اختبار مصطنعة",
  currency: "YER",
  timezone: "Asia/Aden",
  role: "cashier",
  warehouses: [{ id: ids.warehouse, name: "مستودع اختبار" }],
};
export const unit: Unit = {
  unit_id: ids.unit,
  product_id: ids.product,
  trade_name: "صنف اختبار",
  unit_name: "علبة",
  factor: 10,
  barcode: "TEST-001",
  selling_price: "12.25",
  requires_prescription: false,
  controlled: false,
  available_base: 100,
};
export const receipt: Receipt = {
  id: ids.invoice,
  document_uuid: ids.request,
  kind: "sale",
  document_date: "2026-09-20",
  currency: "YER",
  total: "12.25",
  payment_method: "cash",
  organization: "منشأة اختبار مصطنعة",
  lines: [
    {
      id: ids.unit,
      trade_name: "صنف اختبار",
      unit_name: "علبة",
      quantity: 1,
      unit_price: "12.2500",
      total: "12.25",
    },
  ],
};
export const dashboard: Dashboard = {
  business_date: "2026-09-20",
  scope: "mine",
  today_total: "12.25",
  yesterday_total: "0.00",
  expiring_count: 0,
  expired_count: 0,
  low_stock_count: 0,
  series: [{ date: "2026-09-20", total: "12.25" }],
  recent: [],
  low_stock: [],
  expiring: [],
};
export const apiFixture = (): PharmacyApi => ({
  context: vi.fn().mockResolvedValue([workspace]),
  dashboard: vi.fn().mockResolvedValue(dashboard),
  units: vi.fn().mockResolvedValue([unit]),
  inventory: vi.fn().mockResolvedValue([]),
  suppliers: vi
    .fn()
    .mockResolvedValue([{ id: ids.product, name: "مورد اختبار" }]),
  receipt: vi.fn().mockResolvedValue(receipt),
  findReceipt: vi.fn().mockResolvedValue(null),
  report: vi
    .fn()
    .mockResolvedValue({ from: "2026-09-01", to: "2026-09-20", accounts: [] }),
  reportOptions: vi.fn().mockResolvedValue([]),
  statement: vi
    .fn()
    .mockRejectedValue(new Error("No statement fixture supplied")),
  sell: vi.fn().mockResolvedValue(ids.invoice),
  purchase: vi.fn().mockResolvedValue(ids.invoice),
});
