"use client";
import { useCallback, useState, type FormEvent } from "react";
import {
  Building2,
  CalendarDays,
  Download,
  FileText,
  PieChart,
  Printer,
  RefreshCw,
} from "lucide-react";
import type { PharmacyApi, Workspace } from "@/lib/pharmacy/contracts";
import { permissions } from "@/lib/pharmacy/contracts";
import { friendlyError } from "@/lib/pharmacy/api";
import { formatAmount, minorUnits } from "@/lib/pharmacy/money";
import {
  accountKinds,
  accountPeriodAmount,
  downloadStatement,
  validReportRange,
  type FinancialStatement,
  type FinancialTab,
  type ReportRange,
  type StatementAccount,
} from "@/lib/pharmacy/financial";
import { useOnline, useRemote } from "@/hooks/use-remote";
import { Empty, ErrorBox, Skeleton } from "@/features/pharmacy/ui";

interface Props {
  api: PharmacyApi | null;
  workspace?: Workspace;
  businessDate: string;
}
export default function FinancialReports(props: Props) {
  if (!permissions(props.workspace?.role).finance)
    return (
      <ErrorBox message="التقارير المالية متاحة للمالك والمدير والمحاسب فقط." />
    );
  if (!props.api || !props.workspace)
    return (
      <Empty
        title="خدمة التقارير غير متصلة"
        description="تظهر الأرصدة بعد ربط مساحة العمل والتحقق من الحساب."
      />
    );
  return (
    <ReportWorkspace
      key={`${props.workspace.id}:${props.workspace.role}`}
      {...props}
      api={props.api}
      workspace={props.workspace}
    />
  );
}
function ReportWorkspace({
  api,
  workspace,
  businessDate,
}: Props & { api: PharmacyApi; workspace: Workspace }) {
  const online = useOnline();
  const [tab, setTab] = useState<FinancialTab>("trial");
  const [draft, setDraft] = useState<ReportRange>({
    from: `${businessDate.slice(0, 7)}-01`,
    to: businessDate,
    center: null,
    includeZero: false,
  });
  const [range, setRange] = useState(draft);
  const [error, setError] = useState("");
  const optionsLoad = useCallback(
    () => api.reportOptions(workspace.id),
    [api, workspace.id],
  );
  const options = useRemote(
    optionsLoad,
    `${workspace.id}:${workspace.role}:centers`,
  );
  const load = useCallback(
    () => api.statement(workspace.id, range),
    [api, workspace.id, range],
  );
  const query = useRemote(
    load,
    `${workspace.id}:${workspace.role}:${JSON.stringify(range)}`,
  );
  const report = query.data;
  const dirty = JSON.stringify(draft) !== JSON.stringify(range);
  const exportable = !!report && !query.loading && !query.error && !dirty;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!online) {
      setError("تحديث التقرير يحتاج اتصالًا بالإنترنت.");
      return;
    }
    if (!validReportRange(draft)) {
      setError("اختر فترة صحيحة لا يزيد الفرق بين تاريخيها عن 366 يومًا.");
      return;
    }
    setError("");
    if (dirty) setRange({ ...draft });
    else query.reload();
  }
  function exportCsv() {
    if (!exportable || !report) return;
    try {
      downloadStatement(report, tab);
    } catch {
      setError("تعذّر تنزيل التقرير. حاول مجددًا.");
    }
  }
  return (
    <div className="financial-workspace">
      <div className="page-heading no-print">
        <div>
          <span className="eyebrow">دفاتر واضحة، قرارات أدق</span>
          <h1>التقارير المالية</h1>
          <p>قراءة موحّدة من القيود المرحّلة؛ تُحدّث عند طلب التقرير.</p>
        </div>
        <div className="financial-actions">
          <button
            className="secondary-button"
            disabled={!exportable}
            onClick={exportCsv}
          >
            <Download size={17} />
            تصدير CSV
          </button>
          <button
            className="primary-button"
            disabled={!exportable}
            onClick={() => {
              if (exportable) window.print();
            }}
          >
            <Printer size={17} />
            طباعة التقرير
          </button>
        </div>
      </div>
      <section
        className="panel financial-controls no-print"
        aria-label="إعدادات التقارير المالية"
      >
        <div className="financial-tabs" role="tablist" aria-label="نوع التقرير">
          <button
            id="trial-tab"
            role="tab"
            aria-selected={tab === "trial"}
            aria-controls="financial-panel"
            onClick={() => setTab("trial")}
          >
            <FileText size={18} />
            ميزان المراجعة
          </button>
          <button
            id="income-tab"
            role="tab"
            aria-selected={tab === "income"}
            aria-controls="financial-panel"
            onClick={() => setTab("income")}
          >
            <PieChart size={18} />
            قائمة الدخل
          </button>
        </div>
        <form className="financial-filters" onSubmit={submit}>
          <label className="field">
            <span>
              <CalendarDays size={15} />
              من تاريخ
            </span>
            <input
              aria-label="من تاريخ"
              type="date"
              min="1900-01-01"
              max="9999-12-31"
              required
              value={draft.from}
              onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            />
          </label>
          <label className="field">
            إلى تاريخ
            <input
              type="date"
              min="1900-01-01"
              max="9999-12-31"
              required
              value={draft.to}
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            />
          </label>
          <label className="field">
            مركز التكلفة
            <select
              value={draft.center ?? ""}
              onChange={(e) =>
                setDraft({ ...draft, center: e.target.value || null })
              }
              disabled={options.loading || !!options.error}
            >
              <option value="">جميع مراكز التكلفة</option>
              {options.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} · {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="financial-check">
            <input
              type="checkbox"
              checked={draft.includeZero}
              onChange={(e) =>
                setDraft({ ...draft, includeZero: e.target.checked })
              }
            />
            إظهار الحسابات دون أرصدة أو حركة
          </label>
          <button
            className="secondary-button"
            disabled={!online || query.loading}
          >
            <RefreshCw size={17} />
            تحديث التقرير
          </button>
        </form>
        {dirty && (
          <p className="financial-dirty" role="status">
            تغيّرت عوامل التصفية. اضغط تحديث التقرير قبل الطباعة أو التصدير.
          </p>
        )}
        {!online && (
          <p className="financial-dirty">
            لا يوجد اتصال. البيانات الظاهرة تخص وقت آخر جلب موضح في الترويسة.
          </p>
        )}
      </section>
      {!!options.error && (
        <ErrorBox
          message="تعذّر تحميل مراكز التكلفة. يمكنك عرض التقرير العام أو إعادة المحاولة."
          retry={options.reload}
        />
      )}
      {error && <ErrorBox message={error} />}
      {query.error ? (
        <ErrorBox message={friendlyError(query.error)} retry={query.reload} />
      ) : query.loading ? (
        <Skeleton />
      ) : report ? (
        <section
          className="financial-sheet"
          data-report={tab}
          id="financial-panel"
          role="tabpanel"
          aria-labelledby={`${tab}-tab`}
        >
          <header className="financial-report-head">
            <div className="financial-company">
              <span className="financial-logo">
                <Building2 size={27} />
              </span>
              <div>
                <h2>{report.organization}</h2>
                <p>YmPharma · النظام المالي والمحاسبي</p>
              </div>
            </div>
            <div className="financial-report-title">
              <h2>{tab === "trial" ? "ميزان المراجعة" : "قائمة الدخل"}</h2>
              <p>
                الفترة: <bdi>{report.from}</bdi> إلى <bdi>{report.to}</bdi>
              </p>
            </div>
          </header>
          <dl className="financial-metadata">
            <div>
              <dt>مركز التكلفة</dt>
              <dd>{report.cost_center?.name ?? "جميع مراكز التكلفة"}</dd>
            </div>
            <div>
              <dt>العملة</dt>
              <dd>{report.currency}</dd>
            </div>
            <div>
              <dt>عدد القيود في الفترة</dt>
              <dd>{report.posted_journal_count}</dd>
            </div>
            <div>
              <dt>وقت جلب البيانات</dt>
              <dd>
                <bdi>
                  {new Intl.DateTimeFormat("ar-YE-u-nu-latn", {
                    timeZone: report.timezone,
                    dateStyle: "short",
                    timeStyle: "short",
                  }).format(new Date(report.generated_at))}
                </bdi>
                <small>{report.timezone}</small>
              </dd>
            </div>
          </dl>
          {!report.totals.has_data && (
            <p className="financial-empty" role="status">
              لا توجد أرصدة أو حركات مرحّلة ضمن نطاق التقرير. لا يدل ذلك على
              اكتمال الدفاتر.
            </p>
          )}
          {tab === "trial" ? (
            <TrialBalance report={report} />
          ) : (
            <IncomeStatement report={report} />
          )}
          <footer className="financial-footnote">
            <p>
              يشمل القيود المرحّلة فقط. التوازن العددي لا يثبت اكتمال التسجيل أو
              الاعتماد الضريبي.
            </p>
            <p className="print-signature">
              مراجعة المحاسب: ____________________ &nbsp; التاريخ:
              ______________
            </p>
          </footer>
        </section>
      ) : (
        <Empty title="لم تتوفر بيانات التقرير" />
      )}
    </div>
  );
}
const balanceFields = [
  "opening_debit",
  "opening_credit",
  "debit",
  "credit",
  "closing_debit",
  "closing_credit",
] as const;
function TrialBalance({ report }: { report: FinancialStatement }) {
  const totals = report.totals;
  return (
    <>
      <div className="table-scroll financial-table">
        <table aria-label="جدول ميزان المراجعة">
          <thead>
            <tr>
              <th rowSpan={2} scope="col">
                الرمز
              </th>
              <th rowSpan={2} scope="col">
                الحساب
              </th>
              <th rowSpan={2} scope="col">
                التصنيف
              </th>
              <th colSpan={2} scope="colgroup">
                أول المدة
              </th>
              <th colSpan={2} scope="colgroup">
                حركة الفترة
              </th>
              <th colSpan={2} scope="colgroup">
                آخر المدة
              </th>
            </tr>
            <tr>
              {["افتتاحي", "حركة", "ختامي"].flatMap((group) => [
                <th scope="col" key={`${group}-d`}>
                  مدين
                </th>,
                <th scope="col" key={`${group}-c`}>
                  دائن
                </th>,
              ])}
            </tr>
          </thead>
          <tbody>
            {report.accounts.map((r) => (
              <tr key={r.id}>
                <td>
                  <bdi>{r.code}</bdi>
                </td>
                <th scope="row">{r.name}</th>
                <td>{accountKinds[r.kind]}</td>
                {balanceFields.map((field) => (
                  <td className="money-cell" key={field}>
                    <bdi>{formatAmount(r[field])}</bdi>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={3} scope="row">
                الإجمالي
              </th>
              {balanceFields.map((field) => (
                <td className="money-cell" key={field}>
                  <bdi>{formatAmount(totals[field])}</bdi>
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
      {totals.has_data && (
        <div
          className={`financial-balance ${totals.balanced ? "balanced" : "unbalanced"}`}
          role="status"
        >
          {totals.balanced
            ? "أرصدة أول المدة وحركة الفترة وأرصدة آخر المدة متوازنة عدديًا."
            : "يوجد فرق في ميزان المراجعة. يجب فحص القيود قبل الاعتماد."}
        </div>
      )}
    </>
  );
}
function IncomeGroup({
  title,
  rows,
  total,
  currency,
}: {
  title: string;
  rows: StatementAccount[];
  total: string;
  currency: string;
}) {
  return (
    <section className="income-group">
      <h3>{title}</h3>
      {rows.length ? (
        rows.map((r) => (
          <div className="income-row" key={r.id}>
            <span>
              {r.name}
              <small>
                <bdi>{r.code}</bdi>
              </small>
            </span>
            <bdi>{formatAmount(accountPeriodAmount(r))}</bdi>
          </div>
        ))
      ) : (
        <p className="muted">لا توجد حركة في هذه المجموعة.</p>
      )}
      <div className="income-total">
        <strong>إجمالي {title}</strong>
        <strong>
          <bdi>{formatAmount(total)}</bdi> {currency}
        </strong>
      </div>
    </section>
  );
}
function IncomeStatement({ report }: { report: FinancialStatement }) {
  const active = report.accounts.filter(
    (r) => minorUnits(r.debit) !== 0n || minorUnits(r.credit) !== 0n,
  );
  const s = report.income,
    loss = minorUnits(s.net_income) < 0n;
  return (
    <div className="income-statement">
      <IncomeGroup
        title="الإيرادات"
        rows={active.filter((r) => r.kind === "income")}
        total={s.revenue}
        currency={report.currency}
      />
      <IncomeGroup
        title="تكلفة المبيعات"
        rows={active.filter((r) => r.kind === "expense" && r.is_cogs)}
        total={s.cost_of_sales}
        currency={report.currency}
      />
      <div className="income-gross">
        <strong>مجمل الربح / الخسارة</strong>
        <strong>
          <bdi>{formatAmount(s.gross_profit)}</bdi> {report.currency}
        </strong>
      </div>
      <IncomeGroup
        title="المصروفات التشغيلية"
        rows={active.filter((r) => r.kind === "expense" && !r.is_cogs)}
        total={s.operating_expenses}
        currency={report.currency}
      />
      <div className={`income-net ${loss ? "loss" : "profit"}`}>
        <span>
          <PieChart size={25} />
          {loss ? "صافي الخسارة" : "صافي الربح"}
        </span>
        <strong>
          <bdi>{formatAmount(s.net_income)}</bdi>{" "}
          <small>{report.currency}</small>
        </strong>
      </div>
      <p className="field-note">
        تصنيف تكلفة المبيعات حسب ربط الحساب المحاسبي المهيأ؛ باقي حسابات
        المصروفات تظهر ضمن المصروفات التشغيلية.
      </p>
    </div>
  );
}
