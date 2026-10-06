import { z } from "zod";
import { artifactSchema, flatSchema } from "./artifact.js";
export const capabilitySelection = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("reuse"),
    capability_id: z.string().uuid(),
    reason: z.string().min(1),
  }),
  z.strictObject({
    mode: z.literal("new"),
    name: z.string().min(1),
    description: z.string().min(1),
    reason: z.string().min(1),
    input_schema: flatSchema,
    output_schema: flatSchema,
  }),
]);
export const discoveryProposal = z.strictObject({
  proposal_version: z.literal(1),
  capability_selection: capabilitySelection,
  parameter_values: z.record(z.string(), z.unknown()),
  observed_outputs: z.record(z.string(), z.unknown()),
  definition: artifactSchema,
  reference_assets: z
    .array(
      z.strictObject({
        asset_handle: z.string(),
        staged_path: z.string(),
        sha256: z.string(),
        source_call_id: z.string(),
        crop_rect: z.strictObject({
          left: z.number(),
          top: z.number(),
          width: z.number(),
          height: z.number(),
        }),
        relative_point: z.strictObject({ u: z.number(), v: z.number() }),
        capture_context: z.record(z.string(), z.unknown()),
      }),
    )
    .default([]),
});
export type DiscoveryProposal = z.infer<typeof discoveryProposal>;
