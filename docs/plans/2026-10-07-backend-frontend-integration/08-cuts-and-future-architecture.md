# Deferred requirements and future architecture

This file is **report-only**, not an implementation plan/workstream or acceptance gate for this pass. Latest scope explicitly excludes human intervention/handoff and new safety/policy guardrails. Existing runtime protections remain in force. No tasks/endpoints/prompts in this pack implement intervention requests, human ownership transitions, pause/takeover/return/resume, or human action recording.

## Deferred assignment requirements

The assignment's Section 3.6 requires a real same-live-session human takeover and resume mechanism. This pass does not deliver it. Local Chromium visibility or mocked buttons do not satisfy it. Sections 3.4/Safety still have existing domain/action validation, redaction and screenshot gating; new guardrail expansion is deferred. Phase acceptance in 10/11 concerns authorized lifecycle/discovery/replay/storage/API/integration only and is not full assignment completion.

The existing runtime's request_human/needs_intervention halts a task and closes the adapter; retain that behavior/protection and record its stop result as failure. It does not become a backend request queue or waiting_handoff state. Frontend `/handoffs` remains explicitly simulated/deferred with no production network mutations. Real run pages must not display simulated human owner or imply live takeover availability.

## Future local handoff continuity (design only)

A future local mechanism would preserve the same visible Chromium session, stop dispatch, settle in-flight action, discard queued model actions, and use the sequence automation running -> awaiting takeover (neither acts) -> human controlling -> automation resuming (fresh observation/validation) -> running/completed. Returning control must reconcile completed checkpoints, not blindly repeat a mutation. Automation ownership can prevent its own input but cannot physically prevent direct human clicking in an ordinary local window. Human actions/evidence can be captured where supportable; unsupported OS/browser actions must not be claimed recorded. None of those state transitions/controls/listeners are implemented or accepted in this phase.

Railway headless browser is remote from the user's computer. Hosted API + its local subprocess does not operate the user's local visible window. Current local demo co-locates API/Node/Chromium; hosted integration co-locates API/Node/headless Chromium on Railway. A future hosted-control/local-runner transport would need trusted registration, command acknowledgement and disconnect/lifetime design; it is not smuggled into the current JSONL same-host bridge.

## Future remote operator console (design only)

Isolated virtual desktop/browser, embedded operator viewer, noVNC/server input gateway, ownership generations, disconnect leases and stale-input rejection could supply remote takeover. Those are report discussion, not dependencies, infrastructure provisioning or controls in the existing Lovable UI. No new container/VNC/router project is planned here.

## Scale and heterogeneous surfaces (design only)

Keep `BrowserAdapterPort` as perception/action seam. A future legacy/desktop adapter implements observe/act/current-target contracts; artifacts retain stable abstract tool/target/check contracts. Browser-only scopes/visual captures require a new supported surface schema version, not silent reuse of browser refs in desktop.

Replacing the in-memory queue with a durable broker/worker pool would require explicit job leases, at-least-once delivery handling and idempotent control operations, with uncertain mutations never replayed just because a lease expires. Multi-worker storage can move behind repository interfaces with a separately justified database migration; SQLite single-replica deployment is the current locked choice, not a hidden PostgreSQL plan.

Capabilities separate reusable meaning from vendor implementation versions and deployment configuration. Future cross-deployment candidate provisioning can use catalog metadata to propose validation candidates, never as proof of live compatibility. No Tenant X -> Tenant Y bulk bindings, tenant/product registries, general onboarding machinery or UI candidate endpoints are delivered now. Visual anchors can need variant-specific artifacts after branding/theme/release changes; metadata and image matching do not magically generalize.

A future guardrail pass may extend configuration/approval/risk handling and privacy guarantees. This pack preserves RuntimePolicy/dispatch validation and permitted audit projection without introducing new policy flags/endpoints or weakening existing protections to make replay succeed.
