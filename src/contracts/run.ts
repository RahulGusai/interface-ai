import { z } from "zod";
import { finishTaskInput } from "./finish-task.draft.js";
export const taskInputSchema = z.strictObject({
  goal: z.string().trim().min(1),
  targetUrl: z.url().refine((s) => {
    const u = new URL(s);
    return (
      ["http:", "https:"].includes(u.protocol) && !u.username && !u.password
    );
  }),
});
export type TaskInput = z.infer<typeof taskInputSchema>;
export const toolCallSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  argumentsJson: z.string(),
});
export type ToolCall = z.infer<typeof toolCallSchema>;
export const assistantMessageSchema = z.strictObject({
  role: z.literal("assistant"),
  content: z.string().nullable(),
  tool_calls: z.array(toolCallSchema).min(1).optional(),
});
export type AssistantMessage = z.infer<typeof assistantMessageSchema>;
export const agentTurnSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("tool_calls"),
      calls: z.array(toolCallSchema).min(1),
      assistantMessage: assistantMessageSchema,
    }),
    z.strictObject({
      kind: z.literal("final_text"),
      text: z.string(),
      assistantMessage: assistantMessageSchema,
    }),
  ])
  .superRefine((v, c) => {
    if (
      v.kind === "tool_calls" &&
      (new Set(v.calls.map((x) => x.id)).size !== v.calls.length ||
        JSON.stringify(v.calls) !==
          JSON.stringify(v.assistantMessage.tool_calls))
    )
      c.addIssue({
        code: "custom",
        message: "Invalid tool-call correspondence",
      });
    if (
      v.kind === "final_text" &&
      (v.assistantMessage.tool_calls || v.assistantMessage.content !== v.text)
    )
      c.addIssue({ code: "custom", message: "Invalid final message" });
  });
export type AgentTurn = z.infer<typeof agentTurnSchema>;
export const runStatusSchema = z.enum([
  "max_tool_calls_reached",
  "needs_intervention",
  "awaiting_artifact_design",
  "business_outcome",
  "unable_to_complete",
  "agent_stopped_unverified",
  "provider_error",
  "tool_error",
  "policy_blocked",
]);
export const runResultSchema = z.strictObject({
  status: runStatusSchema,
  summary: z.string(),
  model: z.string(),
  toolCallsUsed: z.number().int().nonnegative(),
  proposedOutcome: finishTaskInput.optional(),
  outputs: z.record(z.string(), z.unknown()).optional(),
  error: z.strictObject({ code: z.string(), message: z.string() }).optional(),
});
export type RunResult = z.infer<typeof runResultSchema>;
export const runEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("started"), targetUrl: z.string() }),
  z.strictObject({ type: z.literal("model_turn"), index: z.number().int() }),
  z.strictObject({
    type: z.literal("tool_requested"),
    name: z.string(),
    callId: z.string(),
  }),
  z.strictObject({
    type: z.literal("tool_completed"),
    name: z.string(),
    callId: z.string(),
    status: z.string(),
  }),
  z.strictObject({
    type: z.literal("intervention_requested"),
    reason: z.string(),
  }),
  z.strictObject({ type: z.literal("stopped"), result: runResultSchema }),
]);
export type RunEvent = z.infer<typeof runEventSchema>;
