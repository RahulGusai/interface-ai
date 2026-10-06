import { describe, it, expect } from "vitest";
import {
  toolSchemas,
  parseToolInput,
  toolDefinitions,
} from "../../src/contracts/tools.js";
import {
  parseTaskInput,
  maxToolCalls,
  loadOpenRouterConfig,
} from "../../src/runtime/config.js";
import { buildInitialMessages } from "../../src/runtime/prompts.js";
const control = { kind: "control", control_ref: "c1" };
const point = { kind: "point", x: 10, y: 10 };
describe("public contracts", () => {
  it("exports all twelve tools from strict schemas", () => {
    expect(Object.keys(toolSchemas)).toHaveLength(12);
    expect(toolDefinitions).toHaveLength(12);
    expect(() =>
      parseToolInput("observe_ui", { mode: "both", session_id: "x" }),
    ).toThrow();
  });
  it.each(["press_key", "select_option", "wait_for", "check_ui"])(
    "rejects points for %s",
    (name) => {
      const fields =
        name === "press_key"
          ? { keys: ["Enter"] }
          : name === "select_option"
            ? { option: { label: "A" } }
            : { condition: { kind: "visible" } };
      expect(() =>
        parseToolInput(name, {
          observation_id: "o",
          target: control,
          ...fields,
        }),
      ).not.toThrow();
      expect(() =>
        parseToolInput(name, { observation_id: "o", target: point, ...fields }),
      ).toThrow();
    },
  );
  it("rejects points in extraction, duplicate names, unknown targets and invalid distances", () => {
    for (const fields of [
      [{ name: "x", target: point, property: "text", output_type: "string" }],
      Array(2).fill({
        name: "x",
        target: control,
        property: "text",
        output_type: "string",
      }),
    ])
      expect(() =>
        parseToolInput("extract_data", { observation_id: "o", fields }),
      ).toThrow();
    for (const distance of [-1, 0, NaN, Infinity, 2.1])
      expect(() =>
        parseToolInput("scroll", {
          observation_id: "o",
          direction: "down",
          distance,
        }),
      ).toThrow();
    expect(() =>
      parseToolInput("click", {
        observation_id: "o",
        target: control,
        timeout: 10,
      }),
    ).toThrow();
  });
  it("allows only a single key or modifier chord and optional targets on keyboard/scroll", () => {
    for (const keys of [
      [],
      ["Enter", "Tab"],
      ["Control", "Control", "a"],
      ["Bogus"],
    ])
      expect(() =>
        parseToolInput("press_key", { observation_id: "o", keys }),
      ).toThrow();
    expect(
      parseToolInput("press_key", {
        observation_id: "o",
        keys: ["Control", "a"],
      }),
    ).toBeTruthy();
    expect(
      parseToolInput("scroll", {
        observation_id: "o",
        direction: "down",
        distance: 0.5,
      }),
    ).toBeTruthy();
  });
  it("round trips JSON schemas without browser internals", () => {
    expect(JSON.parse(JSON.stringify(toolDefinitions))).toEqual(
      toolDefinitions,
    );
    expect(JSON.stringify(toolDefinitions)).not.toMatch(
      /session_id|adapter|timeout/,
    );
  });
});
describe("config and prompts", () => {
  it("validates inputs and finite positive budget", () => {
    for (const targetUrl of [
      "file:///a",
      "javascript:x",
      "/relative",
      "https://user:pass@example.org",
    ])
      expect(() => parseTaskInput({ goal: "g", targetUrl })).toThrow();
    expect(() =>
      parseTaskInput({ goal: " ", targetUrl: "https://example.org" }),
    ).toThrow();
    for (const n of [0, -1, NaN, Infinity, 1.5])
      expect(() => maxToolCalls(n)).toThrow();
    expect(maxToolCalls()).toBe(40);
  });
  it("requires both environment values without exposing them", () => {
    expect(() =>
      loadOpenRouterConfig({ OPENROUTER_API_KEY: "SECRET" }),
    ).toThrow("OPENROUTER_MODEL");
    expect(() =>
      loadOpenRouterConfig({ OPENROUTER_MODEL: "provider/model" }),
    ).toThrow("OPENROUTER_API_KEY");
  });
  it("orders system then exact validated goal and URL", () => {
    const input = parseTaskInput({
      goal: "  Find member 42  ",
      targetUrl: "https://example.org/a",
    });
    const messages = buildInitialMessages(input);
    expect(messages.map((x) => x.role)).toEqual(["system", "user"]);
    expect(messages[1]?.content).toContain("Find member 42");
    expect(messages[1]?.content).toContain(input.targetUrl);
    expect(messages[0]?.content).toContain("untrusted");
  });
});
