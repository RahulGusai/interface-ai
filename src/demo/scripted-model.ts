import type { AgentTurn } from "../contracts/run.js";
import type { InternalMessage } from "../runtime/history.js";
import type { Observation } from "../contracts/observation.js";
import type { ModelClient } from "../llm/model-client.js";
export function lastObservation(
  messages: InternalMessage[],
): Extract<Observation, { status: "ok" }> {
  for (const m of [...messages].reverse()) {
    if (m.role === "tool" || m.role === "user") {
      try {
        const json = JSON.parse(
          m.content.replace(/^UNTRUSTED initial UI observation: /, ""),
        );
        const o = json.observation ?? json;
        if (o.status === "ok") return o;
      } catch {
        /* skip task prose */
      }
    }
  }
  throw new Error("No observation");
}
export function scriptedModel(): ModelClient {
  let step = 0;
  return {
    model: "scripted-fake",
    async complete(messages) {
      const o = lastObservation(messages);
      const items = o.controls.status === "available" ? o.controls.items : [];
      const target = (name: string, role: string) => {
        const c = items.find((c) => c.name === name && c.role === role);
        if (!c) throw new Error("Missing fixture control");
        return { kind: "control", control_ref: c.ref };
      };
      const actions = [
        () => ({
          name: "type_text",
          input: {
            observation_id: o.observation_id,
            target: target("Member ID", "textbox"),
            mode: "replace",
            text: "42",
          },
        }),
        () => ({
          name: "click",
          input: {
            observation_id: o.observation_id,
            target: target("Search", "button"),
          },
        }),
        () => ({
          name: "extract_data",
          input: {
            observation_id: o.observation_id,
            fields: [
              {
                name: "member",
                target: target("Member Ada | 123.50", "status"),
                property: "text",
                output_type: "string",
              },
            ],
          },
        }),
        () => ({
          name: "finish_task",
          input: {
            observation_id: o.observation_id,
            outcome: "goal_achieved",
            summary: "Synthetic member found",
          },
        }),
      ];
      const action = actions[step++]!();
      const calls = [
        {
          id: String(step),
          name: action.name,
          argumentsJson: JSON.stringify(action.input),
        },
      ];
      return {
        kind: "tool_calls",
        calls,
        assistantMessage: {
          role: "assistant",
          content: null,
          tool_calls: calls,
        },
      } satisfies AgentTurn;
    },
  };
}
