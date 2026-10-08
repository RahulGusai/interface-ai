import { z } from "zod";
import { flatSchema, validateValues } from "../contracts/artifact.js";

export const capabilityMetadataSchema = z.strictObject({
  name: z.string().trim().min(3).max(100),
  description: z.string().trim().min(3).max(500),
  input_schema: flatSchema,
  example_inputs: z.record(
    z.string(),
    z.union([z.string(), z.number().finite(), z.boolean()]),
  ),
});
export type CapabilityMetadata = z.infer<typeof capabilityMetadataSchema>;

export function parseCapabilityMetadata(value: unknown): CapabilityMetadata {
  const metadata = capabilityMetadataSchema.parse(value);
  validateValues(metadata.input_schema, metadata.example_inputs);
  return metadata;
}
