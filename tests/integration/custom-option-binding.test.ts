import { it, expect } from "vitest";
import { BrowserAdapter } from "../../src/adapters/browser/browser-adapter.js";
import { runTask } from "../../src/runtime/run-task.js";
import { runReplay } from "../../src/replay/run-replay.js";
import { createBrowserFactory } from "../../src/adapters/factory.js";
import { lastObservation } from "../../src/demo/scripted-model.js";
import type { DiscoveryContext } from "../../src/runtime/discovery-context.js";
import { chromium } from "playwright";
import { collectControls } from "../../src/adapters/browser/capture.js";
import { selectOption } from "../../src/adapters/browser/input.js";
import { startFixture } from "../helpers/fixture-server.js";

const dropdownFixture = `<meta charset="utf-8"><input role="combobox" aria-label="Branch" aria-controls="branches" aria-expanded="false" readonly onclick="document.querySelector('#branches').hidden=false;this.setAttribute('aria-expanded','true')">
<ul id="branches" role="listbox" aria-label="Branches" hidden onclick="if(event.target.matches('[role=option]') && event.target.getAttribute('aria-disabled') !== 'true'){document.querySelector('input').value=event.target.textContent;this.hidden=true;document.querySelector('input').setAttribute('aria-expanded','false')}">
<li role="option">012 — Harbor Street</li><li role="option">091 — Westmere Hall</li><li role="option">092 — Westmere Annex</li><li role="option" aria-disabled="true">104 — Disabled Branch</li></ul>
<ul role="listbox" aria-label="Other list"><li role="option">099 — Harbor Street</li><li role="option">099 — Outside Branch</li></ul>`;

it("selects unique bound labels within the observed custom dropdown and verifies changed selections", async () => {
  const fixture = await startFixture(undefined, dropdownFixture);
  const adapter = await BrowserAdapter.create({ headless: true });
  try {
    await adapter.execute({ name: "navigate", input: { url: fixture.url } });
    const observe = async () => {
      const o = (await adapter.capture("controls")).observation;
      if (o.status !== "ok" || o.controls.status !== "available")
        throw Error("Missing controls");
      return { ...o, controls: o.controls };
    };
    for (const [label, status, selected] of [
      ["Harbor Street", "completed", "012 — Harbor Street"],
      ["Westmere Hall", "completed", "091 — Westmere Hall"],
      ["Westmere", "blocked", undefined],
      ["Outside Branch", "blocked", undefined],
      ["Disabled Branch", "blocked", undefined],
    ] as const) {
      let o = await observe();
      let branch = o.controls.items.find((c) => c.name === "Branch")!;
      if (!branch.state.expanded) {
        await adapter.execute({
          name: "click",
          input: {
            observation_id: o.observation_id,
            target: { kind: "control", control_ref: branch.ref },
          },
        });
        o = await observe();
        branch = o.controls.items.find((c) => c.name === "Branch")!;
      }
      const option = o.controls.items.find(
        (c) => c.name === "012 — Harbor Street",
      )!;
      expect(option.parent_ref).toBe(branch.ref);
      const result = await adapter.execute({
        name: "select_option",
        input: {
          observation_id: o.observation_id,
          target: { kind: "control", control_ref: branch.ref },
          option: { label, match: "contains" },
        },
      });
      expect(result.result.status).toBe(status);
      if (selected)
        expect(result.result).toMatchObject({
          selected_label: selected,
          verification: "matched",
        });
    }
    const o = await observe();
    expect(o.controls.items.find((c) => c.name === "Branch")!.value).toBe(
      "091 — Westmere Hall",
    );
  } finally {
    await adapter.close();
    await fixture.close();
  }
});

it("blocks a stale option when another option takes its observed label", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(dropdownFixture);
    await page.getByRole("combobox", { name: "Branch" }).click();
    const capture = await collectControls(page);
    try {
      const binding = [...capture.bindings.values()].find(
        (b) => b.control.name === "Branch",
      )!;
      await page.evaluate(() => {
        const list = document.querySelector("#branches")!;
        list.children[0]!.textContent = "Changed Branch";
        list.children[1]!.textContent = "012 — Harbor Street";
        document.querySelector("input")!.value = "before";
      });
      await expect(
        selectOption(
          { kind: "control", binding },
          "Harbor Street",
          1000,
          "contains",
        ),
      ).rejects.toMatchObject({ code: "UNSUPPORTED_SELECTION" });
      expect(
        await page.getByRole("combobox", { name: "Branch" }).inputValue(),
      ).toBe("before");
    } finally {
      await Promise.all(
        [...capture.bindings.values()].map((b) => b.element.dispose()),
      );
    }
  } finally {
    await browser.close();
  }
});

it("does not report success when clicking a custom option leaves selection unchanged", async () => {
  const fixture = await startFixture(
    undefined,
    dropdownFixture.replace(
      'onclick="if(event.target.matches',
      'data-ignored-handler="if(event.target.matches',
    ),
  );
  const adapter = await BrowserAdapter.create({ headless: true });
  try {
    await adapter.execute({ name: "navigate", input: { url: fixture.url } });
    let o = (await adapter.capture("controls")).observation;
    if (o.status !== "ok" || o.controls.status !== "available") throw Error();
    await adapter.execute({
      name: "click",
      input: {
        observation_id: o.observation_id,
        target: {
          kind: "control",
          control_ref: o.controls.items.find((c) => c.name === "Branch")!.ref,
        },
      },
    });
    o = (await adapter.capture("controls")).observation;
    if (o.status !== "ok" || o.controls.status !== "available") throw Error();
    const r = await adapter.execute({
      name: "select_option",
      input: {
        observation_id: o.observation_id,
        target: {
          kind: "control",
          control_ref: o.controls.items.find((c) => c.name === "Branch")!.ref,
        },
        option: { label: "Harbor Street", match: "contains" },
      },
    });
    expect(r.result).toMatchObject({
      status: "failed",
      verification: "mismatched",
    });
  } finally {
    await adapter.close();
    await fixture.close();
  }
});

