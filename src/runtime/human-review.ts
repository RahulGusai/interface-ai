import type { ExecutionAssessment } from "../contracts/execution.js";
import type { Capture } from "../contracts/observation.js";
export type ReviewSnapshot = { capture: Capture; fingerprint: string };
export type ReviewRequest = ReviewSnapshot & {
  call_id: string;
  tool: string;
  arguments: Record<string, unknown>;
  assessment?: ExecutionAssessment;
};
export type ReviewResult = {
  review_id: string;
  status: "approved" | "rejected" | "expired" | "cancelled";
};
export type ReviewHandler = (
  request: ReviewRequest,
  signal?: AbortSignal,
) => Promise<ReviewResult>;
