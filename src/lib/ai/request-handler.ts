import {
  assistantRequestSchema,
  assistantPlanSchema,
  permitsPlan,
  type AssistantPlan,
} from "./contracts";
import type { PharmacyApi, Workspace } from "@/lib/pharmacy/contracts";
export class AssistantFailure extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code);
  }
}
export interface AssistantContext {
  actor: string;
  workspace: Workspace;
  api: PharmacyApi;
}
export interface AssistantDependencies {
  enabled(): boolean;
  authorize(
    token: string,
    org: string,
    warehouse: string,
    signal: AbortSignal,
  ): Promise<AssistantContext>;
  plan(input: string, signal: AbortSignal): Promise<AssistantPlan>;
  acquire(actor: string): (() => void) | null;
  claimBudget(
    token: string,
    org: string,
    warehouse: string,
    signal: AbortSignal,
  ): Promise<boolean>;
}
const reply = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
async function bodyJSON(request: Request): Promise<unknown> {
  if (
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
    "application/json"
  )
    throw new AssistantFailure("JSON_REQUIRED", 415);
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > 16384))
    throw new AssistantFailure("INPUT_TOO_LARGE", 413);
  if (!request.body) throw new AssistantFailure("INVALID_INPUT", 400);
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new AssistantFailure("BODY_TIMEOUT", 408)),
      5000,
    );
  });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      size += value.byteLength;
      if (size > 16384) throw new AssistantFailure("INPUT_TOO_LARGE", 413);
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      throw new AssistantFailure("INVALID_INPUT", 400);
    }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}
export function createAssistantHandler(deps: AssistantDependencies) {
  return async (request: Request): Promise<Response> => {
    let release: (() => void) | undefined;
    try {
      if (!deps.enabled())
        return reply({ error: "ASSISTANT_UNAVAILABLE" }, 503);
      const token = /^Bearer ([^\s]{1,8192})$/i.exec(
        request.headers.get("authorization") ?? "",
      )?.[1];
      if (!token) return reply({ error: "UNAUTHORIZED" }, 401);
      const parsed = assistantRequestSchema.safeParse(await bodyJSON(request));
      if (!parsed.success) return reply({ error: "INVALID_INPUT" }, 400);
      const { org, warehouse, input } = parsed.data;
      const signal = AbortSignal.any([
        request.signal,
        AbortSignal.timeout(40000),
      ]);
      const context = await deps.authorize(token, org, warehouse, signal);
      release = deps.acquire(context.actor) ?? undefined;
      if (!release) return reply({ error: "RATE_LIMITED" }, 429);
      if (!(await deps.claimBudget(token, org, warehouse, signal)))
        return reply({ error: "RATE_LIMITED" }, 429);
      const plan = assistantPlanSchema.parse(await deps.plan(input, signal));
      // Recheck membership/role after the model wait, before resolving business data.
      const fresh = await deps.authorize(token, org, warehouse, signal);
      if (
        fresh.actor !== context.actor ||
        !permitsPlan(fresh.workspace.role, plan)
      )
        throw new AssistantFailure("FORBIDDEN", 403);
      const matches =
        plan.action === "sale"
          ? await Promise.all(
              plan.items.map((item) =>
                fresh.api.units(org, warehouse, item.search),
              ),
            )
          : [];
      signal.throwIfAborted();
      return reply({
        actor: fresh.actor,
        org,
        warehouse,
        plan,
        matches,
        execution: "not_executed",
        requiresApproval: true,
      });
    } catch (error) {
      // Never return/log SDK errors, prompts, JWTs or environment values.
      if (error instanceof AssistantFailure)
        return reply({ error: error.code }, error.status);
      return reply({ error: "ASSISTANT_FAILED" }, 502);
    } finally {
      release?.();
    }
  };
}
// Per-process protection. Multi-worker deployments also need a shared gateway limit.
export function createAssistantLimiter(now = Date.now) {
  const windows = new Map<string, { start: number; count: number }>();
  let active = 0,
    globalStart = 0,
    globalCount = 0;
  return (actor: string): (() => void) | null => {
    const time = now();
    for (const [key, value] of windows)
      if (time - value.start >= 60000) windows.delete(key);
    if (time - globalStart >= 60000) {
      globalStart = time;
      globalCount = 0;
    }
    const current = windows.get(actor) ?? { start: time, count: 0 };
    if (
      active >= 2 ||
      current.count >= 6 ||
      globalCount >= 20 ||
      windows.size >= 1000
    )
      return null;
    windows.set(actor, { ...current, count: current.count + 1 });
    globalCount++;
    active++;
    let released = false;
    return () => {
      if (!released) {
        active--;
        released = true;
      }
    };
  };
}
