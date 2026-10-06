import { it, expect, vi } from "vitest";
import { OpenRouterClient } from "../../src/llm/openrouter-client.js";
import { ConversationHistory } from "../../src/runtime/history.js";
import { toolDefinitions } from "../../src/contracts/tools.js";
const config = { apiKey: "SECRET", model: "provider/exact-model" };
const turn = (message: unknown) =>
  new Response(JSON.stringify({ choices: [{ message }] }));
it("projects PNG bytes, all tools and preserved IDs on every request", async () => {
  const fetcher = vi.fn(
    async (_url: string | URL | Request, _options?: RequestInit) =>
      turn({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "real-id",
            type: "function",
            function: { name: "observe_ui", arguments: '{"mode":"both"}' },
          },
        ],
      }),
  );
  const client = new OpenRouterClient(config, fetcher);
  const history = new ConversationHistory([
    { role: "system", content: "system" },
  ]);
  history.appendObservationImage(
    {
      ref: "img",
      mimeType: "image/png",
      bytes: Uint8Array.from([137, 80, 78, 71]),
    },
    "obs",
    "bootstrap",
  );
  const result = await client.complete(history.messages, toolDefinitions);
  expect(result.kind).toBe("tool_calls");
  expect(result.assistantMessage.tool_calls?.[0]?.id).toBe("real-id");
  history.appendAssistantToolCalls(result.assistantMessage);
  history.appendToolResult("real-id", {
    status: "error",
    code: "TEST",
    message: "test",
  });
  await client.complete(history.messages, toolDefinitions);
  const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(request.model).toBe(config.model);
  expect(request.parallel_tool_calls).toBe(false);
  expect(request.tools).toHaveLength(12);
  expect(JSON.stringify(request)).toContain("data:image/png;base64,iVBORw==");
  expect(request.messages[1].content[0].text).toContain("image_ref=img");
  expect(JSON.stringify(request)).not.toContain("SECRET");
  const next = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
  expect(next.messages[1].content[0].text).toContain("image_ref=img");
  expect(next.messages.at(-1).tool_call_id).toBe("real-id");
});
it.each([
  { choices: [] },
  { choices: [{ message: { content: null } }] },
  {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: "a",
              type: "function",
              function: { name: "x", arguments: "{}" },
            },
            {
              id: "a",
              type: "function",
              function: { name: "x", arguments: "{}" },
            },
          ],
        },
      },
    ],
  },
  {
    choices: [
      {
        message: {
          tool_calls: [
            { type: "function", function: { name: "x", arguments: "{}" } },
          ],
        },
      },
    ],
  },
])("rejects malformed provider envelope safely", async (body) => {
  const c = new OpenRouterClient(
    config,
    async () => new Response(JSON.stringify(body)),
  );
  await expect(c.complete([], toolDefinitions)).rejects.toThrow(
    "Invalid provider response",
  );
});
it("returns final text and leaves malformed argument JSON to counted dispatch", async () => {
  const c = new OpenRouterClient(config, async () => turn({ content: "done" }));
  expect((await c.complete([], toolDefinitions)).kind).toBe("final_text");
  const d = new OpenRouterClient(config, async () =>
    turn({
      content: null,
      tool_calls: [
        {
          id: "a",
          type: "function",
          function: { name: "x", arguments: "{broken" },
        },
      ],
    }),
  );
  expect((await d.complete([], toolDefinitions)).kind).toBe("tool_calls");
});
it("does not disclose HTTP response or transport secrets", async () => {
  for (const fetcher of [
    async () => new Response("SECRET", { status: 401 }),
    async () => {
      throw new Error("SECRET");
    },
  ]) {
    await expect(
      new OpenRouterClient(config, fetcher).complete([], toolDefinitions),
    ).rejects.not.toThrow("SECRET");
  }
});
it("fails missing image bytes before transport and refuses unmatched history", async () => {
  const fetcher = vi.fn();
  const c = new OpenRouterClient(config, fetcher);
  await expect(
    c.complete(
      [
        {
          role: "observation",
          observationId: "o",
          callId: "x",
          image: { ref: "img", mimeType: "image/png", bytes: new Uint8Array() },
        },
      ],
      toolDefinitions,
    ),
  ).rejects.toThrow("image");
  expect(fetcher).not.toHaveBeenCalled();
  const h = new ConversationHistory([]);
  expect(() =>
    h.appendToolResult("missing", { status: "error", code: "X", message: "x" }),
  ).toThrow();
});
