"use client";
import { useCallback, useState } from "react";
import { Search } from "lucide-react";
import type { PharmacyApi, Workspace } from "@/lib/pharmacy/contracts";
import { friendlyError } from "@/lib/pharmacy/api";
import { useRemote } from "@/hooks/use-remote";
import { Empty, ErrorBox, Skeleton } from "./ui";
export function Inventory({
  api,
  workspace,
  warehouse,
  initialSearch = "",
}: {
  api: PharmacyApi | null;
  workspace?: Workspace;
  warehouse: string;
  initialSearch?: string;
}) {
  const [term, setTerm] = useState(initialSearch);
  const [search, setSearch] = useState(initialSearch);
  const [offset, setOffset] = useState(0);
  const load = useCallback(
    () =>
      api && workspace && warehouse
        ? api.inventory(workspace.id, warehouse, search, offset)
        : null,
    [api, workspace, warehouse, search, offset],
  );
  const query = useRemote(
    load,
    `${workspace?.id}:${warehouse}:${search}:${offset}`,
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">المخزون</span>
          <h1>التشغيلات والصلاحية</h1>
          <p>الرصيد الفعلي والمحجوز، مع تمييز التشغيلة غير القابلة للصرف.</p>
        </div>
      </div>
      <section className="panel">
        <form
          className="search-field"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(term.trim());
            setOffset(0);
          }}
        >
          <Search size={19} />
          <input
            placeholder="ابحث باسم الصنف أو رقم التشغيلة"
            aria-label="بحث التشغيلات"
            maxLength={120}
            value={term}
            disabled={!workspace}
            onChange={(e) => setTerm(e.target.value)}
          />
          <button className="text-button" disabled={!workspace}>
            بحث
          </button>
        </form>
        {query.error ? (
          <ErrorBox message={friendlyError(query.error)} retry={query.reload} />
        ) : workspace && query.loading ? (
          <Skeleton />
        ) : query.data?.length ? (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>الصنف</th>
                    <th>التشغيلة</th>
                    <th>الصلاحية</th>
                    <th>الرصيد</th>
                    <th>المحجوز</th>
                    <th>الحالة</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.map((b) => (
                    <tr key={b.id}>
                      <td>
                        <strong>{b.trade_name}</strong>
                      </td>
                      <td>
                        <bdi>{b.batch_number}</bdi>
                      </td>
                      <td>
                        <bdi>{b.expiry_date}</bdi>
                      </td>
                      <td>{b.quantity}</td>
                      <td>{b.reserved}</td>
                      <td>
                        <span
                          className={`badge ${b.expired || b.status !== "available" ? "rose" : "emerald"}`}
                        >
                          {b.expired
                            ? "منتهية"
                            : b.status === "quarantine"
                              ? "محجورة"
                              : b.status === "recalled"
                                ? "مستدعاة"
                                : "متاحة"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="field-note">
              الكميات بوحدة الصنف الأساسية؛ لا تعرض هذه الشاشة سعر التكلفة.
            </p>
            <div className="pagination">
              <button
                className="secondary-button"
                disabled={offset === 0}
                onClick={() => setOffset((n) => Math.max(0, n - 30))}
              >
                السابق
              </button>
              <span>
                {offset + 1}–{offset + query.data.length}
              </span>
              <button
                className="secondary-button"
                disabled={query.data.length < 30}
                onClick={() => setOffset((n) => n + 30)}
              >
                التالي
              </button>
            </div>
          </>
        ) : (
          <Empty
            title={workspace ? "لا توجد تشغيلات مطابقة" : "المخزون غير متصل"}
            description="تظهر التشغيلات بعد تسجيل الاستلام في المستودع المحدد."
          />
        )}
      </section>
    </>
  );
}
export { default as Reports } from "@/FinancialReports";
