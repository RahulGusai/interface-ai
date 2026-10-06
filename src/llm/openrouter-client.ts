import { z } from "zod";
import type { ModelClient } from "./model-client.js";
import { projectMessages, type InternalMessage } from "../runtime/history.js";
import { agentTurnSchema, type AgentTurn } from "../contracts/run.js";
import { SafeError } from "../contracts/errors.js";
import type { toolDefinitions } from "../contracts/tools.js";
const responseSchema = z.object({
  choices: z
    .array(
      z.object({
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
export class OpenRouterClient implements ModelClient {
  readonly model: string;
  constructor(
    private readonly config: { apiKey: string; model: string },
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.model = config.model;
  }
  async complete(
    messages: InternalMessage[],
    tools: typeof toolDefinitions,
  ): Promise<AgentTurn> {
    const projected = projectMessages(messages);
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
            parallel_tool_calls: false,
            stream: false,
          }),
          signal: AbortSignal.timeout(120000),
        },
      );
    } catch {
      throw new SafeError("PROVIDER_TRANSPORT", "Provider transport failed");
    }
    if (!response.ok)
      throw new SafeError(
        "PROVIDER_HTTP",
        `Provider request failed (HTTP ${response.status})`,
      );
    try {
      const m = responseSchema.parse(await response.json()).choices[0]!.message;
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
    } catch {
      throw new SafeError("PROVIDER_PROTOCOL", "Invalid provider response");
    }
  }
}
