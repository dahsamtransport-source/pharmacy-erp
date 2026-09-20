import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isLoopbackDataApi } from "./connectivity";
import { z } from "zod";
import { centerSchema, financialStatementSchema } from "./financial";
import {
  type Database,
  type PharmacyApi,
  workspaceSchema,
  dashboardSchema,
  unitSchema,
  batchSchema,
  supplierSchema,
  receiptSchema,
  reportSchema,
} from "./contracts";
export class ApiFailure extends Error {
  constructor(
    message: string,
    public readonly definitive = false,
  ) {
    super(message);
    this.name = "ApiFailure";
  }
}
const messages: Record<string, string> = {
  REPORT_ACCOUNT_MAPPING_REQUIRED:
    "تحتاج التقارير إلى ربط صحيح لحساب تكلفة المبيعات. راجع المحاسب.",
  INVALID_REPORT_PERIOD:
    "اختر فترة صحيحة لا يزيد الفرق بين تاريخيها عن 366 يومًا.",
  INVALID_REPORT_CENTER: "مركز التكلفة غير متاح ضمن المنشأة الحالية.",
  REPORT_CURRENCY_MISMATCH:
    "تعذّر إعداد التقرير لوجود عملات غير متوافقة في القيود. راجع المحاسب.",
  FORBIDDEN: "لا تملك صلاحية هذه العملية.",
  INSUFFICIENT_STOCK: "الرصيد غير كافٍ. حدّث الأصناف وراجع الكمية.",
  INSUFFICIENT_AVAILABLE_STOCK: "الكمية المطلوبة محجوزة أو غير متاحة للصرف.",
  PHARMACIST_REVIEW_REQUIRED: "تحتاج هذه السلة مراجعة الصيدلي قبل الصرف.",
  CONTROLLED_DRUG_WORKFLOW_NOT_CONFIGURED:
    "صرف الأدوية الخاضعة للرقابة غير مفعّل.",
  PERIOD_NOT_OPEN: "الفترة المحاسبية مغلقة أو غير مهيأة.",
  IDEMPOTENCY_CONFLICT:
    "هذا المرجع مرتبط بعملية أخرى. تحقّق من نتيجة العملية السابقة.",
  EXPIRED_PURCHASE: "لا يمكن استلام تشغيلة منتهية الصلاحية.",
  BATCH_EXPIRY_CONFLICT: "صلاحية التشغيلة تختلف عن السجل السابق.",
  BATCH_BLOCKED: "هذه التشغيلة محجورة أو مستدعاة.",
  UNIT_UNAVAILABLE: "الصنف أو العبوة لم يعد متاحًا. أعد البحث.",
  WAREHOUSE_UNAVAILABLE: "المستودع غير متاح.",
  ACCOUNT_MAPPING_REQUIRED: "تحتاج الحسابات المحاسبية إلى تهيئة من المسؤول.",
  INVOICE_NOT_FOUND: "المستند غير متاح ضمن صلاحياتك.",
  SUPPLIER_UNAVAILABLE: "المورد غير متاح.",
};
export function friendlyError(error: unknown): string {
  return error instanceof ApiFailure
    ? error.message
    : "تعذّر إكمال الطلب. حاول مجددًا أو راجع المسؤول.";
}
function translate(error: unknown): ApiFailure {
  const parsed = z
    .object({
      code: z.string().optional(),
      message: z.string().optional(),
      status: z.number().optional(),
    })
    .safeParse(error);
  if (!parsed.success)
    return new ApiFailure(
      "تعذّر الاتصال. لم تتأكد نتيجة العملية؛ تحقّق قبل إعادة الإرسال.",
    );
  const { code, message = "", status } = parsed.data;
  if (code === "42501") return new ApiFailure(messages.FORBIDDEN, true);
  if (code === "23505")
    return new ApiFailure("المستند أو رقم فاتورة المورد مسجل مسبقًا.", true);
  if (code?.startsWith("PGRST") || code === "42P01")
    return new ApiFailure(
      "خدمة البيانات غير جاهزة. يلزم إكمال إعداد بيئة الاختبار.",
      true,
    );
  if (status === 401 || code === "bad_jwt" || code === "session_not_found")
    return new ApiFailure("انتهت الجلسة. سجّل الدخول مجددًا.", true);
  const key = Object.keys(messages).find((k) => message.includes(k));
  if (key) return new ApiFailure(messages[key], true);
  const definite = code === "P0001" || code === "23514" || code === "22P02";
  return new ApiFailure(
    definite
      ? "تعذّر قبول البيانات. راجع الحقول ثم أعد المحاولة."
      : "تعذّر الاتصال. لم تتأكد نتيجة العملية؛ تحقّق قبل إعادة الإرسال.",
    definite,
  );
}
async function read<T>(
  request: PromiseLike<{ data: unknown; error: unknown }>,
  schema: z.ZodType<T>,
): Promise<T> {
  const { data, error } = await request;
  if (error) throw translate(error);
  const parsed = schema.safeParse(data);
  if (!parsed.success)
    throw new ApiFailure("استجابة البيانات غير متوافقة. يرجى مراجعة المسؤول.");
  return parsed.data;
}
export function browserClient(): SupabaseClient<Database> | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  // Publishable keys only. Reject secret and legacy service_role JWT keys before client creation.
  if (!key.startsWith("sb_publishable_")) return null;
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && isLoopbackDataApi(url))
    )
      return null;
  } catch {
    return null;
  }
  return createClient<Database>(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
}
export function pharmacyApi(client: SupabaseClient<Database>): PharmacyApi {
  const api = client.schema("ym_api");
  return {
    context: () =>
      read(api.rpc("workspace_context", {}), z.array(workspaceSchema)),
    dashboard: (p_org, p_warehouse) =>
      read(
        api.rpc("dashboard_snapshot", { p_org, p_warehouse }),
        dashboardSchema,
      ),
    units: (p_org, p_warehouse, p_search, p_offset = 0) =>
      read(
        api.rpc("search_units", { p_org, p_warehouse, p_search, p_offset }),
        z.array(unitSchema),
      ),
    inventory: (p_org, p_warehouse, p_search, p_offset = 0) =>
      read(
        api.rpc("inventory_page", { p_org, p_warehouse, p_search, p_offset }),
        z.array(batchSchema),
      ),
    suppliers: (p_org) =>
      read(api.rpc("supplier_options", { p_org }), z.array(supplierSchema)),
    receipt: (p_org, p_id) =>
      read(api.rpc("invoice_receipt", { p_org, p_id }), receiptSchema),
    findReceipt: (p_org, p_request) =>
      read(
        api.rpc("receipt_by_request", { p_org, p_request }),
        receiptSchema.nullable(),
      ),
    report: (p_org, p_from, p_to) =>
      read(api.rpc("financial_report", { p_org, p_from, p_to }), reportSchema),
    reportOptions: (p_org) =>
      read(
        api.rpc("financial_report_options", { p_org }),
        z.array(centerSchema),
      ),
    statement: (p_org, range) =>
      read(
        api.rpc("financial_report_v2", {
          p_org,
          p_from: range.from,
          p_to: range.to,
          p_center: range.center,
          p_include_zero: range.includeZero,
        }),
        financialStatementSchema.refine(
          (s) =>
            s.org_id === p_org &&
            s.from === range.from &&
            s.to === range.to &&
            (s.cost_center?.id ?? null) === range.center &&
            s.include_zero === range.includeZero,
        ),
      ),
    sell: (p_org, p_request, input) =>
      read(
        api.rpc("process_pharmacy_sale", {
          p_org,
          p_request,
          p_warehouse: input.warehouse,
          p_items: input.items.map((x) => ({ ...x })),
          p_payment: input.payment,
        }),
        z.uuid(),
      ),
    purchase: (p_org, p_request, input) =>
      read(
        api.rpc("receive_purchase_order", {
          p_org,
          p_request,
          p_warehouse: input.warehouse,
          p_supplier: input.supplier,
          p_reference: input.reference,
          p_items: input.items.map((x) => ({ ...x })),
        }),
        z.uuid(),
      ),
  };
}
