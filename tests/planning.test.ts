import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPlanningHandler } from '../src/lib/ai/request-handler';
import { classifyBusinessIntent } from '../src/lib/ai/intent';
import { AuthenticationError, requireMerchantMember } from '../src/lib/auth/merchant-auth';

const merchantId = '20000000-0000-4000-8000-000000000001';
function request(body: unknown = { merchantId, input: 'تقرير مبيعات اليوم' }, headers = {}) {
  return new Request('http://localhost/api/ai/orchestrate', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
}
function fixture(options: { enabled?: boolean; authError?: AuthenticationError['code']; planError?: Error } = {}) {
  const calls: string[] = [];
  const handler = createPlanningHandler({
    enabled: () => options.enabled ?? true,
    authorize: async (_request, id) => {
      calls.push('auth:' + id);
      if (options.authError) throw new AuthenticationError(options.authError);
      return { userId: 'verified-user', merchantId: id, role: 'owner' };
    },
    plan: async (input) => {
      calls.push('plan:' + input);
      if (options.planError) throw options.planError;
      return { output: 'draft', execution: 'executed', requiresApproval: false };
    },
  });
  return { handler, calls };
}

test('planning disabled means no auth network call and no paid model call', async () => {
  const { handler, calls } = fixture({ enabled: false });
  const response = await handler(request());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'AI_PLANNING_NOT_ENABLED' });
  assert.deepEqual(calls, []);
});
test('model invocation follows authorization; draft cannot claim execution', async () => {
  const { handler, calls } = fixture();
  const response = await handler(request({ merchantId, input: '  تقرير  ' }));
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['auth:' + merchantId, 'plan:تقرير']);
  assert.deepEqual(await response.json(), {
    output: 'draft', execution: 'not_executed', requiresApproval: true, context: { merchantId, role: 'owner' },
  });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
for (const [code, status] of [
  ['AUTH_CONFIGURATION_MISSING', 503], ['AUTH_TOKEN_MISSING', 401],
  ['AUTH_TOKEN_INVALID', 401], ['MERCHANT_ACCESS_DENIED', 403],
] as const) {
  test('authorization failure prevents model invocation: ' + code, async () => {
    const { handler, calls } = fixture({ authError: code });
    const response = await handler(request());
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: code });
    assert.equal(calls.length, 1);
  });
}
for (const [body, status] of [
  [null, 400], [{ merchantId: 'bad', input: 'test' }, 400],
  [{ merchantId, input: '' }, 400], [{ merchantId, input: 'x'.repeat(4001) }, 413],
  [{ merchantId, input: 'test', role: 'owner' }, 400],
] as const) {
  test('invalid schema is rejected before authorization: ' + JSON.stringify(body)?.slice(0,60), async () => {
    const { handler, calls } = fixture();
    assert.equal((await handler(request(body))).status, status);
    assert.deepEqual(calls, []);
  });
}
test('malformed JSON is 400, not an internal error', async () => {
  const { handler, calls } = fixture();
  const response = await handler(new Request('http://localhost', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
  }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'INVALID_JSON' });
  assert.deepEqual(calls, []);
});
test('body byte limit enforced even with forged small content-length', async () => {
  const { handler, calls } = fixture();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(20_000));
      controller.enqueue(new Uint8Array(20_000));
      controller.close();
    },
  });
  const input = new Request('http://localhost', {
    method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '10' },
    body: stream, duplex: 'half',
  } as RequestInit);
  assert.equal((await handler(input)).status, 413);
  assert.deepEqual(calls, []);
});
test('non-JSON content type is rejected', async () => {
  assert.equal((await fixture().handler(request({}, { 'content-type': 'text/plain' }))).status, 415);
});
test('provider error contents are not returned', async () => {
  const response = await fixture({ planError: new Error('secret-token-and-private-prompt') }).handler(request());
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'AI_ORCHESTRATOR_ERROR' });
});
test('provider timeout is bounded and explicit', async () => {
  const error = new Error('timeout'); error.name = 'TimeoutError';
  assert.equal((await fixture({ planError: error }).handler(request())).status, 504);
});
test('local Arabic classifier is separate from SDK and prioritizes reports', () => {
  for (const [input, expected] of [
    ['تقرير مبيعات اليوم', 'analytics'], ['طلب شراء من مورد', 'suppliers'],
    ['سجل أن محمد أخذ 5 كراتين مياه بالدين', 'sales'], ['سداد دين محمد', 'debts'],
    ['كمية المخزون', 'inventory'], ['', 'unknown'],
  ]) assert.equal(classifyBusinessIntent(input), expected);
});
test('Supabase auth adapter verifies token then membership using verified user ID (mocked backend)', async () => {
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_ANON_KEY;
  process.env.SUPABASE_URL = 'https://example.invalid';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key-not-a-secret';
  try {
    const calls: unknown[] = [];
    let userOk = true;
    let member: { role: string } | null = { role: 'staff' };
    const factory = ((_url: string, _key: string, options: unknown) => {
      calls.push(options);
      const query = {
        select: (columns: string) => { calls.push(columns); return query; },
        eq: (column: string, value: string) => { calls.push([column, value]); return query; },
        maybeSingle: async () => ({ data: member, error: null }),
      };
      return {
        auth: { getUser: async (token: string) => {
          calls.push(['getUser', token]);
          return { data: { user: userOk ? { id: 'verified-user' } : null }, error: null };
        } },
        from: (table: string) => { calls.push(table); return query; },
      };
    }) as unknown as Parameters<typeof requireMerchantMember>[2];
    const bearer = request(undefined, { authorization: 'bearer test-access-token' });
    assert.deepEqual(await requireMerchantMember(bearer, merchantId, factory),
      { userId: 'verified-user', merchantId, role: 'staff' });
    assert(calls.some((entry) => JSON.stringify(entry) === JSON.stringify(['user_id', 'verified-user'])));
    calls.length = 0; userOk = false;
    await assert.rejects(requireMerchantMember(bearer, merchantId, factory), /AUTH_TOKEN_INVALID/);
    assert(!calls.includes('merchant_members'));
    userOk = true; member = null;
    await assert.rejects(requireMerchantMember(bearer, merchantId, factory), /MERCHANT_ACCESS_DENIED/);
    member = { role: 'unexpected-admin' };
    await assert.rejects(requireMerchantMember(bearer, merchantId, factory), /MERCHANT_ACCESS_DENIED/);
    await assert.rejects(requireMerchantMember(request(), merchantId, factory), /AUTH_TOKEN_MISSING/);
    await assert.rejects(requireMerchantMember(request(undefined, { authorization: 'Bearer one two' }), merchantId, factory), /AUTH_TOKEN_MISSING/);
  } finally {
    if (originalUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = originalKey;
  }
});
