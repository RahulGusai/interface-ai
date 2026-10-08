import { createHash } from "node:crypto";
import type { DurableTarget } from "../contracts/artifact.js";
import type { Capture, Control, Target } from "../contracts/observation.js";
import { resolveBindings } from "./bindings.js";
import { matchTemplate } from "./template-matcher.js";
import { rowMatchesValues } from "../runtime/row-selection.js";
export type BindingContext = {
  inputs: Record<string, unknown>;
  results: Record<string, unknown>;
  environment: { base_url: string };
};
export function semanticMatches(
  target: Extract<DurableTarget, { kind: "semantic" }>,
  capture: Capture,
  c: BindingContext,
): Control[] {
  if (
    capture.observation.status !== "ok" ||
    capture.observation.controls.status !== "available"
  )
    throw Error("CAPTURE_FAILED");
  const name = resolveBindings(target.name, c.inputs, c.results, c.environment);
  if (typeof name !== "string") throw Error("TARGET_NAME_INVALID");
  return capture.observation.controls.items.filter(
    (control) =>
      control.role === target.role &&
      (target.match_by === "text" ? control.text?.trim() : control.name) ===
        name &&
      (!target.scope ||
        target.scope.every((scope, index) => {
          const actual = control.ancestry?.[index];
          return (
            actual?.role === scope.role &&
            actual?.name === scope.name &&
            (!scope.frame ||
              (control.frame?.name === scope.frame.name &&
                control.frame?.url_path === scope.frame.url_path))
          );
        })),
  );
}
export function resolveTarget(
  target: DurableTarget,
  capture: Capture,
  assets: ReadonlyMap<string, Buffer>,
  c: BindingContext,
  rowMatch?: Record<string, unknown>,
): { target?: Target; diagnosis: Record<string, unknown> } {
  let candidates: any[] = [];
  try {
    if (capture.observation.status !== "ok") throw Error("CAPTURE_FAILED");
    if (target.kind === "row_action") {
      if (
        !rowMatch ||
        !Object.keys(rowMatch).length ||
        capture.observation.controls.status !== "available"
      )
        throw Error("ROW_MATCH_REQUIRED");
      const selection = resolveBindings(
        rowMatch,
        c.inputs,
        c.results,
        c.environment,
      );
      const controls = capture.observation.controls.items;
      const rows = controls.filter(
        (row) =>
          row.role === target.row_role &&
          (!target.scope ||
            target.scope.every(
              (scope, index) =>
                row.ancestry?.[index]?.role === scope.role &&
                row.ancestry?.[index]?.name === scope.name,
            )) &&
          rowMatchesValues(row, controls, selection),
      );
      if (rows.length !== 1) {
        return {
          diagnosis: {
            verdict: "failed",
            reason: rows.length ? "TARGET_AMBIGUOUS" : "TARGET_NOT_FOUND",
            target,
            candidates: rows,
            required_matches: 1,
            observed: { count: rows.length },
          },
        };
      }
      candidates = rows.flatMap((row) =>
        controls.filter(
          (control) =>
            control.parent_ref === row.ref &&
            control.role === target.action_role &&
            (target.action_text
              ? control.text?.trim() === target.action_text
              : control.name === target.action_name),
        ),
      );
      if (candidates.length === 1)
        return {
          target: { kind: "control", control_ref: candidates[0].ref },
          diagnosis: {
            verdict: "resolved",
            target,
            candidates,
            required_matches: 1,
            observed: { count: 1 },
          },
        };
    } else if (target.kind === "semantic") {
      candidates = semanticMatches(target, capture, c);
      if (candidates.length === 1)
        return {
          target: { kind: "control", control_ref: candidates[0].ref },
          diagnosis: {
            verdict: "resolved",
            target,
            candidates,
            required_matches: 1,
            expected: {
              role: target.role,
              name: resolveBindings(
                target.name,
                c.inputs,
                c.results,
                c.environment,
              ),
            },
            observed: { count: 1 },
          },
        };
    } else {
      const bytes = assets.get(target.asset_id);
      if (
        !bytes ||
        createHash("sha256").update(bytes).digest("hex") !== target.sha256
      )
        throw Error("REFERENCE_HASH_MISMATCH");
      const obs = capture.observation;
      if (obs.screenshot.status !== "available" || !capture.image)
        throw Error("CAPTURE_FAILED");
      if (
        obs.screenshot.width !== target.capture_context.viewport_width ||
        obs.screenshot.height !== target.capture_context.viewport_height
      )
        throw Error("CAPTURE_CONTEXT_MISMATCH");
      candidates = matchTemplate(
        Buffer.from(capture.image.bytes),
        bytes,
        target.threshold,
      );
      if (candidates.length === 1) {
        const m = candidates[0];
        return {
          target: {
            kind: "point",
            x: m.left + target.relative_point.u * m.width,
            y: m.top + target.relative_point.v * m.height,
          },
          diagnosis: {
            verdict: "resolved",
            target,
            candidates,
            required_matches: 1,
            score: m.score,
            threshold: target.threshold,
            expected: target.capture_context,
            observed: {
              width: obs.screenshot.width,
              height: obs.screenshot.height,
            },
          },
        };
      }
    }
    return {
      diagnosis: {
        verdict: "failed",
        reason: candidates.length ? "TARGET_AMBIGUOUS" : "TARGET_NOT_FOUND",
        candidates,
        required_matches: 1,
        target,
        expected: { count: 1 },
        observed: { count: candidates.length },
      },
    };
  } catch (error) {
    return {
      diagnosis: {
        verdict: "failed",
        reason:
          error instanceof Error ? error.message : "TARGET_RESOLUTION_FAILED",
        candidates,
        required_matches: 1,
        target,
        expected: { count: 1 },
        observed: { count: candidates.length },
      },
    };
  }
}
