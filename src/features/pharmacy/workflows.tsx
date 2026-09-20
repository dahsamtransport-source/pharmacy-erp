"use client";
import { useCallback, useMemo, useState, type FormEvent } from "react";
import {
  Search,
  Plus,
  Trash2,
  ShoppingBag,
  Package,
  Printer,
  RefreshCw,
} from "lucide-react";
import type {
  PharmacyApi,
  Workspace,
  Unit,
  Receipt,
  PurchaseInput,
} from "@/lib/pharmacy/contracts";
import { permissions } from "@/lib/pharmacy/contracts";
import { ApiFailure, friendlyError } from "@/lib/pharmacy/api";
import { createTransactions } from "@/lib/pharmacy/transactions";
import {
  decimalUnits,
  formatAmount,
  minorUnits,
  purchaseLineTotal,
} from "@/lib/pharmacy/money";
import { useRemote, useOnline } from "@/hooks/use-remote";
import { Dialog, Empty, ErrorBox, Skeleton } from "./ui";
export interface WorkflowProps {
  api: PharmacyApi | null;
  workspace?: Workspace;
  warehouse: string;
  userId: string;
  onReceipt: (receipt: Receipt) => void;
  notify: (message: string) => void;
}
type Line = { unit: Unit; quantity: number };
function Catalog({
  api,
  workspace,
  warehouse,
  onSelect,
  purchase = false,
}: {
  api: PharmacyApi | null;
  workspace?: Workspace;
  warehouse: string;
  onSelect: (unit: Unit) => void;
  purchase?: boolean;
}) {
  const [term, setTerm] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const load = useCallback(
    () =>
      api && workspace && warehouse
        ? api.units(workspace.id, warehouse, search, offset)
        : null,
    [api, workspace, warehouse, search, offset],
  );
  const query = useRemote(
    load,
    `${workspace?.id}:${warehouse}:${search}:${offset}`,
  );
  const enabled = !!workspace && !!warehouse;
  return (
    <section className="panel catalog">
      <div className="section-heading">
        <h2>دليل الأصناف</h2>
        <span className="subtle-pill">الاسم أو الباركود</span>
      </div>
      <form
        className="search-field"
        onSubmit={(e) => {
          e.preventDefault();
          setOffset(0);
          setSearch(term.trim());
        }}
      >
        <Search size={18} aria-hidden />
        <input
          aria-label="بحث الأصناف بالاسم أو الباركود"
          placeholder="مرّر الباركود أو اكتب اسم الصنف"
          value={term}
          maxLength={120}
          onChange={(e) => setTerm(e.target.value)}
          disabled={!enabled}
        />
        <button type="submit" className="text-button" disabled={!enabled}>
          بحث
        </button>
      </form>
      {query.error ? (
        <ErrorBox message={friendlyError(query.error)} retry={query.reload} />
      ) : enabled && query.loading ? (
        <Skeleton />
      ) : query.data?.length ? (
        <>
          <div className="product-list">
            {query.data.map((unit) => {
              const blocked =
                !purchase &&
                (unit.controlled ||
                  unit.requires_prescription ||
                  unit.available_base < unit.factor);
              return (
                <button
                  className="product-row"
                  key={unit.unit_id}
                  onClick={() => onSelect(unit)}
                  disabled={blocked}
                >
                  <span className="product-icon">
                    <Package size={21} />
                  </span>
                  <span className="product-info">
                    <strong>{unit.trade_name}</strong>
                    <small>
                      {unit.unit_name} ·{" "}
                      {purchase
                        ? "عبوة استلام"
                        : `${Math.floor(unit.available_base / unit.factor)} عبوة متاحة`}
                    </small>
                    {!purchase &&
                      (unit.requires_prescription || unit.controlled) && (
                        <span className="badge amber">
                          {unit.controlled ? "صرف مقيّد" : "تحتاج مراجعة وصفة"}
                        </span>
                      )}
                  </span>
                  <span className="product-price">
                    {formatAmount(unit.selling_price)}
                    <small>{workspace?.currency}</small>
                  </span>
                  <Plus size={18} />
                </button>
              );
            })}
          </div>
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
          title={enabled ? "لا توجد أصناف مطابقة" : "دليل الأصناف غير متصل"}
          description={
            enabled
              ? "جرّب اسمًا آخر أو راجع تهيئة الأصناف."
              : "تظهر الأصناف الفعلية بعد تسجيل الدخول."
          }
        />
      )}
    </section>
  );
}
export function POS(props: WorkflowProps) {
  const { api, workspace, warehouse, userId, onReceipt, notify } = props;
  const online = useOnline();
  const [cart, setCart] = useState<Line[]>([]);
  const [payment, setPayment] = useState<"cash" | "bank">("cash");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const allowed = permissions(workspace?.role).sell;
  const transactions = useMemo(
    () =>
      api && workspace
        ? createTransactions(
            api,
            {
              getItem: (k) => sessionStorage.getItem(k),
              setItem: (k, v) => sessionStorage.setItem(k, v),
              removeItem: (k) => sessionStorage.removeItem(k),
            },
            workspace.id,
            userId,
            "sale",
          )
        : null,
    [api, workspace, userId],
  );
  const total = cart.reduce(
    (sum, l) => sum + minorUnits(l.unit.selling_price) * BigInt(l.quantity),
    0n,
  );
  const add = (unit: Unit) => {
    setError("");
    setCart((lines) => {
      const found = lines.find((x) => x.unit.unit_id === unit.unit_id);
      return found
        ? lines.map((x) =>
            x === found
              ? { ...x, quantity: Math.min(999999, x.quantity + 1) }
              : x,
          )
        : [...lines, { unit, quantity: 1 }];
    });
  };
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!transactions || !allowed || !cart.length || busy) return;
    setBusy(true);
    setError("");
    try {
      const receipt = await transactions.submit({
        warehouse,
        payment,
        items: cart
          .map((l) => ({ unit_id: l.unit.unit_id, quantity: l.quantity }))
          .sort((a, b) => a.unit_id.localeCompare(b.unit_id)),
      });
      setCart([]);
      setPending(false);
      onReceipt(receipt);
      notify("تم تسجيل البيع. الإجمالي في المستند هو الإجمالي المعتمد.");
    } catch (e) {
      setError(friendlyError(e));
      setPending(true);
    } finally {
      setBusy(false);
    }
  }
  async function reconcile() {
    if (!transactions || busy) return;
    setBusy(true);
    setError("");
    try {
      const receipt = await transactions.check();
      if (receipt) {
        setCart([]);
        setPending(false);
        onReceipt(receipt);
      } else {
        setError(
          "لم تظهر نتيجة مسجلة بعد. أعد نفس السلة للتحقق أو المحاولة بالمرجع نفسه.",
        );
      }
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">المبيعات</span>
          <h1>نقطة البيع</h1>
          <p>اختر العبوة والكمية؛ يتحقق الخادم من الرصيد والسعر عند التسجيل.</p>
        </div>
      </div>
      {!allowed && (
        <ErrorBox message="يلزم حساب كاشير أو صيدلي أو مدير لتسجيل البيع." />
      )}
      <div className="workflow-grid">
        <Catalog
          {...{ api, workspace, warehouse }}
          onSelect={(unit) => {
            if (!busy) add(unit);
          }}
        />
        <form className="panel basket" onSubmit={submit}>
          <div className="section-heading">
            <h2>
              <ShoppingBag size={20} />
              السلة الحالية
            </h2>
            <span className="subtle-pill">{cart.length} بند</span>
          </div>
          {error && <ErrorBox message={error} />}
          {cart.length ? (
            <div className="basket-lines">
              {cart.map((l) => (
                <div className="basket-line" key={l.unit.unit_id}>
                  <div>
                    <strong>{l.unit.trade_name}</strong>
                    <small>
                      {l.unit.unit_name} · {formatAmount(l.unit.selling_price)}{" "}
                      {workspace?.currency}
                    </small>
                  </div>
                  <label className="sr-only" htmlFor={`qty-${l.unit.unit_id}`}>
                    كمية {l.unit.trade_name} {l.unit.unit_name}
                  </label>
                  <input
                    id={`qty-${l.unit.unit_id}`}
                    type="number"
                    min={1}
                    max={999999}
                    step={1}
                    value={l.quantity}
                    disabled={busy}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (Number.isSafeInteger(n) && n >= 0 && n <= 999999)
                        setCart((rows) =>
                          rows.map((x) =>
                            x === l ? { ...x, quantity: n } : x,
                          ),
                        );
                    }}
                  />
                  <button
                    className="icon-button danger"
                    type="button"
                    aria-label={`حذف ${l.unit.trade_name} ${l.unit.unit_name}`}
                    disabled={busy}
                    onClick={() =>
                      setCart((rows) => rows.filter((x) => x !== l))
                    }
                  >
                    <Trash2 size={18} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <Empty
              title="السلة فارغة"
              description="اختر صنفًا من الدليل لإضافته."
            />
          )}
          <div className="basket-footer">
            <label className="field">
              طريقة الدفع
              <select
                value={payment}
                disabled={busy}
                onChange={(e) => setPayment(e.target.value as "cash" | "bank")}
              >
                <option value="cash">نقدي</option>
                <option value="bank">بنك / شبكة</option>
              </select>
            </label>
            <div className="total-line">
              <span>الإجمالي التقديري</span>
              <strong dir="ltr">
                {formatAmount(decimalUnits(total))} {workspace?.currency}
              </strong>
            </div>
            <p className="field-note">
              يتحدد الإجمالي النهائي من الأسعار المسجلة في الخادم.
            </p>
            <button
              type="submit"
              className="primary-button full"
              disabled={
                !cart.length || busy || !allowed || !online || !warehouse
              }
            >
              {busy ? "جار التحقق والتسجيل…" : "تسجيل البيع"}
            </button>
            <button
              type="button"
              className="text-button full"
              disabled={!transactions || busy || !online}
              onClick={reconcile}
            >
              <RefreshCw size={15} />
              {pending
                ? "التحقق من نتيجة العملية السابقة"
                : "التحقق من عملية سابقة"}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
type PurchaseLine = {
  key: string;
  unit: Unit;
  quantity: number;
  cost: string;
  batch: string;
  expiry: string;
};
export function PurchaseReceipt(props: WorkflowProps) {
  const { api, workspace, warehouse, userId, onReceipt, notify } = props;
  const online = useOnline();
  const allowed = permissions(workspace?.role).purchase;
  const [supplier, setSupplier] = useState("");
  const [reference, setReference] = useState("");
  const [lines, setLines] = useState<PurchaseLine[]>([]);
  const [selected, setSelected] = useState<Unit | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    () => (api && workspace && allowed ? api.suppliers(workspace.id) : null),
    [api, workspace, allowed],
  );
  const suppliers = useRemote(load, `${workspace?.id}:suppliers`);
  const transactions = useMemo(
    () =>
      api && workspace
        ? createTransactions(
            api,
            {
              getItem: (k) => sessionStorage.getItem(k),
              setItem: (k, v) => sessionStorage.setItem(k, v),
              removeItem: (k) => sessionStorage.removeItem(k),
            },
            workspace.id,
            userId,
            "purchase",
          )
        : null,
    [api, workspace, userId],
  );
  const total = lines.reduce(
    (sum, l) => sum + purchaseLineTotal(l.cost, l.quantity),
    0n,
  );
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!allowed || !transactions || !lines.length || busy) return;
    setBusy(true);
    setError("");
    try {
      const input: PurchaseInput = {
        warehouse,
        supplier,
        reference: reference.trim(),
        items: lines.map((l) => ({
          unit_id: l.unit.unit_id,
          quantity: l.quantity,
          unit_cost: l.cost,
          batch_number: l.batch.trim(),
          expiry_date: l.expiry,
        })),
      };
      const receipt = await transactions.submit(input);
      setLines([]);
      setReference("");
      onReceipt(receipt);
      notify("تم تسجيل الاستلام والمخزون والقيد المحاسبي.");
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  async function reconcile() {
    if (!transactions || busy) return;
    setBusy(true);
    try {
      const receipt = await transactions.check();
      if (receipt) {
        setLines([]);
        setReference("");
        onReceipt(receipt);
      } else
        setError(
          "لم تتأكد النتيجة بعد. احتفظ بمرجع الفاتورة وأعد البيانات نفسها.",
        );
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">المشتريات</span>
          <h1>استلام فاتورة مورد</h1>
          <p>سجّل كل تشغيلة بصلاحيتها وتكلفة العبوة المختارة.</p>
        </div>
      </div>
      {!allowed ? (
        <ErrorBox message="يلزم حساب أمين مخزن أو مدير لاستلام المشتريات." />
      ) : (
        <></>
      )}
      <div className="workflow-grid purchase-grid">
        <Catalog
          {...{ api, workspace, warehouse }}
          purchase
          onSelect={(u) => {
            if (allowed && !busy) setSelected(u);
          }}
        />
        <form className="panel" onSubmit={submit}>
          <div className="section-heading">
            <h2>بيانات الاستلام</h2>
            <Package size={21} />
          </div>
          {error && <ErrorBox message={error} />}
          <div className="form-grid">
            <label className="field">
              المورد
              <select
                value={supplier}
                onChange={(e) => setSupplier(e.target.value)}
                required
                disabled={!allowed || busy}
              >
                <option value="">اختر المورد</option>
                {suppliers.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              رقم فاتورة المورد
              <input
                required
                maxLength={100}
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                disabled={!allowed || busy}
                placeholder="كما يظهر في فاتورة المورد"
              />
            </label>
          </div>
          {!!suppliers.error && (
            <ErrorBox
              message={friendlyError(suppliers.error)}
              retry={suppliers.reload}
            />
          )}
          {lines.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>الصنف / العبوة</th>
                    <th>التشغيلة والصلاحية</th>
                    <th>الكمية</th>
                    <th>تكلفة العبوة</th>
                    <th>الإجمالي</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.key}>
                      <td>
                        {l.unit.trade_name}
                        <small>{l.unit.unit_name}</small>
                      </td>
                      <td>
                        <bdi>{l.batch}</bdi>
                        <small>{l.expiry}</small>
                      </td>
                      <td>{l.quantity}</td>
                      <td>{l.cost}</td>
                      <td>
                        {formatAmount(
                          decimalUnits(purchaseLineTotal(l.cost, l.quantity)),
                        )}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="icon-button danger"
                          aria-label={`حذف تشغيلة ${l.batch}`}
                          disabled={busy}
                          onClick={() =>
                            setLines((rows) =>
                              rows.filter((x) => x.key !== l.key),
                            )
                          }
                        >
                          <Trash2 size={17} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title="أضف بنود الاستلام"
              description="اختر صنفًا من الدليل لإدخال التشغيلة."
            />
          )}
          <div className="total-line">
            <span>إجمالي الاستلام</span>
            <strong>
              {formatAmount(decimalUnits(total))} {workspace?.currency}
            </strong>
          </div>
          <button
            className="primary-button full"
            disabled={
              !allowed || !lines.length || busy || !online || !warehouse
            }
          >
            {busy ? "جار تسجيل الاستلام…" : "اعتماد الاستلام وتسجيل القيد"}
          </button>
          <button
            className="text-button full"
            type="button"
            onClick={reconcile}
            disabled={!transactions || busy || !online}
          >
            التحقق من عملية سابقة
          </button>
        </form>
      </div>
      {selected && (
        <BatchEditor
          unit={selected}
          onClose={() => setSelected(null)}
          onAdd={(line) => {
            setLines((rows) => [
              ...rows,
              { ...line, key: crypto.randomUUID(), unit: selected },
            ]);
            setSelected(null);
          }}
        />
      )}
    </>
  );
}
function BatchEditor({
  unit,
  onClose,
  onAdd,
}: {
  unit: Unit;
  onClose: () => void;
  onAdd: (line: Omit<PurchaseLine, "key" | "unit">) => void;
}) {
  const [batch, setBatch] = useState("");
  const [expiry, setExpiry] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [cost, setCost] = useState("");
  const [error, setError] = useState("");
  function add(e: FormEvent) {
    e.preventDefault();
    try {
      const n = Number(quantity);
      if (
        !batch.trim() ||
        !expiry ||
        !Number.isSafeInteger(n) ||
        n < 1 ||
        n > 999999
      )
        throw new ApiFailure("راجع التشغيلة والصلاحية والكمية.");
      purchaseLineTotal(cost, n);
      onAdd({ batch: batch.trim(), expiry, quantity: n, cost });
    } catch {
      setError("أدخل كمية صحيحة وتكلفة موجبة أو صفرًا، حتى أربع منازل عشرية.");
    }
  }
  return (
    <Dialog title={`تشغيلة ${unit.trade_name}`} onClose={onClose}>
      <form onSubmit={add} className="stack">
        {error && <ErrorBox message={error} />}
        <p className="muted">
          العبوة: {unit.unit_name} · {unit.factor} وحدة أساسية
        </p>
        <label className="field">
          رقم التشغيلة
          <input
            required
            maxLength={100}
            autoFocus
            value={batch}
            onChange={(e) => setBatch(e.target.value)}
          />
        </label>
        <label className="field">
          تاريخ الصلاحية
          <input
            type="date"
            required
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
          />
        </label>
        <div className="form-grid">
          <label className="field">
            عدد العبوات
            <input
              type="number"
              min={1}
              max={999999}
              step={1}
              required
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </label>
          <label className="field">
            تكلفة العبوة
            <input
              inputMode="decimal"
              required
              value={cost}
              onChange={(e) => setCost(e.target.value)}
              placeholder="0.0000"
            />
          </label>
        </div>
        <button className="primary-button">إضافة التشغيلة</button>
      </form>
    </Dialog>
  );
}
export function ReceiptDialog({
  receipt,
  onClose,
}: {
  receipt: Receipt;
  onClose: () => void;
}) {
  return (
    <Dialog title="المستند المسجل" onClose={onClose}>
      <article className="receipt">
        <header>
          <h2>{receipt.organization}</h2>
          <p>
            {receipt.kind === "sale"
              ? "فاتورة مبيعات"
              : "فاتورة استلام مشتريات"}
          </p>
          <bdi>{receipt.document_date}</bdi>
        </header>
        <dl>
          <div>
            <dt>المرجع</dt>
            <dd className="mono">
              <bdi>{receipt.document_uuid}</bdi>
            </dd>
          </div>
          <div>
            <dt>الحالة</dt>
            <dd>مسجل محليًا؛ لا يؤكد الترحيل إلى Modern Soft</dd>
          </div>
        </dl>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>الصنف</th>
                <th>العبوة</th>
                <th>الكمية</th>
                <th>الإجمالي</th>
              </tr>
            </thead>
            <tbody>
              {receipt.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.trade_name}</td>
                  <td>{l.unit_name}</td>
                  <td>{l.quantity}</td>
                  <td>{formatAmount(l.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="total-line">
          <span>الإجمالي المعتمد</span>
          <strong dir="ltr">
            {formatAmount(receipt.total)} {receipt.currency}
          </strong>
        </div>
      </article>
      <button
        className="primary-button full no-print"
        onClick={() => window.print()}
      >
        <Printer size={18} />
        طباعة المستند
      </button>
    </Dialog>
  );
}
