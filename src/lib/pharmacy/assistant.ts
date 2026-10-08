import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Unit } from "./contracts";
import { ApiFailure } from "./api";
import {
  assistantResultSchema,
  type AssistantResult,
} from "@/lib/ai/contracts";
export type AskAssistant = (
  org: string,
  warehouse: string,
  input: string,
  signal: AbortSignal,
) => Promise<AssistantResult>;
export interface SaleDraft {
  lines: { unit: Unit; quantity: number }[];
  payment: "cash" | "bank";
}
export async function requestAssistant(
  client: SupabaseClient<Database>,
  actor: string,
  org: string,
  warehouse: string,
  input: string,
  signal: AbortSignal,
): Promise<AssistantResult> {
  const { data, error } = await client.auth.getSession();
  if (error || !data.session || data.session.user.id !== actor)
    throw new ApiFailure("تغيّر الحساب. أعد فتح المساعد.");
  signal.throwIfAborted();
  const response = await fetch("/api/ai/orchestrate", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${data.session.access_token}`,
    },
    body: JSON.stringify({ org, warehouse, input }),
  });
  if (!response.ok)
    throw new ApiFailure(
      response.status === 503
        ? "المساعد غير مفعّل على الخادم. يمكنك متابعة العمل من الأقسام المعتادة."
        : response.status === 429
          ? "بلغ المساعد حد الطلبات مؤقتًا. انتظر دقيقة ثم حاول مجددًا."
          : response.status === 401 || response.status === 403
            ? "الجلسة أو الصلاحية لا تسمح بهذا الطلب. حدّث الحساب."
            : "تعذّر إعداد المسودة. لم تُسجّل أي عملية؛ حاول مجددًا.",
    );
  const result = assistantResultSchema.parse(await response.json());
  const current = await client.auth.getSession();
  if (
    current.error ||
    current.data.session?.user.id !== actor ||
    result.actor !== actor ||
    result.org !== org ||
    result.warehouse !== warehouse
  )
    throw new ApiFailure(
      "تغيّر سياق العمل. أعد الطلب من الحساب والمستودع الحاليين.",
    );
  signal.throwIfAborted();
  return result;
}
export function reviewSaleDraft(
  result: AssistantResult,
  selections: string[],
  quantities: string[],
  payment: string,
): SaleDraft {
  if (
    result.plan.action !== "sale" ||
    !result.plan.items.length ||
    result.plan.items.length !== result.matches.length ||
    !["cash", "bank"].includes(payment)
  )
    throw new ApiFailure("اختر الأصناف والكمية وطريقة الدفع قبل المراجعة.");
  const seen = new Set<string>();
  const lines = result.plan.items.map((_, i) => {
    const unit = result.matches[i]?.find((u) => u.unit_id === selections[i]);
    const quantity = Number(quantities[i]);
    if (
      !unit ||
      !/^\d+$/.test(quantities[i] ?? "") ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      quantity > 999999
    )
      throw new ApiFailure("حدّد العبوة المطابقة وكمية صحيحة لكل بند.");
    if (unit.controlled || unit.requires_prescription)
      throw new ApiFailure(
        "هذا الصنف يحتاج مسار صرف متخصصًا؛ لا يمكن إضافته من المساعد.",
      );
    if (
      unit.factor < 1 ||
      quantity > Math.floor(unit.available_base / unit.factor)
    )
      throw new ApiFailure("الكمية المطلوبة تتجاوز الرصيد المتاح للعبوة.");
    if (seen.has(unit.unit_id))
      throw new ApiFailure(
        "الصنف مكرر. أعد الطلب بكمية إجمالية واحدة لكل عبوة.",
      );
    seen.add(unit.unit_id);
    return { unit, quantity };
  });
  return { lines, payment: payment as "cash" | "bank" };
}
