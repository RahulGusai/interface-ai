import { randomUUID } from "node:crypto";
export type InterventionContext = { halted: boolean; interventionId?: string };
export function requestIntervention(context: InterventionContext) {
  context.halted = true;
  context.interventionId ??= randomUUID();
  return { status: "requested" as const, request_id: context.interventionId };
}
