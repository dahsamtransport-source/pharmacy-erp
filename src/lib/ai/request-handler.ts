import 'server-only';
import { z } from 'zod';
import { AuthenticationError, type MerchantAuthContext } from '../auth/merchant-auth';

const MAX_BODY_BYTES = 32_768;
const RequestBody = z.object({
  merchantId: z.uuid(),
  input: z.string().trim().min(1).max(4000),
}).strict();

class RequestError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

async function readBody(request: Request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new RequestError(415, 'JSON_CONTENT_TYPE_REQUIRED');
  }
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
    throw new RequestError(413, 'INPUT_TOO_LARGE');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError(400, 'INVALID_REQUEST');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void reader.cancel().catch(() => {});
      reject(new RequestError(408, 'REQUEST_BODY_TIMEOUT'));
    }, 5000);
  });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        throw new RequestError(413, 'INPUT_TOO_LARGE');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new RequestError(400, 'INVALID_JSON'); }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

type PlanningDependencies = {
  enabled: () => boolean;
  authorize: (request: Request, merchantId: string) => Promise<MerchantAuthContext>;
  plan: (input: string) => Promise<Record<string, unknown>>;
};

// Dependencies stay server-side. Tests supply fakes; production uses verified Supabase Auth.
export function createPlanningHandler(dependencies: PlanningDependencies) {
  return async (request: Request): Promise<Response> => {
    try {
      // Closed by default until live auth, budgets and distributed rate limiting are verified.
      if (!dependencies.enabled()) throw new RequestError(503, 'AI_PLANNING_NOT_ENABLED');
      const body = RequestBody.parse(await readBody(request));
      const auth = await dependencies.authorize(request, body.merchantId);
      const draft = await dependencies.plan(body.input);
      return Response.json({
        ...draft,
        execution: 'not_executed',
        requiresApproval: true,
        context: { merchantId: auth.merchantId, role: auth.role },
      }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      let status = 500;
      let code = 'AI_ORCHESTRATOR_ERROR';
      if (error instanceof RequestError) {
        status = error.status; code = error.code;
      } else if (error instanceof AuthenticationError) {
        code = error.code;
        status = code === 'AUTH_CONFIGURATION_MISSING' ? 503 : code === 'MERCHANT_ACCESS_DENIED' ? 403 : 401;
      } else if (error instanceof z.ZodError) {
        const tooLarge = error.issues.some((issue) => issue.code === 'too_big');
        status = tooLarge ? 413 : 400;
        code = tooLarge ? 'INPUT_TOO_LARGE' : 'INVALID_REQUEST';
      } else if (error instanceof Error && error.message === 'OPENAI_API_KEY_MISSING') {
        status = 503; code = 'OPENAI_API_KEY_MISSING';
      } else if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) {
        status = 504; code = 'AI_REQUEST_TIMEOUT';
      }
      // Never log tokens, user prompts, SDK error objects, or model/provider responses.
      return Response.json({ error: code }, { status, headers: { 'Cache-Control': 'no-store' } });
    }
  };
}
