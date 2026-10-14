import { z } from "zod";
import type { ToolAction, ToolResponse } from "../contracts/tools.js";
export const accessPolicySchema = z.enum(["READ_ONLY", "READ_WRITE"]);
export type AccessPolicy = z.infer<typeof accessPolicySchema>;
export type ActionCategory = "read" | "mutation" | "unknown" | "control";
export type Classification = { category: ActionCategory; reason: string };
export type PolicyViolation = {
  code: "ACCESS_POLICY_VIOLATION" | "DOMAIN_POLICY_VIOLATION";
  access_policy: AccessPolicy;
  category: ActionCategory;
  reason: string;
  dispatch_state: "not_dispatched" | "uncertain";
};
export function sameHostname(url: string, hostname: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      parsed.hostname === hostname
    );
  } catch {
    return false;
  }
}
/** Only these operations are intrinsically free of application input events. */
export function intrinsicClassification(
  action: ToolAction,
): Classification | undefined {
  if (["finish_task", "request_human"].includes(action.name))
    return { category: "control", reason: "Runtime control action" };
  if (
    ["observe_ui", "extract_data", "check_ui", "wait_for"].includes(action.name)
  )
    return {
      category: "read",
      reason: "Rendered UI inspection without input events",
    };
  // Navigation is subject to the exact-host gate. Application-specific URL effects
  // still require a trusted rule at the browser boundary.
  return undefined;
}
export function accessDecision(
  policy: AccessPolicy,
  classification: Classification,
): PolicyViolation | undefined {
  if (policy === "READ_ONLY") return;
  if (classification.category === "unknown")
    return {
      code: "ACCESS_POLICY_VIOLATION",
      access_policy: policy,
      ...classification,
      dispatch_state: "not_dispatched",
    };
}
/** Terminal today; this is the single outcome boundary for any future handoff. */
export function violationResponse(violation: PolicyViolation): ToolResponse {
  return {
    result: {
      status: "policy_blocked",
      code: violation.code,
      message: violation.reason,
      policy: violation,
    },
  };
}

/** Race even providers that ignore AbortSignal; remove listeners after settlement. */
export async function untilPolicyBreach<T>(
  signal: AbortSignal | undefined,
  work: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        abort = () => reject(signal?.reason);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      }),
    ]);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
