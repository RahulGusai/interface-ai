import { z } from "zod";

/** Zod records skip __proto__; escape it while parsing and restore own data keys. */
export function objectRecord<T extends z.ZodType>(value: T) {
  const prefix = "\u0000";
  return z
    .preprocess(
      (raw) =>
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? Object.fromEntries(
              Object.entries(raw).map(([key, item]) => [
                key === "__proto__" || key.startsWith(prefix)
                  ? prefix + key
                  : key,
                item,
              ]),
            )
          : raw,
      z.record(z.string(), value),
    )
    .transform((parsed) =>
      Object.fromEntries(
        Object.entries(parsed).map(([key, item]) => [
          key.startsWith(prefix) ? key.slice(prefix.length) : key,
          item,
        ]),
      ),
    );
}
