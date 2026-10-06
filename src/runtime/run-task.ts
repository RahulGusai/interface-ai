import {
  agentTurnSchema,
  runResultSchema,
  type RunResult,
  type RunEvent,
  type TaskInput,
} from "../contracts/run.js";
import { finishTaskInput } from "../contracts/finish-task.draft.js";
import type { BrowserAdapterFactory } from "../adapters/surface.js";
import type { ModelClient } from "../llm/model-client.js";
import type { RuntimePolicy } from "./policy.js";
import { parseTaskInput, maxToolCalls } from "./config.js";
import { ConversationHistory } from "./history.js";
import { buildInitialMessages } from "./prompts.js";
import type { AuditSink } from "./audit.js";
import { dispatchTool, type DispatchContext } from "./dispatch.js";
import {
  toolDefinitions,
  toolSchemas,
  type ToolResponse,
} from "../contracts/tools.js";
export type TaskRunContext = DispatchContext & {
  history: ConversationHistory;
  maxToolCalls: number;
  toolCallsUsed: number;
};
export type RunDependencies = {
  model: ModelClient;
  adapterFactory: BrowserAdapterFactory;
  policy: RuntimePolicy;
};
export async function runTask(
  raw: unknown,
  deps: RunDependencies,
  options: {
    maxToolCalls?: number;
    onEvent?: (event: RunEvent) => void;
    onAudit?: AuditSink;
    signal?: AbortSignal;
  } = {},
): Promise<RunResult> {
  const input: TaskInput = parseTaskInput(raw);
  const budget = maxToolCalls(options.maxToolCalls);
  let used = 0;
  let context: TaskRunContext | undefined;
  let modelTurn = 0;
  let remainingProposals: import("../contracts/run.js").ToolCall[] = [];
  let auditFailed = false;
  const audit: AuditSink = async (record, image) => {
    if (auditFailed) throw new Error("Audit unavailable");
    try {
      await options.onAudit?.(deps.policy.sanitize(record), image);
    } catch (error) {
      auditFailed = true;
      throw error;
    }
  };
  const invoke = async (
    call: import("../contracts/run.js").ToolCall,
    source: "bootstrap" | "model",
  ) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(call.argumentsJson);
    } catch {
      parsed = null;
    }
    await audit({ type: "tool_started", modelTurn, call, input: parsed, source });
    const started = performance.now();
    options.signal?.throwIfAborted();
    const response = await dispatchTool(context!, call);
    await audit(
      {
        type: "tool_finished",
        modelTurn,
        call,
        result: response.result,
        elapsedMs: Math.round(performance.now() - started),
      },
      response.image,
    );
    return response;
  };
  // Configured provider slug is deliberately not disclosed through public results/events.
  const result = (
    status: RunResult["status"],
    summary: string,
    extra: Partial<RunResult> = {},
  ): RunResult =>
    runResultSchema.parse(
      deps.policy.sanitize({
        status,
        summary,
        model: "configured-model",
        toolCallsUsed: used,
        ...extra,
      }),
    );
  const emit = (event: RunEvent) => {
    try {
      options.onEvent?.(deps.policy.sanitize(event));
    } catch {
      /* Diagnostic observers cannot control execution. */
    }
  };
  const stop = async (r: RunResult) => {
    if (!auditFailed) {
      if (remainingProposals.length)
        await audit({
          type: "tool_not_executed",
          modelTurn,
          calls: remainingProposals,
          reason: r.status,
        });
      remainingProposals = [];
      await audit({ type: "run_finished", result: r });
    }
    if (r.status === "needs_intervention")
      emit({ type: "intervention_requested", reason: r.summary });
    emit({ type: "stopped", result: r });
    return r;
  };
  const addImage = (response: ToolResponse, id: string) => {
    const r = response.result;
    const obs =
      "observation" in r ? r.observation : r.status === "ok" ? r : undefined;
    if (obs?.status === "ok" && obs.screenshot.status === "available") {
      if (!response.image?.bytes.length) throw new Error("Missing image");
      context!.history.appendObservationImage(
        response.image,
        obs.observation_id,
        id,
      );
    }
  };
  if (
    deps.policy.decide({
      name: "navigate",
      input: { url: input.targetUrl },
    }) !== "allow"
  )
    return await stop(
      result("policy_blocked", "Initial destination denied by trusted policy"),
    );
  emit({ type: "started", targetUrl: input.targetUrl });
  try {
    await audit({
      type: "run_started",
      targetUrl: input.targetUrl,
      goal: input.goal,
      maxToolCalls: budget,
    });
    options.signal?.throwIfAborted();
    const adapter = await deps.adapterFactory.createForTask(input, deps.policy);
    context = {
      adapter,
      policy: deps.policy,
      busy: false,
      halted: false,
      history: new ConversationHistory(buildInitialMessages(input)),
      maxToolCalls: budget,
      toolCallsUsed: 0,
    };
    const bootstrap = await invoke(
      {
        id: "bootstrap",
        name: "navigate",
        argumentsJson: JSON.stringify({ url: input.targetUrl }),
      },
      "bootstrap",
    );
    if (bootstrap.result.status !== "completed")
      return await stop(
        result(
          context.halted
            ? "needs_intervention"
            : bootstrap.result.status === "policy_blocked"
              ? "policy_blocked"
              : "tool_error",
          "Initial navigation did not complete",
        ),
      );
    context.history.appendUserObservation(bootstrap.result);
    addImage(bootstrap, "bootstrap");
    let index = 0;
    while (used < budget) {
      options.signal?.throwIfAborted();
      emit({ type: "model_turn", index: ++index });
      modelTurn = index;
      let turn;
      try {
        turn = agentTurnSchema.parse(
          await deps.model.complete(
            context.history.messages.map((m) =>
              m.role === "observation" ? m : deps.policy.sanitize(m),
            ),
            toolDefinitions,
            {signal:options.signal},
          ),
        );
      } catch {
        return await stop(
          result("provider_error", "Provider request or protocol failed", {
            error: {
              code: "PROVIDER_ERROR",
              message: "Provider request or protocol failed",
            },
          }),
        );
      }
      options.signal?.throwIfAborted();
      if (turn.kind === "final_text") {
        await audit({ type: "model_final_text", modelTurn, text: turn.text });
        return await stop(result("agent_stopped_unverified", turn.text));
      }
      remainingProposals = [...turn.calls];
      await audit({ type: "model_proposed", modelTurn, calls: turn.calls });
      if (turn.calls.length > budget - used)
        return await stop(
          result(
            "max_tool_calls_reached",
            "Proposed batch exceeds remaining tool-call budget",
          ),
        );
      try {
        context.history.appendAssistantToolCalls(turn.assistantMessage);
      } catch {
        return await stop(result("provider_error", "Invalid tool-call history"));
      }
      for (const call of turn.calls) {
        options.signal?.throwIfAborted();
        used++;
        context.toolCallsUsed = used;
        emit({
          type: "tool_requested",
          name: toolDefinitions.some((d) => d.function.name === call.name)
            ? call.name
            : "unknown",
          callId: call.id,
        });
        remainingProposals.shift();
        const response = await invoke(call, "model");
        context.history.appendToolResult(call.id, response.result);
        addImage(response, call.id);
        emit({
          type: "tool_completed",
          name: toolDefinitions.some((d) => d.function.name === call.name)
            ? call.name
            : "unknown",
          callId: call.id,
          status: response.result.status,
        });
        if (
          response.result.status === "policy_blocked" ||
          ("blocker" in response.result &&
            response.result.blocker?.kind === "policy")
        )
          return await stop(
            result("policy_blocked", "Action denied by trusted policy"),
          );
        if (context.halted || response.result.status === "needs_intervention")
          return await stop(
            result(
              response.result.status === "error"
                ? "tool_error"
                : "needs_intervention",
              call.name === "request_human" &&
                response.result.status === "requested"
                ? toolSchemas.request_human.parse(
                    JSON.parse(call.argumentsJson),
                  ).message
                : "blocker" in response.result && response.result.blocker
                  ? response.result.blocker.message
                  : "Autonomous execution stopped",
            ),
          );
        if (
          call.name === "finish_task" &&
          (response.result.status === "accepted" ||
            (response.result.status === "rejected" &&
              response.result.code === "ARTIFACT_INTEGRATION_REQUIRED"))
        ) {
          const proposed = finishTaskInput.parse(
            JSON.parse(call.argumentsJson),
          );
          return await stop(
            result(
              proposed.outcome === "goal_achieved"
                ? "awaiting_artifact_design"
                : proposed.outcome,
              proposed.summary,
              { proposedOutcome: proposed, outputs: proposed.outputs },
            ),
          );
        }
      }
    }
    return await stop(result("max_tool_calls_reached", "Tool-call budget exhausted"));
  } catch {
    return await stop(
      result("tool_error", "Browser execution or observation failed", {
        error: {
          code: "RUNTIME_ERROR",
          message: "Browser execution or observation failed",
        },
      }),
    );
  } finally {
    if (context) await context.adapter.close().catch(() => {});
  }
}
