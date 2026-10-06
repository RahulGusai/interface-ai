import { it, expect } from "vitest";
import { RuntimePolicy } from "../../src/runtime/policy.js";
import { dispatchTool } from "../../src/runtime/dispatch.js";
import { makeFakeAdapter } from "../helpers/fake-adapter.js";
const make = () =>
  new RuntimePolicy({
    documents: [{ origin: "https://example.org", pathPrefix: "/app" }],
    resourceOrigins: ["https://example.org"],
    allowedActions: ["observe_ui", "click", "navigate", "press_key"],
    allowScreenshots: false,
    redactPatterns: ["SENSITIVE"],
    riskyAction: () => "intervention",
    dialogs: [{ type: "alert", message: "Known", decision: "accept" }],
  });
it("uses exact origins, path boundaries and rejects credentials/encoded traversal", () => {
  const p = make();
  expect(p.allowUrl("https://example.org/app/a")).toBe(true);
  for (const url of [
    "https://example.org.evil/app",
    "https://example.org/application",
    "https://u:p@example.org/app",
    "https://example.org/app/%2e%2e/other",
    "file:///app",
    "https://example.org/app/%2f../x",
  ])
    expect(p.allowUrl(url)).toBe(false);
});
it("owns action, risk, dialog and exposure decisions", () => {
  const p = make();
  expect(
    p.decide({
      name: "type_text",
      input: {
        observation_id: "o",
        target: { kind: "point", x: 1, y: 1 },
        text: "x",
        mode: "replace",
      },
    }),
  ).toBe("deny");
  expect(
    p.decide({
      name: "click",
      input: { observation_id: "o", target: { kind: "point", x: 1, y: 1 } },
    }),
  ).toBe("intervention");
  expect(p.dialog("alert", "Known").decision).toBe("accept");
  expect(p.dialog("confirm", "Unknown").decision).toBe("intervention");
  expect(p.sanitize({ text: "SENSITIVE" })).toEqual({ text: "[REDACTED]" });
});
it("never invokes adapter for invalid/unknown/blocked proposals", async () => {
  const adapter = makeFakeAdapter();
  const context = { adapter, policy: make(), busy: false, halted: false };
  for (const [name, argumentsJson] of [
    ["unknown", "{}"],
    ["click", "{"],
    [
      "press_key",
      '{"observation_id":"o","target":{"kind":"point","x":1,"y":1},"keys":["Enter"]}',
    ],
    ["navigate", '{"url":"https://evil.org"}'],
  ]) {
    const r = await dispatchTool(context, {
      id: "id",
      name: name!,
      argumentsJson: argumentsJson!,
    });
    expect(["error", "policy_blocked"]).toContain(r.result.status);
  }
  expect(adapter.calls).toHaveLength(0);
});
