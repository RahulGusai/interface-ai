import { createHash, randomUUID } from "node:crypto";
import type { BrowserAdapterPort } from "../adapters/surface.js";
import type { DurableTarget } from "../contracts/artifact.js";
import type { Capture, Control, Target } from "../contracts/observation.js";
import { assessmentOf } from "../contracts/execution.js";
import { untilPolicyBreach } from "../runtime/action-policy.js";
import type { ReviewHandler, TargetBounds } from "../runtime/human-review.js";
import { resolveTarget, type BindingContext } from "./targets.js";

type Spec = { target: DurableTarget; rowMatch?: Record<string, unknown> };
type Choice = { target: Target; label: string; bounds: TargetBounds };
function compatible(tool: string, control: Control): boolean {
  if (
    ["click", "type_text", "select_option", "press_key"].includes(tool) &&
    control.state.enabled === false
  )
    return false;
  if (tool === "click")
    return [
      "button",
      "link",
      "checkbox",
      "radio",
      "switch",
      "option",
      "menuitem",
      "tab",
      "treeitem",
    ].includes(control.role);
  if (tool === "type_text")
    return ["textbox", "combobox", "spinbutton"].includes(control.role);
  if (tool === "select_option")
    return ["combobox", "listbox"].includes(control.role);
  return true;
}
function fingerprint(capture: Capture, choices: Choice[][]): string {
  const o = capture.observation;
  if (o.status !== "ok") throw Error("CAPTURE_FAILED");
  const controls = o.controls.status === "available" ? o.controls.items : [];
  const refs = new Map(controls.map((c, i) => [c.ref, i]));
  return createHash("sha256")
    .update(
      JSON.stringify({
        surface: o.surface,
        screenshot:
          o.screenshot.status === "available"
            ? { width: o.screenshot.width, height: o.screenshot.height }
            : null,
        controls: controls.map(({ ref, parent_ref, ...c }) => ({
          ...c,
          parent: parent_ref ? refs.get(parent_ref) : null,
        })),
        choices: choices.map((items) =>
          items.map(({ label, bounds }) => ({ label, bounds })),
        ),
      }),
    )
    .update(capture.image?.bytes ?? new Uint8Array())
    .digest("hex");
}
function validBounds(
  bounds: TargetBounds | null,
  capture: Capture,
): bounds is TargetBounds {
  const o = capture.observation;
  return (
    !!bounds &&
    o.status === "ok" &&
    o.screenshot.status === "available" &&
    Object.values(bounds).every(Number.isFinite) &&
    bounds.x >= 0 &&
    bounds.y >= 0 &&
    bounds.width > 0 &&
    bounds.height > 0 &&
    bounds.x + bounds.width <= o.screenshot.width &&
    bounds.y + bounds.height <= o.screenshot.height
  );
}
async function candidates(
  spec: Spec,
  diagnosis: Record<string, unknown>,
  capture: Capture,
  adapter: BrowserAdapterPort,
  tool: string,
): Promise<Choice[]> {
  const o = capture.observation;
  if (o.status !== "ok") throw Error("CAPTURE_FAILED");
  const offered: Choice[] = [];
  const matches = (diagnosis.candidates as any[]) ?? [];
  if (
    spec.target.kind === "visual" &&
    matches.length &&
    ["click", "type_text", "scroll"].includes(tool)
  ) {
    for (const m of matches) {
      const bounds = { x: m.left, y: m.top, width: m.width, height: m.height };
      if (validBounds(bounds, capture))
        offered.push({
          target: {
            kind: "point",
            x: m.left + spec.target.relative_point.u * m.width,
            y: m.top + spec.target.relative_point.v * m.height,
          },
          label: `Screenshot match ${offered.length + 1}`,
          bounds,
        });
    }
    return offered;
  }
  if (o.controls.status !== "available") return [];
  let controls: Control[];
  if (!matches.length)
    controls = o.controls.items.filter((c) => compatible(tool, c));
  else if (
    spec.target.kind === "row_action" &&
    matches.some((m) => m.role === "row")
  ) {
    const target = spec.target;
    controls = o.controls.items.filter(
      (c) =>
        matches.some((row) => row.ref === c.parent_ref) &&
        c.role === target.action_role &&
        (target.action_text
          ? c.text?.trim() === target.action_text
          : c.name === target.action_name),
    );
  } else controls = matches.filter((m) => typeof m.ref === "string");
  for (const control of controls) {
    // A matched control can be clicked regardless of its semantic role (for
    // example a table cell); missing-target alternatives favor interaction roles.
    if (
      !compatible(tool, control) &&
      !(matches.length && tool === "click" && control.state.enabled !== false)
    )
      continue;
    const target: Target = { kind: "control", control_ref: control.ref };
    const bounds = (await adapter.targetBounds?.(target)) ?? null;
    if (!validBounds(bounds, capture)) continue;
    const context = control.ancestry
      ?.map((c) => c.name)
      .filter(Boolean)
      .join(" / ");
    const label = [
      control.role,
      control.name,
      context,
      control.value,
      control.text !== control.name ? control.text : undefined,
    ]
      .filter(Boolean)
      .join(" — ");
    offered.push({ target, label, bounds });
  }
  return offered;
}
/** Resolve all step targets together so one refreshed capture cannot stale earlier extraction fields. */
export async function resolveStepTargets(options: {
  call_id: string;
  specs: Spec[];
  capture: Capture;
  fresh: () => Promise<Capture>;
  adapter: BrowserAdapterPort;
  assets: ReadonlyMap<string, Buffer>;
  bindings: BindingContext;
  tool: string;
  arguments: Record<string, unknown>;
  execution?: unknown;
  review?: ReviewHandler;
  signal?: AbortSignal;
  audit: (
    diagnosis: Record<string, unknown>,
    capture: Capture,
  ) => Promise<void>;
}): Promise<{ capture: Capture; targets: Target[] }> {
  let capture = options.capture;
  const signals = [
    options.signal,
    options.adapter.policySignal,
    options.adapter.reviewSignal,
  ].filter((s): s is AbortSignal => !!s);
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  const chosen = new Map<number, number>();
  let forceReview: number | undefined;
  let previousReason = "TARGET_NOT_FOUND";
  let rebuilds = 0;
  let pending:
    | { slot: number; index: number; fingerprint: string; refresh: boolean }
    | undefined;
  for (;;) {
    signal?.throwIfAborted();
    const resolutions = options.specs.map((s) =>
      resolveTarget(
        s.target,
        capture,
        options.assets,
        options.bindings,
        s.rowMatch,
      ),
    );
    for (const r of resolutions) {
      await options.audit(r.diagnosis, capture);
      if (
        !r.target &&
        !["TARGET_AMBIGUOUS", "TARGET_NOT_FOUND"].includes(
          String(r.diagnosis.reason),
        )
      )
        throw Error(String(r.diagnosis.reason));
    }
    if (
      !pending &&
      !chosen.size &&
      forceReview === undefined &&
      resolutions.every((r) => r.target)
    )
      return { capture, targets: resolutions.map((r) => r.target!) };
    let choices: Choice[][];
    try {
      choices = await untilPolicyBreach(signal, () =>
        Promise.all(
          resolutions.map((r, i) =>
            candidates(
              options.specs[i]!,
              r.diagnosis,
              capture,
              options.adapter,
              options.tool,
            ),
          ),
        ),
      );
    } catch (error) {
      signal?.throwIfAborted();
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "REVIEW_TARGET_STALE"
      )
        throw error;
      // A detached frame can invalidate the screenshot as well as its bounds.
      // Rebuild the entire step, then offer refresh/reject if it stays unstable.
      if (rebuilds++ < 2) {
        capture = await untilPolicyBreach(signal, options.fresh);
        continue;
      }
      choices = options.specs.map(() => []);
    }
    const currentFingerprint = fingerprint(capture, choices);
    if (pending) {
      if (
        pending.refresh ||
        currentFingerprint !== pending.fingerprint ||
        !choices[pending.slot]?.[pending.index]
      ) {
        chosen.clear();
        forceReview = pending.slot;
      } else {
        chosen.set(pending.slot, pending.index);
        forceReview = undefined;
      }
      pending = undefined;
    }
    const slot = resolutions.findIndex(
      (r, i) => forceReview === i || (!r.target && !chosen.has(i)),
    );
    if (slot < 0)
      return {
        capture,
        targets: resolutions.map(
          (r, i) => r.target ?? choices[i]![chosen.get(i)!]!.target,
        ),
      };
    if (!options.review)
      throw Error(
        String(
          resolutions[slot]!.diagnosis.reason ?? "HUMAN_REVIEW_UNAVAILABLE",
        ),
      );
    const reason = String(
      resolutions[slot]!.diagnosis.reason ?? previousReason,
    );
    const items = choices[slot]!.map((choice) => ({
      ...choice,
      id: randomUUID(),
    }));
    const decision = await untilPolicyBreach(signal, () =>
      options.review!(
        {
          capture,
          fingerprint: currentFingerprint,
          call_id: options.call_id,
          tool: options.tool,
          arguments: options.arguments,
          assessment: assessmentOf(options.execution),
          target_resolution: {
            reason: reason === "TARGET_AMBIGUOUS" ? "ambiguous" : "not_found",
            candidates: items.map(({ id, label, bounds }) => ({
              id,
              label,
              bounds,
            })),
          },
        },
        signal,
      ),
    );
    signal?.throwIfAborted();
    if (decision.status !== "approved")
      throw Error(`HUMAN_REVIEW_${decision.status.toUpperCase()}`);
    const index = items.findIndex(
      (c) => c.id === decision.selected_candidate_id,
    );
    const refresh = decision.refresh_targets === true;
    if (refresh ? decision.selected_candidate_id != null : index < 0)
      throw Error("HUMAN_REVIEW_PROTOCOL_ERROR");
    pending = { slot, index, fingerprint: currentFingerprint, refresh };
    previousReason = reason;
    rebuilds = 0;
    capture = await untilPolicyBreach(signal, options.fresh);
  }
}
