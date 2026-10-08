import { z } from "zod";
import { resolveBindings } from "../replay/bindings.js";
import { SafeError } from "../contracts/errors.js";

/** Shared admission/build check: variable values must retain their bindings. */
export function assertBoundArguments(
  tool: string,
  raw: Record<string, any>,
  inputs: Record<string, unknown>,
) {
  if (["finish_task", "request_human"].includes(tool)) return;
  const variableValues = Object.values(inputs)
    .filter((value) => ["string", "number", "boolean"].includes(typeof value))
    .map((value) => String(value).toLowerCase())
    .filter(Boolean);
  const includesVariableLiteral = (value: any): boolean => {
    if (value?.kind === "input") return false;
    if (value?.kind === "literal") return includesVariableLiteral(value.value);
    if (value?.kind === "template")
      return value.parts.some(includesVariableLiteral);
    if (typeof value === "string")
      return variableValues.some((input) =>
        value.toLowerCase().includes(input),
      );
    if (Array.isArray(value)) return value.some(includesVariableLiteral);
    if (value && typeof value === "object")
      return Object.values(value).some(includesVariableLiteral);
    return false;
  };
  const values: [string, unknown][] = [];
  if (tool === "type_text") values.push(["text", raw.text]);
  if (raw.row_match) values.push(["row_match", raw.row_match]);
  if (tool === "extract_data")
    raw.fields?.forEach((field: any, index: number) => {
      if (field.row_match)
        values.push([`fields.${index}.row_match`, field.row_match]);
    });
  if (tool === "select_option")
    values.push(["option.label", raw.option?.label]);
  if (["check_ui", "wait_for"].includes(tool))
    values.push(["condition.expected", raw.condition?.expected]);
  const invalid =
    values.find(([, value]) => includesVariableLiteral(value))?.[0] ??
    (tool === "navigate" &&
    variableValues.some(
      (value) =>
        value.length > 2 && String(raw.url).toLowerCase().includes(value),
    )
      ? "url"
      : undefined);
  if (invalid)
    throw new SafeError(
      "UNBOUND_INPUT_ARGUMENT",
      `UNBOUND_INPUT_ARGUMENT: ${invalid} contains a variable example value. Replace it with an input reference or template; keep fixed values plain. Available references: ${JSON.stringify(Object.keys(inputs).map((path) => ({ kind: "input", path })))}`,
    );
}

const input = z.strictObject({
  kind: z.literal("input"),
  path: z.string().min(1),
});
const template = z.strictObject({
  kind: z.literal("template"),
  parts: z
    .array(z.union([z.string(), z.number().finite(), z.boolean(), input]))
    .min(1),
});
export const explicitDiscoveryExpression = z.discriminatedUnion("kind", [
  input,
  template,
  z.strictObject({
    kind: z.literal("literal"),
    value: z.union([z.string(), z.number().finite(), z.boolean()]),
  }),
]);
export const discoveryExpression = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  explicitDiscoveryExpression,
]);
const resolvedRowMatch = z.record(
  z.string(),
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.strictObject({
      operator: z.enum(["ends_with", "contains"]),
      value: z.string().min(1),
    }),
  ]),
);
export const rowCriterionJson = z.toJSONSchema(
  z.union([
    discoveryExpression,
    z.strictObject({
      operator: z.enum(["ends_with", "contains"]),
      value: discoveryExpression,
    }),
  ]),
  { io: "input" },
);

export function resolveDiscoveryArguments(
  tool: string,
  raw: Record<string, unknown>,
  inputs: Record<string, unknown>,
  declared: Record<string, unknown>,
) {
  if (["finish_task", "request_human"].includes(tool))
    return { resolved: raw, rowMatch: undefined };
  const checkRowShape = (criteria: unknown) => {
    if (
      !criteria ||
      typeof criteria !== "object" ||
      Array.isArray(criteria) ||
      !Object.keys(criteria).length ||
      Object.keys(criteria).some((key) => !Object.hasOwn(declared, key))
    )
      throw new SafeError(
        "ROW_MATCH_INVALID",
        `row_match must map declared input names to binding objects. Valid keys: ${Object.keys(declared).join(", ")}. Do not put operator/value at the top level.`,
      );
    for (const [key, criterion] of Object.entries(
      criteria as Record<string, any>,
    )) {
      const ref = criterion?.operator ? criterion.value : criterion;
      if (
        !ref ||
        typeof ref !== "object" ||
        ref.kind !== "input" ||
        ref.path !== key ||
        Object.keys(ref).some((k) => !["kind", "path"].includes(k))
      )
        throw new SafeError(
          "UNBOUND_INPUT_ARGUMENT",
          `UNBOUND_INPUT_ARGUMENT: row_match.${key} must use {"kind":"input","path":"${key}"}, optionally inside {"operator":"contains" or "ends_with","value":...}. Observed literals are not allowed, even with different spelling. If this input does not match the row, omit that criterion only when other bound criteria uniquely identify it.`,
        );
    }
  };
  if (raw?.row_match) checkRowShape(raw.row_match);
  if (tool === "extract_data" && Array.isArray(raw?.fields))
    for (const field of raw.fields)
      if (field.row_match) checkRowShape(field.row_match);
  const resolve = (value: any): any => {
    if (Array.isArray(value)) return value.map(resolve);
    if (!value || typeof value !== "object") return value;
    if (["input", "template", "literal"].includes(value.kind)) {
      const expression = discoveryExpression.parse(value);
      const check = (part: any) => {
        if (part?.kind === "input" && !Object.hasOwn(declared, part.path))
          throw Error("UNDECLARED_INPUT");
        if (part?.kind === "template") part.parts.forEach(check);
      };
      check(expression);
      return resolveBindings(expression, inputs, {}, { base_url: "" });
    }
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolve(v)]),
    );
  };
  const resolved = resolve(raw);
  if (
    tool === "type_text" &&
    typeof raw.text === "string" &&
    raw.text.trimStart().startsWith("{") &&
    /[,{]\s*["']?kind["']?\s*:/.test(raw.text.replace(/\\/g, ""))
  )
    throw new SafeError(
      "INVALID_BINDING_SHAPE",
      'text must be a JSON object, not a string containing JSON. Example: "text":{"kind":"input","path":"input_name"}. Do not quote or escape the object.',
    );
  if (
    tool === "type_text" &&
    ["number", "boolean"].includes(typeof resolved.text)
  )
    resolved.text = String(resolved.text);
  let rowMatch: Record<string, unknown> | undefined;
  if (Object.hasOwn(resolved, "row_match")) {
    if (!["click", "type_text"].includes(tool))
      throw Error("ROW_MATCH_UNSUPPORTED");
    if (
      !resolved.row_match ||
      typeof resolved.row_match !== "object" ||
      Array.isArray(resolved.row_match) ||
      !Object.keys(resolved.row_match).length
    )
      throw Error("ROW_MATCH_INVALID");
    rowMatch = resolved.row_match;
    rowMatch = resolvedRowMatch.parse(rowMatch);
    delete resolved.row_match;
  }
  const fieldRowMatches: (Record<string, unknown> | undefined)[] = [];
  if (tool === "extract_data" && Array.isArray(resolved.fields)) {
    for (const field of resolved.fields) {
      fieldRowMatches.push(
        field.row_match ? resolvedRowMatch.parse(field.row_match) : undefined,
      );
      delete field.row_match;
    }
  }
  return { resolved, rowMatch, fieldRowMatches };
}

export const discoveryExpressionJson = z.toJSONSchema(discoveryExpression, {
  io: "input",
});
