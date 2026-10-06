# Architecture

FastAPI is the control plane. It owns opaque IDs, lifecycle, input contracts, exact selection snapshots, a SQLite database and private MinIO storage. The database contains eight tables: runs, artifacts, artifact assets, run events, evidence assets, capabilities, app deployments and capability bindings. Node retains the existing typed tool dispatcher, Playwright browser and OpenRouter model loop. One in-memory worker supervises one child/browser at a time, with 16 pending jobs. Protocol events are acknowledged only after image upload and the event/asset metadata transaction have completed. Upload failure stops the child before another action; confirmed object bytes followed by a database failure can leave an orphan for conservative operator cleanup.

Discovery passes the original natural language task and stable capability catalog to the model. The model explicitly proposes reuse or a new operation; Python does not infer semantic identity from names or schema similarity. Source discovery is provisional until an observed durable plan is frozen, replayed successfully in a linked validation run, and atomically published. The first ready binding is part of that publication transaction. Subsequent versions require deliberate activation to change an existing binding.

Local execution can use a visible browser. The Railway recipe uses headless Chromium, one API process/replica and a persistent `/app/data` volume. No deployment or storage provisioning has been performed. The queue is not recoverable: restart interrupts unfinished runs instead of repeating potentially dispatched actions.

# Artifact schema

Artifact v1 stores surface/compatibility metadata, closed flat input/output JSON schemas, a trusted entry URL binding, ordered named steps, durable targets, finite checks, bounded recovery and output mappings. The shared structural schema is generated from TypeScript/Zod and used by Python. Bindings are explicit literal, input, prior-step output, trusted environment URL or primitive string template values. Number and boolean values stay typed; declared defaults are applied during input validation.

Artifacts contain no historical observation/control/call IDs or recorded global point coordinates. Semantic targets use exact role/name, optionally bounded by named ancestor/frame descriptions. Point-capable tools use a pre-action PNG crop, immutable hash and normalized point within that crop. Python allocates final reference IDs and preserves event provenance separately. Publication freezes the executable definition; validation records the exact hash. Published capability schemas and artifact definitions are immutable. Every admitted replay pins an artifact ID/version/hash and deployment configuration, optionally with a binding snapshot.

# Determinism & error handling

Replay has no model dependency. It navigates through the existing dispatcher, captures fresh state, resolves each target uniquely, persists resolution evidence before dispatch, builds new transient refs/call IDs, and checks the resulting state. Tool uncertainty, duplicate/missing targets, failed entry conditions and malformed outputs cannot become success. The synthetic member fixture exercises search, opening a parameterized result, and status extraction for two inputs. A declared missing member is an expected business outcome, not a crash.

`rgb-template-v1` compares RGB at all integer translations with a pinned threshold of at least 0.95, exact accumulated-error rejection and IoU suppression of one physical anchor cluster. Flat crops are rejected. Exactly one surviving candidate is required, at the same viewport/scale and orientation. Shift and duplicate-anchor tests pass the two-second fixture gate. There is no OCR, rescaling, semantic fallback or cross-branding promise.

Read recovery is bounded to two waits or one explicitly saved interstitial action. A dispatched mutation is not blindly retried. Cancellation checks run around provider calls and before tools; provider abort and process-group cleanup bound shutdown. Events use monotonic database sequences, including filtered cursor advancement. HTTP starts require idempotency keys; configuration and binding changes use compare-and-swap versions. Storage/network failures have sanitized errors and honest missing/partial evidence. An interrupted or cancelled run remains a lifecycle stop with an explicit dispatch uncertainty.

# Heterogeneity & multi-tenant

Minimal deployment registration stores tenant/product IDs, trusted base URL, environment, UI variant, exact optional vendor release and a configuration version. It does not provision tenant registries or candidate deployments. A capability is a stable typed operation; immutable artifact versions can implement that operation differently. Bindings track deployment-specific validated selection history. A changed deployment configuration invalidates readiness without rewriting historical runs. Every execution still performs fresh entry checks even after prior validation.

This phase supports validation, replay and activation on the artifact's source deployment only. Cross-deployment portability, provisioning and broader compatibility matrices are deferred. A null vendor release is unspecified provenance; it does not prove support for all vendor releases.

# Escalation & handoff

Live human handoff is deferred. The existing `request_human` behavior halts and closes autonomous execution; the backend maps it to `RUNTIME_STOPPED_REQUIRES_HUMAN`, not to a retained session, waiting state or ownership transfer. No pause/resume, remote viewer, takeover endpoints or human request tables are implemented. Any frontend handoff simulation remains a separate mock. A future same-session handoff needs its own agreed ownership, transport and execution-lifetime contract.

# Safety

Existing runtime protections remain in use: trusted document/resource origin/path policy, action permissions, dialog decisions, stale observation rejection, layout checks, output validation and policy-projected screenshot bytes. Model history retains actual permitted inline image bytes and observation correlation; MinIO URLs do not replace them. Credentials are server-side and excluded from argv, pipe commands and exported records. Staging is private, relative paths cannot escape or traverse symlinks, image bytes and metadata are verified, and the service does not create public bucket policies.

No new guardrail system or authentication workstream is added. The public phase API and exact-origin CORS are the agreed scope; CORS is not authentication. Export is explicit and requires a synthetic-data declaration plus operator inspection before sharing.

# Cuts

The Lovable frontend integration, candidate provisioning, cross-deployment activation/validation, authentication, durable broker/queue, multiple workers/replicas, automatic retry, remote browser transport, live handoff and new policy controls are excluded. Legacy examples and historical GLM runs are not seeded as published capabilities. No public push, deployment, email submission or external sharing has occurred.

Backend code and offline/real-browser boundary tests are implemented. Genuine configured-provider discovery and actual MinIO upload/download/signature checks remain external acceptance gates because this workspace lacks the model/storage configuration; see the verification record. A genuine example package is therefore not presented as completed evidence. Docker runtime/volume and hosted behavior have not been independently verified. This phase completion is separate from full assignment readiness, which still needs the deferred handoff and guardrail scope.
