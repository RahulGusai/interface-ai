import { z } from "zod";
export const dialogEventSchema = z.strictObject({
  type: z.string(),
  message: z.string(),
  decision: z.enum(["accept", "dismiss", "intervention"]),
  action: z.enum(["accepted", "dismissed", "pending"]),
});
export type DialogEvent = z.infer<typeof dialogEventSchema>;
export class SafeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
