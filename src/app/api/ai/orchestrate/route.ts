import { NextResponse } from 'next/server';
import { z } from 'zod';
import { orchestrateBusinessRequest } from '@/lib/ai/orchestrator';
import {
  AuthenticationError,
  requireMerchantMember,
} from '@/lib/auth/merchant-auth';

export const runtime = 'nodejs';

const MAX_INPUT_LENGTH = 4000;
const RequestBody = z.object({
  merchantId: z.uuid(),
  input: z.string().trim().min(1).max(MAX_INPUT_LENGTH),
});

export async function POST(request: Request) {
  try {
    const body = RequestBody.parse(await request.json());
    const auth = await requireMerchantMember(request, body.merchantId);
    const result = await orchestrateBusinessRequest(body.input);

    return NextResponse.json(
      { ...result, context: { merchantId: auth.merchantId, role: auth.role } },
      { status: 200 },
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : 'AI_ORCHESTRATOR_ERROR';

    if (error instanceof AuthenticationError) {
      const status = error.code === 'AUTH_CONFIGURATION_MISSING'
        ? 503
        : error.code === 'MERCHANT_ACCESS_DENIED'
          ? 403
          : 401;
      return NextResponse.json({ error: error.code }, { status });
    }

    if (error instanceof z.ZodError) {
      const tooLarge = error.issues.some((issue) => issue.code === 'too_big');
      return NextResponse.json(
        { error: tooLarge ? 'INPUT_TOO_LARGE' : 'INVALID_REQUEST' },
        { status: tooLarge ? 413 : 400 },
      );
    }

    if (code === 'OPENAI_API_KEY_MISSING') {
      return NextResponse.json(
        { error: 'OPENAI_API_KEY_MISSING' },
        { status: 503 },
      );
    }

    if (code === 'EMPTY_INPUT') {
      return NextResponse.json(
        { error: 'INPUT_REQUIRED' },
        { status: 400 },
      );
    }

    console.error('[mawsil.ai.orchestrate]', error);
    return NextResponse.json(
      { error: 'AI_ORCHESTRATOR_ERROR' },
      { status: 500 },
    );
  }
}
