import { ZodError } from "zod";
import { SafeError } from "../contracts/errors.js";

/** Describe contract failures without echoing submitted argument values. */
export function toolValidationMessage(error: unknown): string {
  if (error instanceof SafeError) return error.message;
  if (error instanceof ZodError)
    return `Correct these argument fields: ${error.issues
      .map(
        (issue) =>
          `${issue.path.map(String).join(".") || "arguments"}: ${issue.message}`,
      )
      .join(
        "; ",
      )}. Follow the supplied tool schema and resubmit corrected arguments.`;
  if (error instanceof SyntaxError)
    return "arguments: supply valid JSON matching the tool schema.";
  if (error instanceof Error && error.message === "UNKNOWN_TOOL")
    return "name: unknown tool. Use a tool from the supplied definitions.";
  return "arguments: correct the arguments to match the supplied tool schema.";
}
