import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { randomUUID } from "node:crypto";
import type { BrowserAdapterPort } from "../surface.js";
import { browserDefaults, type BrowserOptions } from "../../runtime/config.js";
import { validateToolResponse } from "../../runtime/tool-response.js";
import { SafeError } from "../../contracts/errors.js";
import {
  toolResultSchemas,
  type BrowserAction,
  type ToolResponse,
} from "../../contracts/tools.js";
import type { Capture, Observation } from "../../contracts/observation.js";
import { collectControls } from "./capture.js";
import {
  resolve,
  layoutSignature,
  type Binding,
  type Resolved,
} from "./targets.js";
import { click, typeText, pressKey, selectOption } from "./input.js";
import { scroll } from "./scroll.js";
import { evaluateCondition } from "./conditions.js";
import { readProperty, convertNumber } from "./extraction.js";
import { installEvents, type EventState } from "./events.js";
const failedObservation = (): Observation => ({
  status: "error",
  code: "CAPTURE_FAILED",
  message: "Fresh observation unavailable",
  retryable: true,
});
export class BrowserAdapter implements BrowserAdapterPort {
  readonly kind = "browser" as const;
  readonly capabilities = new Set([
    "observe_ui",
    "navigate",
    "click",
    "type_text",
    "press_key",
    "scroll",
    "select_option",
    "wait_for",
    "check_ui",
    "extract_data",
  ]);
  private bindings = new Map<string, Binding>();
  private observationId = "";
  private observedGeneration = -1;
  private signature = "";
  private busy = false;
  private poisoned = false;
  private pending: Promise<unknown> | undefined;
  private readonly state: EventState = {
    generation: 0,
    dialogs: [],
    notify: () => {},
    closed: false,
  };
  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly options: BrowserOptions,
  ) {}
  static async create(options: Partial<BrowserOptions> = {}) {
    const config = { ...browserDefaults, ...options };
    const browser = await chromium.launch({
      headless: config.headless,
      slowMo: config.slowMo,
    });
    try {
      const context = await browser.newContext({
        viewport: config.viewport,
        deviceScaleFactor: config.deviceScaleFactor,
        serviceWorkers: "allow",
        acceptDownloads: true,
      });
      const page = await context.newPage();
      page.setDefaultTimeout(config.actionMs);
      page.setDefaultNavigationTimeout(config.navigationMs);
      const adapter = new BrowserAdapter(browser, context, page, config);
      installEvents(context, page, adapter.state);
      return adapter;
    } catch (e) {
      await browser.close();
      throw e;
    }
  }
  isCurrentObservation(id: string) {
    return (
      !!id &&
      id === this.observationId &&
      this.observedGeneration === this.state.generation &&
      !this.state.closed &&
      !this.poisoned
    );
  }
  private async invalidate() {
    this.observationId = "";
    const old = this.bindings;
    this.bindings = new Map();
    await Promise.all(
      [...old.values()].map((b) => b.element.dispose().catch(() => {})),
    );
  }
  async capture(
    mode: "screenshot" | "controls" | "both",
    options?: { includeAriaHidden?: boolean },
  ): Promise<Capture> {
    if (this.busy || this.poisoned) return { observation: failedObservation() };
    this.busy = true;
    try {
      return await this.captureInternal(mode, options?.includeAriaHidden);
    } finally {
      this.busy = false;
    }
  }
  private async captureInternal(
    mode: "screenshot" | "controls" | "both",
    includeAriaHidden = false,
  ): Promise<Capture> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operation = this.captureAttempt(mode, includeAriaHidden);
    this.pending = operation;
    try {
      const outcome = await Promise.race([
        operation.then((capture) => ({ kind: "capture" as const, capture })),
        new Promise<{ kind: "timeout" }>((resolve) => {
          timer = setTimeout(
            () => resolve({ kind: "timeout" }),
            this.options.captureMs,
          );
        }),
      ]);
      if (outcome.kind === "timeout") {
        // A Promise.race is not cancellation. Poison the adapter until close terminates the read.
        this.poisoned = true;
        this.observationId = "";
        return { observation: failedObservation() };
      }
      this.pending = undefined;
      return outcome.capture;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private async captureAttempt(
    mode: "screenshot" | "controls" | "both",
    includeAriaHidden = false,
  ): Promise<Capture> {
    const deadline = performance.now() + this.options.captureMs;
    await this.invalidate();
    while (performance.now() < deadline) {
      let fresh = new Map<string, Binding>();
      try {
        if (this.poisoned || this.state.closed || this.state.blocked)
          throw new Error();
        // DOMContentLoaded on the parent does not await newly attached iframe documents.
        // Wait only for their initial URL within the enclosing capture deadline.
        for (const frame of this.page.frames())
          if (!frame.url() || frame.url() === "about:blank") {
            await frame.waitForURL((url) => url.href !== "about:blank", {
              waitUntil: "domcontentloaded",
              timeout: this.options.captureMs,
            });
          }
        if (this.state.blocked) throw new Error();
        const generation = this.state.generation;
        const signature = await layoutSignature(this.page);
        let controls: Extract<Observation, { status: "ok" }>["controls"] = {
          status: "not_requested",
        };
        if (mode !== "screenshot") {
          if (this.options.semanticCapture) {
            const collected = await collectControls(
              this.page,
              includeAriaHidden,
            );
            fresh = collected.bindings;
            controls = { status: "available", items: collected.controls };
          } else controls = { status: "unavailable" };
        }
        let image: Capture["image"];
        let screenshot: Extract<Observation, { status: "ok" }>["screenshot"] = {
          status: "not_requested",
        };
        if (mode !== "controls") {
          const bytes = await this.page.screenshot({
            type: "png",
            scale: "css",
            timeout: this.options.captureMs,
          });
          const ref = randomUUID();
          image = { ref, mimeType: "image/png", bytes };
          screenshot = {
            status: "available",
            image_ref: ref,
            ...this.options.viewport,
          };
        }
        if (
          generation !== this.state.generation ||
          signature !== (await layoutSignature(this.page))
        ) {
          await Promise.all(
            [...fresh.values()].map((b) => b.element.dispose().catch(() => {})),
          );
          await new Promise((resolve) =>
            setTimeout(resolve, this.options.pollMs),
          );
          continue;
        }
        const title = await this.page.title();
        if (
          this.poisoned ||
          this.state.blocked ||
          generation !== this.state.generation
        )
          throw new Error();
        this.bindings = fresh;
        this.observationId = `obs_${randomUUID()}`;
        this.observedGeneration = generation;
        this.signature = signature;
        const observation: Observation = {
          status: "ok",
          observation_id: this.observationId,
          captured_at: new Date().toISOString(),
          surface: {
            id: "active-browser",
            kind: "browser",
            title,
            url: this.page.url(),
          },
          screenshot,
          controls,
        };
        return {
          observation,
          image,
        };
      } catch {
        await Promise.all(
          [...fresh.values()].map((b) => b.element.dispose().catch(() => {})),
        );
        if (this.poisoned || this.state.closed || this.state.blocked) break;
        // Navigation or rerendering can invalidate a read. Retry only the capture,
        // never the action that preceded it, within the existing capture deadline.
        await new Promise((resolve) =>
          setTimeout(resolve, this.options.pollMs),
        );
      }
    }
    return { observation: failedObservation() };
  }
  async execute(action: BrowserAction): Promise<ToolResponse> {
    if (this.busy || this.poisoned || this.state.blocked)
      return {
        result: {
          status: "needs_intervention",
          code: "PENDING_OPERATION",
          message: "Browser execution is halted",
        },
      };
    if (
      "observation_id" in action.input &&
      !this.isCurrentObservation(action.input.observation_id)
    )
      return {
        result: {
          status: "error",
          code: "STALE_OBSERVATION",
          message: "Observe again before using a reference",
        },
      };
    if (action.name === "observe_ui") {
      const c = await this.capture(action.input.mode);
      return this.project(action.name, {
        result: c.observation,
        image: c.image,
      });
    }
    this.busy = true;
    this.state.dialogs = [];
    let wake: () => void = () => {};
    const blocker = new Promise<"blocked">((r) => {
      wake = () => r("blocked");
    });
    this.state.notify = wake;
    const generation = this.state.generation;
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Retain ownership after timeout or dialog until cleanup terminates pending browser work.
    const operation = this.perform(action, generation);
    this.pending = operation;
    const settled = operation.then(
      (value) => ({ kind: "settled" as const, value }),
      (error) => ({ kind: "error" as const, error }),
    );
    try {
      const ms =
        action.name === "navigate"
          ? this.options.navigationMs
          : action.name === "wait_for"
            ? this.options.waitMs + this.options.actionMs
            : this.options.actionMs;
      const outcome = await Promise.race([
        settled,
        blocker.then(() => ({ kind: "blocked" as const })),
        new Promise<{ kind: "timeout" }>((r) => {
          timer = setTimeout(() => r({ kind: "timeout" }), ms);
        }),
      ]);
      let fields: Record<string, unknown>;
      if (outcome.kind === "settled") {
        fields = outcome.value;
        this.pending = undefined;
      } else if (outcome.kind === "error") {
        this.pending = undefined;
        const safe = outcome.error instanceof SafeError;
        fields = {
          status: safe ? "blocked" : "uncertain",
          code: safe ? outcome.error.code : "ACTION_UNCERTAIN",
          reason: safe
            ? outcome.error.message
            : "Browser action failed or acknowledgement was unavailable",
        };
        if (!safe) this.poisoned = true;
      } else {
        this.poisoned = true;
        fields = {
          status: outcome.kind === "blocked" ? "blocked" : "uncertain",
          reason:
            outcome.kind === "blocked"
              ? "Browser operation blocked"
              : "Browser operation timed out; no retry",
          ...(outcome.kind === "blocked"
            ? { blocker: this.state.blocked }
            : {}),
        };
      }
      if (this.state.blocked)
        fields = { ...fields, status: "blocked", blocker: this.state.blocked };
      const capture =
        this.poisoned || this.state.blocked
          ? (await this.invalidate(), { observation: failedObservation() })
          : await this.captureInternal("both");
      if (this.state.blocked)
        fields = { ...fields, status: "blocked", blocker: this.state.blocked };
      fields = this.completeFields(action, fields, performance.now() - started);
      if (
        capture.observation.status === "error" &&
        fields.status === "completed"
      )
        fields.status = "uncertain";
      const raw = {
        ...fields,
        observation: capture.observation,
        ...(this.state.dialogs.length
          ? { dialog_events: [...this.state.dialogs] }
          : {}),
      };
      const result = toolResultSchemas[action.name].parse(raw);
      return this.project(action.name, {
        result,
        image: "image" in capture ? capture.image : undefined,
      });
    } finally {
      if (timer) clearTimeout(timer);
      this.state.notify = () => {};
      this.busy = false;
    }
  }
  private project(name: BrowserAction["name"], response: ToolResponse) {
    return validateToolResponse(name, response);
  }
  private completeFields(
    action: BrowserAction,
    fields: Record<string, unknown>,
    elapsed: number,
  ) {
    if (action.name === "navigate")
      return {
        ...fields,
        requested_url: action.input.url,
        final_url: this.page.url(),
      };
    if (action.name === "type_text" || action.name === "select_option")
      return { verification: "unavailable", ...fields };
    if (action.name === "scroll") return { movement: "unknown", ...fields };
    if (action.name === "wait_for")
      return {
        ...fields,
        status: [
          "condition_met",
          "timed_out",
          "blocked",
          "invalidated",
          "failed",
        ].includes(String(fields.status))
          ? fields.status
          : "failed",
        elapsed_ms: elapsed,
      };
    if (action.name === "check_ui")
      return {
        verdict: "unknown",
        ...fields,
        status: ["evaluated", "blocked", "invalidated", "failed"].includes(
          String(fields.status),
        )
          ? fields.status
          : "failed",
      };
    if (action.name === "extract_data")
      return {
        fields: {},
        ...fields,
        status: [
          "completed",
          "partial",
          "blocked",
          "invalidated",
          "failed",
        ].includes(String(fields.status))
          ? fields.status
          : "failed",
      };
    return fields;
  }
  private async perform(
    action: BrowserAction,
    generation: number,
  ): Promise<Record<string, unknown>> {
    if (action.name === "navigate") {
      await this.page.goto(action.input.url, {
        waitUntil: "domcontentloaded",
        timeout: this.options.navigationMs,
      });
      return { status: "completed" };
    }
    if (action.name === "check_ui" || action.name === "wait_for") {
      const binding = this.bindings.get(action.input.target.control_ref);
      const start = performance.now();
      do {
        if (this.state.generation !== generation)
          return {
            status: "invalidated",
            ...(action.name === "check_ui" ? { verdict: "unknown" } : {}),
          };
        const evaluation = await evaluateCondition(
          binding,
          action.input.condition,
        );
        if (this.state.generation !== generation)
          return {
            status: "invalidated",
            ...(action.name === "check_ui" ? { verdict: "unknown" } : {}),
          };
        if (action.name === "check_ui")
          return { status: "evaluated", ...evaluation };
        if (evaluation.verdict === "pass") return { status: "condition_met" };
        if (!binding) return { status: "failed", reason: "Unknown control" };
        await new Promise((r) => setTimeout(r, this.options.pollMs));
      } while (performance.now() - start < this.options.waitMs);
      return { status: "timed_out" };
    }
    if (action.name === "extract_data") {
      const fields: Record<string, unknown> = Object.create(null);
      let successes = 0;
      for (const field of action.input.fields) {
        if (this.state.generation !== generation)
          return { status: "invalidated", fields: {} };
        let value = await readProperty(
          this.bindings.get(field.target.control_ref),
          field.property,
        );
        if (value === undefined) {
          fields[field.name] = {
            status: "error",
            code: "UNREADABLE",
            message: "Field is not readable",
          };
          continue;
        }
        const converted =
          field.output_type === "number" ? convertNumber(value) : value;
        if (converted === undefined) {
          fields[field.name] = {
            status: "error",
            code: "INVALID_NUMBER",
            message: "Expected a plain finite decimal",
          };
          continue;
        }
        fields[field.name] = { status: "extracted", value: converted };
        successes++;
      }
      if (this.state.generation !== generation)
        return { status: "invalidated", fields: {} };
      return {
        status:
          successes === action.input.fields.length
            ? "completed"
            : successes
              ? "partial"
              : "failed",
        fields,
      };
    }
    let target: Resolved | undefined;
    if ("target" in action.input && action.input.target)
      target = await resolve(
        this.page,
        this.bindings,
        action.input.target,
        this.signature,
      );
    this.observationId = "";
    if (action.name === "click") {
      await click(this.page, target!, this.options.actionMs);
      return { status: "completed" };
    }
    if (action.name === "type_text") {
      const r = await typeText(
        this.page,
        target!,
        action.input.text,
        action.input.mode,
        this.options.actionMs,
      );
      return {
        status:
          r.verification === "matched"
            ? "completed"
            : r.verification === "mismatched"
              ? "failed"
              : "uncertain",
        ...r,
      };
    }
    if (action.name === "press_key") {
      await pressKey(this.page, target, action.input.keys);
      return { status: "completed" };
    }
    if (action.name === "select_option") {
      const r = await selectOption(
        target!,
        action.input.option.label,
        this.options.actionMs,
      );
      return {
        status: r.verification === "matched" ? "completed" : "failed",
        ...r,
      };
    }
    if (action.name === "scroll")
      return {
        status: "completed",
        ...(await scroll(
          this.page,
          target,
          action.input.direction,
          action.input.distance,
        )),
      };
    throw new SafeError("UNSUPPORTED", "Unsupported action");
  }
  async close() {
    this.poisoned = true;
    await this.context.close().catch(() => {});
    await this.browser.close().catch(() => {});
    await this.pending?.catch(() => {});
    await this.invalidate();
  }
}
