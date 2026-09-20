"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { AlertTriangle, Inbox, X } from "lucide-react";
export function Dialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = ref.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-label={title}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog-head">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="إغلاق" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Empty({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="empty">
      <Inbox size={30} aria-hidden />
      <strong>{title}</strong>
      {description && <p>{description}</p>}
    </div>
  );
}
export function ErrorBox({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return (
    <div role="alert" className="error-box">
      <AlertTriangle size={19} aria-hidden />
      <span>{message}</span>
      {retry && (
        <button className="text-button" onClick={retry}>
          إعادة المحاولة
        </button>
      )}
    </div>
  );
}
export function Skeleton() {
  return (
    <div
      className="skeleton-group"
      role="status"
      aria-label="جار تحميل البيانات"
    >
      <span className="sr-only">جار تحميل البيانات</span>
      {[1, 2, 3].map((n) => (
        <div key={n} className="skeleton" />
      ))}
    </div>
  );
}
