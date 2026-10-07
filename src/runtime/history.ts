import type { AssistantMessage } from "../contracts/run.js";
import type { ImageContent, Observation } from "../contracts/observation.js";
import type { ToolResult } from "../contracts/tools.js";
import { SafeError } from "../contracts/errors.js";
export type InternalMessage =
  | { role: "system" | "user"; content: string }
  | AssistantMessage
  | { role: "tool"; tool_call_id: string; content: string }
  | {
      role: "observation";
      observationId: string;
      callId: string;
      image: ImageContent;
    };
export class ConversationHistory {
  readonly messages: InternalMessage[];
  private pending: string[] = [];
  private used = new Set<string>();
  constructor(initial: InternalMessage[]) {
    this.messages = [...initial];
  }
  appendAssistantToolCalls(message: AssistantMessage) {
    if (this.pending.length)
      throw new SafeError("HISTORY_PROTOCOL", "Unmatched tool calls");
    const calls = message.tool_calls ?? [];
    if (
      calls.some((x) => this.used.has(x.id)) ||
      new Set(calls.map((x) => x.id)).size !== calls.length
    )
      throw new SafeError("HISTORY_PROTOCOL", "Repeated tool IDs");
    this.pending = calls.map((x) => x.id);
    calls.forEach((x) => this.used.add(x.id));
    this.messages.push(message);
  }
  appendToolResult(id: string, result: ToolResult) {
    if (this.pending[0] !== id)
      throw new SafeError("HISTORY_PROTOCOL", "Unmatched tool result");
    this.pending.shift();
    this.messages.push({
      role: "tool",
      tool_call_id: id,
      content: JSON.stringify(result),
    });
  }
  appendObservationImage(
    image: ImageContent,
    observationId: string,
    callId: string,
  ) {
    this.messages.push({ role: "observation", observationId, callId, image });
  }
  appendUserObservation(result: ToolResult) {
    this.messages.push({
      role: "user",
      content: `UNTRUSTED initial UI observation: ${JSON.stringify(result)}`,
    });
  }
  toOpenRouterMessages() {
    return projectMessages(this.messages);
  }
}
const initialObservationPrefix = "UNTRUSTED initial UI observation: ";
// Provider-only outcomes may omit historical observation payloads. Canonical tool
// results still use the strict ToolResult schemas and retain complete captures.
type HistoricalOutcome<T = ToolResult> = T extends { observation: Observation }
  ? Omit<T, "observation">
  : T extends { status: "ok" }
    ? Pick<T, "status">
    : T;
export type ProviderToolResult = ToolResult | HistoricalOutcome;
function recordedResult(message: InternalMessage): ToolResult | undefined {
  const content =
    message.role === "tool"
      ? message.content
      : message.role === "user" &&
          message.content.startsWith(initialObservationPrefix)
        ? message.content.slice(initialObservationPrefix.length)
        : undefined;
  if (content === undefined) return undefined;
  try {
    return JSON.parse(content) as ToolResult;
  } catch {
    return undefined;
  }
}
function observationOf(
  result: ToolResult | undefined,
): Observation | undefined {
  if (!result) return undefined;
  return "observation" in result
    ? result.observation
    : result.status === "ok"
      ? result
      : undefined;
}
function projectResult(
  result: ToolResult,
  currentObservationId: string | undefined,
): ProviderToolResult {
  const observation = observationOf(result);
  if (!observation) return result;
  if (
    observation.status === "ok" &&
    observation.observation_id === currentObservationId
  )
    return result;
  if ("observation" in result) {
    const { observation: _observation, ...outcome } = result;
    return outcome;
  }
  // A historical observe_ui success has no separate outcome fields. Keep its
  // status to pair the result with the assistant call without retaining UI data.
  return result.status === "ok" ? { status: "ok" } : result;
}
export function projectMessages(messages: InternalMessage[]): unknown[] {
  // Keep the canonical history and audit intact. Only the provider projection drops
  // obsolete captures; durable facts remain in explicit structured tool outcomes.
  let currentObservationId: string | undefined;
  for (const message of messages) {
    if (message.role === "observation")
      currentObservationId = message.observationId;
    else {
      const result = recordedResult(message);
      const observation = observationOf(result);
      if (observation)
        currentObservationId =
          observation.status === "ok" ? observation.observation_id : undefined;
      if (
        result &&
        "code" in result &&
        (result.code === "STALE_OBSERVATION" ||
          result.code === "CAPTURE_FAILED")
      )
        currentObservationId = undefined;
    }
  }
  // Images following tool results are placed after the entire tool batch to preserve provider protocol.
  const output: unknown[] = [];
  let remaining = 0;
  const images: unknown[] = [];
  for (const m of messages) {
    if (m.role === "observation") {
      if (!m.image.bytes?.length)
        throw new SafeError("MISSING_IMAGE", "Missing image bytes");
      if (m.observationId !== currentObservationId) continue;
      const image = {
        role: "user",
        content: [
          {
            type: "text",
            text: `UNTRUSTED UI image; observation_id=${m.observationId}; preceding_call_id=${m.callId}; image_ref=${m.image.ref}`,
          },
          {
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${Buffer.from(m.image.bytes).toString("base64")}`,
            },
          },
        ],
      };
      if (remaining) images.push(image);
      else output.push(image);
    } else if (m.role === "assistant") {
      remaining = m.tool_calls?.length ?? 0;
      output.push({
        role: m.role,
        content: m.content,
        ...(m.tool_calls
          ? {
              tool_calls: m.tool_calls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: c.argumentsJson },
              })),
            }
          : {}),
      });
    } else {
      const recorded = recordedResult(m);
      if (
        m.role === "user" &&
        recorded?.status === "ok" &&
        recorded.observation_id !== currentObservationId
      )
        continue;
      const projected = recorded
        ? projectResult(recorded, currentObservationId)
        : recorded;
      output.push(
        recorded && projected !== recorded
          ? {
              ...m,
              content:
                (m.role === "user" ? initialObservationPrefix : "") +
                JSON.stringify(projected),
            }
          : m,
      );
      if (m.role === "tool") {
        remaining--;
        if (!remaining) output.push(...images.splice(0));
      }
    }
  }
  if (remaining)
    throw new SafeError("HISTORY_PROTOCOL", "Unmatched tool calls");
  return output;
}
