import { z } from "zod";
import {
  controlTarget,
  target,
  observationSchema,
  type ImageContent,
} from "./observation.js";
import { finishTaskInput } from "./finish-task.draft.js";
import { dialogEventSchema } from "./errors.js";
const obs = { observation_id: z.string().min(1) };
export const conditionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("visible") }),
  z.strictObject({ kind: z.literal("hidden") }),
  z.strictObject({ kind: z.literal("enabled") }),
  z.strictObject({ kind: z.literal("text_equals"), expected: z.string() }),
  z.strictObject({ kind: z.literal("value_equals"), expected: z.string() }),
]);
const conditionInput = z.strictObject({
  ...obs,
  target: controlTarget,
  condition: conditionSchema,
});
const modifiers = ["Control", "Meta", "Alt", "Shift"];
const named = [
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Space",
];
export const toolSchemas = {
  observe_ui: z.strictObject({
    mode: z.enum(["screenshot", "controls", "both"]),
  }),
  navigate: z.strictObject({
    url: z.url().refine((s) => /^https?:\/\//.test(s)),
  }),
  click: z.strictObject({ ...obs, target }),
  type_text: z.strictObject({
    ...obs,
    target,
    text: z.string(),
    mode: z.enum(["replace", "append"]),
  }),
  press_key: z.strictObject({
    ...obs,
    target: controlTarget.optional(),
    keys: z
      .array(z.string())
      .min(1)
      .max(5)
      .refine(
        (keys) =>
          new Set(keys).size === keys.length &&
          keys.slice(0, -1).every((k) => modifiers.includes(k)) &&
          !!keys.at(-1) &&
          (named.includes(keys.at(-1)!) || /^[\x20-\x7E]$/.test(keys.at(-1)!)),
      ),
  }),
  scroll: z.strictObject({
    ...obs,
    target: target.optional(),
    direction: z.enum(["up", "down", "left", "right"]),
    distance: z.number().finite().positive().max(2),
  }),
  select_option: z.strictObject({
    ...obs,
    target: controlTarget,
    option: z.strictObject({ label: z.string() }),
  }),
  wait_for: conditionInput,
  check_ui: conditionInput,
  extract_data: z.strictObject({
    ...obs,
    fields: z
      .array(
        z.strictObject({
          name: z.string().min(1),
          target: controlTarget,
          property: z.enum(["text", "value", "name"]),
          output_type: z.enum(["string", "number"]),
        }),
      )
      .min(1)
      .refine(
        (fields) => new Set(fields.map((f) => f.name)).size === fields.length,
      ),
  }),
  request_human: z.strictObject({
    ...obs,
    reason: z.enum([
      "stuck",
      "ambiguous_state",
      "unsupported_interaction",
      "approval_required",
      "unrecoverable_error",
    ]),
    message: z.string().min(1),
  }),
  finish_task: finishTaskInput,
};
export type ToolName = keyof typeof toolSchemas;
export type ToolInputs = { [K in ToolName]: z.infer<(typeof toolSchemas)[K]> };
export type ToolAction = {
  [K in ToolName]: { name: K; input: ToolInputs[K] };
}[ToolName];
export type BrowserAction = Exclude<
  ToolAction,
  { name: "request_human" | "finish_task" }
>;
export function parseToolInput(name: string, input: unknown) {
  if (!Object.hasOwn(toolSchemas, name)) throw new Error("UNKNOWN_TOOL");
  return toolSchemas[name as ToolName].parse(input);
}
export function parseToolAction(name: string, input: unknown): ToolAction {
  return { name, input: parseToolInput(name, input) } as ToolAction;
}
const descriptions: Record<ToolName, string> = {
  observe_ui:
    "Read rendered UI; both returns semantic controls and screenshot. Fresh observations supersede old references.",
  navigate: "Navigate active browser to an allowed task or observed URL.",
  click: "One primary click on an observed control or screenshot point.",
  type_text:
    "Focus editable target and replace text or append at end; never submit.",
  press_key:
    "One key or simultaneous modifier chord; optional control target focuses without click.",
  scroll:
    "Scroll selected region by positive visible-viewport fraction, at most two; no focus change.",
  select_option:
    "Select exact unique observed label on native single-select; custom widgets unsupported.",
  wait_for:
    "Poll a deterministic condition on an observed control under runtime deadline.",
  check_ui:
    "Evaluate a deterministic control condition once. Unknown is not success.",
  extract_data:
    "Read rendered fields using control references; plain decimal numbers only.",
  request_human:
    "Stop autonomous work and report intervention request; takeover is deferred.",
  finish_task:
    "Report the terminal outcome and a meaningful summary. For goal_achieved, outputs must be an object (use {} if empty). No observation_id or proposal is needed; the runtime builds the artifact from recorded actions. Correct only invalid required fields after rejection.",
};
export const toolDefinitions = Object.entries(toolSchemas).map(
  ([name, schema]) => ({
    type: "function" as const,
    function: {
      name,
      description: descriptions[name as ToolName],
      parameters: {
        ...z.toJSONSchema(schema, { unrepresentable: "any", io: "input" }),
        ...(name === "finish_task"
          ? {
              allOf: [
                {
                  if: {
                    properties: { outcome: { const: "goal_achieved" } },
                    required: ["outcome"],
                  },
                  then: { required: ["outputs"] },
                },
              ],
            }
          : {}),
      },
    },
  }),
);
const common = {
  reason: z.string().optional(),
  code: z.string().optional(),
  blocker: z.strictObject({ kind: z.string(), message: z.string() }).optional(),
  dialog_events: z.array(dialogEventSchema).optional(),
};
const actionFields = {
  status: z.enum(["completed", "blocked", "failed", "uncertain"]),
  ...common,
  observation: observationSchema,
};
const actionResult = z.strictObject(actionFields);
const verification = z.enum(["matched", "mismatched", "unavailable"]);
const fieldResult = z.union([
  z.strictObject({
    status: z.literal("extracted"),
    value: z.union([z.string(), z.number().finite()]),
  }),
  z.strictObject({
    status: z.literal("error"),
    code: z.string(),
    message: z.string(),
  }),
]);
export const toolResultSchemas = {
  observe_ui: observationSchema,
  navigate: z.strictObject({
    ...actionFields,
    requested_url: z.string(),
    final_url: z.string().optional(),
  }),
  click: actionResult,
  type_text: z.strictObject({ ...actionFields, verification }),
  press_key: actionResult,
  scroll: z.strictObject({
    ...actionFields,
    movement: z.enum(["moved", "no_movement", "unknown"]),
  }),
  select_option: z.strictObject({
    ...actionFields,
    verification,
    selected_label: z.string().optional(),
  }),
  wait_for: z.strictObject({
    status: z.enum([
      "condition_met",
      "timed_out",
      "blocked",
      "invalidated",
      "failed",
    ]),
    elapsed_ms: z.number().nonnegative(),
    ...common,
    observation: observationSchema,
  }),
  check_ui: z.strictObject({
    status: z.enum(["evaluated", "blocked", "invalidated", "failed"]),
    verdict: z.enum(["pass", "fail", "unknown"]),
    evidence: z
      .strictObject({
        property: z.string(),
        observed: z.union([z.string(), z.boolean()]),
      })
      .optional(),
    ...common,
    observation: observationSchema,
  }),
  extract_data: z.strictObject({
    status: z.enum([
      "completed",
      "partial",
      "blocked",
      "invalidated",
      "failed",
    ]),
    fields: z.custom<Record<string, z.infer<typeof fieldResult>>>(
      (value) =>
        !!value &&
        typeof value === "object" &&
        (Object.getPrototypeOf(value) === Object.prototype ||
          Object.getPrototypeOf(value) === null) &&
        Object.values(value).every(
          (item) => fieldResult.safeParse(item).success,
        ),
    ),
    ...common,
    observation: observationSchema,
  }),
  request_human: z.union([
    z.strictObject({ status: z.literal("requested"), request_id: z.string() }),
    z.strictObject({ status: z.literal("failed"), reason: z.string() }),
  ]),
  finish_task: z.union([
    z.strictObject({
      status: z.literal("accepted"),
      outcome: finishTaskInput.shape.outcome,
    }),
    z.strictObject({
      status: z.literal("rejected"),
      code: z.string(),
      message: z.string(),
    }),
  ]),
};
export const dispatchErrorSchema = z.strictObject({
  status: z.enum(["error", "policy_blocked", "needs_intervention"]),
  code: z.string(),
  message: z.string(),
});
export type ToolResult =
  | z.infer<(typeof toolResultSchemas)[ToolName]>
  | z.infer<typeof dispatchErrorSchema>;
export type ToolResponse = { result: ToolResult; image?: ImageContent };
