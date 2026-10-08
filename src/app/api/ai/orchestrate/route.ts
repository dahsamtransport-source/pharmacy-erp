import { orchestrateBusinessRequest } from "@/lib/ai/orchestrator";
import { authorizeAssistant } from "@/lib/ai/authorize";
import {
  createAssistantHandler,
  createAssistantLimiter,
} from "@/lib/ai/request-handler";
export const runtime = "nodejs";
export const maxDuration = 50;
export const POST = createAssistantHandler({
  enabled: () =>
    process.env.YMPHARMA_AI_ENABLED === "true" && !!process.env.OPENAI_API_KEY,
  authorize: authorizeAssistant,
  plan: orchestrateBusinessRequest,
  acquire: createAssistantLimiter(),
});
