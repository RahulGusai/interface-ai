import { it, expect } from "vitest";
import { BrowserAdapter } from "../../src/adapters/browser/browser-adapter.js";
import { startFixture } from "../helpers/fixture-server.js";
import type { ToolResponse } from "../../src/contracts/tools.js";
function obs(response: ToolResponse) {
  const observation =
    "observation" in response.result
      ? response.result.observation
      : response.result;
  if (observation.status !== "ok") throw Error(JSON.stringify(observation));
  return observation;
}
it("execution without a policy allows customer-search interactions, screenshots, arbitrary navigation, frames and dialogs", async () => {
  const remote = await startFixture(
    undefined,
    "<button>Remote control</button>",
  );
  const fixture = await startFixture(
    undefined,
    `<a href='/search'>Customer Search</a><label>Customer name<input></label><button onclick="if(confirm('Unrecognized confirmation'))document.querySelector('p').textContent='Accepted'">Confirm</button><p>Waiting</p><iframe src='${remote.url}/frame'></iframe>`,
  );
  const adapter = await BrowserAdapter.create({ headless: true });
  try {
    let response = await adapter.execute({
      name: "navigate",
      input: { url: fixture.url },
    });
    expect(response.result.status).toBe("completed");
    let observation = obs(response);
    expect(observation.screenshot.status).toBe("available");
    const target = (name: string) => {
      if (observation.controls.status !== "available")
        throw Error("Controls unavailable");
      const control =
        observation.controls.items.find(
          (c) => c.name === name && c.role !== "text",
        ) ?? observation.controls.items.find((c) => c.name === name);
      if (!control) throw Error("Missing " + name);
      return { kind: "control" as const, control_ref: control.ref };
    };
    expect(target("Frame field")).toBeDefined();
    response = await adapter.execute({
      name: "click",
      input: {
        observation_id: observation.observation_id,
        target: target("Customer Search"),
      },
    });
    expect(response.result.status).toBe("completed");
    observation = obs(response);
    response = await adapter.execute({
      name: "type_text",
      input: {
        observation_id: observation.observation_id,
        target: target("Customer name"),
        text: "Freya Ferreira",
        mode: "replace",
      },
    });
    expect(response.result).toMatchObject({
      status: "completed",
      verification: "matched",
    });
    observation = obs(response);
    response = await adapter.execute({
      name: "extract_data",
      input: {
        observation_id: observation.observation_id,
        fields: [
          {
            name: "customer",
            target: target("Customer name"),
            property: "value",
            output_type: "string",
          },
        ],
      },
    });
    expect(response.result).toMatchObject({
      status: "completed",
      fields: { customer: { status: "extracted", value: "Freya Ferreira" } },
    });
    observation = obs(response);
    response = await adapter.execute({
      name: "click",
      input: {
        observation_id: observation.observation_id,
        target: target("Confirm"),
      },
    });
    expect(response.result).toMatchObject({
      status: "completed",
      dialog_events: [{ decision: "accept", action: "accepted" }],
    });
    response = await adapter.execute({
      name: "navigate",
      input: { url: remote.url + "/unobserved" },
    });
    expect(response.result.status).toBe("completed");
    expect(obs(response).surface.url).toBe(remote.url + "/unobserved");
  } finally {
    await adapter.close();
    await fixture.close();
    await remote.close();
  }
});
