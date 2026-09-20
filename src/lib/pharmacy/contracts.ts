import { z } from "zod";
export const roleSchema = z.enum([
  "owner",
  "manager",
  "accountant",
  "cashier",
  "pharmacist",
  "inventory",
]);
export type Role = z.infer<typeof roleSchema>;
const id = z.uuid();
export const decimal = z.string().regex(/^-?\d+(\.\d{1,4})?$/);
const count = z.number().int().nonnegative().refine(Number.isSafeInteger);
export const workspaceSchema = z.object({
  id,
  name: z.string(),
  currency: z.string(),
  timezone: z.string(),
  role: roleSchema,
  warehouses: z.array(z.object({ id, name: z.string() })),
});
export type Workspace = z.infer<typeof workspaceSchema>;
export const unitSchema = z.object({
  unit_id: id,
  product_id: id,
  trade_name: z.string(),
  unit_name: z.string(),
  factor: count,
  barcode: z.string().nullable(),
  selling_price: decimal,
  requires_prescription: z.boolean(),
  controlled: z.boolean(),
  available_base: count,
});
export type Unit = z.infer<typeof unitSchema>;
export const batchSchema = z.object({
  id,
  trade_name: z.string(),
  batch_number: z.string(),
  expiry_date: z.string(),
  quantity: count,
  reserved: count,
  status: z.enum(["available", "quarantine", "recalled"]),
  expired: z.boolean(),
});
export type Batch = z.infer<typeof batchSchema>;
export const dashboardSchema = z.object({
  business_date: z.string(),
  scope: z.enum(["mine", "organization", "inventory"]),
  today_total: decimal.nullable(),
  yesterday_total: decimal.nullable(),
  expiring_count: count,
  expired_count: count,
  low_stock_count: count,
  series: z.array(z.object({ date: z.string(), total: decimal.nullable() })),
  recent: z.array(
    z.object({
      id,
      document_uuid: id,
      kind: z.enum(["sale", "purchase"]),
      document_date: z.string(),
      total: decimal,
      currency: z.string(),
    }),
  ),
  low_stock: z.array(
    z.object({
      product_id: id,
      trade_name: z.string(),
      available: count,
      minimum: count,
      target: count,
    }),
  ),
  expiring: z.array(
    batchSchema.omit({ id: true, reserved: true }).extend({ batch_id: id }),
  ),
});
export type Dashboard = z.infer<typeof dashboardSchema>;
export const receiptSchema = z.object({
  id,
  document_uuid: id,
  kind: z.enum(["sale", "purchase"]),
  document_date: z.string(),
  currency: z.string(),
  total: decimal,
  payment_method: z.string(),
  organization: z.string(),
  lines: z.array(
    z.object({
      id,
      trade_name: z.string(),
      unit_name: z.string(),
      quantity: count,
      unit_price: decimal,
      total: decimal,
    }),
  ),
});
export type Receipt = z.infer<typeof receiptSchema>;
export const supplierSchema = z.object({ id, name: z.string() });
export type Supplier = z.infer<typeof supplierSchema>;
export const reportSchema = z.object({
  from: z.string(),
  to: z.string(),
  accounts: z.array(
    z.object({
      id,
      code: z.string(),
      name: z.string(),
      kind: z.enum(["asset", "liability", "equity", "income", "expense"]),
      opening: decimal,
      debit: decimal,
      credit: decimal,
      closing: decimal,
    }),
  ),
});
export type FinancialReport = z.infer<typeof reportSchema>;
export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json | undefined };
type Read<Args> = { Args: Args; Returns: Json };
export interface Database {
  public: {
    Tables: Record<string, never>;
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
  ym_api: {
    Tables: Record<string, never>;
    Views: Record<string, never>;
    Functions: {
      workspace_context: Read<Record<string, never>>;
      dashboard_snapshot: Read<{ p_org: string; p_warehouse: string }>;
      search_units: Read<{
        p_org: string;
        p_warehouse: string;
        p_search: string;
        p_offset: number;
      }>;
      inventory_page: Read<{
        p_org: string;
        p_warehouse: string;
        p_search: string;
        p_offset: number;
      }>;
      supplier_options: Read<{ p_org: string }>;
      invoice_receipt: Read<{ p_org: string; p_id: string }>;
      receipt_by_request: Read<{ p_org: string; p_request: string }>;
      financial_report: Read<{ p_org: string; p_from: string; p_to: string }>;
      process_pharmacy_sale: {
        Args: {
          p_org: string;
          p_request: string;
          p_warehouse: string;
          p_items: Json;
          p_payment: string;
        };
        Returns: string;
      };
      receive_purchase_order: {
        Args: {
          p_org: string;
          p_request: string;
          p_warehouse: string;
          p_supplier: string;
          p_reference: string;
          p_items: Json;
        };
        Returns: string;
      };
    };
  };
}
export interface SaleInput {
  warehouse: string;
  payment: "cash" | "bank";
  items: { unit_id: string; quantity: number }[];
}
export interface PurchaseInput {
  warehouse: string;
  supplier: string;
  reference: string;
  items: {
    unit_id: string;
    quantity: number;
    unit_cost: string;
    batch_number: string;
    expiry_date: string;
  }[];
}
export interface PharmacyApi {
  context(): Promise<Workspace[]>;
  dashboard(org: string, warehouse: string): Promise<Dashboard>;
  units(
    org: string,
    warehouse: string,
    search: string,
    offset?: number,
  ): Promise<Unit[]>;
  inventory(
    org: string,
    warehouse: string,
    search: string,
    offset?: number,
  ): Promise<Batch[]>;
  suppliers(org: string): Promise<Supplier[]>;
  receipt(org: string, id: string): Promise<Receipt>;
  findReceipt(org: string, request: string): Promise<Receipt | null>;
  report(org: string, from: string, to: string): Promise<FinancialReport>;
  sell(org: string, request: string, input: SaleInput): Promise<string>;
  purchase(org: string, request: string, input: PurchaseInput): Promise<string>;
}
export const permissions = (role?: Role) => ({
  sell: !!role && ["owner", "manager", "cashier", "pharmacist"].includes(role),
  purchase: !!role && ["owner", "manager", "inventory"].includes(role),
  finance: !!role && ["owner", "manager", "accountant"].includes(role),
});
export const roleLabels: Record<Role, string> = {
  owner: "مالك المنشأة",
  manager: "المدير",
  accountant: "المحاسب",
  cashier: "الكاشير",
  pharmacist: "الصيدلي",
  inventory: "أمين المخزن",
};
