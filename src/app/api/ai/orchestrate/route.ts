import { orchestrateBusinessRequest } from '@/lib/ai/orchestrator';
import { createPlanningHandler } from '@/lib/ai/request-handler';
import { requireMerchantMember } from '@/lib/auth/merchant-auth';

export const runtime = 'nodejs';

export const POST = createPlanningHandler({
  enabled: () => process.env.MAWSIL_AI_PLANNING_ENABLED === 'true',
  authorize: requireMerchantMember,
  plan: orchestrateBusinessRequest,
});
