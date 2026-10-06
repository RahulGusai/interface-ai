import { z } from "zod";
import { taskInputSchema } from "../contracts/run.js";
export const parseTaskInput = (raw: unknown) => taskInputSchema.parse(raw);
export const maxToolCalls = (raw: unknown = 40) =>
  z.number().finite().int().positive().parse(raw);
export function loadOpenRouterConfig(env: Record<string, string | undefined>) {
  for (const key of ["OPENROUTER_API_KEY", "OPENROUTER_MODEL"])
    if (!env[key]?.trim()) throw new Error(`Missing ${key}`);
  return {
    apiKey: env.OPENROUTER_API_KEY!.trim(),
    model: env.OPENROUTER_MODEL!.trim(),
  };
}
export const browserDefaults = {
  headless: false,
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  navigationMs: 15000,
  actionMs: 5000,
  captureMs: 5000,
  waitMs: 5000,
  pollMs: 100,
  semanticCapture: true,
  slowMo: 0,
};
export type BrowserOptions = typeof browserDefaults;
