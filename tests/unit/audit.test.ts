import { it, expect } from "vitest";
import { runTask } from "../../src/runtime/run-task.js";
import { syntheticContract } from "../../src/demo/synthetic-contract.js";
import { makeFakeAdapter } from "../helpers/fake-adapter.js";
import type { AgentTurn } from "../../src/contracts/run.js";
import { createFileAudit } from "../../src/runtime/audit.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("audits exact input strings, bootstrap, rejected calls and unexecuted batch tails in order", async () => {
  const adapter = makeFakeAdapter();
  const records: any[] = [];
  const calls = [
    { id: "bad", name: "unknown", argumentsJson: '{ "x": 1 }' },
    {
      id: "end",
      name: "finish_task",
      argumentsJson:
        '{"observation_id":"obs_1","outcome":"goal_achieved","summary":"done","outputs":{}}',
    },
    { id: "tail", name: "observe_ui", argumentsJson: '{"mode":"both"}' },
  ];
  const turn: AgentTurn = {
    kind: "tool_calls",
    calls,
    assistantMessage: { role: "assistant", content: null, tool_calls: calls },
  };
  await runTask(
    { goal: "Inspect", targetUrl: "https://example.org/app" },
    {
      adapterFactory: { createForTask: async () => adapter },
      contract: syntheticContract(),
      model: { model: "fake", complete: async () => turn },
    },
    { onAudit: (record: any) => records.push(record) },
  );
  expect(
    records.filter((r) => r.type === "tool_started").map((r) => r.call.id),
  ).toEqual(["bootstrap", "bad", "end"]);
  expect(
    records.find((r) => r.type === "tool_started" && r.call.id === "bad").call
      .argumentsJson,
  ).toBe('{ "x": 1 }');
  expect(
    records.find((r) => r.type === "tool_finished" && r.call.id === "bad")
      .result.code,
  ).toBe("INVALID_TOOL_CALL");
  expect(
    records
      .find((r) => r.type === "tool_not_executed")
      .calls.map((c: any) => c.id),
  ).toEqual(["tail"]);
  expect(records.at(-1).type).toBe("run_finished");
});

it("stops before dispatch when durable audit writing fails", async () => {
  const adapter = makeFakeAdapter();
  const result = await runTask(
    { goal: "Inspect", targetUrl: "https://example.org/app" },
    {
      adapterFactory: { createForTask: async () => adapter },
      contract: syntheticContract(),
      model: {
        model: "fake",
        complete: async () => {
          throw new Error("not reached");
        },
      },
    },
    {
      onAudit: (record: any) => {
        if (record.type === "tool_started") throw new Error("disk full");
      },
    },
  );
  expect(result.status).toBe("tool_error");
  expect(adapter.calls).toHaveLength(0);
  expect(adapter.closed).toBe(true);
});

it("persists a numbered JSONL audit with exact Unicode arguments and external screenshot files", () => {
  const directory = mkdtempSync(join(tmpdir(), "runtime-audit-"));
  const sink = createFileAudit(directory);
  try {
    sink.write(
      {
        type: "model_proposed",
        modelTurn: 1,
        calls: [
          { id: "a", name: "type_text", argumentsJson: '{ "text": "α\nβ" }' },
        ],
      },
      { ref: "img", mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) },
    );
    const row = JSON.parse(
      readFileSync(join(directory, "audit.jsonl"), "utf8"),
    );
    expect(row.sequence).toBe(1);
    expect(row.calls[0].argumentsJson).toBe('{ "text": "α\nβ" }');
    expect([...readFileSync(join(directory, row.screenshot))]).toEqual([
      1, 2, 3,
    ]);
  } finally {
    sink.close();
    rmSync(directory, { recursive: true });
  }
});
