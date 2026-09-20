"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { MotionConfig } from "framer-motion";
import {
  Activity,
  LayoutDashboard,
  ShoppingBag,
  Package,
  ClipboardList,
  ChartNoAxesCombined,
  Bell,
  Search,
  Menu,
  LogOut,
  Settings,
  ChevronDown,
  WifiOff,
  RefreshCw,
  ShieldCheck,
  ArrowLeft,
} from "lucide-react";
import AnimatedDashboard, { type Page } from "@/AnimatedDashboard";
import {
  permissions,
  roleLabels,
  type Receipt,
} from "@/lib/pharmacy/contracts";
import { friendlyError } from "@/lib/pharmacy/api";
import { businessDateInZone } from "@/lib/pharmacy/financial";
import { useRemote, useOnline } from "@/hooks/use-remote";
import { PharmacySession, usePharmacySession } from "./session";
import { Dialog, ErrorBox } from "./ui";
import { POS, PurchaseReceipt, ReceiptDialog } from "./workflows";
import { Inventory, Reports } from "./data-views";
const pageLabels: Record<Page, string> = {
  dashboard: "لوحة التحكم",
  pos: "نقطة البيع",
  purchases: "المشتريات",
  inventory: "المخزون والصلاحية",
  reports: "التقارير المالية",
};
export default function PharmacyApp() {
  return (
    <PharmacySession>
      <MotionConfig reducedMotion="user">
        <WorkspaceApp />
      </MotionConfig>
    </PharmacySession>
  );
}
function WorkspaceApp() {
  const session = usePharmacySession();
  const { auth, api } = session;
  const online = useOnline();
  const workspace = auth.status === "ready" ? auth.workspaces[0] : undefined;
  const userId = auth.status === "ready" ? auth.userId : "";
  const [warehouseChoice, setWarehouseChoice] = useState("");
  const warehouse = workspace?.warehouses.some((w) => w.id === warehouseChoice)
    ? warehouseChoice
    : (workspace?.warehouses[0]?.id ?? "");
  const [page, setPage] = useState<Page>("dashboard");
  const [menu, setMenu] = useState(false);
  const [login, setLogin] = useState(false);
  const [settings, setSettings] = useState(false);
  const [alerts, setAlerts] = useState(false);
  const [receipt, setReceipt] = useState<{
    identity: string;
    value: Receipt;
  } | null>(null);
  const [toast, setToast] = useState("");
  const [globalSearch, setGlobalSearch] = useState("");
  const [stockSearch, setStockSearch] = useState("");
  const role = workspace?.role;
  const access = permissions(role);
  const ready = auth.status === "ready" && !!workspace && !!warehouse;
  const effectiveApi = ready ? api : null;
  const load = useCallback(
    () =>
      effectiveApi && workspace
        ? effectiveApi.dashboard(workspace.id, warehouse)
        : null,
    [effectiveApi, workspace, warehouse],
  );
  const dashboard = useRemote(
    load,
    `${userId}:${workspace?.id}:${warehouse}:${role}`,
  );
  const data = ready ? dashboard.data : undefined;
  const identity = `${userId}:${workspace?.id}:${warehouse}:${role}`;
  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(""), 6000);
    return () => clearTimeout(timeout);
  }, [toast]);
  function navigate(next: Page) {
    setPage(next);
    setMenu(false);
  }
  async function openReceipt(id: string) {
    if (!api || !workspace) return;
    try {
      setReceipt({ identity, value: await api.receipt(workspace.id, id) });
    } catch (e) {
      setToast(friendlyError(e));
    }
  }
  function received(value: Receipt) {
    setReceipt({ identity, value });
    dashboard.reload();
  }
  const items = [
    { page: "dashboard" as const, icon: LayoutDashboard },
    { page: "pos" as const, icon: ShoppingBag },
    { page: "purchases" as const, icon: ClipboardList },
    { page: "inventory" as const, icon: Package },
    { page: "reports" as const, icon: ChartNoAxesCombined },
  ].filter(
    (x) =>
      !role ||
      ((x.page !== "reports" || access.finance) &&
        (x.page !== "purchases" || access.purchase) &&
        (x.page !== "pos" || access.sell)),
  );
  const currentReceipt =
    ready && receipt?.identity === identity ? receipt.value : null;
  return (
    <div className="app-shell" dir="rtl">
      <a href="#main-content" className="skip-link">
        انتقل إلى المحتوى
      </a>
      {menu && (
        <button
          className="nav-backdrop"
          aria-label="إغلاق قائمة التنقل"
          onClick={() => setMenu(false)}
        />
      )}
      <aside
        className={`sidebar ${menu ? "is-open" : ""}`}
        aria-label="القائمة الجانبية"
      >
        <Link className="brand" href="/" aria-label="YmPharma الرئيسية">
          <span className="brand-mark">
            <Activity size={26} />
          </span>
          <span>
            <b>
              YmPharma<span className="brand-dot">.</span>
            </b>
            <small>إدارة الصيدلية والمالية</small>
          </span>
        </Link>
        <div className="workspace-card">
          <span className="workspace-avatar">ص</span>
          <span>
            <strong>{workspace?.name ?? "مساحة الصيدلية"}</strong>
            <small>
              {workspace ? "منشأة واحدة · إدارة موحّدة" : "بانتظار ربط الحساب"}
            </small>
          </span>
        </div>
        <nav aria-label="التنقل الرئيسي">
          <details open>
            <summary>
              مساحة العمل
              <ChevronDown size={14} />
            </summary>
            <div className="nav-items">
              {items.map(({ page: p, icon: Icon }) => (
                <button
                  key={p}
                  className={`nav-item ${page === p ? "active" : ""}`}
                  aria-current={page === p ? "page" : undefined}
                  onClick={() => navigate(p)}
                >
                  <Icon size={20} />
                  {pageLabels[p]}
                  {page === p && <span className="nav-active-dot" />}
                </button>
              ))}
            </div>
          </details>
        </nav>
        <div className="sidebar-bottom">
          <div className="security-note">
            <ShieldCheck size={20} />
            <span>
              مساحة عمل محمية<small>كل إجراء مرتبط بصلاحية حسابك</small>
            </span>
          </div>
          <button className="nav-item" onClick={() => setSettings(true)}>
            <Settings size={20} />
            حالة الاتصال
          </button>
          <div className="sidebar-version">
            YmPharma <span>SPRINT 02</span>
          </div>
        </div>
      </aside>
      <div className="app-body">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="فتح القائمة"
              aria-expanded={menu}
              onClick={() => setMenu(!menu)}
            >
              <Menu size={23} />
            </button>
            <span>مساحة العمل</span>
            <span className="muted">/</span>
            <strong>{pageLabels[page]}</strong>
          </div>
          <div className="topbar-actions">
            <form
              className="global-search"
              onSubmit={(e) => {
                e.preventDefault();
                setStockSearch(globalSearch.trim());
                navigate("inventory");
              }}
            >
              <Search size={17} />
              <input
                aria-label="البحث العام عن صنف أو تشغيلة"
                placeholder="ابحث عن صنف أو تشغيلة…"
                maxLength={120}
                value={globalSearch}
                onChange={(e) => setGlobalSearch(e.target.value)}
              />
              <kbd>↵</kbd>
            </form>
            <button
              className="icon-button bell"
              aria-label="عرض تنبيهات المخزون"
              onClick={() => setAlerts(true)}
            >
              <Bell size={21} />
              {data &&
                data.expired_count +
                  data.expiring_count +
                  data.low_stock_count >
                  0 && <span className="notification-dot" />}
            </button>
            <span className="topbar-divider" />
            <button
              className="profile"
              onClick={() => (ready ? setSettings(true) : setLogin(true))}
            >
              <span className="profile-avatar">
                {auth.status === "ready" ? auth.name.slice(0, 1) || "م" : "ز"}
              </span>
              <span>
                <strong>
                  {auth.status === "ready"
                    ? auth.name || "حساب المستخدم"
                    : "تسجيل الدخول"}
                </strong>
                <small>{role ? roleLabels[role] : "لم تبدأ الجلسة"}</small>
              </span>
              <ChevronDown size={14} />
            </button>
          </div>
        </header>
        <main id="main-content" className="workspace-main">
          <div className="workspace-toolbar">
            <span
              className={`connection-badge ${ready && online ? "connected" : ""}`}
            >
              {!online ? (
                <>
                  <WifiOff size={14} />
                  غير متصل بالإنترنت
                </>
              ) : ready ? (
                "متصل بمساحة العمل"
              ) : (
                "مساحة العمل غير متصلة"
              )}
            </span>
            <div className="toolbar-actions">
              {workspace && (
                <label className="warehouse-label">
                  المستودع
                  <select
                    aria-label="المستودع الحالي"
                    value={warehouse}
                    onChange={(e) => {
                      setWarehouseChoice(e.target.value);
                      setReceipt(null);
                    }}
                  >
                    {workspace.warehouses.map((w) => (
                      <option value={w.id} key={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button
                className="icon-button"
                title="تحديث البيانات"
                aria-label="تحديث البيانات"
                disabled={!ready || !online}
                onClick={dashboard.reload}
              >
                <RefreshCw size={16} />
              </button>
            </div>
          </div>
          {!online && (
            <ErrorBox message="لا يوجد اتصال. لا يمكن تسجيل عمليات مالية الآن؛ تبقى السلة الحالية داخل الصفحة." />
          )}
          {auth.status === "unconfigured" && (
            <div className="setup-notice">
              <div>
                <strong>بانتظار ربط مساحة العمل</strong>
                <p>
                  الواجهة جاهزة للمراجعة. لا تُعرض أرقام تجريبية، ولن تُحفظ أي
                  عملية قبل إعداد الاتصال.
                </p>
              </div>
              <button
                className="secondary-button"
                onClick={() => setSettings(true)}
              >
                متطلبات الاتصال
                <ArrowLeft size={16} />
              </button>
            </div>
          )}
          {auth.status === "anonymous" && (
            <div className="setup-notice">
              <div>
                <strong>سجّل الدخول لعرض بيانات منشأتك</strong>
                <p>تظهر البيانات والأقسام حسب صلاحيات حسابك.</p>
              </div>
              <button className="primary-button" onClick={() => setLogin(true)}>
                تسجيل الدخول
              </button>
            </div>
          )}
          {auth.status === "error" && (
            <ErrorBox
              message={auth.message ?? "تعذّر تحميل الحساب."}
              retry={session.refresh}
            />
          )}
          {auth.status === "ready" && !ready && (
            <ErrorBox message="لا توجد منشأة أو مستودعات فعّالة لهذا الحساب. راجع مسؤول النظام." />
          )}
          {ready && !!dashboard.error && (
            <ErrorBox
              message={friendlyError(dashboard.error)}
              retry={dashboard.reload}
            />
          )}
          <div key={identity} className="view-content">
            {page === "dashboard" && (
              <AnimatedDashboard
                data={data}
                currency={workspace?.currency}
                name={auth.status === "ready" ? auth.name : undefined}
                loading={
                  auth.status === "loading" || (ready && dashboard.loading)
                }
                connected={ready}
                canSell={access.sell}
                navigate={navigate}
                openReceipt={(id) => void openReceipt(id)}
              />
            )}
            {page === "pos" && (
              <POS
                api={effectiveApi}
                workspace={workspace}
                warehouse={warehouse}
                userId={userId}
                onReceipt={received}
                notify={setToast}
              />
            )}
            {page === "purchases" && (
              <PurchaseReceipt
                api={effectiveApi}
                workspace={workspace}
                warehouse={warehouse}
                userId={userId}
                onReceipt={received}
                notify={setToast}
              />
            )}
            {page === "inventory" && (
              <Inventory
                key={stockSearch}
                api={effectiveApi}
                workspace={workspace}
                warehouse={warehouse}
                initialSearch={stockSearch}
              />
            )}
            {page === "reports" && (
              <Reports
                api={effectiveApi}
                workspace={workspace}
                businessDate={
                  data?.business_date ??
                  businessDateInZone(workspace?.timezone ?? "UTC")
                }
              />
            )}
          </div>
          <footer className="page-footer">
            <span>YmPharma · مساحة عمل الصيدلية</span>
            <span>الربط الخارجي بـModern Soft غير مفعّل</span>
          </footer>
        </main>
      </div>
      {login && <LoginDialog onClose={() => setLogin(false)} />}
      {settings && (
        <Dialog title="حالة مساحة العمل" onClose={() => setSettings(false)}>
          <div className="stack">
            <p>
              {ready
                ? "أنت متصل بمساحة العمل المحددة، وتُنفذ العمليات وفق صلاحيات حسابك."
                : "هذه نسخة Sprint 2 للمراجعة. تحتاج بيئة Supabase اختبار مهيأة بهجرات قاعدة البيانات وحساب مستخدم مسجل."}
            </p>
            <p className="muted">
              المطلوب من مسؤول الإعداد: عنوان المشروع ومفتاحه العام في متغيرات
              الاستضافة، وإتاحة واجهات ym_api. تُحفظ بيانات الدخول في نموذج
              تسجيل الدخول فقط.
            </p>
            <p className="muted">
              لم تُفعّل قراءة الوصفات الآلية أو الإشعارات الخارجية أو الترحيل
              إلى Modern Soft. ولا تُحفظ العمليات المالية دون اتصال.
            </p>
            {auth.status === "ready" && (
              <button
                className="secondary-button"
                onClick={() => {
                  void session
                    .signOut()
                    .then(() => {
                      setReceipt(null);
                      setSettings(false);
                      setPage("dashboard");
                    })
                    .catch((e) => setToast(friendlyError(e)));
                }}
              >
                <LogOut size={17} />
                تسجيل الخروج
              </button>
            )}
          </div>
        </Dialog>
      )}
      {alerts && (
        <Dialog title="تنبيهات المخزون" onClose={() => setAlerts(false)}>
          <div className="stack">
            {data ? (
              <>
                <div className="alert-summary">
                  <span>{data.expired_count} منتهية</span>
                  <span>{data.expiring_count} تقارب الانتهاء</span>
                  <span>{data.low_stock_count} نواقص</span>
                </div>
                {data.expiring.map((b) => (
                  <div className="alert-row" key={b.batch_id}>
                    <strong>{b.trade_name}</strong>
                    <span>
                      {b.batch_number} · {b.expiry_date}
                    </span>
                  </div>
                ))}
                {data.low_stock.map((b) => (
                  <div className="alert-row" key={b.product_id}>
                    <strong>{b.trade_name}</strong>
                    <span>
                      المتاح {b.available} · الحد الأدنى {b.minimum}
                    </span>
                  </div>
                ))}
                {!data.expiring.length && !data.low_stock.length && (
                  <p>لا توجد تنبيهات حالية في المستودع.</p>
                )}
                <button
                  className="primary-button"
                  onClick={() => {
                    setAlerts(false);
                    navigate("inventory");
                  }}
                >
                  فتح المخزون
                </button>
              </>
            ) : (
              <p>ستظهر التنبيهات من بيانات المستودع بعد الاتصال.</p>
            )}
          </div>
        </Dialog>
      )}
      {currentReceipt && (
        <ReceiptDialog
          receipt={currentReceipt}
          onClose={() => setReceipt(null)}
        />
      )}
      {toast && (
        <div className="toast" role="status" aria-live="polite">
          {toast}
          <button className="text-button" onClick={() => setToast("")}>
            إغلاق
          </button>
        </div>
      )}
    </div>
  );
}
function LoginDialog({ onClose }: { onClose: () => void }) {
  const { signIn, auth } = usePharmacySession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await signIn(email.trim(), password);
      setPassword("");
      onClose();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="تسجيل الدخول" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {error && <ErrorBox message={error} />}
        <p className="muted">استخدم البريد المسجل لحسابك في مساحة العمل.</p>
        <label className="field">
          البريد الإلكتروني
          <input
            type="email"
            autoComplete="username"
            required
            dir="ltr"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
          />
        </label>
        <label className="field">
          كلمة المرور
          <input
            type="password"
            autoComplete="current-password"
            required
            dir="ltr"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
        </label>
        <button
          className="primary-button"
          disabled={busy || auth.status === "unconfigured"}
        >
          {busy ? "جار تسجيل الدخول…" : "تسجيل الدخول"}
        </button>
        {auth.status === "unconfigured" && (
          <p className="field-note">
            يلزم إعداد الاتصال أولًا. لم يُنشأ حساب أو كلمة مرور افتراضية.
          </p>
        )}
      </form>
    </Dialog>
  );
}
