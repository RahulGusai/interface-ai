# Customer lookup evidence

This package comes from a genuine LLM-driven discovery on the deployed Meridian application, followed by deterministic validation and two user replays. All customer and account data shown is synthetic. The runs took place on 14 October 2026 UTC (15 October in India).

The goal was:

> Find Halima Achterberg, making sure you select the correct customer if multiple people share that name. Open their profile and report their customer ID and contact details without changing any records.

The model recorded a six-step flow: navigate, wait for fixture loading to finish, enter the customer name, search, open the matching row, and extract customer details. Validation used Halima. The successful user replay changed the input to Tomas Achterberg. The exceptional replay used a nonexistent customer and was rejected at the handoff.

## Runs and results

| Stage | Run ID | Input: `customer_name` | Final result | Events | Model proposal events |
| --- | --- | --- | --- | ---: | ---: |
| Discovery | `5541ec6e-dc77-49ea-85ef-9f623fe29573` | Halima Achterberg | Completed; artifact published after validation | 43 | 8 |
| Validation | `f90d2d48-f723-42b4-ad6b-12605303c930` | Halima Achterberg | `GOAL_ACHIEVED` | 29 | 0 |
| Changed-input replay | `5c8b0840-7270-4464-ab0e-3e457d435eed` | Tomas Achterberg | `GOAL_ACHIEVED` | 29 | 0 |
| Exceptional replay | `0e190104-fca8-4e29-b086-b9f1e6407749` | Demo Missing Customer 999999 | `HUMAN_REVIEW_REJECTED` | 23 | 0 |

| Output | Discovery and validation | Changed-input replay |
| --- | --- | --- |
| Customer ID | `C483704` | `C135291` |
| Name | Halima Achterberg | Tomas Achterberg |
| Address | 282 Cobalt Avenue | 9 Larkspur Way |
| City / postcode | Fenwick Bay ZX30 1DR | Eastholme ZX37 6CQ |
| Email | `halima.achterberg12@example.test` | `tomas.achterberg59@example.test` |
| Phone | `555-0117` | `555-0180` |

These are the observed values preserved in [runs.json](runs.json). A later fixture reset may change the live application.

## Files

| File | What to inspect |
| --- | --- |
| [artifact.json](artifact.json) | Published artifact API record, full definition, schemas, parameter bindings, output mapping and lineage. |
| [runs.json](runs.json) | All four terminal run records, frozen deployment snapshots, inputs and outcomes. |
| [discovery-events.jsonl](discovery-events.jsonl) | Complete discovery audit, including model proposals, correction feedback, draft creation and publication. |
| [validation-events.jsonl](validation-events.jsonl) | Validation replay and final checkpoint. |
| [replay-events.jsonl](replay-events.jsonl) | Successful changed-input execution, target resolution and fresh outputs. |
| [exception-replay-events.jsonl](exception-replay-events.jsonl) | Missing-target detection, pause, review decision and terminal failure. |
| [human-reviews.json](human-reviews.json) | The rejected review, pending action, screenshot ID, candidates and operator comment. |
| [capability.json](capability.json) | Capability name, description and contracts. |
| [app-deployment.json](app-deployment.json) | The target installation's exported configuration. Historical run configuration is in `runs.json`. |
| [bindings.json](bindings.json) | The ready binding to artifact v1 and its successful validation. |
| [evidence-assets.json](evidence-assets.json) | 53 screenshot records: asset ID, run/event join, dimensions, byte size and hash. |
| [artifact-assets.json](artifact-assets.json) | Empty for this artifact: its targets are semantic and row-based, so it needs no visual crops. |
| [images/](images/) | All 53 original PNGs downloaded and verified against the stored hashes. |
| [provenance.json](provenance.json) | Export method, timestamps, API endpoints, pagination completion and event counts. |
| [manifest.json](manifest.json) | SHA-256 hashes and the mapping from asset IDs to local images. The manifest excludes its own hash. |

Artifact: `3054a0ec-043f-409c-8831-ba2eb007e5fa`, published version `1`.
Capability: `a0703f44-eb48-4757-961f-09d7bbacb8a8`, `find_customer_by_name_and_get_details`.
Binding: `5610278d-e531-45a7-ba63-cffa226f1c5b`.
Deployment: `60799cd6-75f7-492e-8257-27280a3154f9`.

The artifact definition hash is `7bf6ba9388609eb2e57b649bada1a0188a24b4d009d2d3a87937ef92e5e0eb07`. All three replay records pin that same definition. Step 3 binds typed text to `inputs.customer_name`; step 5 binds row selection to the same input. Step 6 maps freshly extracted fields into the returned outputs.

## Inspect the discovery and replay

Event sequences are contiguous and scoped to a run. Each JSONL line contains one event. From the repository root:

