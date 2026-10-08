import { z } from "zod";
import { unitSchema, permissions, type Role } from "@/lib/pharmacy/contracts";
export const assistantRequestSchema = z
  .object({
    org: z.uuid(),
    warehouse: z.uuid(),
    input: z.string().trim().min(1).max(2000),
  })
  .strict();
// The model supplies search terms, never IDs, prices, SQL or executable tools.
export const assistantPlanSchema = z
  .object({
    action: z.enum(["sale", "inventory", "reports", "clarify"]),
    explanation: z.string().max(1200),
    search: z.string().max(120),
    payment: z.enum(["cash", "bank"]).nullable(),
    items: z
      .array(
        z
          .object({
            search: z.string().trim().min(1).max(120),
            quantity: z.number().int().min(1).max(999999).nullable(),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();
export type AssistantPlan = z.infer<typeof assistantPlanSchema>;
export const assistantResultSchema = z.object({
  actor: z.uuid(),
  org: z.uuid(),
  warehouse: z.uuid(),
  execution: z.literal("not_executed"),
  requiresApproval: z.literal(true),
  plan: assistantPlanSchema,
  matches: z.array(z.array(unitSchema).max(30)).max(10),
});
export type AssistantResult = z.infer<typeof assistantResultSchema>;
export function permitsPlan(role: Role, plan: AssistantPlan) {
  const access = permissions(role);
  return (
    (plan.action !== "sale" || access.sell) &&
    (plan.action !== "reports" || access.finance)
  );
}
