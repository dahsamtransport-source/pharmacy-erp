import { afterEach, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  isLoopbackDataApi,
  canAttemptDataRequest,
} from "@/lib/pharmacy/connectivity";
import { useOnline } from "@/hooks/use-remote";
import { createTransactions } from "@/lib/pharmacy/transactions";
import { apiFixture, ids } from "./fixtures";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
const input = {
  warehouse: ids.warehouse,
  payment: "cash" as const,
  items: [{ unit_id: ids.unit, quantity: 1 }],
};
const store = () => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
};

it("only recognizes exact loopback HTTP endpoints as local", () => {
  for (const url of [
    "http://localhost:54321",
    "http://127.0.0.1:54321",
    "http://[::1]:54321",
  ])
    expect(isLoopbackDataApi(url)).toBe(true);
  for (const url of [
    "https://localhost.evil.test",
    "http://192.168.1.2:54321",
    "ftp://localhost",
    "http://user:secret@localhost",
    "garbage",
  ])
    expect(isLoopbackDataApi(url)).toBe(false);
});
it("keeps hosted API submissions disabled when the OS reports offline", () => {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  expect(canAttemptDataRequest()).toBe(false);
  expect(renderHook(useOnline).result.current).toBe(false);
});
it("allows an actual local transaction attempt without a WAN connection", async () => {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  expect(renderHook(useOnline).result.current).toBe(true);
  const api = apiFixture();
  await createTransactions(api, store(), ids.org, "local-user", "sale").submit(
    input,
  );
  expect(api.sell).toHaveBeenCalledTimes(1);
});
it("local API failure is propagated and retains its idempotency reference", async () => {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  const api = apiFixture();
  vi.mocked(api.sell).mockRejectedValue(
    new TypeError("local database stopped"),
  );
  const tx = createTransactions(api, store(), ids.org, "local-user", "sale");
  await expect(tx.submit(input)).rejects.toThrow("local database stopped");
  expect(tx.pending()?.id).toBeTruthy();
  expect(api.receipt).not.toHaveBeenCalled();
});
