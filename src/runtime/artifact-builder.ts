import {
  parseArtifact,
  type ArtifactDefinition,
} from "../contracts/artifact.js";
import type { DiscoveryProposal } from "../contracts/discovery-proposal.js";
import type { DiscoveryContext } from "./discovery-context.js";
import { assertBoundArguments } from "./discovery-bindings.js";
const literal = (value: any) => ({
  kind: "literal",
  value: structuredClone(value),
});
const argumentBinding = (value: any): any => {
  if (value && typeof value === "object" && value.kind === "input")
    return { kind: "input", path: value.path };
  if (value && typeof value === "object" && value.kind === "template") {
    return { kind: "template", parts: value.parts.map(argumentBinding) };
  }
  if (Array.isArray(value)) return value.map(argumentBinding);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        argumentBinding(nested),
      ]),
    );
  return literal(value);
};
const objectSchema = (values: Record<string, unknown>) => ({
  type: "object" as const,
  properties: Object.fromEntries(Object.keys(values).map((k) => [k, {}])),
  required: Object.keys(values),
  additionalProperties: false as const,
});
/** Build a reusable artifact from recorded actions and explicit bindings. */
export function buildArtifact(
  c: DiscoveryContext,
  goal: string,
  outputs: Record<string, unknown>,
): DiscoveryProposal {
  const steps = c.records.map((record, i) => {
    if (c.metadata) assertBoundArguments(record.tool, record.input, c.inputs);
    const args = Object.fromEntries(
      Object.entries(record.input)
        .filter(
          ([k]) =>
            ![
              "observation_id",
              "target",
              "_durable_fields",
              "recording_hint",
            ].includes(k),
        )
        .map(([k, v]) => [
          k,
          k === "row_match"
            ? Object.fromEntries(
                Object.entries(v as Record<string, unknown>).map(
                  ([key, value]) => [key, argumentBinding(value)],
                ),
              )
            : argumentBinding(v),
        ]),
    );
    if (record.tool === "navigate") {
      const url = new URL(record.input.url, c.deployment.base_url);
      const base = new URL(c.deployment.base_url);
      const path = url.pathname + url.search + url.hash;
      args.url =
        url.origin !== base.origin ||
        path.startsWith("//") ||
        path.includes("..") ||
        path.includes("\\")
          ? literal(url.href)
          : url.href === base.href
            ? ({ kind: "environment", path: "base_url" } as any)
            : ({
                kind: "url",
                base: { kind: "environment", path: "base_url" },
                path,
              } as any);
    }
    if (record.tool === "extract_data") {
      args.fields = record.input.fields.map((f: any) => {
        const target = record.input._durable_fields?.[f.name];
        if (!target) throw Error("RECORDED_EXTRACTION_TARGET_MISSING");
        return { ...f, target: structuredClone(target) };
      });
    }
    if (record.input.target && !record.target)
      throw Error("RECORDED_ACTION_TARGET_MISSING");
    return {
      step_id: `step_${i + 1}`,
      tool: record.tool,
      arguments: args,
      ...(record.target ? { target: structuredClone(record.target) } : {}),
      pre_checks: [],
      post_checks: [],
      recoveries: [],
    };
  });
  if (!steps.length) throw Error("RECORDED_SEQUENCE_MISSING");
  const output_mapping = Object.fromEntries(
    Object.entries(outputs).map(([key, value]) => {
      const index = c.records.findLastIndex(
        (r) =>
          r.tool === "extract_data" &&
          !key.includes(".") &&
          !["__proto__", "constructor", "prototype"].includes(key) &&
          r.result.fields?.[key]?.status === "extracted" &&
          JSON.stringify(r.result.fields[key].value) === JSON.stringify(value),
      );
      return [
        key,
        index < 0
          ? literal(value)
          : {
              kind: "step_output",
              step_id: steps[index]!.step_id,
              path: `fields.${key}.value`,
            },
      ];
    }),
  );
  if (
    c.metadata &&
    Object.keys(c.metadata.input_schema.properties).length &&
    Object.values(output_mapping).some(
      (binding: any) => binding.kind === "literal",
    )
  )
    throw Error("UNBOUND_OUTPUT");
  const last = steps.at(-1)!;
  const definition = parseArtifact({
    surface: "browser",
    compatibility: {
      product_id: c.deployment.product_id,
      ui_variant: c.deployment.ui_variant,
      vendor_release: c.deployment.vendor_release,
    },
    input_schema: c.metadata?.input_schema ?? objectSchema(c.inputs),
    output_schema: objectSchema(outputs),
    entry: { url: { kind: "environment", path: "base_url" }, checks: [] },
    steps,
    success_checks: [
      {
        check_id: "recorded_sequence_completed",
        kind: "tool_status_equals",
        step_id: last.step_id,
        expected: c.records.at(-1)!.result.status,
      },
    ],
    business_outcomes: [],
    output_mapping,
  } as ArtifactDefinition);
  return {
    proposal_version: 1,
    capability_selection: {
      mode: "new",
      name: c.metadata?.name ?? goal,
      description: c.metadata?.description ?? goal,
      reason: "Built from the recorded discovery execution",
      input_schema: definition.input_schema,
      output_schema: definition.output_schema,
    },
    parameter_values: structuredClone(c.inputs),
    observed_outputs: structuredClone(outputs),
    definition,
    reference_assets: structuredClone(c.references),
  };
}
