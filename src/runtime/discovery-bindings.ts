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
      `UNBOUND_INPUT_ARGUMENT: ${invalid} contains a variable example value. Use {kind:"input",path:"input_name"} or a template with the names in capability_metadata.input_schema; keep fixed values plain.`,
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
export const discoveryExpression = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  input,
  template,
]);

export function resolveDiscoveryArguments(
  tool: string,
  raw: Record<string, unknown>,
  inputs: Record<string, unknown>,
  declared: Record<string, unknown>,
) {
  if (["finish_task", "request_human"].includes(tool))
    return { resolved: raw, rowMatch: undefined };
  const resolve = (value: any): any => {
    if (Array.isArray(value)) return value.map(resolve);
    if (!value || typeof value !== "object") return value;
    if (value.kind === "input" || value.kind === "template") {
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
    for (const value of Object.values(rowMatch!))
      if (!["string", "number", "boolean"].includes(typeof value))
        throw Error("ROW_MATCH_INVALID");
    delete resolved.row_match;
  }
  return { resolved, rowMatch };
}

export const discoveryExpressionJson = z.toJSONSchema(discoveryExpression, {
  io: "input",
});
