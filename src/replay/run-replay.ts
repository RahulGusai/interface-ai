import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  parseArtifact,
  validateValues,
  type ArtifactDefinition,
} from "../contracts/artifact.js";
import type { StartCommand } from "../bridge/protocol.js";
import { stagingPath } from "../bridge/staging.js";
import type {
  BrowserAdapterFactory,
  BrowserAdapterPort,
} from "../adapters/surface.js";
import { dispatchTool, type DispatchContext } from "../runtime/dispatch.js";
import { parseToolAction } from "../contracts/tools.js";
import type { Capture, ImageContent } from "../contracts/observation.js";
import { resolveBindings } from "./bindings.js";
import { resolveTarget, type BindingContext } from "./targets.js";
import { evaluateCheck } from "./checks.js";
export type ReplayAudit = (
  type: string,
  payload: Record<string, unknown>,
  image?: ImageContent,
  step_id?: string | null,
) => Promise<void>;
export type ReplayResult = {
  status: "success" | "expected_outcome" | "hard_failure" | "cancelled";
  code: string;
  message: string;
  outputs: Record<string, unknown> | null;
  failure_stage: "readiness" | "execution" | null;
  step_id: string | null;
  expected: unknown;
  observed: unknown;
  dispatch_state: "not_dispatched" | "completed" | "uncertain";
};
export async function runReplay(
  command: Pick<
    StartCommand,
    "artifact" | "inputs" | "deployment" | "assets" | "staging_directory"
  >,
  deps: { adapterFactory: BrowserAdapterFactory },
  options: { signal?: AbortSignal; onAudit: ReplayAudit },
): Promise<ReplayResult> {
  let adapter: BrowserAdapterPort | undefined;
  let stepId: string | null = null;
  let dispatchState: ReplayResult["dispatch_state"] = "not_dispatched";
  let stage: ReplayResult["failure_stage"] = "readiness";
  let definition: ArtifactDefinition;
  const outcome = (
    status: ReplayResult["status"],
    code: string,
    message: string,
    outputs: Record<string, unknown> | null = null,
    expected: unknown = null,
    observed: unknown = null,
  ): ReplayResult => ({
    status,
    code,
    message,
    outputs,
    failure_stage: status === "hard_failure" ? stage : null,
    step_id: stepId,
    expected,
    observed,
    dispatch_state: dispatchState,
  });
  const audit = options.onAudit,
    assets = new Map<string, Buffer>();
  try {
    options.signal?.throwIfAborted();
    const artifact = command.artifact as any;
    definition = parseArtifact(artifact.definition);
    const inputs = validateValues(definition.input_schema, command.inputs),
      results: Record<string, unknown> = {};
    const c: BindingContext = {
      inputs,
      results,
      environment: { base_url: command.deployment.base_url },
    };
    const meta = definition.compatibility;
    if (
      meta.product_id !== command.deployment.product_id ||
      meta.ui_variant !== command.deployment.ui_variant ||
      meta.vendor_release !== command.deployment.vendor_release
    )
      throw Error("ARTIFACT_INCOMPATIBLE");
    for (const a of command.assets) {
      const bytes = await readFile(
        stagingPath(command.staging_directory, a.staged_path),
      );
      if (createHash("sha256").update(bytes).digest("hex") !== a.sha256)
        throw Error("REFERENCE_HASH_MISMATCH");
      assets.set(a.asset_id, bytes);
    }
    adapter = await deps.adapterFactory.createForTask({
      goal: "Execute pinned artifact",
      targetUrl: command.deployment.base_url,
    });
    const context: DispatchContext = {
      adapter,
      busy: false,
      halted: false,
    };
    const execute = async (tool: string, args: any, id: string | null) => {
      options.signal?.throwIfAborted();
      const call = {
        id: randomUUID(),
        name: tool,
        argumentsJson: JSON.stringify(args),
      };
      parseToolAction(tool, args);
      await audit(
        "tool_started",
        {
          call_id: call.id,
          tool,
          input: args,
          dispatch_state: "not_dispatched",
        },
        undefined,
        id,
      );
      options.signal?.throwIfAborted();
      dispatchState = "uncertain";
      const response = await dispatchTool(context, call);
      dispatchState = [
        "completed",
        "ok",
        "evaluated",
        "condition_met",
      ].includes(response.result.status)
        ? "completed"
        : "uncertain";
      await audit(
        "tool_finished",
        {
          call_id: call.id,
          tool,
          result: response.result,
          dispatch_state: dispatchState,
        },
        response.image,
        id,
      );
      return response;
    };
    const fresh = () => adapter!.capture("both");
    const checkAll = async (
      checks: any[],
      id: string | null,
      capture?: Capture,
    ) => {
      const shot = capture ?? (await fresh());
      const verdicts = [];
      for (const check of checks) {
        const verdict = evaluateCheck(check, shot, c, id ?? undefined);
        await audit("check_finished", { ...verdict }, shot.image, id);
        verdicts.push(verdict);
      }
      return verdicts;
    };
    const entry = await execute(
      "navigate",
      {
        url: resolveBindings(
          definition.entry.url,
          inputs,
          results,
          c.environment,
        ),
      },
      null,
    );
    if (entry.result.status !== "completed")
      throw Error("ENTRY_NAVIGATION_FAILED");
    if (
      (await checkAll(definition.entry.checks, null)).some(
        (v) => v.verdict !== "pass",
      )
    )
      throw Error("ENTRY_CHECK_FAILED");
    stage = "execution";
    const step = async (s: any): Promise<void> => {
      stepId = s.step_id;
      dispatchState = "not_dispatched";
      options.signal?.throwIfAborted();
      const withRecovery = async (checks: any[]) => {
        for (const check of checks) {
          let verdict = (await checkAll([check], s.step_id))[0]!;
          const recovery = (s.recoveries ?? []).find(
            (r: any) => r.on_check_id === check.check_id,
          );
          if (verdict.verdict !== "pass" && recovery) {
            for (
              let attempt = 1;
              attempt <= recovery.max_attempts && verdict.verdict !== "pass";
              attempt++
            ) {
              options.signal?.throwIfAborted();
              await audit(
                "recovery_started",
                {
                  kind: "recoverable",
                  code: "CHECK_RECOVERY",
                  message: "Applying saved bounded recovery",
                  recovery_id: recovery.recovery_id,
                  attempt,
                  max_attempts: recovery.max_attempts,
                },
                undefined,
                s.step_id,
              );
              if (recovery.kind === "wait") {
                await new Promise((r) => setTimeout(r, recovery.delay_ms));
              } else {
                await step(recovery.step);
                if (
                  (
                    await checkAll(recovery.then_checks, recovery.step.step_id)
                  ).some((v) => v.verdict !== "pass")
                )
                  throw Error("RECOVERY_CHECK_FAILED");
                stepId = s.step_id;
              }
              verdict = (await checkAll([check], s.step_id))[0]!;
            }
          }
          if (verdict.verdict !== "pass") throw Error("CHECK_FAILED");
        }
      };
      await withRecovery(s.pre_checks);
      let capture = await fresh();
      if (capture.observation.status !== "ok") throw Error("CAPTURE_FAILED");
      const resolve = async (
        saved: any,
        rowMatch?: Record<string, unknown>,
      ) => {
        const r = resolveTarget(saved, capture, assets, c, rowMatch);
        await audit(
          "target_resolution_finished",
          r.diagnosis,
          capture.image,
          s.step_id,
        );
        if (!r.target) throw Error(String(r.diagnosis.reason));
        return r.target;
      };
      let args: any;
      // Extraction targets are durable descriptions rather than raw tool refs.
      if (s.tool === "extract_data") {
        args = { fields: [] };
        for (const field of s.arguments.fields) {
          const { target, row_match, ...fieldArguments } = field;
          args.fields.push({
            ...resolveBindings(
              fieldArguments,
              inputs,
              results,
              c.environment,
            ),
            target: await resolve(target, row_match),
          });
        }
      } else {
        args = resolveBindings(s.arguments, inputs, results, c.environment);
        if (
          s.tool === "type_text" &&
          ["number", "boolean"].includes(typeof args.text)
        )
          args.text = String(args.text);
        if (s.target) {
          const rowMatch = s.arguments.row_match;
          const r = resolveTarget(s.target, capture, assets, c, rowMatch);
          await audit(
            "target_resolution_finished",
            r.diagnosis,
            capture.image,
            s.step_id,
          );
          if (!r.target) throw Error(String(r.diagnosis.reason));
          args.target = r.target;
        }
        delete args.row_match;
      }
      if (s.tool !== "navigate" && s.tool !== "observe_ui")
        args.observation_id = capture.observation.observation_id;
      const response = await execute(s.tool, args, s.step_id);
      results[s.step_id] = response.result;
      if (
        !["completed", "ok", "evaluated", "condition_met"].includes(
          response.result.status,
        ) ||
        (response.result.status === "evaluated" &&
          "verdict" in response.result &&
          response.result.verdict !== "pass")
      )
        throw Error("TOOL_DID_NOT_COMPLETE");
      await withRecovery(s.post_checks);
    };
    for (const s of definition.steps) {
      await step(s);
      const possible = definition.business_outcomes.filter(
        (b) => b.after_step_id === s.step_id,
      );
      const capture = await fresh();
      const matches = [];
      for (const b of possible) {
        if (
          (await checkAll(b.checks, s.step_id, capture)).every(
            (v) => v.verdict === "pass",
          )
        )
          matches.push(b);
      }
      if (matches.length > 1) throw Error("RESULT_AMBIGUOUS");
      if (matches.length === 1) {
        const b = matches[0]!;
        const success = await checkAll(
          definition.success_checks,
          s.step_id,
          capture,
        );
        if (success.every((v) => v.verdict === "pass"))
          throw Error("RESULT_AMBIGUOUS");
        return outcome(
          "expected_outcome",
          b.code,
          b.message,
          resolveBindings(b.output_mapping, inputs, results, c.environment),
        );
      }
    }
    if (
      (await checkAll(definition.success_checks, stepId)).some(
        (v) => v.verdict !== "pass",
      )
    )
      throw Error("SUCCESS_CHECK_FAILED");
    const outputs = validateValues(
      definition.output_schema,
      resolveBindings(
        definition.output_mapping,
        inputs,
        results,
        c.environment,
      ),
    );
    return outcome(
      "success",
      "GOAL_ACHIEVED",
      "Saved flow completed with verified checks",
      outputs,
    );
  } catch (error) {
    if (options.signal?.aborted)
      return outcome("cancelled", "USER_CANCELLED", "Execution cancelled");
    return outcome(
      "hard_failure",
      error instanceof Error ? error.message : "REPLAY_FAILED",
      "Saved flow could not be verified",
    );
  } finally {
    if (adapter) await adapter.close().catch(() => {});
  }
}
