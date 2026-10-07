import { startFixture } from "../../tests/helpers/fixture-server.js";
import { scriptedModel } from "./scripted-model.js";
import { runTask } from "../runtime/run-task.js";
import { createBrowserFactory } from "../adapters/factory.js";
import { syntheticContract } from "../demo/synthetic-contract.js";
const fixture = await startFixture();
try {
  console.log("SCRIPTED mechanics demo — fake model, real headed Chromium.");
  const result = await runTask(
    { goal: "Find synthetic member 42", targetUrl: fixture.url },
    {
      model: scriptedModel(),
      contract: syntheticContract(),
      adapterFactory: createBrowserFactory({ headless: false, slowMo: 150 }),
    },
    {
      onEvent: (event) => {
        if (event.type === "tool_completed") console.log(JSON.stringify(event));
      },
    },
  );
  console.log(JSON.stringify(result));
  if (result.status !== "awaiting_artifact_design") process.exitCode = 1;
} finally {
  await fixture.close();
}
