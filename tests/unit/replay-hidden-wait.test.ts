import { it, expect } from "vitest";
import { runReplay } from "../../src/replay/run-replay.js";
import { makeFakeAdapter } from "../helpers/fake-adapter.js";
it.each(["hidden", "visible"])(
  "replay treats an absent target as satisfied only for a hidden wait: %s",
  async (condition) => {
    const adapter = makeFakeAdapter();
    const object = {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    };
    const events: any[] = [];
    const result = await runReplay(
      {
        artifact: {
          definition: {
            surface: "browser",
            compatibility: {
              product_id: "desk",
              ui_variant: "standard",
              vendor_release: null,
            },
            input_schema: object,
            output_schema: object,
            entry: {
              url: { kind: "environment", path: "base_url" },
              checks: [],
            },
            steps: [
              {
                step_id: "wait",
                tool: "wait_for",
                arguments: {
                  condition: { kind: { kind: "literal", value: condition } },
                },
                target: {
                  kind: "semantic",
                  role: "status",
                  name: { kind: "literal", value: "Loading" },
                  exact: true,
                  scope: null,
                  required_matches: 1,
                },
                pre_checks: [],
                post_checks: [],
                recoveries: [],
              },
            ],
            success_checks: [
              {
                check_id: "done",
                kind: "tool_status_equals",
                step_id: "wait",
                expected: "condition_met",
              },
            ],
            business_outcomes: [],
            output_mapping: {},
          },
        },
        inputs: {},
        deployment: {
          app_deployment_id: "test",
          base_url: "https://example.org/app",
          config_version: 1,
          product_id: "desk",
          ui_variant: "standard",
          vendor_release: null,
        },
        assets: [],
        staging_directory: "/tmp",
      },
      { adapterFactory: { createForTask: async () => adapter } },
      {
        onAudit: async (type, payload) => {
          events.push({ type, payload });
        },
      },
    );
    expect(result.status).toBe(
      condition === "hidden" ? "success" : "hard_failure",
    );
    expect(adapter.calls.filter((c) => c.name === "wait_for")).toHaveLength(0);
    if (condition === "hidden")
      expect(events).toContainEqual(
        expect.objectContaining({ type: "wait_condition_satisfied" }),
      );
    else expect(result.code).toBe("TARGET_NOT_FOUND");
  },
);
