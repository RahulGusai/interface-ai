import { ZodError } from "zod";

/** Describe contract failures without echoing submitted argument values. */
export function toolValidationMessage(error: unknown): string {
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

const proposalRepairs: Record<string, string> = {
  DURABLE_PLAN_REQUIRED:
    "proposal: required for discovery goal_achieved. Supply proposal_version 1, capability_selection, parameter_values, observed_outputs and definition. A summary and outputs alone cannot complete discovery",
  STALE_ARTIFACT_FIELD:
    "proposal.definition: replace observation_id, control_ref, source/call IDs and fixed coordinates with observed durable semantic or visual targets",
  ABSOLUTE_URL:
    "proposal.definition: replace absolute URLs with environment base_url or a relative url binding",
  UNTRUSTED_ENTRY:
    "proposal.definition.entry.url: use an environment or relative url binding",
  UNTRUSTED_NAVIGATION:
    "proposal.definition.steps.arguments.url: use an environment or relative url binding",
  UNDECLARED_INPUT:
    "proposal.definition: input bindings must name declared input_schema properties",
  FORWARD_STEP_OUTPUT:
    "proposal.definition: step_output bindings must refer to earlier steps",
  DUPLICATE_STEP: "proposal.definition.steps: supply unique step_id values",
  DUPLICATE_CHECK: "proposal.definition: supply unique check_id values",
  FORWARD_CHECK:
    "proposal.definition: checks must reference steps already executed",
  UNKNOWN_RECOVERY_CHECK:
    "proposal.definition.steps.recoveries: on_check_id must name this step's pre/post check",
  UNKNOWN_BUSINESS_STEP:
    "proposal.definition.business_outcomes: after_step_id must name an existing step",
  OUTPUT_MAPPING_INVALID:
    "proposal.definition.output_mapping: map every output_schema field using a binding object",
  SCHEMA_UNSUPPORTED:
    "proposal: schema required fields must be declared and unique",
  INPUT_CONTRACT_INVALID:
    "proposal.parameter_values/observed_outputs: correct field names, types and required values to match the declared schemas",
  CAPABILITY_UNKNOWN:
    "proposal.capability_selection.capability_id: select an existing catalog capability or declare a new capability",
  CAPABILITY_SCHEMA_DRIFT:
    "proposal.definition.input_schema/output_schema: match the selected capability's contract exactly",
  EXPLICIT_INPUT_CONFLICT:
    "proposal.parameter_values: match the explicitly requested inputs",
  ARTIFACT_INCOMPATIBLE:
    "proposal.definition.compatibility: match the deployment product_id, ui_variant and vendor_release",
  UNOBSERVED_PLAN_STEP:
    "proposal.definition.steps: use the tools actually observed, in execution order",
  UNOBSERVED_PLAN_ARGUMENT:
    "proposal.definition.steps.arguments: resolved arguments must match the observed action inputs",
  UNOBSERVED_PLAN_TARGET:
    "proposal.definition.steps: use the observed durable target for each action/extracted field",
  UNVERIFIED_DISCOVERY_TOOL:
    "proposal.definition.steps: only verified successful actions can support the plan",
  UNRECORDED_MUTATION:
    "proposal.definition.steps: include every observed mutation in execution order",
  DISCOVERY_CHECK_FAILED:
    "proposal.definition.success_checks: correct the checks or gather fresh evidence; all must pass on the current capture",
  DISCOVERY_OUTPUT_MISMATCH:
    "proposal.definition.output_mapping/observed_outputs: bind outputs to the correct extracted step fields; resolved values must match observed_outputs exactly",
  BINDING_UNAVAILABLE:
    "proposal.definition: binding path is unavailable; use an existing input or extracted step field, such as fields.current_balance.value",
  URL_ORIGIN_INVALID:
    "proposal.definition: url bindings must remain relative to environment base_url",
  TEMPLATE_PRIMITIVE_REQUIRED:
    "proposal.definition: template parts must resolve to primitive values",
  CAPTURE_FAILED:
    "proposal: obtain a fresh observation before verifying success checks",
};
export function proposalValidationMessage(error: unknown): string {
  const detail =
    error instanceof ZodError
      ? toolValidationMessage(error)
      : error instanceof Error && Object.hasOwn(proposalRepairs, error.message)
        ? `${error.message}: ${proposalRepairs[error.message]}.`
        : "proposal: verification failed. Supply an observed plan with valid inputs, targets, output bindings and fresh success checks.";
  return `${detail} Repair the proposal and resubmit it with outputs matching observed_outputs. Do not remove the proposal or repeat unchanged completion arguments.`;
}
