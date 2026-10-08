import { z } from "zod";
import { objectRecord } from "./object-record.js";
export const finishTaskInput = z
  .object({
    outcome: z.enum([
      "goal_achieved",
      "business_outcome",
      "unable_to_complete",
    ]),
    summary: z.string().trim().min(1),
    outcome_code: z.string().optional().catch(undefined),
    outputs: objectRecord(z.unknown()).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.outcome === "goal_achieved" && input.outputs === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["outputs"],
        message:
          "Successful completion requires an outputs object (use {} when there are no outputs)",
      });
  });
export type FinishTaskInput = z.infer<typeof finishTaskInput>;
