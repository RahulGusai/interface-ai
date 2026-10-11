import { z } from "zod";
export const executionAssessmentSchema = z.strictObject({
  decision: z.enum(["auto_approve", "requires_human_review"]),
  confidence: z.number().finite().min(0).max(1),
  reason: z.string().trim().min(1).max(2000),
});
export type ExecutionAssessment = z.infer<typeof executionAssessmentSchema>;
export function assessmentOf(raw: unknown): ExecutionAssessment | undefined {
  const result = executionAssessmentSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}
export function requiresReview(raw: unknown): boolean {
  const a = assessmentOf(raw);
  return !a || a.decision === "requires_human_review" || a.confidence < 0.3;
}
export const entryAssessment: ExecutionAssessment = {
  decision: "auto_approve",
  confidence: 1,
  reason: "Runtime-owned entry navigation",
};
