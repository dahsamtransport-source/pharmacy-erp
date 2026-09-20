"use client";
import { motion, useReducedMotion, type Variants } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  ArrowUpLeft,
  Package,
  ShoppingBag,
  TrendingUp,
  ArrowLeft,
  CalendarDays,
} from "lucide-react";
import type { Dashboard } from "@/lib/pharmacy/contracts";
import { formatAmount, percentChange } from "@/lib/pharmacy/money";
import { Empty, Skeleton } from "@/features/pharmacy/ui";
export type Page = "dashboard" | "pos" | "purchases" | "inventory" | "reports";
export interface DashboardProps {
  data?: Dashboard;
  currency?: string;
  name?: string;
  loading: boolean;
  connected: boolean;
  canSell: boolean;
  navigate: (page: Page) => void;
  openReceipt: (id: string) => void;
}
const containerVariants: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.075, delayChildren: 0.05 },
  },
};
const itemVariants: Variants = {
  hidden: { opacity: 0, y: 16 },
  show: {
    opacity: 1,
    y: 0,
    transition: { type: "spring", stiffness: 300, damping: 26 },
  },
};
export default function AnimatedDashboard({
  data,
  currency,
  name,
  loading,
  connected,
  canSell,
  navigate,
  openReceipt,
}: DashboardProps) {
  const reduce = useReducedMotion();
  const trend = data
    ? percentChange(data.today_total, data.yesterday_total)
    : null;
  const series =
    data?.series.filter(
      (x): x is { date: string; total: string } => x.total !== null,
    ) ?? [];
  const max = Math.max(1, ...series.map((x) => Number(x.total))); // Chart geometry only; never financial arithmetic.
  const cards = [
    {
      title: data?.scope === "mine" ? "مبيعاتك اليوم" : "مبيعات اليوم",
      value: formatAmount(data?.today_total),
      unit: currency ?? "",
      icon: TrendingUp,
      color: "indigo",
      caption:
        data?.scope === "inventory"
          ? "غير متاح ضمن صلاحياتك"
          : trend
            ? `${trend} مقارنة بالأمس`
            : "حسب الفواتير المسجلة",
      action: () => navigate("pos"),
    },
    {
      title: "تشغيلات تقارب الانتهاء",
      value: data ? String(data.expiring_count) : "—",
      unit: "تشغيلة",
      icon: AlertTriangle,
      color: "rose",
      caption: "خلال 90 يومًا",
      action: () => navigate("inventory"),
    },
    {
      title: "نواقص المخزون",
      value: data ? String(data.low_stock_count) : "—",
      unit: "صنف",
      icon: Package,
      color: "amber",
      caption: "أقل من حد الطلب المحدد",
      action: () => navigate("inventory"),
    },
  ];
  return (
    <>
      <motion.header
        initial={{ opacity: 0, y: reduce ? 0 : -10 }}
        animate={{ opacity: 1, y: 0 }}
        className="page-heading"
      >
        <div>
          <span className="eyebrow">نظرة عامة</span>
          <h1>
            مرحبًا{name ? `، ${name}` : " بك"}{" "}
            <span className="wave" aria-hidden>
              ✦
            </span>
          </h1>
          <p>كل ما تحتاجه لمتابعة يومك، في مكان واحد.</p>
        </div>
        <button
          className="primary-button"
          onClick={() => navigate("pos")}
          disabled={connected && !canSell}
        >
          <ShoppingBag size={19} />
          فتح نقطة البيع
          <ArrowUpLeft size={17} />
        </button>
      </motion.header>
      <motion.div
        variants={containerVariants}
        initial="hidden"
        animate="show"
        className="stat-grid"
      >
        {cards.map(
          ({ title, value, unit, icon: Icon, color, caption, action }) => (
            <motion.button
              type="button"
              key={title}
              variants={itemVariants}
              whileHover={reduce ? undefined : { y: -3 }}
              className={`stat-card ${color}`}
              onClick={action}
            >
              <div className="stat-top">
                <span className="stat-icon">
                  <Icon size={23} />
                </span>
                <ArrowUpLeft size={18} className="muted" />
              </div>
              <h2>{title}</h2>
              {loading ? (
                <span className="skeleton stat-skeleton" />
              ) : (
                <div className="stat-value">
                  <b dir="ltr">{value}</b>
                  <span>{unit}</span>
                </div>
              )}
              <p>{caption}</p>
            </motion.button>
          ),
        )}
      </motion.div>
      <div className="dashboard-middle">
        <section className="panel sales-panel">
          <div className="section-heading">
            <div>
              <h2>حركة المبيعات</h2>
              <p>
                {data?.scope === "mine"
                  ? "مبيعاتك خلال آخر 7 أيام"
                  : "آخر 7 أيام"}
              </p>
            </div>
            <span className="subtle-pill">
              <CalendarDays size={15} />
              {data?.business_date ?? "بانتظار البيانات"}
            </span>
          </div>
          {loading ? (
            <Skeleton />
          ) : series.length ? (
            <div
              className="chart"
              role="img"
              aria-label={`المبيعات اليومية: ${series.map((x) => `${x.date}: ${x.total}`).join("، ")}`}
            >
              <div className="chart-bars">
                {series.map((x, i) => (
                  <div className="bar-column" key={x.date}>
                    <span className="bar-value">{formatAmount(x.total)}</span>
                    <div
                      className={`bar ${i === series.length - 1 ? "last" : ""}`}
                      style={{
                        height: `${Math.max(2, (Number(x.total) / max) * 130)}px`,
                      }}
                    />
                    <span className="bar-date">{x.date.slice(5)}</span>
                  </div>
                ))}
              </div>
              <p className="chart-note">
                {currency} · من الفواتير المسجلة في المستودع المحدد
              </p>
            </div>
          ) : (
            <Empty
              title="لا توجد بيانات مبيعات للعرض"
              description={
                connected
                  ? "تظهر الحركة بعد تسجيل المبيعات، حسب صلاحياتك."
                  : "ستظهر البيانات الفعلية بعد ربط مساحة العمل وتسجيل الدخول."
              }
            />
          )}
        </section>
        <section className="panel quick-panel">
          <div className="section-heading">
            <h2>مهام يومك</h2>
            <span className="subtle-pill">وصول سريع</span>
          </div>
          <button
            className="quick-action"
            onClick={() => navigate("purchases")}
          >
            <span className="quick-icon emerald">
              <Package size={22} />
            </span>
            <span>
              <strong>استلام مشتريات</strong>
              <small>المورد، التشغيلات وتواريخ الصلاحية</small>
            </span>
            <ArrowLeft size={17} />
          </button>
          <button
            className="quick-action"
            onClick={() => navigate("inventory")}
          >
            <span className="quick-icon amber">
              <AlertTriangle size={22} />
            </span>
            <span>
              <strong>مراجعة المخزون</strong>
              <small>
                {data
                  ? `${data.expired_count} تشغيلة منتهية · ${data.low_stock_count} صنف ناقص`
                  : "الصلاحية، الكميات والحجوزات"}
              </small>
            </span>
            <ArrowLeft size={17} />
          </button>
          <div className="clinical-note">
            <Activity size={20} />
            <div>
              <strong>المراجعة الصيدلانية</strong>
              <p>
                قراءة الوصفات والفحص السريري الآلي غير مفعّلين في هذه النسخة.
              </p>
            </div>
          </div>
        </section>
      </div>
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>آخر المستندات</h2>
            <p>المستندات التي تسمح صلاحياتك بعرضها</p>
          </div>
          <span className="subtle-pill">
            {data?.recent.length ?? "—"} مستند
          </span>
        </div>
        {loading ? (
          <Skeleton />
        ) : data?.recent.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>مرجع المستند</th>
                  <th>النوع</th>
                  <th>التاريخ</th>
                  <th>الإجمالي</th>
                  <th>الحالة</th>
                  <th>
                    <span className="sr-only">الإجراء</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <bdi className="mono">{r.document_uuid.slice(0, 8)}</bdi>
                    </td>
                    <td>{r.kind === "sale" ? "مبيعات" : "مشتريات"}</td>
                    <td>
                      <bdi>{r.document_date}</bdi>
                    </td>
                    <td>
                      <bdi>
                        {formatAmount(r.total)} {r.currency}
                      </bdi>
                    </td>
                    <td>
                      <span className="badge emerald">مسجل محليًا</span>
                    </td>
                    <td>
                      <button
                        className="text-button"
                        onClick={() => openReceipt(r.id)}
                      >
                        عرض المستند
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="لا توجد مستندات للعرض"
            description="تظهر هنا العمليات المسجلة بعد الاتصال بحسابك."
          />
        )}
      </section>
    </>
  );
}