it.each([
  {
    name: "verifies a selected option after its popup closes",
    html: `<button role="combobox" aria-label="Branch" aria-controls="branches">Choose</button><ul id="branches" role="listbox"><li role="option" onclick="this.setAttribute('aria-selected','true');this.parentElement.hidden=true;document.querySelector('button').textContent='012 — Harbor Street'">012 — Harbor Street</li></ul>`,
    verification: "matched",
  },
  {
    name: "uses accessible option names",
    html: `<button role="combobox" aria-label="Branch" aria-controls="branches">Choose</button><ul id="branches" role="listbox"><li role="option" aria-labelledby="option-name" onclick="this.setAttribute('aria-selected','true')">Internal code</li></ul><span id="option-name">012 — Harbor Street</span>`,
    verification: "matched",
  },
  {
    name: "rejects selection in a list no longer owned by the widget",
    html: `<button role="combobox" aria-label="Branch" aria-controls="branches">Choose</button><ul id="branches" role="listbox"><li role="option" onclick="this.setAttribute('aria-selected','true');document.querySelector('button').setAttribute('aria-controls','other')">012 — Harbor Street</li></ul><ul id="other" role="listbox"><li role="option" aria-selected="true">091 — Westmere Hall</li></ul>`,
    verification: "mismatched",
  },
])("$name", async ({ html, verification }) => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html);
    const capture = await collectControls(page);
    try {
      const binding = [...capture.bindings.values()].find(
        (b) => b.control.name === "Branch",
      )!;
      expect(
        await selectOption(
          { kind: "control", binding },
          "Harbor Street",
          1000,
          "contains",
        ),
      ).toMatchObject({ verification });
    } finally {
      await Promise.all(
        [...capture.bindings.values()].map((b) => b.element.dispose()),
      );
    }
  } finally {
    await browser.close();
  }
});

it("records selection bindings on a stable parent and replays another prefixed branch", async () => {
  const fixture = await startFixture(undefined, dropdownFixture);
  const context: DiscoveryContext = {
    deployment: {
      app_deployment_id: "d",
      base_url: fixture.url,
      product_id: "p",
      ui_variant: "v",
      vendor_release: null,
      config_version: 1,
    },
    inputs: {},
    capability_catalog: [],
    records: [],
    references: [],
  };
  let turn = 0;
  try {
    const result = await runTask(
      {
        goal: "Choose Harbor Street and read the branch",
        targetUrl: fixture.url,
      },
      {
        adapterFactory: createBrowserFactory({ headless: true }),
        model: {
          model: "fake",
          generateCapability: async () => ({
            name: "choose_branch",
            description: "Select a branch",
            input_schema: {
              type: "object",
              properties: { location: { type: "string" } },
              required: ["location"],
              additionalProperties: false,
            },
            example_inputs: { location: "Harbor Street" },
          }),
          complete: async (messages) => {
            const o = lastObservation(messages);
            if (o.controls.status !== "available")
              throw Error("Missing controls");
            const target = {
              kind: "control",
              control_ref: o.controls.items.find((c) => c.name === "Branch")!
                .ref,
            };
            const calls = [
              {
                id: String(turn),
                name: ["click", "select_option", "extract_data", "finish_task"][
                  turn
                ]!,
                argumentsJson: JSON.stringify(
                  [
                    { observation_id: o.observation_id, target },
                    {
                      observation_id: o.observation_id,
                      target,
                      option: {
                        label: { kind: "input", path: "location" },
                        match: "contains",
                      },
                    },
                    {
                      observation_id: o.observation_id,
                      fields: [
                        {
                          name: "branch",
                          target,
                          property: "value",
                          output_type: "string",
                        },
                      ],
                    },
                    {
                      outcome: "goal_achieved",
                      summary: "Selected branch",
                      outputs: { branch: "012 — Harbor Street" },
                    },
                  ][turn++],
                ),
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
            };
          },
        },
      },
      { discovery: context, maxToolCalls: 5 },
    );
    expect(result.status).toBe("goal_achieved");
    const artifact = context.artifact!.definition;
    const selection = artifact.steps.find(
      (step) => step.tool === "select_option",
    )!;
    expect(selection.target).toMatchObject({
      kind: "semantic",
      role: "combobox",
      name: { kind: "literal", value: "Branch" },
    });
    expect(selection.arguments.option).toEqual({
      label: { kind: "input", path: "location" },
      match: { kind: "literal", value: "contains" },
    });
    expect(JSON.stringify(artifact.steps)).not.toContain("012 — Harbor Street");
    const replay = await runReplay(
      {
        artifact: { definition: artifact },
        inputs: { location: "Westmere Hall" },
        deployment: context.deployment,
        assets: [],
        staging_directory: "/tmp",
      },
      { adapterFactory: createBrowserFactory({ headless: true }) },
      { onAudit: async () => {} },
    );
    expect(replay).toMatchObject({
      status: "success",
      outputs: { branch: "091 — Westmere Hall" },
    });
  } finally {
    await fixture.close();
  }
});
