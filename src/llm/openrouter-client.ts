import { z } from "zod";
import type { ModelClient } from "./model-client.js";
import { projectMessages, type InternalMessage } from "../runtime/history.js";
import { agentTurnSchema, type AgentTurn } from "../contracts/run.js";
import { SafeError } from "../contracts/errors.js";
import type { toolDefinitions } from "../contracts/tools.js";
import {
  capabilityDefinitionSchema,
  buildCapabilityMetadata,
  capabilityMetadataError,
} from "../runtime/capability-metadata.js";
const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable().optional(),
        message: z.object({
          content: z.string().nullable().optional(),
          reasoning: z.string().nullable().optional(),
          reasoning_details: z
            .array(z.record(z.string(), z.unknown()))
            .nullable()
            .optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string().min(1),
                type: z.literal("function"),
                function: z.object({
                  name: z.string().min(1),
                  arguments: z.string(),
                }),
              }),
            )
            .min(1)
            .optional(),
        }),
      }),
    )
    .min(1),
});
// Report only documented categories, never provider messages or raw metadata.
const providerErrorTypes = new Set([
  "context_length_exceeded",
  "max_tokens_exceeded",
  "token_limit_exceeded",
  "authentication",
  "permission_denied",
  "payment_required",
  "rate_limit_exceeded",
  "provider_overloaded",
  "provider_unavailable",
  "invalid_request",
  "invalid_prompt",
  "not_found",
  "precondition_failed",
  "payload_too_large",
  "unprocessable",
  "content_policy_violation",
  "refusal",
  "timeout",
  "server",
  "unmapped",
]);
function providerFailure(response: Response, body: unknown): SafeError {
  const error = z
    .object({
      error: z.object({
        code: z.number().int().min(100).max(599).optional(),
        metadata: z.object({ error_type: z.string().optional() }).optional(),
      }),
    })
    .safeParse(body);
  const details = [`HTTP ${response.status}`];
  if (error.success) {
    if (error.data.error.code !== undefined)
      details.push(`provider code ${error.data.error.code}`);
    const type = error.data.error.metadata?.error_type;
    if (type && providerErrorTypes.has(type)) details.push(`type ${type}`);
  }
  return new SafeError(
    "PROVIDER_HTTP",
    `Provider request failed (${details.join("; ")})`,
  );
}
export class OpenRouterClient implements ModelClient {
  readonly model: string;
  constructor(
    private readonly config: { apiKey: string; model: string },
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.model = config.model;
  }
  async generateCapability(
    goal: string,
    suppliedInputs: Record<string, unknown>,
    options: { signal?: AbortSignal } = {},
  ) {
    const tools = [
      {
        type: "function" as const,
        function: {
          name: "define_capability",
          description:
            "Define the reusable operation and only the caller-provided values used to execute it. Requested results are outputs, never inputs.",
          parameters: z.toJSONSchema(capabilityDefinitionSchema, {
            io: "input",
          }),
        },
      },
    ];
    const turn = await this.complete(
      [
        {
          role: "system",
          content: `Define concise reusable capability metadata before browser discovery. Call define_capability once.
An INPUT is a concrete value the caller has supplied to perform the operation, such as a customer name to search for. An OUTPUT is information the caller asks you to find or report, such as the customer's ID or contact details. Requested outputs MUST NOT appear in inputs. Never invent example values, placeholders, identifiers or contact details for information you have been asked to discover.
Use the smallest input list that covers the actual supplied values. Include all suppliedInputs and all explicit identity/search constraints with values stated in the task: names, identifier suffixes, account or product types, branches or other locations, and date boundaries. Do not add a branch, ID, date of birth, or other discriminator merely because the task mentions possible duplicate names. Discovery can request clarification if the supplied values cannot uniquely identify a record. Fixed instructions such as choosing the correct customer, reporting contact details, and not changing records are behavior, not inputs. Preserve that behavior in the capability description; do not replace selecting the correct customer with returning all matching profiles.
Examples:
- "Find Freya Ferreira, making sure you select the correct customer if multiple people share that name. Open their profile and report their customer ID and contact details without changing any records." with suppliedInputs:{} has exactly ONE input: customer_name="Freya Ferreira". Customer ID and contact details are outputs. No invented disambiguation inputs.
- "Find Freya Ferreira at Harbor Street and report their customer ID and contact details." with suppliedInputs:{} has TWO inputs: customer_name="Freya Ferreira", branch="Harbor Street".
- "Find customer C271413 and report their name and email." with suppliedInputs:{} has ONE input: customer_id="C271413". Name and email are outputs.
Return each input once with a name, description, and primitive example value from the task or suppliedInputs. Use strings for identifiers, account numbers or suffixes (preserving leading zeros) and dates; numbers for quantities; booleans for supplied switches. Convert an explicit month/year or date range into start_date and end_date with inclusive YYYY-MM-DD boundaries for UI filters; do not emit a display-period input. Use a concise name and description without example-specific identities. The runtime constructs the typed input schema from your examples.`,
        },
        { role: "user", content: JSON.stringify({ goal, suppliedInputs }) },
      ],
      tools as any,
      { ...options, toolChoice: "define_capability" },
    );
    if (
      turn.kind !== "tool_calls" ||
      turn.calls.length !== 1 ||
      turn.calls[0]?.name !== "define_capability"
    )
      throw new SafeError(
        "PROVIDER_PROTOCOL",
        "Capability metadata was not returned",
      );
    try {
      return buildCapabilityMetadata(JSON.parse(turn.calls[0].argumentsJson));
    } catch (cause) {
      throw capabilityMetadataError(cause);
    }
  }
  async complete(
    messages: InternalMessage[],
    tools: typeof toolDefinitions,
    options: { signal?: AbortSignal; toolChoice?: string } = {},
  ): Promise<AgentTurn> {
    const projected = projectMessages(messages);
    const requestSignal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(120000)])
      : AbortSignal.timeout(120000);
    const checkAbort = (error: unknown) => {
      if (options.signal?.aborted) options.signal.throwIfAborted();
      if (
        (error instanceof Error && error.name === "TimeoutError") ||
        (requestSignal.aborted && requestSignal.reason?.name === "TimeoutError")
      )
        throw new SafeError(
          "PROVIDER_TIMEOUT",
          "Provider request exceeded its 120-second deadline",
        );
    };
    let response: Response;
    try {
      response = await this.fetcher(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.model,
            messages: projected,
            tools,
            ...(options.toolChoice
              ? {
                  tool_choice:
                    options.toolChoice === "required"
                      ? "required"
                      : {
                          type: "function",
                          function: { name: options.toolChoice },
                        },
                }
              : {}),
            parallel_tool_calls: false,
            stream: false,
          }),
          signal: requestSignal,
        },
      );
    } catch (error) {
      checkAbort(error);
      throw new SafeError("PROVIDER_TRANSPORT", "Provider transport failed");
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      checkAbort(error);
      if (!response.ok) throw providerFailure(response, undefined);
      if (error instanceof Error && error.name !== "SyntaxError")
        throw new SafeError(
          "PROVIDER_TRANSPORT",
          "Provider response transport failed",
        );
      throw new SafeError(
        "PROVIDER_PROTOCOL",
        "Provider response was not valid JSON",
      );
    }
    if (!response.ok || (body && typeof body === "object" && "error" in body))
      throw providerFailure(response, body);
    try {
      const choice = responseSchema.parse(body).choices[0]!;
      const m = choice.message;
      // Opaque provider continuation context stays internal; never interpret or display it.
      const reasoning = m.reasoning_details?.length
        ? { reasoning_details: m.reasoning_details }
        : typeof m.reasoning === "string"
          ? { reasoning: m.reasoning }
          : {};
      if (choice.finish_reason === "length")
        throw new SafeError(
          "PROVIDER_OUTPUT_LIMIT",
          "Provider exhausted its output limit without a usable response",
        );
      if (choice.finish_reason === "error")
        throw new SafeError(
          "PROVIDER_GENERATION_FAILED",
          "Provider reported a generation failure",
        );
      if (m.tool_calls) {
        const calls = m.tool_calls.map((c) => ({
          id: c.id,
          name: c.function.name,
          argumentsJson: c.function.arguments,
        }));
        return agentTurnSchema.parse({
          kind: "tool_calls",
          calls,
          assistantMessage: {
            role: "assistant",
            content: m.content ?? null,
            ...reasoning,
            tool_calls: calls,
          },
        });
      }
      if (typeof m.content !== "string" || !m.content.trim())
        throw new SafeError(
          "PROVIDER_EMPTY_RESPONSE",
          "Invalid provider response: neither tool calls nor final text",
        );
      return agentTurnSchema.parse({
        kind: "final_text",
        text: m.content,
        assistantMessage: {
          role: "assistant",
          content: m.content,
          ...reasoning,
        },
      });
    } catch (error) {
      if (error instanceof SafeError) throw error;
      const detail =
        error instanceof z.ZodError
          ? error.issues
              .map(
                (issue) =>
                  `${issue.path.join(".") || "response"} (${issue.code})`,
              )
              .join("; ")
          : "response correspondence";
      throw new SafeError(
        "PROVIDER_PROTOCOL",
        `Invalid provider response: ${detail}`,
      );
    }
  }
}
