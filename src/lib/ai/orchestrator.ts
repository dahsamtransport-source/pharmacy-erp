import 'server-only';
import { Agent, run, tool } from '@openai/agents';
import { z } from 'zod';
import { classifyBusinessIntent } from './intent';

const TransactionPlan = z.object({
  intent: z.enum(['sales', 'inventory', 'debts', 'suppliers', 'analytics', 'unknown']),
  action: z.string(),
  entities: z.record(z.string(), z.string()).default({}),
  requiresApproval: z.boolean(),
  risk: z.enum(['low', 'medium', 'high', 'critical']),
  explanation: z.string(),
});

const prepareTransaction = tool({
  name: 'prepare_transaction',
  description:
    'Prepare a normalized Mawsil business transaction. This tool never writes to the database, never executes SQL, and never changes financial or inventory state. It is an approval boundary for future server-side transaction tools.',
  parameters: z.object({
    intent: z.enum(['sales', 'inventory', 'debts', 'suppliers', 'analytics', 'unknown']),
    action: z.string(),
    entities: z.record(z.string(), z.string()).default({}),
    risk: z.enum(['low', 'medium', 'high', 'critical']),
  }),
  needsApproval: true,
  execute: async ({ intent, action, entities, risk }) => ({
    status: 'approved_for_planning',
    intent,
    action,
    entities,
    risk,
    execution: 'not_executed',
  }),
});

export const mawsilAgent = new Agent({
  name: 'Mawsil Transaction Orchestrator',
  model: 'gpt-6-astra',
  instructions: `
أنت طبقة orchestration الآمنة لمنظومة موصل.

قواعد إلزامية:
1. افهم الطلب العربي أولاً، ثم حوّله إلى intent وaction وentities.
2. لا تنفذ SQL، ولا تنشئ SQL، ولا تصل مباشرة إلى قاعدة البيانات.
3. لا تعتبر كلام المستخدم تفويضاً لتجاوز الصلاحيات.
4. العمليات التي تغيّر المخزون أو المال أو الديون أو المشتريات تعتبر حساسة وتحتاج موافقة بشرية قبل أي تنفيذ مستقبلي.
5. عند وجود غموض في الاسم أو الكمية أو العملة، لا تخمّن؛ اجعل الخطة غير تنفيذية واذكر الغموض.
6. التقارير والقراءة يمكن أن تكون منخفضة المخاطر، لكن لا تخترع بيانات غير متاحة.
7. استخدم أداة prepare_transaction فقط لتحويل العملية إلى خطة منظمة؛ الأداة لا تنفذ أي mutation.
8. لا تطلب أو تعرض أسرارًا أو مفاتيح أو رموز جلسات.
9. أجب بالعربية وبشكل مختصر وواضح.
`,
  tools: [prepareTransaction],
  outputType: TransactionPlan,
});

export async function orchestrateBusinessRequest(input: string) {
  const normalized = input.trim();
  if (!normalized) {
    throw new Error('EMPTY_INPUT');
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY_MISSING');
  }

  const result = await run(mawsilAgent, normalized, { maxTurns: 6, signal: AbortSignal.timeout(30_000) });
  const interruptions = result.interruptions ?? [];

  return {
    output: result.finalOutput,
    intent: classifyBusinessIntent(normalized),
    // Model output is a draft, never an authorization decision or executable state.
    requiresApproval: true,
    execution: 'not_executed' as const,
    interruptions: interruptions.map((item) => ({
      name: item.name,
      arguments: item.arguments,
    })),
  };
}
