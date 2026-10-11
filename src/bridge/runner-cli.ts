import { randomUUID } from "node:crypto";
import type { DiscoveryContext } from "../runtime/discovery-context.js";
import { createInterface } from "node:readline";
import { startSchema, MAX_LINE } from "./protocol.js";
import { createReviewHandler } from "./review-client.js";
import { Transport } from "./transport.js";
import { stageImage } from "./staging.js";
import { createBrowserFactory } from "../adapters/factory.js";
import { OpenRouterClient } from "../llm/openrouter-client.js";
import { runTask } from "../runtime/run-task.js";
import type { ImageContent } from "../contracts/observation.js";
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const controller = new AbortController();
let transport: Transport | undefined;
let started = false;
lines.on("close", () => transport?.close());
lines.on("line", (line) => {
  try {
    if (Buffer.byteLength(line) > MAX_LINE) throw Error();
    const raw = JSON.parse(line);
    if (started) {
      transport!.control(raw);
      return;
    }
    started = true;
    const command = startSchema.parse(raw);
    transport = new Transport(process.stdout, command.run_id, controller);
    void execute(command).catch(() => {
      controller.abort();
      process.stderr.write(
        "Runner stopped: execution or protocol unavailable.\n",
      );
      process.exitCode = 1;
      lines.close();
    });
  } catch {
    controller.abort();
    process.stderr.write("Runner stopped: invalid protocol.\n");
    process.exitCode = 1;
    lines.close();
  }
});
async function execute(c: ReturnType<typeof startSchema.parse>) {
  await transport!.send("ready");
  const factory = createBrowserFactory({ headless: c.runtime.headless });
  const emit = async (
    type: string,
    payload: Record<string, unknown>,
    image?: ImageContent,
    step_id: string | null = null,
  ) => {
    const assets = image
      ? [
          await stageImage(
            c.staging_directory,
            image,
            type === "target_resolution_finished"
              ? "target_resolution_screenshot"
              : type === "tool_finished"
                ? "post_tool_screenshot"
                : "observation_screenshot",
          ),
        ]
      : [];
    return await transport!.send(
      "event",
      { event: { type, step_id, payload }, assets },
      true,
    );
  };
  const review = c.review
    ? createReviewHandler({
        baseUrl: c.review.api_url,
        runId: c.run_id,
        timeoutMs: c.review.timeout_ms,
        persistSnapshot: async (request) => {
          const ack = (await emit(
            "human_review_snapshot",
            {
              call_id: request.call_id,
              tool: request.tool,
              arguments: request.arguments,
              assessment: request.assessment ?? null,
              state_fingerprint: request.fingerprint,
            },
            request.capture.image,
          )) as { event_sequence: number };
          return ack.event_sequence;
        },
      })
    : undefined;
  let result: any;
  let artifact: any = null;
  if (c.mode === "discovery") {
    const discovery: DiscoveryContext = {
      deployment: c.deployment,
      capability_catalog: c.capability_catalog,
      inputs: c.inputs,
      records: [],
      references: [],
    };
    discovery.recordReference = async (record, crop, capture, callId) => {
      const handle = "ref-" + randomUUID();
      record.target.asset_id = handle;
      const staged = await stageImage(
        c.staging_directory,
        { ref: handle, mimeType: "image/png", bytes: crop },
        "reference_crop",
      );
      const reference = {
        asset_handle: handle,
        staged_path: staged.staged_path,
        sha256: staged.sha256,
        source_call_id: callId,
        ...record.provenance,
      };
      delete reference.observation_id;
      delete reference.image_ref;
      discovery.references.push(reference);
      await emit(
        "target_reference_captured",
        {
          call_id: callId,
          reference: record.provenance,
          asset_handle: handle,
          sha256: staged.sha256,
        },
        capture.image,
      );
    };
    const model = new OpenRouterClient({
      apiKey: process.env.OPENROUTER_API_KEY ?? "",
      model: process.env.OPENROUTER_MODEL ?? "",
    });
    result = await runTask(
      {
        goal: c.task,
        targetUrl: c.deployment.base_url,
        accessPolicy: c.access_policy,
      },
      { model, adapterFactory: factory },
      {
        discovery,
        review,
        signal: controller.signal,
        maxToolCalls: c.runtime.max_tool_calls,
        onAudit: async (record, image) => {
          const payload: any = { ...record };
          delete payload.type;
          if ("call" in record) {
            payload.call_id = record.call.id;
            payload.tool = record.call.name;
            payload.dispatch_state =
              (record.type === "tool_finished" &&
                record.result.status === "policy_blocked" &&
                record.result.policy?.dispatch_state === "not_dispatched") ||
              (record.type === "tool_finished" &&
                record.result.status === "error" &&
                /^(HUMAN_REVIEW_|REVIEW_)/.test(record.result.code)) ||
              record.type === "tool_started"
                ? "not_dispatched"
                : record.type === "tool_finished" &&
                    ["completed", "evaluated", "condition_met"].includes(
                      record.result.status,
                    )
                  ? "completed"
                  : "uncertain";
          }
          await emit(record.type, payload, image);
        },
      },
    );
    artifact = discovery.artifact ?? null;
  } else {
    const modulePath = "../replay/run-replay.js";
    const { runReplay } = await import(modulePath);
    result = await runReplay(
      c,
      { adapterFactory: factory },
      {
        signal: controller.signal,
        review,
        onAudit: async (
          type: string,
          payload: Record<string, unknown>,
          image?: ImageContent,
          step_id?: string | null,
        ) => {
          await emit(type, payload, image, step_id);
        },
      },
    );
  }
  await transport!.send(
    "completed",
    { runtime_result: result, discovery_artifact: artifact },
    true,
  );
  lines.close();
}
