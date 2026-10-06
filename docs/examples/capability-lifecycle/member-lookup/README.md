# Capability lifecycle: one worked example

**These records are illustrative. No model discovery or replay was executed to produce them.** They show the proposed successful lifecycle after capability persistence exists. The current runtime still stops at `awaiting_artifact_design`. The UI labels and member 42 result come from our synthetic member-desk fixture; port 4300 is an example address, not a running service.

## The small discovery

Goal: look up the supplied member ID and return the details displayed by the page.

```json
{
  "inputs": { "member_id": "42" },
  "outputs": {
    "member_id": "42",
    "member_summary": "Member Ada | 123.50"
  }
}
```

The runtime opens the page first. The model then makes four calls:

| Order | Who | Tool | What happens |
| --- | --- | --- | --- |
| 0 | Runtime | `navigate` | Opens the member desk and captures the first observation. |
| 1 | Model | `type_text` | Enters `42` in Member ID and verifies the value. |
| 2 | Model | `click` | Clicks Search; the page displays `Member Ada \| 123.50`. |
| 3 | Model | `extract_data` | Reads that displayed text into `member_summary`. |
| 4 | Model | `finish_task` | Proposes completion with the extracted outputs. |

Final acceptance waits for the artifact to be created, validated and published. The following files represent the final state after that process succeeds.

## 1. Run: the summary of this execution

[discovery-run.json](discovery-run.json) answers: **What happened when we tried member 42?**

```json
{
  "run_id": "run_discovery_001",
  "kind": "discovery",
  "artifact_id": "art_member_lookup_v1",
  "inputs": { "member_id": "42" },
  "status": "succeeded",
  "outputs": {
    "member_id": "42",
    "member_summary": "Member Ada | 123.50"
  },
  "events_path": "discovery-events.jsonl"
}
```

This snippet omits metadata for readability; the file contains the complete record. It is a final-state snapshot: there was no artifact when the run started.

## 2. Artifact: instructions we can execute again

[artifact.json](artifact.json) answers: **How do we look up a supplied member ID again?**

The artifact records four UI steps: open the page, enter the ID, click Search, and extract the result. It also records the input/output schemas, checks and output mapping. The replay runner finishes by validating those outputs; it does not need an LLM-issued `finish_task`.

Compare the discovery input with the stored step:

```json
{
  "observation_id": "obs_discovery_001",
  "target": { "kind": "control", "control_ref": "c3" },
  "mode": "replace",
  "text": "42"
}
```

```json
{
  "step_id": "s1_enter_id",
  "tool": "type_text",
  "target_id": "member_id_field",
  "arguments": {
    "mode": "replace",
    "text": { "source": "input", "path": "/member_id" }
  }
}
```

The artifact refers to this durable target:

```json
{
  "strategy": "semantic",
  "frame_path": [],
  "role": "textbox",
  "name": "Member ID",
  "match": "exact",
  "required_matches": 1
}
```

Replay substitutes the supplied member ID and resolves the target from a fresh observation. The stored plan does not reuse `c3` or `obs_discovery_001`. The validation example resolves the same field to `c9` instead. Source tool-call IDs in the artifact are provenance, not replay call IDs.

The result target is the unique `status` control. Its name is not hardcoded to Ada, because another member can have different result text. Success checks verify the entered ID, the expected result shape, successful extraction and the output contract.

This tiny fixture does not display the member ID in its result. It therefore verifies the searched ID and displayed details, not an independent identity check. A real application that displays the result's member ID should validate that too. `Not found` fails this example's success contract; a separate business-outcome branch is outside this example.

## 3. Run events: the chronological detail

[discovery-events.jsonl](discovery-events.jsonl) answers: **Exactly which calls, checks and lifecycle operations happened, in what order?**

It contains 26 numbered records. A tool has separate start and finish events, and checks and artifact publication create additional events. Four model calls therefore do not mean four events.

For the extraction, the event records link:

```text
run_discovery_001
  tool call: call_003
  input observation: obs_discovery_003
  temporary target: c5
  extracted field: member_summary = "Member Ada | 123.50"
  output observation: obs_discovery_004
  evidence: ev_discovery_004
```

The actual event stores the exact argument string and parsed input. Observation contents are stored in the linked evidence files, rather than repeated in each event. The JSONL is an illustrative proposed storage format, not a claim that the current audit writer already emits lifecycle events.

## 4. Evidence asset: metadata pointing to a file

[evidence-assets.json](evidence-assets.json) answers: **Where is the evidence for an event, and which run owns it?**

For example, `ev_discovery_003` points to [the observation after Search](evidence/discovery/observation-003.json). Its metadata contains its run ID, event sequence, observation ID, media type, storage path and SHA-256 hash of the file bytes.

These are JSON observation assets. No screenshots were taken for this worked example: `screenshot.status` is `not_requested` and each asset's `image_ref` is null. A permitted screenshot would be an additional asset pointing to its PNG file and containing the screenshot UUID as `image_ref`.

## The validation replay and publication

[validation-run.json](validation-run.json) and [validation-events.jsonl](validation-events.jsonl) demonstrate a second, fresh execution of the artifact using the same input. It makes four UI tool calls and **zero model calls**. Fresh observation IDs, references and tool-call IDs make the distinction visible.

This validation occurs while discovery finalization is pending. Once the definition and replay pass, [publication.json](publication.json) marks the immutable artifact `ready`. Then the discovery's `finish_task` is accepted. A failed validation would keep it draft and record the failed check.

These schemas and bindings are proposed data contracts, not currently implemented replay code. `matches_schema` is a planned deterministic check, not an existing browser tool.

## What /evidence will read

```text
Discovery run: run_discovery_001
  Artifact produced: art_member_lookup_v1
  Discovery timeline: discovery-events.jsonl
  Discovery evidence: ev_discovery_001 ... ev_discovery_004
  Validation replay: run_validation_001
    Replay timeline: validation-events.jsonl
    Replay evidence: ev_validation_001 ... ev_validation_004
  Future replays: additional runs pinned to this artifact version
```

Opening a run shows its inputs, outputs, ordered events, validation verdicts and evidence. If it fails, its failure record identifies the stage, step and code; the relevant event contains expected versus observed values.

## Integrity conventions

Artifact `content_hash` is SHA-256 of canonical JSON: UTF-8, sorted object keys and compact separators, excluding its own `content_hash` field. Evidence hashes cover the exact file bytes. Definition changes produce a new artifact version; publication state is stored separately.
