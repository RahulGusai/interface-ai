import { z } from "zod";
import { flatSchema, validateValues } from "../contracts/artifact.js";
import { SafeError } from "../contracts/errors.js";

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

// The model supplies examples; the runtime owns JSON Schema syntax and types.
export const capabilityDefinitionSchema = z.strictObject({
  name: capabilityMetadataSchema.shape.name,
  description: capabilityMetadataSchema.shape.description,
  inputs: z.array(
    z.strictObject({
      name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      description: z.string(),
      example: z.union([z.string(), z.number().finite(), z.boolean()]),
    }),
  ),
});

export function buildCapabilityMetadata(value: unknown): CapabilityMetadata {
  const definition = capabilityDefinitionSchema.parse(value);
  if (
    new Set(definition.inputs.map((input) => input.name)).size !==
    definition.inputs.length
  )
    throw new SafeError(
      "CAPABILITY_METADATA_INVALID",
      "Capability metadata contains duplicate input names",
    );
  return parseCapabilityMetadata({
    name: definition.name,
    description: definition.description,
    input_schema: {
      type: "object",
      properties: Object.fromEntries(
        definition.inputs.map((input) => [
          input.name,
          {
            type: typeof input.example,
            description: input.description,
          },
        ]),
      ),
      required: definition.inputs.map((input) => input.name),
      additionalProperties: false,
    },
    example_inputs: Object.fromEntries(
      definition.inputs.map((input) => [input.name, input.example]),
    ),
  });
}

export function capabilityMetadataError(cause: unknown): SafeError {
  if (cause instanceof SafeError) return cause;
  let detail = "generation failed";
  if (cause instanceof SyntaxError) detail = "response was not valid JSON";
  if (cause instanceof z.ZodError) {
    // Never include model values, arbitrary property names, or Zod messages.
    const fields = new Set([
      "name",
      "description",
      "inputs",
      "example",
      "input_schema",
      "example_inputs",
      "properties",
      "required",
      "additionalProperties",
      "type",
    ]);
    const issue = cause.issues[0];
    const path =
      issue?.path
        .map((part) =>
          typeof part === "number"
            ? part
            : fields.has(String(part))
              ? part
              : "[field]",
        )
        .join(".") || "root";
    detail = `failed validation at ${path} (${issue?.code ?? "invalid"})`;
  }
  return new SafeError(
    "CAPABILITY_METADATA_INVALID",
    `Capability metadata ${detail}`,
  );
}

export function parseCapabilityMetadata(value: unknown): CapabilityMetadata {
  const metadata = capabilityMetadataSchema.parse(value);
  validateValues(metadata.input_schema, metadata.example_inputs);
  return metadata;
}
