import { z } from "zod";
import { resolveBindings } from "../replay/bindings.js";

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
