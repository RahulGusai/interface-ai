import { z } from "zod";
import { objectRecord } from "./object-record.js";
export const primitive = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
]);
export const flatSchema = z.strictObject({
  $schema: z.literal("https://json-schema.org/draft/2020-12/schema").optional(),
  type: z.literal("object"),
  description: z.string().optional(),
  properties: z.record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    z.strictObject({
      type: z.enum(["string", "number", "boolean"]),
      description: z.string().optional(),
      enum: z.array(primitive).min(1).optional(),
      format: z.literal("email").optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      default: primitive.optional(),
    }),
  ),
  required: z.array(z.string()),
  additionalProperties: z.literal(false),
});
// Runtime-built artifacts preserve arbitrary JSON output values without imposing
// field types or names on finish_task. Typed capability contracts remain supported.
export const jsonObjectSchema = z.strictObject({
  type: z.literal("object"),
  properties: objectRecord(z.strictObject({})),
  required: z.array(z.string()),
  additionalProperties: z.literal(false),
});
export const valueSchema = z.union([flatSchema, jsonObjectSchema]);
export type FlatSchema = z.infer<typeof flatSchema>;
export function validateValues(
  raw: unknown,
  value: unknown,
): Record<string, unknown> {
  const schema = valueSchema.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("INPUT_CONTRACT_INVALID");
  const result = { ...value } as Record<string, unknown>;
  if (
    schema.required.some((k) => !(k in schema.properties)) ||
    new Set(schema.required).size !== schema.required.length
  )
    throw Error("SCHEMA_UNSUPPORTED");
  for (const key of Object.keys(result))
    if (!Object.hasOwn(schema.properties, key))
      throw Error("INPUT_CONTRACT_INVALID");
  for (const [key, p] of Object.entries(schema.properties)) {
    if (!("type" in p)) {
      if (Object.hasOwn(result, key)) z.json().parse(result[key]);
      else if (schema.required.includes(key))
        throw Error("INPUT_CONTRACT_INVALID");
      continue;
    }
    if (!Object.hasOwn(result, key) && p.default !== undefined)
      result[key] = p.default;
    const v = result[key];
    if (v === undefined) {
      if (schema.required.includes(key)) throw Error("INPUT_CONTRACT_INVALID");
      continue;
    }
    if (
      typeof v !== p.type ||
      (typeof v === "number" && !Number.isFinite(v)) ||
      (p.enum && !p.enum.includes(v as string | number | boolean)) ||
      (p.format === "email" &&
        (typeof v !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))) ||
      (typeof v === "number" &&
        ((p.minimum !== undefined && v < p.minimum) ||
          (p.maximum !== undefined && v > p.maximum)))
    )
      throw Error("INPUT_CONTRACT_INVALID");
  }
  return result;
}
export const binding: z.ZodType<any> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("literal"),
      value: z.custom((value) => z.json().safeParse(value).success),
    }),
    z.strictObject({ kind: z.literal("input"), path: z.string() }),
    z.strictObject({
      kind: z.literal("step_output"),
      step_id: z.string(),
      path: z.string(),
    }),
    z.strictObject({
      kind: z.literal("environment"),
      path: z.literal("base_url"),
    }),
    z.strictObject({
      kind: z.literal("url"),
      base: z.strictObject({
        kind: z.literal("environment"),
        path: z.literal("base_url"),
      }),
      path: z
        .string()
        .startsWith("/")
        .refine(
          (v) => !v.startsWith("//") && !v.includes("\\") && !v.includes(".."),
        ),
    }),
    z.strictObject({
      kind: z.literal("template"),
      parts: z.array(binding).min(1),
    }),
  ]),
);
const scope = z.strictObject({
  role: z.string().min(1),
  name: z.string(),
  exact: z.literal(true),
  frame: z.strictObject({ name: z.string(), url_path: z.string() }).optional(),
});
export const captureContext = z.strictObject({
  viewport_width: z.literal(1280),
  viewport_height: z.literal(800),
  device_scale_factor: z.literal(1),
  image_scale: z.literal("css"),
  color_space: z.literal("srgb"),
});
export const durableTarget = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("table_cell"),
    columns: z.array(z.string()).min(1),
    column_index: z.number().int().nonnegative(),
    row_index: z.number().int().nonnegative().nullable(),
    scope: z.array(scope).nullable(),
    required_matches: z.literal(1),
  }),
  z.strictObject({
    kind: z.literal("row_action"),
    row_role: z.literal("row"),
    action_role: z.string().min(1),
    action_text: z.string().min(1).optional(),
    action_name: z.string().min(1).optional(),
    scope: z.array(scope).nullable(),
    required_matches: z.literal(1),
  }),
  z.strictObject({
    kind: z.literal("semantic"),
    role: z.string().min(1),
    name: binding,
    match_by: z.enum(["name", "text"]).optional(),
    exact: z.literal(true),
    scope: z.array(scope).nullable(),
    required_matches: z.literal(1),
  }),
  z.strictObject({
    kind: z.literal("visual"),
    asset_id: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    matcher: z.literal("rgb-template-v1"),
    threshold: z.number().min(0.95).max(1),
    required_matches: z.literal(1),
    relative_point: z.strictObject({
      u: z.number().min(0).lt(1),
      v: z.number().min(0).lt(1),
    }),
    capture_context: captureContext,
  }),
]);
export type DurableTarget = z.infer<typeof durableTarget>;
export const check: z.ZodType<any> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({
      check_id: z.string().min(1),
      kind: z.enum(["all", "any"]),
      checks: z.array(check).min(1),
    }),
    z.strictObject({
      check_id: z.string().min(1),
      kind: z.enum(["tool_status_equals", "tool_verification"]),
      step_id: z.string().optional(),
      expected: z.string(),
    }),
    z.strictObject({
      check_id: z.string().min(1),
      kind: z.literal("field_equals"),
      actual: binding,
      expected: binding,
    }),
    z.strictObject({
      check_id: z.string().min(1),
      kind: z.enum([
        "control_visible",
        "control_absent",
        "control_text_equals",
        "control_value_equals",
      ]),
      target: durableTarget,
      expected: binding.optional(),
    }),
  ]),
);
const argumentTree: z.ZodType<any> = z.lazy(() =>
  z.union([
    durableTarget,
    binding,
    primitive,
    z.null(),
    z.array(argumentTree),
    z.record(z.string(), argumentTree),
  ]),
);
const stepFields = {
  step_id: z.string().regex(/^[A-Za-z0-9_]+$/),
  tool: z.enum([
    "observe_ui",
    "navigate",
    "click",
    "type_text",
    "press_key",
    "scroll",
    "select_option",
    "wait_for",
    "check_ui",
    "extract_data",
  ]),
  arguments: z.record(z.string(), argumentTree),
  target: durableTarget.optional(),
  pre_checks: z.array(check).default([]),
  post_checks: z.array(check).default([]),
};
const recoveryStep = z.strictObject(stepFields);
const recovery = z.discriminatedUnion("kind", [
  z.strictObject({
    recovery_id: z.string(),
    on_check_id: z.string(),
    kind: z.literal("wait"),
    max_attempts: z.number().int().min(1).max(2),
    delay_ms: z.literal(500),
  }),
  z.strictObject({
    recovery_id: z.string(),
    on_check_id: z.string(),
    kind: z.literal("saved_action"),
    max_attempts: z.literal(1),
    step: recoveryStep,
    then_checks: z.array(check),
  }),
]);
export const artifactSchema = z.strictObject({
  surface: z.literal("browser"),
  compatibility: z.strictObject({
    product_id: z.string().min(1),
    ui_variant: z.string().min(1),
    vendor_release: z.string().nullable(),
  }),
  input_schema: valueSchema,
  output_schema: valueSchema,
  entry: z.strictObject({ url: binding, checks: z.array(check) }),
  steps: z
    .array(
      z.strictObject({
        ...stepFields,
        recoveries: z.array(recovery).default([]),
      }),
    )
    .min(1),
  success_checks: z.array(check).min(1),
  business_outcomes: z.array(
    z.strictObject({
      code: z.string().min(1),
      message: z.string(),
      after_step_id: z.string(),
      checks: z.array(check).min(1),
      output_mapping: objectRecord(binding),
    }),
  ),
  output_mapping: objectRecord(binding),
});
export type ArtifactDefinition = z.infer<typeof artifactSchema>;
export function parseArtifact(raw: unknown): ArtifactDefinition {
  const a = artifactSchema.parse(raw);
  const availableAfter = new Map<string, Set<string>>();
  const seen = new Set<string>(),
    checks = new Set<string>();
  const walk = (v: any, available: Set<string>) => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x, available);
      return;
    }
    if (!v || typeof v !== "object") return;
    if (v.kind === "literal") return;
    for (const k of Object.keys(v))
      if (
        [
          "observation_id",
          "control_ref",
          "tool_call_id",
          "source_tool_call_id",
          "call_id",
          "x",
          "y",
        ].includes(k)
      )
        throw Error("STALE_ARTIFACT_FIELD");
    if (v.kind === "input" && !Object.hasOwn(a.input_schema.properties, v.path))
      throw Error("UNDECLARED_INPUT");
    if (v.kind === "step_output" && !available.has(v.step_id))
      throw Error("FORWARD_STEP_OUTPUT");
    if (v.check_id) {
      if (checks.has(v.check_id)) throw Error("DUPLICATE_CHECK");
      checks.add(v.check_id);
      if (v.step_id && !available.has(v.step_id)) throw Error("FORWARD_CHECK");
    }
    for (const x of Object.values(v)) walk(x, available);
  };
  if (!["environment", "url"].includes(a.entry.url.kind))
    throw Error("UNTRUSTED_ENTRY");
  walk(a.entry, seen);
  const trustedNavigation = (s: any) => {
    if (
      s.tool === "navigate" &&
      (!s.arguments.url ||
        !(
          ["environment", "url"].includes(s.arguments.url.kind) ||
          (s.arguments.url.kind === "literal" &&
            typeof s.arguments.url.value === "string" &&
            /^https?:\/\//i.test(s.arguments.url.value) &&
            z.url().safeParse(s.arguments.url.value).success)
        ))
    )
      throw Error("UNTRUSTED_NAVIGATION");
  };
  for (const s of a.steps) {
    trustedNavigation(s);
    if (seen.has(s.step_id)) throw Error("DUPLICATE_STEP");
    walk(s.arguments, seen);
    walk(s.target, seen);
    walk(s.pre_checks, seen);
    seen.add(s.step_id);
    walk(s.post_checks, seen);
    for (const r of s.recoveries) {
      if (
        !s.pre_checks
          .concat(s.post_checks)
          .some((c) => c.check_id === r.on_check_id)
      )
        throw Error("UNKNOWN_RECOVERY_CHECK");
      if (r.kind === "saved_action") {
        trustedNavigation(r.step);
        if (seen.has(r.step.step_id)) throw Error("DUPLICATE_STEP");
        walk(r.step.arguments, seen);
        walk(r.step.target, seen);
        walk(r.step.pre_checks, seen);
        seen.add(r.step.step_id);
        walk(r.step.post_checks, seen);
        walk(r.then_checks, seen);
      }
    }
    availableAfter.set(s.step_id, new Set(seen));
  }
  walk(a.success_checks, seen);
  for (const value of Object.values(a.output_mapping)) walk(value, seen);
  for (const b of a.business_outcomes) {
    const available = availableAfter.get(b.after_step_id);
    if (!available) throw Error("UNKNOWN_BUSINESS_STEP");
    walk(b, available);
  }
  if (
    Object.keys(a.output_mapping).sort().join() !==
    Object.keys(a.output_schema.properties).sort().join()
  )
    throw Error("OUTPUT_MAPPING_INVALID");
  // Validate schema defaults even when required values are not yet supplied.
  for (const schema of [a.input_schema, a.output_schema])
    for (const [k, p] of Object.entries(schema.properties))
      if ("default" in p && p.default !== undefined)
        validateValues({ ...schema, required: [] }, { [k]: p.default });
  return a;
}
