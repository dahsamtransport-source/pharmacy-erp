"use client";
import { useCallback } from "react";
import type { PharmacyApi } from "@/lib/pharmacy/contracts";
import type { ReportRange } from "@/lib/pharmacy/financial";
import { formatAmount } from "@/lib/pharmacy/money";
import { downloadLedger } from "@/lib/pharmacy/ledger";
import { friendlyError } from "@/lib/pharmacy/api";
import { useRemote } from "@/hooks/use-remote";
import { Dialog, Empty, ErrorBox, Skeleton } from "./ui";

export function AccountLedger({
  api,
  org,
  account,
  range,
  onClose,
}: {
  api: PharmacyApi;
  org: string;
  account: string;
  range: ReportRange;
  onClose: () => void;
}) {
  const load = useCallback(
    () => api.ledger(org, account, range),
    [api, org, account, range],
  );
  const query = useRemote(load, `${org}:${account}:${JSON.stringify(range)}`);
  const r = query.data;
  return (
    <Dialog title="دفتر الأستاذ — كشف حركة الحساب" onClose={onClose}>
      {query.loading ? (
        <Skeleton />
      ) : query.error ? (
        <ErrorBox message={friendlyError(query.error)} retry={query.reload} />
      ) : r ? (
        <div className="ledger-detail">
          <h3>
            {r.organization_name} · {r.account.code} — {r.account.name}
          </h3>
          <p>
            الفترة: <bdi>{r.from}</bdi> إلى <bdi>{r.to}</bdi> · العملة:{" "}
            {r.currency}
          </p>
          <p>
            رصيد أول المدة: <bdi>{formatAmount(r.opening)}</bdi> · رصيد آخر
            المدة: <bdi>{formatAmount(r.closing)}</bdi>
          </p>
          <p className="muted">
            الرصيد الموجب مدين والسالب دائن. يشمل القيود المرحّلة فقط وبنطاق
            مركز التكلفة المختار. أُعيد جلب الكشف عند فتحه؛ قد يختلف عن ملخص
            سابق إذا أضيفت قيود.
          </p>
          <div className="ledger-actions">
            <button
              className="button secondary"
              onClick={() => downloadLedger(r)}
            >
              تصدير كشف الحساب CSV
            </button>
            <button className="button secondary" onClick={query.reload}>
              تحديث الكشف
            </button>
          </div>
          {r.entries.length ? (
            <div className="table-scroll financial-table">
              <table>
                <caption>{r.count} قيدًا في الفترة</caption>
                <thead>
                  <tr>
                    {[
                      "التاريخ",
                      "مرجع المستند",
                      "البيان",
                      "مدين",
                      "دائن",
                      "الرصيد",
                    ].map((t) => (
                      <th key={t}>{t}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {r.entries.map((e) => (
                    <tr key={e.journal_id}>
                      <td>
                        <bdi>{e.document_date}</bdi>
                      </td>
                      <td>
                        <details>
                          <summary>عرض المرجع</summary>
                          <small>
                            المستند: <bdi>{e.document_uuid}</bdi>
                            <br />
                            القيد: <bdi>{e.journal_id}</bdi>
                          </small>
                        </details>
                      </td>
                      <th scope="row">{e.description}</th>
                      {[e.debit, e.credit, e.balance].map((n, i) => (
                        <td key={i} className="money-cell">
                          <bdi>{formatAmount(n)}</bdi>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th colSpan={3}>الإجمالي</th>
                    {[r.debit, r.credit, r.closing].map((n, i) => (
                      <td key={i} className="money-cell">
                        <bdi>{formatAmount(n)}</bdi>
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : (
            <Empty
              title="لا توجد حركة مرحّلة في الفترة"
              description="قد يوجد رصيد افتتاحي من فترات سابقة."
            />
          )}
          <small>
            وقت الجلب: <bdi>{r.generated_at}</bdi>
          </small>
        </div>
      ) : (
        <Empty title="لم تتوفر بيانات الكشف" />
      )}
    </Dialog>
  );
}
