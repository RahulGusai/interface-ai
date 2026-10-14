import type { ExecutionAssessment } from "../contracts/execution.js";
import type { Capture } from "../contracts/observation.js";
export type ReviewSnapshot = { capture: Capture; fingerprint: string };
export type TargetBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};
export type TargetResolution = {
  reason: "ambiguous" | "not_found";
  candidates: { id: string; label: string; bounds: TargetBounds }[];
};
export type ReviewRequest = ReviewSnapshot & {
  call_id: string;
  tool: string;
  arguments: Record<string, unknown>;
  assessment?: ExecutionAssessment;
  target_resolution?: TargetResolution;
};
export type ReviewResult = {
  review_id: string;
  status: "approved" | "rejected" | "expired" | "cancelled";
  selected_candidate_id?: string | null;
  refresh_targets?: boolean;
};
export type ReviewHandler = (
  request: ReviewRequest,
  signal?: AbortSignal,
) => Promise<ReviewResult>;
