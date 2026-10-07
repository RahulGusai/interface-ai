import type { TaskContract } from "../runtime/finalization.js";

/** Output contract for the standalone member-search fixture. */
export function syntheticContract(): TaskContract {
  return {
    businessCodes: ["not_found"],
    validateOutputs: (outputs) =>
      Object.keys(outputs).every(
        (key) => key === "member" && typeof outputs[key] === "string",
      ),
  };
}
