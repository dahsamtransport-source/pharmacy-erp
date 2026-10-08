import { it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { pharmacyApi } from "@/lib/pharmacy/api";
import type { Database } from "@/lib/pharmacy/contracts";
import { ids } from "./fixtures";
function fixture(actor: string) {
  const session = { user: { id: actor }, access_token: "fresh-A" };
  const setHeader = vi
    .fn()
    .mockResolvedValue({ data: ids.invoice, error: null });
  const rpc = vi.fn().mockReturnValue({ setHeader });
  const client = {
    schema: () => ({ rpc }),
    auth: {
      getSession: vi.fn(async () => ({ data: { session }, error: null })),
    },
  };
  return {
    session,
    setHeader,
    rpc,
    client: client as unknown as SupabaseClient<Database>,
  };
}
const input = {
  warehouse: ids.warehouse,
  payment: "cash" as const,
  items: [{ unit_id: ids.unit, quantity: 1 }],
};
it("blocks a sale and purchase from an old actor after the user switches", async () => {
  const f = fixture(ids.request);
  const api = pharmacyApi(f.client, ids.product);
  await expect(api.sell(ids.org, ids.request, input)).rejects.toThrow(/تغيّر/);
  await expect(
    api.purchase(ids.org, ids.request, {
      warehouse: ids.warehouse,
      supplier: ids.unit,
      reference: "x",
      items: [],
    }),
  ).rejects.toThrow(/تغيّر/);
  expect(f.rpc).not.toHaveBeenCalled();
});
it("pins refreshed same-actor authorization on the mutation request", async () => {
  const f = fixture(ids.product);
  const api = pharmacyApi(f.client, ids.product);
  await expect(api.sell(ids.org, ids.request, input)).resolves.toBe(
    ids.invoice,
  );
  expect(f.setHeader).toHaveBeenCalledWith("Authorization", "Bearer fresh-A");
});
it("an unbound read client cannot submit mutations", async () => {
  const f = fixture(ids.product);
  await expect(
    pharmacyApi(f.client).sell(ids.org, ids.request, input),
  ).rejects.toThrow();
  expect(f.rpc).not.toHaveBeenCalled();
});
