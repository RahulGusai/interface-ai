import {
  mkdirSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ImageContent } from "../contracts/observation.js";
import type { ToolCall, RunResult } from "../contracts/run.js";
import type { ToolResponse } from "../contracts/tools.js";
import type { CapabilityMetadata } from "./capability-metadata.js";

export type AuditRecord =
  | {
      type: "capability_metadata_generated";
      metadata: CapabilityMetadata;
      inputs: Record<string, unknown>;
    }
  | {
      type: "run_started";
      targetUrl: string;
      goal: string;
      maxToolCalls: number;
    }
  | { type: "model_proposed"; modelTurn: number; calls: ToolCall[] }
  | { type: "model_final_text"; modelTurn: number; text: string }
  | {
      type: "provider_retry";
      modelTurn: number;
      attempt: number;
      max_attempts: number;
      stage?: "capability_metadata";
      error: { code: string; message: string };
    }
  | {
      type: "provider_failed";
      modelTurn: number;
      stage?: "capability_metadata";
      error: { code: string; message: string };
      elapsedMs: number;
    }
  | {
      type: "tool_started";
      modelTurn: number;
      call: ToolCall;
      input: unknown;
      source: "bootstrap" | "model";
    }
  | {
      type: "tool_finished";
      modelTurn: number;
      call: ToolCall;
      result: ToolResponse["result"];
      elapsedMs: number;
    }
  | {
      type: "tool_not_executed";
      modelTurn: number;
      calls: ToolCall[];
      reason: string;
    }
  | { type: "run_finished"; result: RunResult };
export type AuditSink = (record: AuditRecord, image?: ImageContent) => unknown;

/** Synchronous durable writes intentionally fail closed before the next action. */
export function createFileAudit(directory: string) {
  mkdirSync(join(directory, "screenshots"), { recursive: true, mode: 0o700 });
  const fd = openSync(join(directory, "audit.jsonl"), "ax", 0o600);
  let sequence = 0;
  let failed = false;
  const write: AuditSink = (record, image) => {
    if (failed) throw new Error("Audit unavailable");
    try {
      const seq = ++sequence;
      const screenshot = image
        ? `screenshots/${String(seq).padStart(4, "0")}.png`
        : undefined;
      if (image && screenshot)
        writeFileSync(join(directory, screenshot), image.bytes, {
          flag: "wx",
          mode: 0o600,
        });
      const line =
        JSON.stringify({
          sequence: seq,
          timestamp: new Date().toISOString(),
          ...record,
          ...(screenshot ? { screenshot, imageRef: image!.ref } : {}),
        }) + "\n";
      const bytes = Buffer.from(line);
      let offset = 0;
      while (offset < bytes.length)
        offset += writeSync(fd, bytes, offset, bytes.length - offset);
      fsyncSync(fd);
    } catch (error) {
      failed = true;
      throw error;
    }
  };
  return { write, close: () => closeSync(fd) };
}
