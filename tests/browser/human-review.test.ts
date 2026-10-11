import { createServer } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { BrowserAdapter } from "../../src/adapters/browser/browser-adapter.js";
import { dispatchTool } from "../../src/runtime/dispatch.js";
let base = "",
  writes = 0;
const server = createServer((req, res) => {
  if (req.url === "/write") {
    writes++;
    res.end("saved");
    return;
  }
  res.setHeader("Content-Type", "text/html");
  res.end(
    `<button style="position:absolute;left:10px;top:10px;width:100px;height:30px" onclick="fetch('/write',{method:'POST'}).then(()=>document.querySelector('p').textContent='Saved')">Save</button><p>Ready</p>`,
  );
});
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
async function setup(policy: "READ_ONLY" | "READ_WRITE" = "READ_WRITE") {
  const adapter = await BrowserAdapter.create({
    headless: true,
    runPolicy: { baseUrl: base, accessPolicy: policy },
  });
  const initial = await adapter.execute({
    name: "navigate",
    input: { url: base },
  });
  const o = (initial.result as any).observation;
  return {
    adapter,
    context: {
      adapter,
      accessPolicy: policy,
      allowedHostname: "127.0.0.1",
      busy: false,
      halted: false,
    },
    o,
  };
}
function call(o: any, confidence: number | undefined, point = false) {
  return {
    id: "save-call",
    name: "click",
    argumentsJson: JSON.stringify({
      observation_id: o.observation_id,
      target: point
        ? { kind: "point", x: 40, y: 25 }
        : {
            kind: "control",
            control_ref: o.controls.items.find((c: any) => c.name === "Save")
              .ref,
          },
      ...(confidence === undefined
        ? {}
        : {
            execution: {
              decision: "auto_approve",
              confidence,
              reason: "Save synthetic record",
            },
          }),
    }),
  };
}
it.each([0.3, 1])(
  "auto assessment at %s executes without review",
  async (confidence) => {
    const { adapter, context, o } = await setup();
    const before = writes;
    try {
      const r = await dispatchTool(context, call(o, confidence));
      expect(r.result.status).toBe("completed");
      expect(writes - before).toBe(1);
    } finally {
      await adapter.close();
    }
  },
);
it.each([false, true])(
  "approval retains browser and blocks dispatch while pending (point=%s)",
  async (point) => {
    const { adapter, context, o } = await setup();
    const before = writes;
    let approve!: (v: any) => void;
    let requested!: () => void;
    const seen = new Promise<void>((r) => (requested = r));
    const pending = new Promise<any>((r) => (approve = r));
    (context as any).review = async (request: any) => {
      expect(request.capture.image.bytes.length).toBeGreaterThan(0);
      requested();
      return pending;
    };
    try {
      const executing = dispatchTool(context, call(o, 0.29, point));
      await Promise.race([
        seen,
        executing.then(() => {
          throw Error("Execution completed without requesting review");
        }),
      ]);
      expect(writes).toBe(before);
      approve({ status: "approved", review_id: "review-1" });
      const r = await executing;
      expect(r.result.status).toBe("completed");
      expect(writes - before).toBe(1);
      const next = await adapter.capture("both");
      expect(next.observation.status).toBe("ok");
    } finally {
      await adapter.close();
    }
  },
);
it("missing assessment is reviewed and rejection performs no write", async () => {
  const { adapter, context, o } = await setup();
  const before = writes;
  (context as any).review = async () => ({
    status: "rejected",
    review_id: "review-1",
  });
  try {
    const r = await dispatchTool(context, call(o, undefined));
    expect(r.result).toMatchObject({
      status: "error",
      code: "HUMAN_REVIEW_REJECTED",
    });
    expect(writes).toBe(before);
  } finally {
    await adapter.close();
  }
});
it("READ_ONLY ignores auto approval and still denies unknown clicks", async () => {
  const { adapter, context, o } = await setup("READ_ONLY");
  const before = writes;
  try {
    expect((await dispatchTool(context, call(o, 1))).result.status).toBe(
      "policy_blocked",
    );
    expect(writes).toBe(before);
  } finally {
    await adapter.close();
  }
});
it("changed review context requires fresh approval before dispatch", async () => {
  const { adapter, context, o } = await setup();
  const before = writes;
  const fingerprints: string[] = [];
  (context as any).review = async (request: any) => {
    fingerprints.push(request.fingerprint);
    if (fingerprints.length === 1) {
      await (adapter as any).page.evaluate(
        () => (document.querySelector("p")!.textContent = "Different record"),
      );
      return { status: "approved", review_id: "first" };
    }
    return { status: "rejected", review_id: "second" };
  };
  try {
    const result = await dispatchTool(context, call(o, 0.1));
    expect(result.result).toMatchObject({ code: "HUMAN_REVIEW_REJECTED" });
    expect(fingerprints).toHaveLength(2);
    expect(fingerprints[0]).not.toBe(fingerprints[1]);
    expect(writes).toBe(before);
  } finally {
    await adapter.close();
  }
});
it.each(["expired", "cancelled"] as const)(
  "%s review does not dispatch",
  async (status) => {
    const { adapter, context, o } = await setup();
    const before = writes;
    (context as any).review = async () => ({ status, review_id: "review" });
    try {
      expect((await dispatchTool(context, call(o, 0.1))).result).toMatchObject({
        code: `HUMAN_REVIEW_${status.toUpperCase()}`,
      });
      expect(writes).toBe(before);
    } finally {
      await adapter.close();
    }
  },
);
