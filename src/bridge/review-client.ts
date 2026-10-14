import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { ReviewHandler, ReviewRequest } from "../runtime/human-review.js";
import { SafeError } from "../contracts/errors.js";
const reviewResponse = z.object({
  review_id: z.string(),
  run_id: z.string(),
  status: z.enum(["pending", "approved", "rejected", "expired", "cancelled"]),
  run_status: z.string(),
  expires_at: z.iso.datetime({ offset: true }),
  selected_candidate_id: z.string().min(1).nullable().optional(),
  refresh_targets: z.boolean().default(false),
});
export function createReviewHandler(options: {
  baseUrl: string;
  runId: string;
  timeoutMs: number;
  pollMs?: number;
  persistSnapshot: (request: ReviewRequest) => Promise<number>;
  fetcher?: typeof fetch;
}): ReviewHandler {
  const origin = new URL(options.baseUrl);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  )
    throw Error("INVALID_REVIEW_API_URL");
  const base = options.baseUrl.replace(/\/$/, "");
  return async (request, signal) => {
    const reviewId = randomUUID();
    // Snapshot persistence is separately bounded by the acknowledged event pipe.
    // Creation retries must not consume the server's subsequent review window.
    let deadline: AbortSignal | undefined;
    let created = false;
    let expiresAt: number | undefined;
    const waiting = () =>
      signal ? AbortSignal.any([signal, deadline!]) : deadline!;
    try {
      const eventSequence = await options.persistSnapshot(request);
      const body = JSON.stringify({
        review_id: reviewId,
        call_id: request.call_id,
        tool: request.tool,
        arguments: request.arguments,
        assessment: request.assessment ?? null,
        event_sequence: eventSequence,
        state_fingerprint: request.fingerprint,
        target_resolution: request.target_resolution ?? null,
      });
      deadline = AbortSignal.timeout(options.timeoutMs);
      for (;;) {
        const waitSignal = waiting();
        waitSignal.throwIfAborted();
        let response: Response | undefined;
        try {
          response = await (options.fetcher ?? fetch)(
            created
              ? `${base}/v1/human-reviews/${reviewId}`
              : `${base}/v1/runs/${options.runId}/human-reviews`,
            {
              method: created ? "GET" : "POST",
              headers: { "Content-Type": "application/json" },
              ...(created ? {} : { body }),
              signal: AbortSignal.any([waitSignal, AbortSignal.timeout(5000)]),
            },
          );
        } catch {
          waitSignal.throwIfAborted();
        }
        if (response && response.status < 500 && !response.ok)
          throw new SafeError(
            "HUMAN_REVIEW_API_ERROR",
            `Review API rejected request (${response.status})`,
          );
        if (response?.ok) {
          const r = reviewResponse.safeParse(await response.json());
          if (
            !r.success ||
            r.data.review_id !== reviewId ||
            r.data.run_id !== options.runId
          )
            throw new SafeError(
              "HUMAN_REVIEW_PROTOCOL_ERROR",
              "Review response identity or status is invalid",
            );
          if (!created) {
            expiresAt = Date.parse(r.data.expires_at);
            // One final bounded status read can observe approval committed before
            // expiry. The API atomically expires pending rows on that read.
            deadline = AbortSignal.timeout(
              Math.max(1, expiresAt - Date.now()) + 5000,
            );
            created = true;
          }
          if (!["running", "awaiting_human"].includes(r.data.run_status))
            return { review_id: reviewId, status: "cancelled" };
          if (r.data.status !== "pending") {
            if (r.data.status === "approved" && request.target_resolution) {
              const selection = r.data.selected_candidate_id;
              const offered = request.target_resolution.candidates.some(
                (c) => c.id === selection,
              );
              if (r.data.refresh_targets ? selection != null : !offered)
                throw new SafeError(
                  "HUMAN_REVIEW_PROTOCOL_ERROR",
                  "Target review must select an offered candidate or refresh",
                );
            }
            return {
              review_id: reviewId,
              status: r.data.status,
              selected_candidate_id: r.data.selected_candidate_id ?? null,
              refresh_targets: r.data.refresh_targets,
            };
          }
        }
        const untilExpiry =
          expiresAt === undefined ? undefined : expiresAt - Date.now();
        const pause =
          untilExpiry !== undefined && untilExpiry > 0
            ? Math.min(options.pollMs ?? 1000, untilExpiry)
            : (options.pollMs ?? 1000);
        await delay(pause, undefined, { signal: waiting() });
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (deadline?.aborted) {
        if (!created)
          throw new SafeError(
            "HUMAN_REVIEW_API_TIMEOUT",
            "Review creation could not be confirmed",
          );
        return { review_id: reviewId, status: "expired" };
      }
      throw error;
    }
  };
}
