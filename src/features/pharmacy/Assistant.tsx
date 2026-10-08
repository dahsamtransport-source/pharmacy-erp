"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AssistantResult } from "@/lib/ai/contracts";
import { permitsPlan } from "@/lib/ai/contracts";
import {
  reviewSaleDraft,
  type AskAssistant,
  type SaleDraft,
} from "@/lib/pharmacy/assistant";
import { friendlyError } from "@/lib/pharmacy/api";
import { formatAmount } from "@/lib/pharmacy/money";
import { POS, type WorkflowProps } from "./workflows";
import { ErrorBox } from "./ui";

export function Assistant(
  props: WorkflowProps & {
    ask: AskAssistant;
    openInventory(search: string): void;
    openReports(): void;
  },
) {
  const [input, setInput] = useState("");
  const [result, setResult] = useState<AssistantResult | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [quantities, setQuantities] = useState<string[]>([]);
  const [payment, setPayment] = useState("");
  const [draft, setDraft] = useState<SaleDraft | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (request.current || !props.workspace || !input.trim()) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setResult(null);
    setError("");
    try {
      const value = await props.ask(
        props.workspace.id,
        props.warehouse,
        input,
        AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]),
      );
      if (controller.signal.aborted) return;
      setResult(value);
      setSelected(value.plan.items.map(() => ""));
      setQuantities(
        value.plan.items.map((item) =>
          item.quantity === null ? "" : String(item.quantity),
        ),
      );
      setPayment(value.plan.payment ?? "");
    } catch (e) {
      if (!controller.signal.aborted) setError(friendlyError(e));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      request.current = null;
    }
  }
  if (draft)
    return (
      <>
        <div className="setup-notice">
          <p>
            هذه مسودة مراجعة. راجع العبوات والكميات والإجمالي؛ التسجيل يتم بزر
            نقطة البيع.
          </p>
          <button className="secondary-button" onClick={() => setDraft(null)}>
            إغلاق مراجعة المسودة
          </button>
        </div>
        <POS {...props} draft={draft} />
      </>
    );
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">موصل داخل YmPharma</span>
          <h1>مساعد العمل</h1>
          <p>
            حضّر مسودة بيع، ابحث في المخزون، أو افتح التقارير بصلاحيات حسابك.
          </p>
        </div>
      </div>
      <section className="panel stack">
        <p>
          يُرسل نص الطلب إلى OpenAI لفهمه. اكتب أسماء الأصناف والكميات فقط؛ لا
          تُدخل بيانات مرضى أو أسرارًا.
        </p>
        <form className="stack" onSubmit={submit}>
          <label>
            طلبك
            <textarea
              aria-label="طلب المساعد"
              rows={4}
              maxLength={2000}
              value={input}
              disabled={busy || !props.workspace}
              onChange={(e) => {
                setInput(e.target.value);
                setResult(null);
                setError("");
              }}
              placeholder="مثال: حضّر بيع علبتين من اسم الصنف نقدًا"
            />
          </label>
          <button
            className="primary-button"
            disabled={busy || !input.trim() || !props.workspace}
          >
            {busy ? "جار إعداد المسودة…" : "تحضير الطلب"}
          </button>
        </form>
        {error && <ErrorBox message={error} />}
        {result && props.workspace && (
          <div className="stack" aria-live="polite">
            <strong>اقتراح المساعد — لم تُسجّل أي عملية</strong>
            <p>{result.plan.explanation}</p>
            {!permitsPlan(props.workspace.role, result.plan) ? (
              <ErrorBox message="هذا الطلب خارج صلاحيات حسابك." />
            ) : (
              <>
                {result.plan.action === "inventory" && (
                  <button
                    className="secondary-button"
                    onClick={() => props.openInventory(result.plan.search)}
                  >
                    عرض المخزون الفعلي
                  </button>
                )}
                {result.plan.action === "reports" && (
                  <button
                    className="secondary-button"
                    onClick={props.openReports}
                  >
                    فتح التقارير المالية
                  </button>
                )}
                {result.plan.action === "sale" && (
                  <>
                    <p>
                      اختر العبوة بنفسك لكل بند. الأسعار والأرصدة أدناه من دليل
                      المنشأة؛ يعيد الخادم التحقق منها عند التسجيل.
                    </p>
                    {result.plan.items.map((item, i) => (
                      <div className="stack" key={i}>
                        <label>
                          مطابقة: {item.search}
                          <select
                            aria-label={`العبوة للبند ${i + 1}`}
                            value={selected[i] ?? ""}
                            onChange={(e) =>
                              setSelected((s) =>
                                s.map((v, j) => (j === i ? e.target.value : v)),
                              )
                            }
                          >
                            <option value="">اختر العبوة المطابقة</option>
                            {result.matches[i]?.map((unit) => (
                              <option
                                key={unit.unit_id}
                                value={unit.unit_id}
                                disabled={
                                  unit.controlled ||
                                  unit.requires_prescription ||
                                  unit.available_base < unit.factor
                                }
                              >
                                {unit.trade_name} · {unit.unit_name} ·{" "}
                                {formatAmount(unit.selling_price)}{" "}
                                {props.workspace?.currency} ·{" "}
                                {Math.floor(unit.available_base / unit.factor)}{" "}
                                متاح
                              </option>
                            ))}
                          </select>
                        </label>
                        {!result.matches[i]?.length && (
                          <p>
                            لا توجد مطابقة. عدّل الطلب باستخدام اسم أدق أو
                            باركود العبوة.
                          </p>
                        )}
                        <label>
                          الكمية
                          <input
                            aria-label={`كمية البند ${i + 1}`}
                            type="number"
                            min={1}
                            max={999999}
                            step={1}
                            value={quantities[i] ?? ""}
                            onChange={(e) =>
                              setQuantities((s) =>
                                s.map((v, j) => (j === i ? e.target.value : v)),
                              )
                            }
                          />
                        </label>
                      </div>
                    ))}
                    <label>
                      طريقة الدفع
                      <select
                        aria-label="دفع المسودة"
                        value={payment}
                        onChange={(e) => setPayment(e.target.value)}
                      >
                        <option value="">اختر طريقة الدفع</option>
                        <option value="cash">نقدًا</option>
                        <option value="bank">بنك</option>
                      </select>
                    </label>
                    <button
                      className="primary-button"
                      onClick={() => {
                        try {
                          setDraft(
                            reviewSaleDraft(
                              result,
                              selected,
                              quantities,
                              payment,
                            ),
                          );
                          setError("");
                        } catch (e) {
                          setError(friendlyError(e));
                        }
                      }}
                    >
                      مراجعة المسودة في نقطة البيع
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        )}
      </section>
    </>
  );
}
