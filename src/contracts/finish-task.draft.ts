import { z } from "zod";
export const finishTaskInput = z.strictObject({
  observation_id: z.string().min(1),
  outcome: z.enum(["goal_achieved", "business_outcome", "unable_to_complete"]),
  summary: z.string().min(1),
  outcome_code: z.string().min(1).optional(),
  outputs: z.record(z.string(), z.unknown()).optional(),
});
export type FinishTaskInput = z.infer<typeof finishTaskInput>;
