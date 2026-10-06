import { z } from "zod";
import { PNG } from "pngjs";
import { createHash } from "node:crypto";
import type { Capture, Target } from "../contracts/observation.js";
import type { DurableTarget } from "../contracts/artifact.js";
export const recordingHint = z.strictObject({
  visual_reference: z.strictObject({
    rect: z.strictObject({
      left: z.number().int().nonnegative(),
      top: z.number().int().nonnegative(),
      width: z.number().int().min(32),
      height: z.number().int().min(32),
    }),
    relative_point: z.strictObject({
      u: z.number().min(0).lt(1),
      v: z.number().min(0).lt(1),
    }),
    description: z.string().min(1),
  }),
});
export function recordDurableTarget(
  target: Target,
  capture: Capture,
  hint?: unknown,
): {
  target: DurableTarget;
  crop?: Buffer;
  provenance?: Record<string, unknown>;
} {
  const observation = capture.observation;
  if (observation.status !== "ok") throw Error("REFERENCE_CAPTURE_REQUIRED");
  if (target.kind === "control") {
    if (observation.controls.status !== "available")
      throw Error("REFERENCE_CAPTURE_REQUIRED");
    const control = observation.controls.items.find(
      (c) => c.ref === target.control_ref,
    );
    if (!control) throw Error("STALE_REFERENCE");
    const scope = control.ancestry?.length
      ? control.ancestry.map((a, index) => ({
          ...a,
          ...(index === 0 && control.frame ? { frame: control.frame } : {}),
        }))
      : null;
    return {
      target: {
        kind: "semantic",
        role: control.role,
        name: { kind: "literal", value: control.name },
        exact: true,
        scope,
        required_matches: 1,
      },
    };
  }
  if (!hint) throw Error("REFERENCE_BOUNDS_REQUIRED");
  const reference = recordingHint.parse(hint).visual_reference;
  if (
    !capture.image ||
    observation.screenshot.status !== "available" ||
    capture.image.ref !== observation.screenshot.image_ref
  )
    throw Error("REFERENCE_CAPTURE_REQUIRED");
  const png = PNG.sync.read(Buffer.from(capture.image.bytes));
  const r = reference.rect,
    p = reference.relative_point;
  if (
    r.left + r.width > png.width ||
    r.top + r.height > png.height ||
    target.x < r.left ||
    target.y < r.top ||
    target.x >= r.left + r.width ||
    target.y >= r.top + r.height ||
    Math.abs(target.x - (r.left + p.u * r.width)) > 1 ||
    Math.abs(target.y - (r.top + p.v * r.height)) > 1
  )
    throw Error("REFERENCE_BOUNDS_INVALID");
  const crop = new PNG({ width: r.width, height: r.height });
  PNG.bitblt(png, crop, r.left, r.top, r.width, r.height, 0, 0);
  const bytes = PNG.sync.write(crop);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const context = {
    viewport_width: 1280,
    viewport_height: 800,
    device_scale_factor: 1,
    image_scale: "css",
    color_space: "srgb",
  } as const;
  if (png.width !== 1280 || png.height !== 800)
    throw Error("REFERENCE_CONTEXT_INVALID");
  return {
    target: {
      kind: "visual",
      asset_id: "pending-" + sha,
      sha256: sha,
      matcher: "rgb-template-v1",
      threshold: 0.95,
      required_matches: 1,
      relative_point: p,
      capture_context: context,
    },
    crop: bytes,
    provenance: {
      crop_rect: r,
      relative_point: p,
      capture_context: context,
      observation_id: observation.observation_id,
      image_ref: capture.image.ref,
    },
  };
}
