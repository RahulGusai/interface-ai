import type { DiscoveryContext } from "./discovery-context.js";
import { isDeepStrictEqual } from "node:util";
import { buildArtifact } from "./artifact-builder.js";
import { recordDurableTarget, recordingHint } from "./target-recorder.js";
import type { Capture } from "../contracts/observation.js";
import { SafeError } from "../contracts/errors.js";
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
import type { TaskContract } from "./finalization.js";
import { parseTaskInput, maxToolCalls } from "./config.js";
import { ConversationHistory } from "./history.js";
import { toolValidationMessage } from "./validation-feedback.js";
import { buildInitialMessages, DISCOVERY_PROMPT } from "./prompts.js";
import type { AuditSink } from "./audit.js";
import { dispatchTool, type DispatchContext } from "./dispatch.js";
import {
  parseCapabilityMetadata,
  capabilityMetadataError,
} from "./capability-metadata.js";
import { validateValues } from "../contracts/artifact.js";
import {
  discoveryExpressionJson,
  resolveDiscoveryArguments,
  assertBoundArguments,
  rowCriterionJson,
} from "./discovery-bindings.js";
import {
  toolDefinitions,
  toolSchemas,
  parseToolAction,
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
  contract?: TaskContract;
};
export async function runTask(
  raw: unknown,
  deps: RunDependencies,
  options: {
    maxToolCalls?: number;
    onEvent?: (event: RunEvent) => void;
    onAudit?: AuditSink;
    signal?: AbortSignal;
    discovery?: DiscoveryContext;
  } = {},
): Promise<RunResult> {
  const input: TaskInput = parseTaskInput(raw);
  const contract = deps.contract ?? {};
  const budget = maxToolCalls(options.maxToolCalls);
  let used = 0;
  let context: TaskRunContext | undefined;
  let modelTurn = 0;
  let remainingProposals: import("../contracts/run.js").ToolCall[] = [];
  let auditFailed = false;
  let currentCapture: Capture | undefined;
  let rejectedExtraction: unknown;
  const getDefinitions = () =>
    options.discovery
      ? toolDefinitions.map((d) => {
          const name = d.function.name;
          const original = (d.function.parameters as any).properties;
          const properties: Record<string, any> = { ...original };
          if (["click", "type_text", "scroll"].includes(name))
            properties.recording_hint = recordingHint.toJSONSchema();
          const refs = Object.keys(
            options.discovery!.metadata?.input_schema.properties ?? {},
          ).map((path) => ({ kind: "input", path }));
          const expression = {
            ...discoveryExpressionJson,
            description: `Variable task values MUST use input references, never their example literals. Available references: ${JSON.stringify(refs)}. Templates may combine references with fixed text. Plain values are only for fixed constants.`,
          };
          if (name === "type_text") properties.text = expression;
          if (["click", "type_text"].includes(name))
            properties.row_match = {
              type: "object",
              minProperties: 1,
              additionalProperties: rowCriterionJson,
            };
          if (name === "select_option")
            properties.option = {
              ...original.option,
              properties: {
                ...original.option.properties,
                label: expression,
              },
            };
          if (["check_ui", "wait_for"].includes(name))
            properties.condition = {
              oneOf: original.condition.oneOf.map((variant: any) =>
                variant.properties.expected
                  ? {
                      ...variant,
                      properties: {
                        ...variant.properties,
                        expected: expression,
                      },
                    }
                  : variant,
              ),
            };
          if (name === "press_key")
            properties.keys = {
              ...original.keys,
              items: expression,
            };
          if (name === "extract_data")
            properties.fields = {
              ...original.fields,
              items: {
                ...original.fields.items,
                properties: {
                  ...original.fields.items.properties,
                  row_match: {
                    type: "object",
                    minProperties: 1,
                    additionalProperties: rowCriterionJson,
                    description:
                      "Bind identifying row criteria to inputs. For a ranked result, first sort/filter the table in the UI and omit row_match to retain its visible row position.",
                  },
                },
              },
            };
          return {
            ...d,
            function: {
              ...d.function,
              parameters: { ...d.function.parameters, properties },
            },
          };
        })
      : toolDefinitions;
  const audit: AuditSink = async (record, image) => {
    if (auditFailed) throw new Error("Audit unavailable");
    try {
      await options.onAudit?.(record, image);
    } catch (error) {
      auditFailed = true;
      throw error;
    }
  };
  const invoke = async (
    call: import("../contracts/run.js").ToolCall,
    source: "bootstrap" | "model",
  ) => {
    let parsed: any;
    let recordedTarget: any;
    let hint: any;
    let resolved: any;
    let rowMatch: Record<string, unknown> | undefined;
    let fieldRowMatches: (Record<string, unknown> | undefined)[] | undefined;
    let preflight: ToolResponse | undefined;
    try {
      parsed = JSON.parse(call.argumentsJson);
    } catch {
      parsed = null;
    }
    if (options.discovery) {
      if (parsed && typeof parsed === "object") {
        hint = parsed.recording_hint;
        delete parsed.recording_hint;
      }
      try {
        ({ resolved, rowMatch, fieldRowMatches } = resolveDiscoveryArguments(
          call.name,
          parsed,
          options.discovery.inputs,
          options.discovery.metadata?.input_schema.properties ?? {},
        ));
        const action = parseToolAction(call.name, resolved);
        if (options.discovery.metadata)
          assertBoundArguments(call.name, parsed, options.discovery.inputs);
        if (action.name === "finish_task") parsed = action.input;
        if (
          "observation_id" in action.input &&
          (!context!.adapter.isCurrentObservation(
            action.input.observation_id,
          ) ||
            (("target" in action.input || action.name === "extract_data") &&
              (!currentCapture ||
                currentCapture.observation.status !== "ok" ||
                action.input.observation_id !==
                  currentCapture.observation.observation_id)))
        )
          preflight = {
            result: {
              status: "error",
              code: "STALE_OBSERVATION",
              message: "Observe again before using this reference",
            },
          };
      } catch (error) {
        preflight = {
          result: {
            status: "error",
            code: error instanceof SafeError ? error.code : "INVALID_TOOL_CALL",
            message: toolValidationMessage(error),
          },
        };
      }
      if (!preflight && parsed.target) {
        try {
          if (
            !currentCapture ||
            currentCapture.observation.status !== "ok" ||
            parsed.observation_id !== currentCapture.observation.observation_id
          )
            throw Error("REFERENCE_CAPTURE_REQUIRED");
          const recorded = recordDurableTarget(
            parsed.target,
            currentCapture,
            hint,
            rowMatch,
            options.discovery.inputs,
          );
          recordedTarget = recorded.target;
          if (recorded.crop) {
            await options.discovery.recordReference?.(
              recorded,
              recorded.crop,
              currentCapture,
              call.id,
            );
          }
        } catch (error) {
          preflight = {
            result: {
              status: "error",
              code:
                error instanceof SafeError ? error.code : "INVALID_TOOL_CALL",
              message: toolValidationMessage(error),
            },
          };
        }
      }
      if (!preflight && call.name === "extract_data") {
        let fieldIndex = 0;
        try {
          if (!currentCapture) throw Error("REFERENCE_CAPTURE_REQUIRED");
          parsed._durable_fields = Object.fromEntries(
            parsed.fields.map((f: any, index: number) => {
              fieldIndex = index;
              return [
                f.name,
                recordDurableTarget(
                  f.target,
                  currentCapture!,
                  undefined,
                  fieldRowMatches?.[index],
                  options.discovery!.inputs,
                ).target,
              ];
            }),
          );
        } catch (error) {
          preflight = {
            result: {
              status: "error",
              code:
                error instanceof SafeError ? error.code : "INVALID_TOOL_CALL",
              message: `fields.${fieldIndex}.target: ${toolValidationMessage(error)}`,
            },
          };
        }
      }
    }
    const normalized = { ...(resolved ?? parsed) };
    delete normalized._durable_fields;
    // A repeated input-dependent target on the same observation cannot become
    // reusable through retry. Give correction feedback once, then stop the loop.
    if (
      call.name === "extract_data" &&
      preflight?.result.status === "error" &&
      preflight.result.code === "TARGET_DEPENDS_ON_INPUT"
    ) {
      if (isDeepStrictEqual(rejectedExtraction, normalized)) {
        preflight = {
          result: {
            status: "error",
            code: "REPEATED_INVALID_EXTRACTION",
            message: `Stopped an unchanged rejected extraction. ${preflight.result.message}`,
          },
        };
      }
      rejectedExtraction = structuredClone(normalized);
    } else {
      rejectedExtraction = undefined;
    }
    const dispatchedCall = {
      ...call,
      argumentsJson: JSON.stringify(normalized),
    };
    await audit({
      type: "tool_started",
      modelTurn,
      call,
      input: normalized,
      source,
      ...({
        proposed_input: parsed ? JSON.parse(call.argumentsJson) : null,
        durable_target: recordedTarget,
        durable_fields: parsed?._durable_fields,
      } as any),
    });
    const started = performance.now();
    options.signal?.throwIfAborted();
    const response =
      preflight ?? (await dispatchTool(context!, dispatchedCall));
    const observation =
      "observation" in response.result
        ? response.result.observation
        : response.result.status === "ok"
          ? response.result
          : undefined;
    if (observation) currentCapture = { observation, image: response.image };
    if (
      options.discovery &&
      !preflight &&
      !["finish_task", "request_human"].includes(call.name)
    )
      options.discovery.records.push({
        call_id: call.id,
        tool: call.name,
        input: parsed,
        target: recordedTarget,
        result: response.result,
      });
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
    runResultSchema.parse({
      status,
      summary,
      model: "configured-model",
      toolCallsUsed: used,
      ...extra,
    });
  const emit = (event: RunEvent) => {
    try {
      options.onEvent?.(event);
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
  emit({ type: "started", targetUrl: input.targetUrl });
  try {
    await audit({
      type: "run_started",
      targetUrl: input.targetUrl,
      goal: input.goal,
      maxToolCalls: budget,
    });
    options.signal?.throwIfAborted();
    if (options.discovery) {
      const metadataStarted = performance.now();
      try {
        if (!options.discovery!.metadata) {
          if (!deps.model.generateCapability)
            throw Error("METADATA_GENERATOR_UNAVAILABLE");
          options.discovery!.metadata = parseCapabilityMetadata(
            await deps.model.generateCapability(
              input.goal,
              options.discovery!.inputs,
              { signal: options.signal },
            ),
          );
        }
        options.discovery!.inputs = validateValues(
          options.discovery!.metadata.input_schema,
          {
            ...options.discovery!.metadata.example_inputs,
            ...options.discovery!.inputs,
          },
        );
      } catch (cause) {
        options.signal?.throwIfAborted();
        const failure = capabilityMetadataError(cause);
        const error = { code: failure.code, message: failure.message };
        await audit({
          type: "provider_failed",
          modelTurn: 0,
          stage: "capability_metadata",
          error,
          elapsedMs: Math.round(performance.now() - metadataStarted),
        });
        return await stop(result("provider_error", error.message, { error }));
      }
      await audit({
        type: "capability_metadata_generated",
        metadata: options.discovery.metadata!,
        inputs: options.discovery.inputs,
      });
    }
    const adapter = await deps.adapterFactory.createForTask(input);
    context = {
      adapter,
      contract,
      busy: false,
      halted: false,
      history: new ConversationHistory(buildInitialMessages(input)),
      maxToolCalls: budget,
      toolCallsUsed: 0,
    };
    if (options.discovery) {
      const system = context.history.messages[0];
      if (system?.role !== "system") throw Error("SYSTEM_PROMPT_REQUIRED");
      system.content +=
        "\n\n" +
        DISCOVERY_PROMPT +
        "\nUse these exact input references for variable values:\n" +
        JSON.stringify(
          Object.entries(options.discovery.inputs).map(([path, example]) => ({
            example,
            reference: { kind: "input", path },
          })),
        ) +
        "\nDiscovery context:\n" +
        JSON.stringify({
          deployment: options.discovery.deployment,
          capability_catalog: options.discovery.capability_catalog,
          capability_metadata: options.discovery.metadata,
          requested_inputs: options.discovery.inputs,
        });
    }
    const definitions = getDefinitions();
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
          context.halted ? "needs_intervention" : "tool_error",
          "Initial navigation did not complete",
        ),
      );
    context.history.appendUserObservation(bootstrap.result);
    addImage(bootstrap, "bootstrap");
    let index = 0;
    while (used < budget) {
      options.signal?.throwIfAborted();
      if (options.discovery?.references.length)
        context.history.messages.push({
          role: "system",
          content: JSON.stringify({
            reference_assets: options.discovery.references.map(
              ({ asset_handle, sha256, capture_context, relative_point }) => ({
                asset_handle,
                sha256,
                capture_context,
                relative_point,
              }),
            ),
          }),
        });
      emit({ type: "model_turn", index: ++index });
      modelTurn = index;
      let turn;
      const providerStarted = performance.now();
      try {
        turn = agentTurnSchema.parse(
          await deps.model.complete(
            context.history.messages.map((m) => m),
            definitions,
            {
              signal: options.signal,
              ...(options.discovery ? { toolChoice: "required" } : {}),
            },
          ),
        );
      } catch (cause) {
        options.signal?.throwIfAborted();
        const error =
          cause instanceof SafeError
            ? { code: cause.code, message: cause.message }
            : {
                code: "PROVIDER_ERROR",
                message: "Provider request or protocol failed",
              };
        await audit({
          type: "provider_failed",
          modelTurn,
          error,
          elapsedMs: Math.round(performance.now() - providerStarted),
        });
        return await stop(
          result("provider_error", error.message, {
            error,
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
        return await stop(
          result("provider_error", "Invalid tool-call history"),
        );
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
          response.result.status === "error" &&
          response.result.code === "REPEATED_INVALID_EXTRACTION"
        )
          return await stop(
            result("tool_error", response.result.message, {
              error: {
                code: response.result.code,
                message: response.result.message,
              },
            }),
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
          response.result.status === "accepted"
        ) {
          const proposed = finishTaskInput.parse(
            JSON.parse(call.argumentsJson),
          );
          if (proposed.outcome === "goal_achieved" && options.discovery) {
            try {
              options.discovery.artifact = buildArtifact(
                options.discovery,
                input.goal,
                proposed.outputs!,
              );
            } catch {
              return await stop(
                result("tool_error", "Runtime artifact construction failed", {
                  error: {
                    code: "ARTIFACT_BUILD_FAILED",
                    message: "Runtime artifact construction failed",
                  },
                }),
              );
            }
          }
          return await stop(
            result(proposed.outcome, proposed.summary, {
              proposedOutcome: proposed,
              outputs: proposed.outputs,
            }),
          );
        }
      }
    }
    return await stop(
      result("max_tool_calls_reached", "Tool-call budget exhausted"),
    );
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
