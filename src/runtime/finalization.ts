import type { FinishTaskInput } from "../contracts/finish-task.draft.js";
import type { RuntimePolicy } from "./policy.js";
export function finalize(input: FinishTaskInput, policy: RuntimePolicy) {
  if (input.outputs && !policy.config.validateOutputs?.(input.outputs))
    return {
      status: "rejected" as const,
      code: "OUTPUT_CONTRACT_MISMATCH",
      message: "Outputs do not match the trusted task contract",
    };
  if (
    input.outcome === "business_outcome" &&
    (!input.outcome_code ||
      !policy.config.businessCodes?.includes(input.outcome_code))
  )
    return {
      status: "rejected" as const,
      code: "UNKNOWN_BUSINESS_OUTCOME",
      message: "Business outcome is not declared by the task contract",
    };
  if (input.outcome === "goal_achieved")
    return {
      status: "rejected" as const,
      code: "ARTIFACT_INTEGRATION_REQUIRED",
      message: "Capability artifact validation and persistence are deferred",
    };
  return { status: "accepted" as const, outcome: input.outcome };
}
