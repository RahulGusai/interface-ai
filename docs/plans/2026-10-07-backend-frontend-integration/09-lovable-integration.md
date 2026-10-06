# Existing Lovable frontend integration implementation plan

> For future execution: use superpowers:executing-plans after implementation is requested. Prompt files are future handoffs only; do not send them during this planning task.

**Goal:** Replace synthetic lifecycle data with the real API while preserving the existing modern interface.
**Architecture:** Generated transport DTOs + one query/mutation layer + thin presentation selectors. Backend owns lifecycle; existing Theme/Disclosure/primitives/router own presentation. Mock handoff remains isolated and clearly deferred.
**Tech stack:** Existing React/TanStack Router/Query, TypeScript, current shadcn/sonner/theme components, FastAPI OpenAPI.
**Spec:** [07-api-contracts.md](07-api-contracts.md), pinned remote UX-CONTRACT.md at `93cb7664b8b135482ef8392d90a899efe023add7`.

## Global constraints

Only project `6f60c709-4fda-4f4e-8a77-4430b0d24c22`. No auth, Supabase, new backend, redesign, live human handoff or candidate provisioning. Reconcile `app_instance_id` -> `app_deployment_id` including types and mock labels in real surfaces. Routes `/apps` can keep paths; `$id` means deployment UUID. Remote AGENTS/UX-CONTRACT mock-only statements are superseded by user integration scope, but canonical visual owners remain.

## Review focus

Reloaded direct links must load persisted data. A late response from a previous filter/run must not overwrite current screen. Browser fetch cancellation does not cancel a run. Signature expiry must refresh actual images. Mutations must not emit success toasts before server acceptance. Deferred handoff cannot read/mutate production runs.

## Existing owner -> replacement -> endpoint map

| UI owner | Actual synthetic behavior to replace | Endpoint prerequisites |
|---|---|---|
| `src/routes/__root.tsx` | QueryClient already present; root DemoStoreProvider wraps app | `/health/ready`; real API provider, mock provider isolated to `/handoffs` |
| `src/lib/domain/types.ts`, `store.tsx`, `seed.ts` | AppInstance/FieldSchema arrays, keyword matchCapability/extractInputs, reducer + 650ms timers | OpenAPI DTOs + typed selectors; no mock authority for real routes |
| `src/routes/index.tsx` | Requires keyword-matched operation, extracts email/address locally, planDiscovery/start_run | GET deployments, GET recent runs, POST runs discovery, GET by-request; accept unknown NL operations |
| `src/routes/runs.index.tsx` | Client filters q/kind/status/app + sorts started/run_id/status/app, page5, nav-memory | GET runs filters/page/order, GET deployments; map URL `app` -> app_deployment_id and sort started -> started_at |
| `src/routes/runs.$id.tsx` | runProgress counts pending mock events; synthetic owner; FinalizePanel dispatches finalize_discovery | GET run/events/evidence, POST cancel, GET artifacts/validation lineage; finalization automatic backend status |
| `src/components/console/LineageStrip.tsx` | lineageFor over seed from source/pin | GET exact artifact, source run, runs?artifact_id=... (includes validation, labelled) |
| `src/routes/artifacts.index.tsx`, `artifacts.$id.tsx` | family grouping, synthetic counts/crops/checks; exact version links | GET artifacts/capability/bindings/runs/assets/deployments eligibility |
| `src/components/console/ReplayDrawer.tsx` | FieldSchema-based form, compatibleApps and demo scenario selector/planReplay | exact ArtifactDTO/schema, GET eligible deployments, POST replay; remove scenario selector |
| `src/routes/capabilities.tsx` | mock ProposalPanel manual slug/new/reuse/finalize success/failure | GET catalog/bindings/artifacts; proposal only through actual discovery; no POST capability |
| `src/routes/apps.index.tsx` | creates instance + selected unverified CandidatePicker binding | GET/POST deployments; create has no artifact selection/candidates/binding |
| `src/routes/apps.$id.tsx` | propose_binding/run_compat/discard_binding mock actions and checks array | GET deployment/bindings/runs; POST artifact validate + same-deployment activation + optional PATCH config |
| `src/components/console/CandidatePicker.tsx` | tenant onboarding candidate ordering/reuse | Remove from live paths; no candidate endpoint or replacement provisioning machinery |
| `src/routes/evidence.tsx` | SyntheticThumb, events/client filters, page8, zoom, seq deep link | GET evidence-assets, run/events/artifact assets, content-url for each actual image |
| `src/lib/domain/diagnosis.ts` | switches on target_resolution_failed, compatibility_failed, check_failed, input_validation_failed | Adapt actual structured `target_resolution_finished` verdict/diagnosis, check_finished, run outcomes and HTTP field errors |
| `src/components/console/primitives.tsx` | status tones and SyntheticThumb | Single status/outcome mapping updated for07; real image component, no synthetic thumbnail fallback |
| `src/components/console/AppShell.tsx` | global Demo banner/reset and pending handoff count | Remove global mock count/reset on live pages; retain theme/nav/mobile/disclosure; `/handoffs` labelled Mock · Deferred |
| `src/routes/handoffs.tsx`, `HandoffControl.tsx` | local simulated handoff actions | NO backend prerequisites/endpoints. Keep isolated simulation/deferred, no production IDs or calls |

