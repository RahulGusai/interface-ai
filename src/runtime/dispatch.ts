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
export type DispatchContext = {
  adapter: BrowserAdapterPort;
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
  try {
    action = parseToolAction(call.name, JSON.parse(call.argumentsJson));
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
    if (violation) {
      context.halted = true;
      return violationResponse(violation);
    }
    const response: ToolResponse =
      action.name === "request_human"
        ? { result: requestIntervention(context) }
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
  } catch {
    context.halted = true;
    return {
      result: {
        status: "error",
        code: "TOOL_EXECUTION_FAILED",
        message: "Tool failed; execution stopped without retry",
      },
    };
  } finally {
    context.busy = false;
  }
}
