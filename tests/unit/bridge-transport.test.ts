import { it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { Transport } from "../../src/bridge/transport.js";
it("does not complete an event until a matching persisted ACK", async () => {
  const out = new PassThrough();
  let content = "";
  out.on("data", (b) => (content += b));
  const t = new Transport(
    out,
    "eb5ac47b-3a57-4a68-a339-95da44b75e22",
    new AbortController(),
  );
  let completed = false;
  const pending = t
    .send("event", { event: { type: "tool_started" } }, true)
    .then(() => {
      completed = true;
    });
  await Promise.resolve();
  expect(completed).toBe(false);
  const m = JSON.parse(content);
  expect(m.message_seq).toBe(1);
  expect(() =>
    t.control({
      protocol_version: 1,
      type: "ack",
      run_id: t.runId,
      message_seq: 2,
      event_sequence: 4,
      continue: true,
    }),
  ).toThrow();
  t.control({
    protocol_version: 1,
    type: "ack",
    run_id: t.runId,
    message_seq: 1,
    event_sequence: 4,
    continue: true,
  });
  await pending;
  expect(completed).toBe(true);
});
it("negative ACK fails execution", async () => {
  const t = new Transport(
    new PassThrough(),
    "eb5ac47b-3a57-4a68-a339-95da44b75e22",
    new AbortController(),
  );
  const pending = t.send("event", {}, true);
  t.control({
    protocol_version: 1,
    type: "ack",
    run_id: t.runId,
    message_seq: 1,
    event_sequence: 1,
    continue: false,
  });
  await expect(pending).rejects.toThrow("PERSISTENCE_REJECTED");
});