```sh
jq 'select(.type == "model_proposed" or .type == "discovery_correction")' \
  evidence/member-lookup/discovery-events.jsonl
jq 'select(.sequence == 16 or .sequence == 27 or .sequence == 29)' \
  evidence/member-lookup/replay-events.jsonl
jq '.[] | {kind,purpose,run_id,inputs,status,outcome}' evidence/member-lookup/runs.json
```

In discovery, sequence 4 contains generated capability metadata. The model proposals span sequences 7–30; sequences 13 and 23 preserve corrections for an unbound input and a missing row match. Sequence 37 creates the draft, and sequence 42 publishes it after validation. Failed proposals and correction feedback remain in the log.

In the successful replay, sequence 16 resolves exactly one link, `Open Tomas Achterberg C135291`. Sequence 26 contains the extracted values, sequence 27 passes `recorded_sequence_completed`, and sequence 29 records the success outcome. Validation has the same checkpoint for Halima.

The deployed discovery branch constructs `OpenRouterClient`; its saved audit contains eight model proposal events and their tool calls. The replay branch calls `runReplay` without a model, and all three replay logs have zero model proposal events. See [runner-cli.ts](../../src/bridge/runner-cli.ts). The run's `configured-model` label is a placeholder, not the model's identity. This export does not contain a provider billing receipt or raw provider HTTP trace.

## Exceptional replay

Read [exception-replay-events.jsonl](exception-replay-events.jsonl) in sequence:

| Sequence | Evidence |
| --- | --- |
| 16–17 | Step 5 reports `TARGET_NOT_FOUND`: one match required, zero found. |
| 18 | Current UI captured for human review. |
| 19–20 | Run enters `awaiting_human` and links the review request. |
| 21 | Operator rejects, explaining that no candidate opens the requested record. |
| 23 | Run fails with `HUMAN_REVIEW_REJECTED`, `failure_stage: "execution"`, `step_id: "step_5"`, `dispatch_state: "not_dispatched"`. |

There is no step-5 click dispatch or step-6 extraction after rejection. The human review is `120734f6-b5fb-4fff-b0f8-219d1aa89991`. Its [screenshot](images/df7985e6-4c5e-4eb4-b1a6-d5a376642d96.png) shows the missing-customer search state.

This is a missing-target escalation followed by a deliberate stop. The artifact's `business_outcomes` array is empty, so this example does not demonstrate a typed customer-not-found business result. The review's generic `reason` says “Missing or invalid execution assessment”; `target_resolution.reason: "not_found"` and sequences 16–17 establish the actual trigger. The exported record preserves that wording.

## Provenance and verification

This package was exported through read-only GET requests to the deployed API. JSON files preserve the returned API records; JSONL files preserve event order and payloads. API DTOs omit internal request/idempotency fields and add some derived state, so this is an API export, not a raw database dump. All collection pages were read, and event cursors reached `has_more=false`. Terminal run and artifact records were re-read after downloads to check that their state had not changed.

Image bytes were downloaded using short-lived signed content URLs, then checked against each asset's stored SHA-256, byte size and dimensions. The URLs and server credentials are not included. Object keys in metadata are opaque storage identifiers, not access credentials. Hashes detect changed files; they are not an independent signature of the service's records.

From the repository root, verify every file in the evidence package:

```sh
(cd evidence && shasum -a 256 -c SHA256SUMS)
```

On Linux, `sha256sum -c SHA256SUMS` can be used from the `evidence` directory. To verify the artifact definition separately using the backend's canonicalization:

```sh
PYTHONPATH=backend backend/.venv/bin/python - <<'PYTHON'
import json
from pathlib import Path
from interface_api.artifact_validation import digest
artifact = json.loads(Path("evidence/member-lookup/artifact.json").read_text())
assert digest(artifact["definition"]) == artifact["definition_sha256"]
print("Artifact definition hash verified")
PYTHON
```

To locate an image for a specific event, filter `evidence-assets.json` by `run_id` and `event_sequence`, then look up the asset ID in `manifest.json` under `export_path`. Screenshots retain synthetic customer details so the recorded outputs can be checked visually.

## Reproduce

Follow the [repository README](../../README.md#demo-goal-to-artifact-to-replay) to create a new discovery, validate it and replay it with changed inputs. Those commands create fresh run IDs. The local SQLite exporter can only read IDs stored in its own configured backend; it cannot retrieve these hosted records from an empty local database.

The console recording is [../demo.mp4](../demo.mp4). It shows screenshots, logs, payloads and a same-session decision handoff. It does not show a continuously streamed agent browser or direct mouse/keyboard takeover. All four runs use `READ_ONLY`; the implementation currently bypasses action/domain enforcement in that mode. The demo's read-only behavior comes from the chosen task, not an enforced write prohibition. These limits are described in the [report](../../REPORT.md).
