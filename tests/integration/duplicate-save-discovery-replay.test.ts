import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../../src/runtime/run-task.js";
import { runReplay } from "../../src/replay/run-replay.js";
import { stageImage } from "../../src/bridge/staging.js";
import type { DiscoveryContext } from "../../src/runtime/discovery-context.js";
import type { AuditRecord } from "../../src/runtime/audit.js";
import { lastObservation } from "../../src/demo/scripted-model.js";
import { createBrowserFactory } from "../helpers/fixture-browser-factory.js";
import { startFixture } from "../helpers/fixture-server.js";

const assessment = {
  decision: "auto_approve",
  confidence: 0.9,
  reason: "Synthetic contact edit",
};
function html(shift = 0, duplicate = false) {
  const actions = (
    left: number,
  ) => `<div style="position:absolute;left:${left}px;top:310px;width:260px;height:90px;background:#31546a;color:white">
    <span style="position:absolute;left:10px;top:0">Commit contact changes</span>
    <button type="button" style="position:absolute;left:10px;top:40px" onclick="save('bottom')">Save</button>
  </div>`;
  return `<!doctype html><title>Contact editor</title>
    <style>body{background:white;font:16px Arial}button{width:80px;height:32px;background:#123456;color:white}</style>
    <form aria-label="Edit contact details">
      <label>Email <input id="email"></label>
      <button type="button" style="position:absolute;left:50px;top:100px" onclick="save('top')">Save</button>
      ${actions(40 + shift)}${duplicate ? actions(650) : ""}
    </form>
    <p aria-label="Stored email" id="stored"></p><p aria-label="Save result" id="result"></p>
    <script>
      function render(){document.getElementById('stored').textContent=localStorage.getItem('email')||'original@example.test';document.getElementById('result').textContent=localStorage.getItem('result')||'none:0'}
      function save(which){localStorage.setItem('email',document.getElementById('email').value);localStorage.setItem('result',which+':'+(Number(localStorage.getItem('count')||0)+1));localStorage.setItem('count',Number(localStorage.getItem('count')||0)+1);render()}
      render();
    </script>`;
}

