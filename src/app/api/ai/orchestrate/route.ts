import { NextResponse } from 'next/server';
import { orchestrateBusinessRequest } from '@/lib/ai/orchestrator';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { input?: unknown };

    if (typeof body.input !== 'string' || !body.input.trim()) {
      return NextResponse.json(
        { error: 'INPUT_REQUIRED' },
        { status: 400 },
      );
    }

    const result = await orchestrateBusinessRequest(body.input);

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'AI_ORCHESTRATOR_ERROR';

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
