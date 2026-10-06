import { z } from "zod";
export const controlTarget = z.strictObject({
  kind: z.literal("control"),
  control_ref: z.string().min(1),
});
export const pointTarget = z.strictObject({
  kind: z.literal("point"),
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
});
export const target = z.discriminatedUnion("kind", [
  controlTarget,
  pointTarget,
]);
export const controlSchema = z.strictObject({
  ref: z.string(),
  parent_ref: z.string().optional(),
  role: z.string(),
  name: z.string(),
  state: z.strictObject({
    enabled: z.boolean().optional(),
    focused: z.boolean().optional(),
    checked: z.boolean().optional(),
    expanded: z.boolean().optional(),
  }),
  value: z.string().optional(),
  text: z.string().optional(),
  ancestry: z
    .array(
      z.strictObject({
        role: z.string(),
        name: z.string(),
        exact: z.literal(true),
      }),
    )
    .optional(),
  frame: z.strictObject({ name: z.string(), url_path: z.string() }).optional(),
});
export const observationSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ok"),
    observation_id: z.string(),
    captured_at: z.iso.datetime(),
    surface: z.strictObject({
      id: z.string(),
      kind: z.enum(["browser", "desktop"]),
      title: z.string(),
      url: z.string().optional(),
    }),
    screenshot: z.union([
      z.strictObject({
        status: z.literal("available"),
        image_ref: z.string(),
        width: z.number().positive(),
        height: z.number().positive(),
      }),
      z.strictObject({ status: z.enum(["unavailable", "not_requested"]) }),
    ]),
    controls: z.union([
      z.strictObject({
        status: z.literal("available"),
        items: z.array(controlSchema),
      }),
      z.strictObject({ status: z.enum(["unavailable", "not_requested"]) }),
    ]),
  }),
  z.strictObject({
    status: z.literal("error"),
    code: z.enum(["SURFACE_UNAVAILABLE", "CAPTURE_FAILED"]),
    message: z.string(),
    retryable: z.boolean(),
  }),
]);
export type Observation = z.infer<typeof observationSchema>;
export type Control = z.infer<typeof controlSchema>;
export type Target = z.infer<typeof target>;
export type ControlTarget = z.infer<typeof controlTarget>;
export type ImageContent = {
  ref: string;
  mimeType: "image/png";
  bytes: Uint8Array;
};
export type Capture = { observation: Observation; image?: ImageContent };
