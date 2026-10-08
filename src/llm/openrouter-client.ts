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
            "Provide concise reusable capability metadata and typed example inputs extracted from the task",
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
          content:
            "Define the reusable operation before browser discovery. Extract variable example inputs from the task and include all suppliedInputs. Return each input once with a name, description, and primitive example value. Use strings for identifiers, account numbers or suffixes (preserving leading zeros), dates, and periods; numbers for quantities; booleans for switches. Use concise name and description without example-specific identities. Call define_capability once. Do not invent values missing from the task. The runtime constructs the typed input schema from your examples.",
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
                  tool_choice: {
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
            tool_calls: calls,
          },
        });
      }
      if (typeof m.content !== "string" || !m.content.trim()) throw new Error();
      return agentTurnSchema.parse({
        kind: "final_text",
        text: m.content,
        assistantMessage: { role: "assistant", content: m.content },
      });
    } catch (error) {
      if (error instanceof SafeError) throw error;
      throw new SafeError("PROVIDER_PROTOCOL", "Invalid provider response");
    }
  }
}
