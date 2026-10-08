import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { ids, workspace, apiFixture } from "../frontend/fixtures";
const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  pharmacyApi: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/pharmacy/api", () => ({ pharmacyApi: mocks.pharmacyApi }));
import { authorizeAssistant } from "@/lib/ai/authorize";
let api: ReturnType<typeof apiFixture>;
let getUser: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  api = apiFixture();
  mocks.pharmacyApi.mockReturnValue(api);
  getUser = vi
    .fn()
    .mockResolvedValue({
      data: { user: { id: ids.product, is_anonymous: false } },
      error: null,
    });
  mocks.createClient.mockReturnValue({ auth: { getUser } });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it("verifies the token with Auth and scopes context to org AND warehouse", async () => {
  const result = await authorizeAssistant(
    "token-A",
    ids.org,
    ids.warehouse,
    new AbortController().signal,
  );
  expect(result.actor).toBe(ids.product);
  expect(getUser).toHaveBeenCalledWith("token-A");
  expect(mocks.createClient.mock.calls[0][2].global.headers.Authorization).toBe(
    "Bearer token-A",
  );
  await expect(
    authorizeAssistant(
      "token-A",
      ids.request,
      ids.warehouse,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    authorizeAssistant(
      "token-A",
      ids.org,
      ids.request,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ status: 403 });
});
it("rejects invalid and anonymous users before context reads", async () => {
  for (const user of [null, { id: ids.product, is_anonymous: true }]) {
    getUser.mockResolvedValue({ data: { user }, error: null });
    await expect(
      authorizeAssistant(
        "invalid",
        ids.org,
        ids.warehouse,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ status: 401 });
  }
  expect(api.context).not.toHaveBeenCalled();
});
it("uses live role from the context RPC and refuses secret keys", async () => {
  vi.mocked(api.context).mockResolvedValue([
    { ...workspace, role: "inventory" },
  ]);
  expect(
    (
      await authorizeAssistant(
        "token",
        ids.org,
        ids.warehouse,
        new AbortController().signal,
      )
    ).workspace.role,
  ).toBe("inventory");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_secret_test");
  await expect(
    authorizeAssistant(
      "token",
      ids.org,
      ids.warehouse,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ status: 503 });
});
