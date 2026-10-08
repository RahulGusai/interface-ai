import { z } from "zod";
import { PNG } from "pngjs";
import { createHash } from "node:crypto";
import type { Capture, Target } from "../contracts/observation.js";
import type { DurableTarget } from "../contracts/artifact.js";
import { rowMatchesValues } from "./row-selection.js";
import { SafeError } from "../contracts/errors.js";
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
  rowMatch?: Record<string, unknown>,
  variableInputs?: Record<string, unknown>,
): {
  target: DurableTarget;
  crop?: Buffer;
  provenance?: Record<string, unknown>;
} {
  const observation = capture.observation;
  if (observation.status !== "ok") throw Error("REFERENCE_CAPTURE_REQUIRED");
  if (rowMatch && Object.keys(rowMatch).length && target.kind !== "control")
    throw Error("ROW_ACTION_UNSUPPORTED");
  if (target.kind === "control") {
    if (observation.controls.status !== "available")
      throw Error("REFERENCE_CAPTURE_REQUIRED");
    const controls = observation.controls.items;
    const control = controls.find((c) => c.ref === target.control_ref);
    if (!control) throw Error("STALE_REFERENCE");
    const inputValues = Object.values(variableInputs ?? {})
      .filter(
        (v) =>
          ["string", "number", "boolean"].includes(typeof v) &&
          String(v).length > 0,
      )
      .map((value) => String(value).toLowerCase());
    const stableAncestry = (ancestry: typeof control.ancestry) => {
      if (!ancestry) return null;
      const dynamicAt = ancestry.findIndex((a) =>
        inputValues.some((value) => a.name.toLowerCase().includes(value)),
      );
      return dynamicAt < 0 ? ancestry : ancestry.slice(0, dynamicAt);
    };
    if (rowMatch && Object.keys(rowMatch).length) {
      const row = controls.find(
        (item) => item.ref === control.parent_ref && item.role === "row",
      );
      if (!row) throw Error("ROW_ACTION_UNSUPPORTED");
      const matchingRows = controls.filter(
        (item) =>
          item.role === "row" && rowMatchesValues(item, controls, rowMatch),
      );
      if (matchingRows.length > 1) throw Error("ROW_SELECTION_AMBIGUOUS");
      if (matchingRows.length !== 1 || matchingRows[0]?.ref !== row.ref)
        throw Error("ROW_SELECTION_MISMATCH");
      const actionText = control.text?.trim();
      const actionName = actionText ? undefined : control.name;
      if (!actionText && !actionName) throw Error("ROW_ACTION_UNSUPPORTED");
      if (
        actionText &&
        Object.values(rowMatch).some((v) => actionText.includes(String(v)))
      )
        throw Error("ROW_ACTION_UNSUPPORTED");
      if (
        actionName &&
        Object.values(rowMatch).some((v) => actionName.includes(String(v)))
      )
        throw Error("ROW_ACTION_UNSUPPORTED");
      const matchingActions = controls.filter(
        (item) =>
          item.parent_ref === row.ref &&
          item.role === control.role &&
          (actionText
            ? item.text?.trim() === actionText
            : item.name === actionName),
      );
      if (matchingActions.length !== 1) throw Error("ROW_ACTION_AMBIGUOUS");
      return {
        target: {
          kind: "row_action",
          row_role: "row",
          action_role: control.role,
          ...(actionText
            ? { action_text: actionText }
            : { action_name: actionName }),
          scope: stableAncestry(row.ancestry),
          required_matches: 1,
        },
      };
    }
    const scope = stableAncestry(control.ancestry)?.length
      ? stableAncestry(control.ancestry)!.map((a, index) => ({
          ...a,
          ...(index === 0 && control.frame && !inputValues.length
            ? { frame: control.frame }
            : {}),
        }))
      : null;
    const visibleText = control.text?.trim();
    const useText =
      ["link", "button"].includes(control.role) &&
      !!visibleText &&
      visibleText !== control.name;
    const stableName = useText ? visibleText : control.name;
    if (inputValues.some((v) => stableName.toLowerCase().includes(v)))
      throw new SafeError(
        "TARGET_DEPENDS_ON_INPUT",
        "TARGET_DEPENDS_ON_INPUT: this target is identified by an example input value. Select a source control with a stable label. If no reusable source is available, finish_task with unable_to_complete; do not repeat this target.",
      );
    return {
      target: {
        kind: "semantic",
        role: control.role,
        name: { kind: "literal", value: stableName },
        ...(useText ? { match_by: "text" as const } : {}),
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