it("corrects duplicate Save recording and replays the intended button at a fresh position exactly once", async () => {
  const fixture = await startFixture(undefined, html());
  const directory = await mkdtemp(join(tmpdir(), "duplicate-save-"));
  const discovery: DiscoveryContext = {
    deployment: {
      app_deployment_id: "test",
      base_url: fixture.url,
      config_version: 1,
      product_id: "desk",
      ui_variant: "standard",
      vendor_release: null,
    },
    metadata: {
      name: "Save contact email",
      description: "Save and confirm email",
      input_schema: {
        type: "object",
        properties: { email: { type: "string" } },
        required: ["email"],
        additionalProperties: false,
      },
      example_inputs: { email: "discovery@example.test" },
    },
    inputs: { email: "discovery@example.test" },
    capability_catalog: [],
    records: [],
    references: [],
    async recordReference(record, crop, capture, callId) {
      const handle = "save-reference";
      record.target.asset_id = handle;
      const staged = await stageImage(
        directory,
        {
          ref: handle,
          mimeType: "image/png",
          bytes: crop,
        },
        "reference_crop",
      );
      const {
        observation_id: _observation,
        image_ref: _image,
        ...provenance
      } = record.provenance;
      discovery.references.push({
        ...provenance,
        asset_handle: handle,
        staged_path: staged.staged_path,
        sha256: staged.sha256,
        source_call_id: callId,
      });
    },
  };
  const audits: AuditRecord[] = [];
  let turn = 0;
  try {
    const result = await runTask(
      {
        goal: "Save the contact email and confirm the stored value",
        targetUrl: fixture.url,
        accessPolicy: "READ_WRITE",
      },
      {
        adapterFactory: createBrowserFactory({ headless: true }),
        model: {
          model: "scripted",
          async complete(messages) {
            const o = lastObservation(messages);
            if (o.controls.status !== "available") throw Error();
            const controls = o.controls.items;
            const ref = (name: string, role = "text") =>
              controls.find((c) => c.name === name && c.role === role)!.ref;
            const callId = String(turn);
            let name: string;
            let args: any;
            switch (turn++) {
              case 0:
                name = "type_text";
                args = {
                  observation_id: o.observation_id,
                  target: {
                    kind: "control",
                    control_ref: ref("Email", "textbox"),
                  },
                  text: { kind: "input", path: "email" },
                  mode: "replace",
                };
                break;
              case 1:
                name = "click";
                args = {
                  observation_id: o.observation_id,
                  target: {
                    kind: "control",
                    control_ref: controls
                      .filter((c) => c.role === "button" && c.name === "Save")
                      .at(-1)!.ref,
                  },
                };
                break;
              case 2:
                name = "click";
                args = {
                  observation_id: o.observation_id,
                  target: { kind: "point", x: 90, y: 366 },
                  recording_hint: {
                    visual_reference: {
                      rect: { left: 40, top: 310, width: 100, height: 80 },
                      relative_point: { u: 0.5, v: 0.7 },
                      description:
                        "Save with the unique Commit contact changes context",
                    },
                  },
                };
                break;
              case 3:
                name = "extract_data";
                args = {
                  observation_id: o.observation_id,
                  fields: [
                    {
                      name: "stored_email",
                      target: {
                        kind: "control",
                        control_ref: ref("Stored email"),
                      },
                      property: "text",
                      output_type: "string",
                    },
                    {
                      name: "save_result",
                      target: {
                        kind: "control",
                        control_ref: ref("Save result"),
                      },
                      property: "text",
                      output_type: "string",
                    },
                  ],
                };
                break;
              default:
                name = "finish_task";
                args = {
                  outcome: "goal_achieved",
                  summary: "Confirmed stored email",
                  outputs: {
                    stored_email: "discovery@example.test",
                    save_result: "bottom:1",
                  },
                };
            }
            const calls = [
              {
                id: callId,
                name,
                argumentsJson: JSON.stringify({
                  ...args,
                  execution: assessment,
                }),
              },
            ];
            return {
              kind: "tool_calls" as const,
              calls,
              assistantMessage: {
                role: "assistant" as const,
                content: null,
                tool_calls: calls,
              },
            };
          },
        },
      },
      {
        discovery,
        onAudit: async (record) => {
          audits.push(record);
        },
      },
    );
    expect(result.status).toBe("goal_achieved");
    expect(audits).toContainEqual(
      expect.objectContaining({
        type: "tool_finished",
        call: expect.objectContaining({ id: "1" }),
        result: expect.objectContaining({
          status: "error",
          code: "AMBIGUOUS_DURABLE_TARGET",
        }),
      }),
    );
    expect(discovery.records.filter((r) => r.tool === "click")).toHaveLength(1);
    const definition = discovery.artifact!.definition;
    expect(definition.steps[2]!.target!.kind).toBe("visual");
    const assets = discovery.references.map((r) => ({
      asset_id: r.asset_handle,
      staged_path: r.staged_path,
      sha256: r.sha256,
    }));
    for (const duplicate of [false, true]) {
      const fresh = await startFixture(undefined, html(200, duplicate));
      try {
        const events: { type: string; step_id?: string | null }[] = [];
        const replay = await runReplay(
          {
            artifact: { definition } as any,
            inputs: { email: "replay@example.test" },
            deployment: { ...discovery.deployment, base_url: fresh.url },
            access_policy: "READ_WRITE",
            assets,
            staging_directory: directory,
          },
          { adapterFactory: createBrowserFactory({ headless: true }) },
          {
            onAudit: async (type, _payload, _image, step_id) => {
              events.push({ type, step_id });
            },
          },
        );
        if (duplicate) {
          expect(replay).toMatchObject({
            status: "hard_failure",
            code: "TARGET_AMBIGUOUS",
            step_id: "step_3",
            dispatch_state: "not_dispatched",
          });
          expect(
            events.some(
              (e) => e.type === "tool_started" && e.step_id === "step_3",
            ),
          ).toBe(false);
        } else {
          expect(replay).toMatchObject({
            status: "success",
            outputs: {
              stored_email: "replay@example.test",
              save_result: "bottom:1",
            },
          });
        }
      } finally {
        await fresh.close();
      }
    }
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
