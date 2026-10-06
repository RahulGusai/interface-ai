import type { Capture } from "../contracts/observation.js";
import { semanticMatches, type BindingContext } from "./targets.js";
import { resolveBindings } from "./bindings.js";
export type Verdict = {
  check_id: string;
  verdict: "pass" | "fail" | "unknown";
  expected: unknown;
  observed: unknown;
};
export function evaluateCheck(
  check: any,
  capture: Capture,
  c: BindingContext,
  currentStep?: string,
): Verdict {
  let observed: unknown,
    expected: unknown = check.expected;
  try {
    switch (check.kind) {
      case "all":
      case "any": {
        const v = check.checks.map((x: any) =>
          evaluateCheck(x, capture, c, currentStep),
        );
        observed = v;
        expected = check.kind;
        return {
          check_id: check.check_id,
          verdict: v.some((x: Verdict) => x.verdict === "unknown")
            ? "unknown"
            : (
                  check.kind === "all"
                    ? v.every((x: Verdict) => x.verdict === "pass")
                    : v.some((x: Verdict) => x.verdict === "pass")
                )
              ? "pass"
              : "fail",
          expected,
          observed,
        };
      }
      case "tool_status_equals":
      case "tool_verification": {
        const result = c.results[check.step_id ?? currentStep ?? ""] as any;
        if (!result) throw Error();
        observed =
          result[
            check.kind === "tool_verification" ? "verification" : "status"
          ];
        break;
      }
      case "field_equals":
        observed = resolveBindings(
          check.actual,
          c.inputs,
          c.results,
          c.environment,
        );
        expected = resolveBindings(
          check.expected,
          c.inputs,
          c.results,
          c.environment,
        );
        break;
      default: {
        if (check.target.kind !== "semantic") throw Error();
        const matches = semanticMatches(check.target, capture, c);
        if (check.kind === "control_absent") {
          expected = 0;
          observed = matches.length;
          break;
        }
        if (matches.length !== 1) {
          expected = 1;
          observed = matches.length;
          return {
            check_id: check.check_id,
            verdict: "fail",
            expected,
            observed,
          };
        }
        if (check.kind === "control_visible") {
          observed = true;
          expected = true;
        } else {
          observed =
            check.kind === "control_text_equals"
              ? matches[0]!.name
              : matches[0]!.value;
          expected = resolveBindings(
            check.expected,
            c.inputs,
            c.results,
            c.environment,
          );
        }
        break;
      }
    }
    if (observed === undefined) throw Error();
    return {
      check_id: check.check_id,
      verdict:
        JSON.stringify(observed) === JSON.stringify(expected) ? "pass" : "fail",
      expected,
      observed,
    };
  } catch {
    return {
      check_id: check.check_id,
      verdict: "unknown",
      expected,
      observed: null,
    };
  }
}
