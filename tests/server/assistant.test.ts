import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createAssistantHandler,
  createAssistantLimiter,
  AssistantFailure,
} from "@/lib/ai/request-handler";
import { apiFixture, ids, workspace, unit } from "../frontend/fixtures";
import type { AssistantPlan } from "@/lib/ai/contracts";
const plan: AssistantPlan = {
  action: "sale",
  search: "",
  explanation: "مسودة",
  payment: "cash",
  items: [{ search: "صنف", quantity: 2 }],
};
function setup() {
  const api = apiFixture();
  const deps = {
    enabled: () => true,
    authorize: vi
      .fn()
      .mockResolvedValue({ actor: ids.product, workspace, api }),
    plan: vi.fn().mockResolvedValue(plan),
    acquire: createAssistantLimiter(),
    claimBudget: vi.fn().mockResolvedValue(true),
  };
  return { api, deps, handler: createAssistantHandler(deps) };
}
function request(
  body: unknown = {
    org: ids.org,
    warehouse: ids.warehouse,
    input: "بيع علبتين",
  },
  authorization = "Bearer test-session",
) {
  return new Request("https://app.test/api/ai/orchestrate", {
    method: "POST",
    headers: { authorization, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
afterEach(() => vi.useRealTimers());
describe("assistant HTTP boundary", () => {
  it("does not spend model tokens when the shared budget denies admission", async () => {
    const { deps, handler } = setup();
    deps.claimBudget.mockResolvedValue(false);
    expect((await handler(request())).status).toBe(429);
    expect(deps.plan).not.toHaveBeenCalled();
  });
  it("authenticates before model spending and rejects a foreign warehouse", async () => {
    const { deps, handler } = setup();
    expect((await handler(request(undefined, ""))).status).toBe(401);
    deps.authorize.mockRejectedValue(new AssistantFailure("FORBIDDEN", 403));
    expect((await handler(request())).status).toBe(403);
    expect(deps.plan).not.toHaveBeenCalled();
  });
  it("fails closed while disabled", async () => {
    const { deps } = setup();
    deps.enabled = () => false;
    expect((await createAssistantHandler(deps)(request())).status).toBe(503);
    expect(deps.authorize).not.toHaveBeenCalled();
  });
  it("resolves catalog with verified tenant and never performs mutations", async () => {
    const { deps, api, handler } = setup();
    const response = await handler(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      actor: ids.product,
      org: ids.org,
      warehouse: ids.warehouse,
      execution: "not_executed",
      requiresApproval: true,
      matches: [[unit]],
    });
    expect(api.units).toHaveBeenCalledWith(ids.org, ids.warehouse, "صنف");
    expect(deps.authorize).toHaveBeenCalledTimes(2);
    expect(api.sell).not.toHaveBeenCalled();
    expect(api.purchase).not.toHaveBeenCalled();
  });
  it("rejects revoked permissions after the model wait", async () => {
    const { deps, api, handler } = setup();
    deps.authorize
      .mockResolvedValueOnce({ actor: ids.product, workspace, api })
      .mockResolvedValueOnce({
        actor: ids.product,
        workspace: { ...workspace, role: "inventory" },
        api,
      });
    expect((await handler(request())).status).toBe(403);
    expect(api.units).not.toHaveBeenCalled();
  });
  it("denies reports for cashier", async () => {
    const { deps, handler } = setup();
    deps.plan.mockResolvedValue({ ...plan, action: "reports", items: [] });
    expect((await handler(request())).status).toBe(403);
  });
  it("does not trust extra model execution fields or expose SDK errors", async () => {
    const { deps, handler } = setup();
    deps.plan.mockResolvedValue({ ...plan, sql: "delete", execution: "done" });
    expect((await handler(request())).status).toBe(502);
    deps.plan.mockRejectedValue(new Error("secret prompt and JWT"));
    expect(await (await handler(request())).json()).toEqual({
      error: "ASSISTANT_FAILED",
    });
  });
  it("rejects malformed, oversized and extra request fields before authorization", async () => {
    const { deps, handler } = setup();
    for (const body of [
      { org: ids.org, warehouse: ids.warehouse, input: "x", role: "owner" },
      { org: ids.org, warehouse: ids.warehouse, input: "x".repeat(2001) },
      null,
    ])
      expect((await handler(request(body))).status).toBe(400);
    expect((await handler(request("x".repeat(17000)))).status).toBe(413);
    const invalid = request();
    invalid.headers.set("content-type", "text/plain");
    expect((await handler(invalid)).status).toBe(415);
    expect(deps.plan).not.toHaveBeenCalled();
    expect(deps.authorize).not.toHaveBeenCalled();
  });
  it("bounds slow streaming bodies and cancels reading", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const { handler, deps } = setup();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("{"));
      },
      cancel,
    });
    const req = new Request("https://app.test/api", {
      method: "POST",
      headers: {
        authorization: "Bearer t",
        "content-type": "application/json",
      },
      body: stream,
      duplex: "half",
    } as RequestInit);
    const pending = handler(req);
    await vi.advanceTimersByTimeAsync(5001);
    expect((await pending).status).toBe(408);
    expect(cancel).toHaveBeenCalled();
    expect(deps.plan).not.toHaveBeenCalled();
  });
  it("enforces concurrency, per-user and global limits and recovers after a minute", () => {
    let time = 100000;
    const acquire = createAssistantLimiter(() => time);
    const a = acquire("a")!,
      b = acquire("b")!;
    expect(acquire("c")).toBeNull();
    a();
    a();
    b();
    for (let i = 0; i < 5; i++) acquire("a")!();
    expect(acquire("a")).toBeNull();
    for (let i = 0; i < 13; i++) acquire(`other-${i}`)!();
    expect(acquire("last")).toBeNull();
    time += 60000;
    expect(acquire("a")).toBeTypeOf("function");
  });
});