Backend GET runs must support `order_by=created_at|started_at|run_id|status|app_deployment_id`, `direction=asc|desc` (null started_at sorts after real values with created_at/ID tie-breakers). This preserves current sortable headers instead of sorting only a partial server page. Artifact search q matches capability name/artifact ID/variant; add q to07 artifacts read. Evidence q matches label/detail, not raw secrets/PII. URL evidence `type` maps to asset kind; `run`, `kind`, `event`, `seq`, `page` remain; frontend crop section queries artifacts separately rather than mixing them into evidence table.

## Task 1 / Prompt 01: Transport, naming and data reads

**Files:** Create remote `src/lib/api/{client,types.gen,queries}.ts`, `src/lib/domain/selectors.ts`; modify existing domain types, root, shell, deployment/capability list routes. Preserve `src/components/console/{Theme,Disclosure}.tsx` and style tokens.
**Interfaces:** `apiFetch<T>(path,options:{signal?,idempotencyKey?,method?,body?})->Promise<T>`; query keys `["runs",filters]`, `["run",id]`, `["events",run_id]`, `["artifact",id]`, `["deployments",filters]`, `["bindings",deployment_id]`, `["asset-url",kind,id]`; API errors typed.

- [ ] Configure only `VITE_API_BASE_URL` (origin, no trailing slash) in frontend. Missing/invalid base shows configuration error, never seeds fake data. Fetch OpenAPI from supplied backend URL and generate/check DTOs. No backend secret values in frontend env/source. Existing QueryClient reused.
- [ ] Rename live type AppInstance -> AppDeployment; deployed_url -> base_url, tenant/product -> tenant_id/product_id, drop config_profile. Do not inflate backend schema for fixture-only labels/keywords/checks. Typed schema form adapter in task3.
- [ ] Remove root DemoStoreProvider authority and timers for live routes. Existing store/seed may remain only under an isolated HandoffDemoProvider route wrapper using the old simulation, with explicit "Mock · Deferred; no live control" label. Real shell shows no seeded handoff count or reset-all-data action. Do not invent demo mode feature flags, production endpoints or delete backend data on reset.
- [ ] Fetch catalog/deployment lists with loading skeleton, empty next action, inline retry error and not-found states; preserve sidebar mobile drawer/theme. Unknown HTTP data is not shown as seed fallback.
- [ ] Gate: live read pages survive full reload; no synthetic Tenant A/B IDs; missing API fails visibly; `/handoffs` remains mock and produces zero API calls. Typecheck and one focused API-error/query cancellation test PASS.

## Task 2 / Prompt 02: Run start, progress, events and cancel

**Files:** `index.tsx`, `runs.index.tsx`, `runs.$id.tsx`, primitives/diagnosis/LineageStrip; API queries.

- [ ] Composer requires only nonblank task + selected deployment; replace matchCapability/extractInputs gating with backend submission. Suggestions may only prefill synthetic safe task text and actual loaded deployment selected by user; no hardcoded seeded app ID. Show selected target/context rather than invented Matched capability. POST discovery with UUID Idempotency-Key, disable repeated submit, navigate only from accepted RunDTO. Unknown goal remains allowed.
- [ ] Pending POST timeout: retain key/body and draft, GET by-request, retry same key/body only if no record; no automatic new key. Abort on component unmount cancels HTTP fetch, not backend job. Only explicit Cancel run calls cancellation endpoint. Toast once on confirmed accepted/terminal cancel result; no fictitious "completed" toast.
- [ ] Poll active RunDTO and incremental events every 1 second while document visible, every 5 seconds hidden; pause unmounted queries and abort replaced requests. Exponential GET retry delay 1/2/4/8 seconds capped8, show stale/disconnected label without inventing failure. Disable mutation automatic retries. On terminal status, perform one final event drain until has_more=false, then stop; timeline dedupe `(run_id,sequence)` and cursor based on last scanned authoritative sequence. Refetch events from0 on full reload; no dependence on prior session memory.
- [ ] Replace percent simulated progress with discovery current activity and replay completed_steps/total_steps. API statuses map once in primitives. Show pipeline awaiting_finalization/validating, draft/validation links, initial binding ready only after actual publication. Remove Finalize artifact mock mutation. Existing runtime stop stays structured failure; no live handoff control strip.
- [ ] Pair tool_finished with matching tool_started `payload.call_id` in same run, not nearest unrelated event. Raw JSON stays closed except explicit seq/failure inspection; diagnosis stays visible. Timeline badges/source/replay lineage preserve exact IDs and validation purpose.
- [ ] Server list pagination/filter/sort mirrors URL search/nav-memory and preserves clear-filter behavior. Request AbortSignal prevents late prior filter response taking over current result.
- [ ] Gate: double-submit creates one run; cancellation during pending model dispatch blocks next tool; navigate away stops fetch but run continues; direct run link after reload shows complete event order and persistent final result.

