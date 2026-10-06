import { z } from "zod";
export const MAX_LINE = 1024 * 1024;
const common = { protocol_version: z.literal(1), run_id: z.string().uuid() };
export const startSchema = z.strictObject({
  ...common,
  type: z.literal("start"),
  mode: z.enum(["discovery", "replay"]),
  deployment: z
    .object({
      app_deployment_id: z.string(),
      base_url: z.url(),
      product_id: z.string(),
      ui_variant: z.string(),
      vendor_release: z.string().nullable(),
      config_version: z.number().int().positive(),
    })
    .passthrough(),
  task: z.string().nullable(),
  inputs: z.record(z.string(), z.unknown()),
  capability_catalog: z.array(z.unknown()),
  artifact: z.unknown().nullable(),
  assets: z
    .array(
      z.object({
        asset_id: z.string(),
        staged_path: z.string(),
        sha256: z.string(),
      }),
    )
    .default([]),
  staging_directory: z.string(),
  runtime: z.strictObject({
    headless: z.boolean(),
    max_tool_calls: z.number().int().positive(),
    allow_writes: z.boolean(),
    allow_screenshots: z.boolean(),
    path_prefix: z.string().startsWith("/"),
  }),
});
export type StartCommand = z.infer<typeof startSchema>;
export const controlSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...common,
    type: z.literal("ack"),
    message_seq: z.number().int().positive(),
    event_sequence: z.number().int().nonnegative(),
    continue: z.boolean(),
  }),
  z.strictObject({ ...common, type: z.literal("cancel"), reason: z.string() }),
]);
