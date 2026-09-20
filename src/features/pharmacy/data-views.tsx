"use client";
import { useCallback, useState, type FormEvent } from "react";
import { Search, Printer } from "lucide-react";
import type { PharmacyApi, Workspace } from "@/lib/pharmacy/contracts";
import { permissions } from "@/lib/pharmacy/contracts";
import { decimalUnits, formatAmount, minorUnits } from "@/lib/pharmacy/money";
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
export function Reports({
  api,
  workspace,
  businessDate,
}: {
  api: PharmacyApi | null;
  workspace?: Workspace;
  businessDate: string;
}) {
  const allowed = permissions(workspace?.role).finance;
  const initialFrom = businessDate.slice(0, 7) + "-01";
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(businessDate);
  const [range, setRange] = useState({ from: initialFrom, to: businessDate });
  const [error, setError] = useState("");
  const load = useCallback(
    () =>
      allowed && api && workspace
        ? api.report(workspace.id, range.from, range.to)
        : null,
    [allowed, api, workspace, range],
  );
  const query = useRemote(load, `${workspace?.id}:${range.from}:${range.to}`);
  const rows = query.data?.accounts ?? [];
  const debit = rows.reduce((s, r) => s + minorUnits(r.debit), 0n);
  const credit = rows.reduce((s, r) => s + minorUnits(r.credit), 0n);
  const income = rows.filter(
    (r) => r.kind === "income" || r.kind === "expense",
  );
  const net = income.reduce(
    (s, r) => s + minorUnits(r.credit) - minorUnits(r.debit),
    0n,
  );
  function submit(e: FormEvent) {
    e.preventDefault();
    if (to < from) {
      setError("نهاية الفترة يجب ألا تسبق بدايتها.");
      return;
    }
    setError("");
    setRange({ from, to });
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">المالية</span>
          <h1>التقارير المالية</h1>
          <p>ميزان المراجعة وقائمة الدخل من القيود المرحّلة محليًا.</p>
        </div>
        <button
          className="secondary-button no-print"
          disabled={!query.data}
          onClick={() => window.print()}
        >
          <Printer size={17} />
          طباعة التقرير
        </button>
      </div>
      {!allowed ? (
        <ErrorBox message="التقارير المالية متاحة للمالك والمدير والمحاسب فقط." />
      ) : (
        <>
          <form className="panel report-filters no-print" onSubmit={submit}>
            <label className="field">
              من تاريخ
              <input
                type="date"
                required
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label className="field">
              إلى تاريخ
              <input
                type="date"
                required
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
            <button className="primary-button">عرض التقرير</button>
          </form>
          {error && <ErrorBox message={error} />}
          {query.error ? (
            <ErrorBox
              message={friendlyError(query.error)}
              retry={query.reload}
            />
          ) : query.loading ? (
            <Skeleton />
          ) : (
            <div className="report-content">
              <section className="panel">
                <div className="section-heading">
                  <div>
                    <h2>ميزان المراجعة</h2>
                    <p>
                      {query.data?.from} — {query.data?.to} ·{" "}
                      {workspace?.currency}
                    </p>
                  </div>
                  <span
                    className={`badge ${debit === credit ? "emerald" : "rose"}`}
                  >
                    {debit === credit ? "حركة متوازنة" : "فرق يحتاج مراجعة"}
                  </span>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>الحساب</th>
                        <th>رصيد أول المدة</th>
                        <th>مدين</th>
                        <th>دائن</th>
                        <th>رصيد آخر المدة</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <bdi>{r.code}</bdi> · {r.name}
                          </td>
                          <td>{formatAmount(r.opening)}</td>
                          <td>{formatAmount(r.debit)}</td>
                          <td>{formatAmount(r.credit)}</td>
                          <td>{formatAmount(r.closing)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <th>إجمالي الحركة</th>
                        <td />
                        <th>{formatAmount(decimalUnits(debit))}</th>
                        <th>{formatAmount(decimalUnits(credit))}</th>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
                <p className="field-note">
                  الرصيد الموجب مدين والسالب دائن. التقارير بالعملة الأساسية
                  للمنشأة.
                </p>
              </section>
              <section className="panel">
                <div className="section-heading">
                  <h2>قائمة الدخل</h2>
                  <span>{workspace?.currency}</span>
                </div>
                {income.length ? (
                  <>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>الحساب</th>
                            <th>التصنيف</th>
                            <th>صافي الحركة</th>
                          </tr>
                        </thead>
                        <tbody>
                          {income.map((r) => (
                            <tr key={r.id}>
                              <td>{r.name}</td>
                              <td>{r.kind === "income" ? "إيراد" : "مصروف"}</td>
                              <td>
                                {formatAmount(
                                  decimalUnits(
                                    r.kind === "income"
                                      ? minorUnits(r.credit) -
                                          minorUnits(r.debit)
                                      : minorUnits(r.debit) -
                                          minorUnits(r.credit),
                                  ),
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="total-line">
                      <span>صافي نتيجة الفترة</span>
                      <strong>{formatAmount(decimalUnits(net))}</strong>
                    </div>
                  </>
                ) : (
                  <Empty title="لا توجد حسابات إيراد أو مصروف للعرض" />
                )}
              </section>
            </div>
          )}
        </>
      )}
    </>
  );
}
