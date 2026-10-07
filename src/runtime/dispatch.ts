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
    const response: ToolResponse =
      action.name === "request_human"
        ? { result: requestIntervention(context) }
        : action.name === "finish_task"
          ? {
              result: finalize(action.input, context.contract ?? {}),
            }
          : await executeTool(context.adapter, action);
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
