import type { FinishTaskInput } from "../contracts/finish-task.draft.js";
export type TaskContract = {
  validateOutputs?: (outputs: Record<string, unknown>) => boolean;
  businessCodes?: string[];
};
export function finalize(input: FinishTaskInput, _contract: TaskContract) {
  return { status: "accepted" as const, outcome: input.outcome };
}