## Task 3 / Prompt 03: Artifact review, typed replay, deployment lifecycle

**Files:** artifact routes, ReplayDrawer, capability/app routes, selectors/schema helpers; UI API mutations.

- [ ] Artifact detail renders exact published/draft definition, source and validation lineage, variant/release/schema/tool versions as distinct data. Versions link by exact artifact UUID. No raw transcript inference in browser.
- [ ] Replace FieldSchema[] with a single JSON-schema adapter `fieldsFromSchema(schema)->FieldView[]` for supported v1 subset (string/number/boolean/enum, required, format,min,max, typed default). Same helper drives inputs/coercion/client validation; server remains authority. Preserve invalid values/focus/aria/descriptions. Unsupported schema displays error and disables Replay, never silently makes text inputs. Output contract rendered, not edited.
- [ ] Remove demo scenario radios and outcome choice. Select source-deployment eligibility from exact artifact read; metadata is shown as declared support, no fake "passed compatibility". POST exact replay with typed JSON/idempotency; don't move any binding by starting replay. No auto-latest.
- [ ] Capability ProposalPanel becomes a closed disclosure explaining that discovery proposes/reuses operations, plus a link to composer; no manual capability ID/slugs/mock finalize success/failure controls. Preserve compact capability cards/contracts/counts.
- [ ] Deployment create form uses minimal tenant_id/product_id/base_url/environment/ui_variant/vendor_release; no CandidatePicker, preselection/candidates/artifact field. POST deployment creates no binding. PATCH config uses expected_config_version; on409 refetch and preserve local changes for review, don't silently overwrite. Existing config/history disclosure remains closed.
- [ ] App detail shows first ready binding/publication and exact binding history. For a newer **same-deployment** published artifact only, explicit validate action starts validation run (inputs from schema); wait for successful exact hash/current config, then enable Activate exact version using validation_run_id + expected_binding_version. Keep old binding active until confirmed activation. No arbitrary cross-deployment candidate/check/discard flows. Optional app config editor can be omitted if delivery time constrained; backend PATCH contract remains documented.
- [ ] Gate: numeric/boolean inputs keep types; validation failure does not show ready; publish v2 leaves v1 pin until deliberate activation; a run accepted under v1 still shows v1 after upgrade; no cross-deployment provisioning UI/API call.

## Task 4 / Prompt 04: Real evidence and private asset refresh

**Files:** evidence route, new `src/components/console/AssetImage.tsx`, diagnosis, lineage; artifact crop section.

- [ ] Load gallery evidence page8 and separate artifact_assets under closed reference crop section. Ordered event inspection uses run/seq; if seq is outside first event page, drain pages until found or run exhausted. Show discovery, validation and all replays with explicit purpose labels and failure diagnoses.
- [ ] AssetImage queries content-url lazily when visible/open; shows loading/expired/unavailable state, actual image bytes via `<img>`, alt/zoom. Refresh signature 30 seconds before expiry while mounted, or once on403/expired image error then retry; never endless loops, render actual unavailable state after repeated failure. Query cache stores URL transiently, not localStorage/DB. Cache keys include source kind so crop/evidence IDs cannot collide.
- [ ] Keep reference crops separate from run target-resolution/post-tool images; captions link exact run/event/crop provenance. No SyntheticThumb substitution. Preserve zoom dialog/focus/Escape/arrows, URL filters/page and active filter summary; diagnoses are derived solely from real structured payloads/outcomes.
- [ ] Gate: replay resolution failure shows fresh screenshot even though no tool was dispatched; upload/capture failure displays diagnostic and no invented thumbnail; signed refresh after expiry works; reference crop is never attached to a tool_finished row by guessed IDs.

## Task 5 / Prompt 05: Integration review and docs

- [ ] Update remote AGENTS.md/UX-CONTRACT.md/VERIFICATION.md to actual API owners, unprotected routes, deferred handoff and excluded candidate flow. UI metadata/copy says live operations only where implemented; isolated `/handoffs` says simulated/deferred. No global Demo reset affects live data.
- [ ] Run generated DTO check, existing typecheck/build, focused tests for schema coercion, idempotency timeout recovery, event cursor merge/abort and signature refresh. Browser check desktop + 390px in Light/System/Dark, direct links, closed disclosures, keyboard/focus, loading/empty/no-results/not-found/error. No test sprawl mirroring each component.
- [ ] Gate: one real discovery -> published artifact/initial ready binding -> parameterized replay -> evidence reload works; a second replay not-found and failed target are diagnosed. Mock handoff remains isolated/no network. Stop after integration checks; publishing/deployment are separate tasks.
