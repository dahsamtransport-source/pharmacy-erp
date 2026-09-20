import { describe, it, expect, vi } from "vitest";
import { createTransactions } from "@/lib/pharmacy/transactions";
import { ApiFailure } from "@/lib/pharmacy/api";
import {
  decimalUnits,
  minorUnits,
  purchaseLineTotal,
  percentChange,
  formatAmount,
} from "@/lib/pharmacy/money";
import { apiFixture, ids, receipt } from "./fixtures";
const input = {
  warehouse: ids.warehouse,
  payment: "cash" as const,
  items: [{ unit_id: ids.unit, quantity: 1 }],
};
const memory = () => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    map,
  };
};
describe("financial arithmetic and durable operation references", () => {
  it("uses integer minor units, including negative fractional reports", () => {
    expect(decimalUnits(minorUnits("0.10") + minorUnits("0.20"))).toBe("0.30");
    expect(formatAmount("-0.01")).toContain("-0.01");
    expect(purchaseLineTotal("1.2345", 3)).toBe(370n);
  });
  it("does not invent a growth percentage when yesterday is zero", () => {
    expect(percentChange("12500", "0")).toBeNull();
    expect(percentChange("114", "100")).toBe("+14%");
  });
  it("retries an ambiguous request with the same ID even after re-creating the service", async () => {
    const api = apiFixture(),
      store = memory();
    vi.mocked(api.sell).mockRejectedValueOnce(
      new TypeError("network disconnected"),
    );
    await expect(
      createTransactions(api, store, ids.org, "user", "sale").submit(input),
    ).rejects.toThrow();
    const first = vi.mocked(api.sell).mock.calls[0][1];
    const saved = [...store.map.values()].join();
    expect(saved).not.toContain("unit_id");
    expect(saved).not.toContain("12.25");
    await createTransactions(api, store, ids.org, "user", "sale").submit(input);
    expect(vi.mocked(api.sell).mock.calls[1][1]).toBe(first);
    expect(store.map.size).toBe(0);
  });
  it("blocks altered input while a previous result is unknown", async () => {
    const api = apiFixture(),
      store = memory();
    api.sell = vi.fn().mockRejectedValue(new TypeError());
    const tx = createTransactions(api, store, ids.org, "user", "sale");
    await expect(tx.submit(input)).rejects.toThrow();
    await expect(tx.submit({ ...input, payment: "bank" })).rejects.toThrow(
      /السابقة/,
    );
    expect(api.sell).toHaveBeenCalledTimes(1);
  });
  it("clears a reference only after a definite database rejection", async () => {
    const api = apiFixture(),
      store = memory();
    api.sell = vi.fn().mockRejectedValue(new ApiFailure("نفد المخزون", true));
    await expect(
      createTransactions(api, store, ids.org, "user", "sale").submit(input),
    ).rejects.toThrow();
    expect(store.map.size).toBe(0);
  });
  it("keeps reference if posting succeeded but receipt fetch failed", async () => {
    const api = apiFixture(),
      store = memory();
    api.receipt = vi
      .fn()
      .mockRejectedValue(new ApiFailure("receipt unavailable", true));
    await expect(
      createTransactions(api, store, ids.org, "user", "sale").submit(input),
    ).rejects.toThrow();
    expect(store.map.size).toBe(1);
  });
  it("reconciles by reference without creating another sale", async () => {
    const api = apiFixture(),
      store = memory();
    api.sell = vi.fn().mockRejectedValue(new TypeError());
    const tx = createTransactions(api, store, ids.org, "user", "sale");
    await expect(tx.submit(input)).rejects.toThrow();
    api.findReceipt = vi.fn().mockResolvedValue(receipt);
    expect(await tx.check()).toEqual(receipt);
    expect(api.sell).toHaveBeenCalledTimes(1);
    expect(store.map.size).toBe(0);
  });
  it("looks up a timed-out operation before retrying creation", async () => {
    const api = apiFixture(),
      store = memory();
    vi.mocked(api.sell).mockRejectedValueOnce(new TypeError());
    const tx = createTransactions(api, store, ids.org, "user", "sale");
    await expect(tx.submit(input)).rejects.toThrow();
    vi.mocked(api.findReceipt).mockResolvedValue(receipt);
    expect(await tx.submit(input)).toEqual(receipt);
    expect(api.sell).toHaveBeenCalledTimes(1);
    expect(store.map.size).toBe(0);
  });
  it("retains the original reference when a retry is rejected after a timeout", async () => {
    const api = apiFixture(),
      store = memory();
    vi.mocked(api.sell)
      .mockRejectedValueOnce(new TypeError())
      .mockRejectedValueOnce(new ApiFailure("session expired", true));
    const tx = createTransactions(api, store, ids.org, "user", "sale");
    await expect(tx.submit(input)).rejects.toThrow();
    const first = tx.pending()?.id;
    await expect(tx.submit(input)).rejects.toThrow();
    expect(tx.pending()?.id).toBe(first);
  });
  it("isolates pending references per user and organization", async () => {
    const api = apiFixture(),
      store = memory();
    api.sell = vi.fn().mockRejectedValue(new TypeError());
    const tx = createTransactions(api, store, ids.org, "one", "sale");
    await expect(tx.submit(input)).rejects.toThrow();
    expect(
      createTransactions(api, store, ids.org, "two", "sale").pending(),
    ).toBeNull();
  });
  it("blocks double click before the first async operation finishes", async () => {
    const api = apiFixture(),
      store = memory();
    const tx = createTransactions(api, store, ids.org, "user", "sale");
    const first = tx.submit(input);
    await expect(tx.submit(input)).rejects.toThrow(/قيد التنفيذ/);
    await first;
    expect(api.sell).toHaveBeenCalledTimes(1);
  });
  it("does not submit while offline", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const api = apiFixture();
    await expect(
      createTransactions(api, memory(), ids.org, "user", "sale").submit(input),
    ).rejects.toThrow(/غير متصل/);
    expect(api.sell).not.toHaveBeenCalled();
  });
});
