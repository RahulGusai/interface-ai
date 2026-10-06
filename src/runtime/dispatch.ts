import { parseToolAction, type ToolResponse } from "../contracts/tools.js";
import type { ToolCall } from "../contracts/run.js";
import type { BrowserAdapterPort } from "../adapters/surface.js";
import type { RuntimePolicy } from "./policy.js";
import { requestIntervention } from "./intervention.js";
import { finalize } from "./finalization.js";
import { executeTool } from "../tools/registry.js";
export type DispatchContext = {
  adapter: BrowserAdapterPort;
  policy: RuntimePolicy;
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
  } catch {
    return {
      result: {
        status: "error",
        code: "INVALID_TOOL_CALL",
        message: "Unknown tool or invalid arguments",
      },
    };
  }
  if (context.busy || context.halted)
    return {
      result: {
        status: "needs_intervention",
        code: "EXECUTION_HALTED",
        message: "Autonomous execution is unavailable",
      },
    };
  const decision = context.policy.decide(action);
  if (decision !== "allow") {
    if (decision === "intervention") requestIntervention(context);
    return {
      result: {
        status: decision === "deny" ? "policy_blocked" : "needs_intervention",
        code: "POLICY_DECISION",
        message: "Trusted policy did not allow this action",
      },
    };
  }
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
    const response: ToolResponse =
      action.name === "request_human"
        ? { result: requestIntervention(context) }
        : action.name === "finish_task"
          ? { result: finalize(action.input, context.policy) }
          : await executeTool(context.adapter, action);
    if (
      response.result.status === "needs_intervention" ||
      ("blocker" in response.result &&
        response.result.blocker?.kind === "intervention")
    )
      requestIntervention(context);
    return context.policy.project(action.name, response);
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
