import { z } from "zod";
import { ApiFailure } from "./api";
import { canAttemptDataRequest } from "./connectivity";
import type {
  PharmacyApi,
  PurchaseInput,
  Receipt,
  SaleInput,
} from "./contracts";
export interface TicketStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
const ticketSchema = z.object({ id: z.uuid(), fingerprint: z.string() });
export type Ticket = z.infer<typeof ticketSchema>;
export function createTransactions(
  api: PharmacyApi,
  store: TicketStore,
  org: string,
  user: string,
  kind: "sale" | "purchase",
) {
  const key = `ympharma:pending:${org}:${user}:${kind}`;
  let busy = false;
  const pending = (): Ticket | null => {
    const text = store.getItem(key);
    if (!text) return null;
    try {
      return ticketSchema.parse(JSON.parse(text));
    } catch {
      throw new ApiFailure(
        "تعذّرت قراءة مرجع العملية السابقة. راجع المسؤول قبل إنشاء عملية جديدة.",
      );
    }
  };
  async function check(): Promise<Receipt | null> {
    const ticket = pending();
    if (!ticket) return null;
    const receipt = await api.findReceipt(org, ticket.id);
    if (receipt) store.removeItem(key);
    return receipt;
  }
  async function submit(input: SaleInput | PurchaseInput): Promise<Receipt> {
    if (busy) throw new ApiFailure("العملية قيد التنفيذ. انتظر النتيجة.");
    busy = true;
    try {
      if (!canAttemptDataRequest())
        throw new ApiFailure(
          "أنت غير متصل. الترحيل يحتاج اتصالًا؛ السلة باقية في الصفحة.",
        );
      const bytes = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(input)),
      );
      const fingerprint = Array.from(new Uint8Array(bytes), (x) =>
        x.toString(16).padStart(2, "0"),
      ).join("");
      let ticket = pending();
      const hadPending = ticket !== null;
      if (ticket && ticket.fingerprint !== fingerprint)
        throw new ApiFailure(
          "نتيجة العملية السابقة غير محسومة. تحقّق منها أو أعد نفس البيانات والمرجع.",
        );
      if (ticket) {
        const existing = await api.findReceipt(org, ticket.id);
        if (existing) {
          store.removeItem(key);
          return existing;
        }
      }
      ticket ??= { id: crypto.randomUUID(), fingerprint };
      store.setItem(key, JSON.stringify(ticket)); // Only opaque ID/hash; never store basket, prices, PHI, passwords or JWTs.
      let invoice: string;
      try {
        invoice =
          kind === "sale"
            ? await api.sell(org, ticket.id, input as SaleInput)
            : await api.purchase(org, ticket.id, input as PurchaseInput);
      } catch (error) {
        // A new rejection cannot prove that an earlier timed-out attempt rolled back.
        if (!hadPending && error instanceof ApiFailure && error.definitive)
          store.removeItem(key);
        throw error;
      }
      // A receipt read failure must NOT clear a possibly committed operation.
      const receipt = await api.receipt(org, invoice);
      store.removeItem(key);
      return receipt;
    } finally {
      busy = false;
    }
  }
  return { submit, check, pending };
}
