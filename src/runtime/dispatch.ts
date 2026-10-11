import {
  accessDecision,
  intrinsicClassification,
  sameHostname,
  violationResponse,
  type AccessPolicy,
} from "./action-policy.js";
import { parseToolAction, type ToolResponse } from "../contracts/tools.js";
import type { ToolCall } from "../contracts/run.js";
import type { BrowserAdapterPort } from "../adapters/surface.js";
import { requestIntervention } from "./intervention.js";
import { finalize, type TaskContract } from "./finalization.js";
import { validateToolResponse } from "./tool-response.js";
import { toolValidationMessage } from "./validation-feedback.js";
import { executeTool } from "../tools/registry.js";
import { assessmentOf, requiresReview } from "../contracts/execution.js";
import type { ReviewHandler } from "./human-review.js";
import { SafeError } from "../contracts/errors.js";
import { untilPolicyBreach } from "./action-policy.js";
export type DispatchContext = {
  adapter: BrowserAdapterPort;
  review?: ReviewHandler;
  signal?: AbortSignal;
  accessPolicy?: AccessPolicy;
  allowedHostname?: string;
  contract?: TaskContract;
  busy: boolean;
  halted: boolean;
  interventionId?: string;
};
export async function dispatchTool(
  context: DispatchContext,
  call: ToolCall,
): Promise<ToolResponse> {
  let action;
  let execution: unknown;
  try {
    const raw = JSON.parse(call.argumentsJson);
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw Error("Invalid input");
    const { execution: proposed, ...input } = raw;
    execution = proposed;
    action = parseToolAction(call.name, input);
  } catch (error) {
    return {
      result: {
        status: "error",
        code: "INVALID_TOOL_CALL",
        message: toolValidationMessage(error),
      },
    };
  }
  const pendingViolation = context.adapter.policyViolation?.();
  if (pendingViolation) {
    context.halted = true;
    return violationResponse(pendingViolation);
  }
  if (context.busy || context.halted)
    return {
      result: {
        status: "needs_intervention",
        code: "EXECUTION_HALTED",
        message: "Autonomous execution is unavailable",
      },
    };
  if (
    "observation_id" in action.input &&
    !context.adapter.isCurrentObservation(action.input.observation_id)
  )
    return {
      result: {
        status: "error",
        code: "STALE_OBSERVATION",
        message: "Observe again before using this reference",
      },
    };
  context.busy = true;
  try {
    const policy = context.accessPolicy ?? "READ_ONLY";
    if (
      action.name === "navigate" &&
      (!context.allowedHostname ||
        !sameHostname(action.input.url, context.allowedHostname))
    ) {
      context.halted = true;
      return violationResponse({
        code: "DOMAIN_POLICY_VIOLATION",
        access_policy: policy,
        category: "unknown",
        reason: "Page navigation must remain on the deployment hostname",
        dispatch_state: "not_dispatched",
      });
    }
    const classification = intrinsicClassification(action) ??
      (action.name !== "finish_task" && action.name !== "request_human"
        ? await context.adapter.classifyAction?.(action)
        : undefined) ?? {
        category: "unknown" as const,
        reason: "No trusted rule for the current action and target",
      };
    const violation = accessDecision(policy, classification);
    if (violation && policy === "READ_ONLY") {
      context.halted = true;
      return violationResponse(violation);
    }
    let reviewed = false;
    if (
      policy === "READ_WRITE" &&
      (requiresReview(execution) || action.name === "request_human")
    ) {
      if (!context.review || !context.adapter.reviewSnapshot)
        throw new SafeError(
          "HUMAN_REVIEW_UNAVAILABLE",
          "Human review is not configured",
        );
      const signals = [context.signal, context.adapter.policySignal].filter(
        (s): s is AbortSignal => !!s,
      );
      const signal = signals.length ? AbortSignal.any(signals) : undefined;
      let snapshot = await context.adapter.reviewSnapshot(action);
      for (;;) {
        signal?.throwIfAborted();
        const decision = await untilPolicyBreach(signal, () =>
          context.review!(
            {
              ...snapshot,
              call_id: call.id,
              tool: action.name,
              arguments: action.input as Record<string, unknown>,
              assessment: assessmentOf(execution),
            },
            signal,
          ),
        );
        signal?.throwIfAborted();
        if (decision.status !== "approved")
          throw new SafeError(
            `HUMAN_REVIEW_${decision.status.toUpperCase()}`,
            `Human review ${decision.status}`,
          );
        const fresh = await context.adapter.reviewSnapshot(action);
        if (fresh.fingerprint === snapshot.fingerprint) break;
        snapshot = fresh;
      }
      reviewed = true;
    }
    context.signal?.throwIfAborted();
    const pending = context.adapter.policyViolation?.();
    if (pending) {
      context.halted = true;
      return violationResponse(pending);
    }
    if (
      policy === "READ_WRITE" &&
      action.name !== "finish_task" &&
      action.name !== "request_human"
    )
      context.adapter.authorizeReadWrite?.(action);
    const response: ToolResponse =
      action.name === "request_human"
        ? {
            result: reviewed
              ? { status: "approved" as const }
              : requestIntervention(context),
          }
        : action.name === "finish_task"
          ? {
              result: finalize(action.input, context.contract ?? {}),
            }
          : await executeTool(context.adapter, action);
    if (response.result.status === "policy_blocked") context.halted = true;
    const after = context.adapter.policyViolation?.();
    if (after) {
      context.halted = true;
      return violationResponse(after);
    }
    if (
      response.result.status === "needs_intervention" ||
      ("blocker" in response.result &&
        response.result.blocker?.kind === "intervention")
    )
      requestIntervention(context);
    return validateToolResponse(action.name, response);
  } catch (error) {
    context.halted = true;
    const violation = context.adapter.policyViolation?.();
    if (violation) return violationResponse(violation);
    return {
      result: {
        status: "error",
        code: error instanceof SafeError ? error.code : "TOOL_EXECUTION_FAILED",
        message:
          error instanceof SafeError
            ? error.message
            : "Tool failed; execution stopped without retry",
      },
    };
  } finally {
    context.busy = false;
  }
}
