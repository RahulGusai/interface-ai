import { expect, it } from "vitest";
import { createReviewHandler } from "../../src/bridge/review-client.js";
it("polls the persisted decision without changing the review identity", async () => {
  const requests: { url: string; method: string; body?: any }[] = [];
  let id = "";
  let reads = 0;
  const handler = createReviewHandler({
    baseUrl: "http://localhost:8000",
    runId: "run-1",
    timeoutMs: 1000,
    pollMs: 1,
    persistSnapshot: async () => 12,
    fetcher: async (url: any, init: any) => {
      requests.push({
        url: String(url),
        method: init.method,
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      if (init.method === "POST") id = JSON.parse(init.body).review_id;
      else reads++;
      return new Response(
        JSON.stringify({
          review_id: id,
          run_id: "run-1",
          expires_at: new Date(Date.now() + 1000).toISOString(),
          status: reads >= 2 ? "approved" : "pending",
          run_status: reads >= 2 ? "running" : "awaiting_human",
        }),
        { status: 200 },
      );
    },
  });
  const result = await handler({
    call_id: "call",
    tool: "click",
    arguments: {},
    fingerprint: "a".repeat(64),
    capture: {
      observation: {
        status: "error",
        code: "CAPTURE_FAILED",
        message: "test",
        retryable: false,
      },
    },
  });
  expect(result.status).toBe("approved");
  expect(requests[0]!.body.event_sequence).toBe(12);
  expect(requests.slice(1).map((r) => r.url)).toEqual([
    `http://localhost:8000/v1/human-reviews/${id}`,
    `http://localhost:8000/v1/human-reviews/${id}`,
  ]);
});
const request = {
  call_id: "call",
  tool: "click",
  arguments: {},
  fingerprint: "a".repeat(64),
  capture: {
    observation: {
      status: "error" as const,
      code: "CAPTURE_FAILED" as const,
      message: "test",
      retryable: false,
    },
  },
};
it("retries a lost create response with exactly the same identity and action", async () => {
  const bodies: string[] = [];
  let persisted = 0;
  const handler = createReviewHandler({
    baseUrl: "http://localhost",
    runId: "run",
    timeoutMs: 1000,
    pollMs: 1,
    persistSnapshot: async () => {
      persisted++;
      return 3;
    },
    fetcher: async (_url, init) => {
      bodies.push(String(init?.body));
      if (bodies.length === 1) throw Error("socket closed after create");
      return Response.json({
        review_id: JSON.parse(String(init?.body)).review_id,
        run_id: "run",
        expires_at: new Date(Date.now() + 1000).toISOString(),
        status: "approved",
        run_status: "running",
      });
    },
  });
  expect((await handler(request)).status).toBe("approved");
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toBe(bodies[1]);
  expect(persisted).toBe(1);
});
it("bounds unconfirmed creation separately from human decision expiry", async () => {
  const handler = createReviewHandler({
    baseUrl: "http://localhost",
    runId: "run",
    timeoutMs: 20,
    pollMs: 1,
    persistSnapshot: async () => 3,
    fetcher: async () => new Response("", { status: 503 }),
  });
  await expect(handler(request)).rejects.toMatchObject({
    code: "HUMAN_REVIEW_API_TIMEOUT",
  });
});
it("aborts polling when the run is cancelled", async () => {
  const controller = new AbortController();
  let requests = 0;
  const handler = createReviewHandler({
    baseUrl: "http://localhost",
    runId: "run",
    timeoutMs: 1000,
    pollMs: 1,
    persistSnapshot: async () => 3,
    fetcher: async () => {
      requests++;
      controller.abort();
      throw Error("abort");
    },
  });
  await expect(handler(request, controller.signal)).rejects.toThrow();
  expect(requests).toBe(1);
});
it("rejects a response for a different run instead of applying its approval", async () => {
  const handler = createReviewHandler({
    baseUrl: "http://localhost",
    runId: "run",
    timeoutMs: 1000,
    pollMs: 1,
    persistSnapshot: async () => 3,
    fetcher: async (_url, init) =>
      Response.json({
        review_id: JSON.parse(String(init?.body)).review_id,
        run_id: "another-run",
        expires_at: new Date(Date.now() + 1000).toISOString(),
        status: "approved",
        run_status: "running",
      }),
  });
  await expect(handler(request)).rejects.toMatchObject({
    code: "HUMAN_REVIEW_PROTOCOL_ERROR",
  });
});
it("starts the human window after slow snapshot persistence", async () => {
  let posts = 0;
  const handler = createReviewHandler({
    baseUrl: "http://localhost",
    runId: "run",
    timeoutMs: 20,
    pollMs: 1,
    persistSnapshot: async () => {
      await new Promise((r) => setTimeout(r, 40));
      return 1;
    },
    fetcher: async (_url, init) => {
      posts++;
      return Response.json({
        review_id: JSON.parse(String(init?.body)).review_id,
        run_id: "run",
        status: "approved",
        run_status: "running",
        expires_at: new Date(Date.now() + 20).toISOString(),
      });
    },
  });
  expect((await handler(request)).status).toBe("approved");
  expect(posts).toBe(1);
});
it("reads a decision committed before expiry even when polling reaches the deadline", async () => {
  let id = "";
  let reads = 0;
  const expires_at = new Date(Date.now() + 40).toISOString();
  const handler = createReviewHandler({
    baseUrl: "http://localhost",
    runId: "run",
    timeoutMs: 40,
    pollMs: 40,
    persistSnapshot: async () => 1,
    fetcher: async (_url, init) => {
      if (init?.method === "POST") id = JSON.parse(String(init.body)).review_id;
      else reads++;
      return Response.json({
        review_id: id,
        run_id: "run",
        status: reads ? "approved" : "pending",
        run_status: reads ? "running" : "awaiting_human",
        expires_at,
      });
    },
  });
  expect((await handler(request)).status).toBe("approved");
  expect(reads).toBe(1);
});
