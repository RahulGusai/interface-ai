# Submission evidence

This folder contains the saved artifact and complete logs from the recorded customer-lookup demonstration, including its validation, successful changed-input replay and exceptional replay. The customer data is synthetic. The discovery used the deployed model-backed runtime against the live Meridian application.

Start with the [recording](demo.mp4) or the [run-by-run evidence guide](member-lookup/README.md). The [design report](../REPORT.md) explains the architecture and limits; the [repository README](../README.md) gives setup and reproduction commands.

```text
evidence/
  README.md
  SHA256SUMS
  demo.mp4
  member-lookup/
    README.md
    artifact.json
    runs.json
    discovery-events.jsonl
    validation-events.jsonl
    replay-events.jsonl
    exception-replay-events.jsonl
    human-reviews.json
    capability.json
    app-deployment.json
    bindings.json
    artifact-assets.json
    evidence-assets.json
    provenance.json
    manifest.json
    images/                         # 53 original verified screenshots
```

## Recording

[demo.mp4](demo.mp4) is 5 minutes 34 seconds at 1440 × 1000. The opening 20 seconds and selected long idle intervals were removed. Remaining interactions play at their recorded speed; some pauses remain. The video is edited for viewing, so its timeline is shorter than the original event timestamps. The JSONL logs retain the complete audit, including waits and rejected proposals.

| Video time | What is shown |
| --- | --- |
| 00:00 | Discovery goal and start |
| 00:16 | Discovery events, model proposals and payloads |
| 01:22 | Screenshot evidence |
| 01:49 | Saved draft artifact and validation |
| 02:23 | Successful validation result |
| 03:02 | Replay with Tomas Achterberg and fresh outputs |
| 03:48 | Nonexistent-customer replay input |
| 04:18 | Missing target, review context and rejection |
| 05:01 | Failure outcome and artifact lineage |

The console displays progress, backend screenshots, logs and review decisions. It does not stream the browser continuously. The handoff retains the same browser session while an operator decides whether an action should proceed; embedding that session for direct mouse/keyboard control is the next step.

Two labels visible in the recording need context: the `READ_ONLY` helper text overstates enforcement, and the missing-target review uses a generic assessment-related reason. The actual policy limit and target-resolution payload are documented in the [evidence guide](member-lookup/README.md#exceptional-replay) and [report](../REPORT.md#safety).

## Verify the package

There are four terminal run records, 124 events and 53 screenshots. The artifact is published v1. Discovery contains eight model proposal events; validation and the two user replays contain none. The exception ends with `HUMAN_REVIEW_REJECTED` before dispatching the unresolved action.

From the repository root:

```sh
(cd evidence && shasum -a 256 -c SHA256SUMS)
```

`SHA256SUMS` covers every file here except itself, including the video and documentation. `member-lookup/manifest.json` maps image IDs to files and hashes the example's contents except itself. [provenance.json](member-lookup/provenance.json) records the API export method and completion checks. No private database, signed download URLs or model/storage credentials are included.

The assignment requires an example artifact and discovery/replay logs under `/evidence/`; the exceptional replay and recording provide additional context. The nested layout and manifests are this repository's packaging choice.
