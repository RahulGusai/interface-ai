"""Explicit export of a caller-identified synthetic example, never a database dump."""

import argparse
import hashlib
import json
from pathlib import Path

from .artifact_validation import canonical, digest
from .config import Settings
from .db import Database
from .reads import Reads
from .repositories import Repository
from .storage import Storage


def export_example(
    repo, storage, source_run_id, replay_run_ids, output_dir, synthetic=False
):
    if not synthetic:
        raise ValueError("Explicit synthetic-data declaration is required")
    if output_dir.exists():
        raise ValueError("Export destination must be new")
    source = repo.get("runs", "run_id", source_run_id)
    if (
        source["kind"] != "discovery"
        or source["status"] != "completed"
        or not source["finalized_artifact_id"]
    ):
        raise ValueError("Source has no published artifact")
    artifact = repo.get("artifacts", "artifact_id", source["finalized_artifact_id"])
    if (
        artifact["state"] != "published"
        or digest(artifact["definition"]) != artifact["definition_sha256"]
    ):
        raise ValueError("Published artifact hash mismatch")
    validations = repo.rows(
        "runs",
        "pinned_artifact_id=? AND purpose='validation'",
        (artifact["artifact_id"],),
        "created_at ASC,run_id ASC",
    )
    replays = [repo.get("runs", "run_id", ident) for ident in replay_run_ids]
    if any(
        r["kind"] != "replay"
        or r["purpose"] != "user"
        or r["pinned_artifact_id"] != artifact["artifact_id"]
        or r["status"] not in ("completed", "failed", "cancelled", "interrupted")
        for r in replays
    ):
        raise ValueError("Replay selection does not match the example")
    runs = [source, *validations, *replays]
    run_ids = {r["run_id"] for r in runs}
    evidence = [
        a
        for a in repo.rows("evidence_assets", order="captured_at ASC,asset_id ASC")
        if a["run_id"] in run_ids
    ]
    crops = repo.rows(
        "artifact_assets",
        "artifact_id=?",
        (artifact["artifact_id"],),
        "created_at ASC,asset_id ASC",
    )
    # Download and verify everything before creating a package that appears complete.
    images = {
        a["asset_id"]: storage.get_png(a["object_key"], a["sha256"])
        for a in evidence + crops
    }
    output_dir.mkdir(parents=True, mode=0o700)
    (output_dir / "images").mkdir(mode=0o700)
    paths = {}
    files = {}

    def write(name, data):
        encoded = data.encode() if isinstance(data, str) else data
        path = output_dir / name
        path.write_bytes(encoded)
        path.chmod(0o600)
        files[name] = hashlib.sha256(encoded).hexdigest()

    for a in evidence + crops:
        name = f"images/{a['asset_id']}.png"
        write(name, images[a["asset_id"]])
        paths[a["asset_id"]] = name
    write(
        "artifact.json",
        json.dumps(
            {k: v for k, v in artifact.items() if k != "capability_proposal"},
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
    )
    write(
        "runs.json",
        json.dumps([Reads(repo).run(r) for r in runs], ensure_ascii=False, indent=2)
        + "\n",
    )
    write("artifact-assets.json", json.dumps(crops, indent=2) + "\n")
    write("evidence-assets.json", json.dumps(evidence, indent=2) + "\n")

    def events(ids):
        return "".join(
            canonical(e) + "\n"
            for ident in ids
            for e in repo.rows("run_events", "run_id=?", (ident,), "sequence ASC")
        )

    write("discovery-events.jsonl", events([source_run_id]))
    write("validation-events.jsonl", events([r["run_id"] for r in validations]))
    write(
        "replay-events.jsonl",
        events([r["run_id"] for r in replays if r["status"] == "completed"]),
    )
    write(
        "exception-replay-events.jsonl",
        events([r["run_id"] for r in replays if r["status"] != "completed"]),
    )
    write(
        "README.md",
        f"# Synthetic example evidence\n\nSource: `{source_run_id}`. Artifact: `{artifact['artifact_id']}` v{artifact['version']}.\n\nEvents and selections come from SQLite; image bytes were downloaded by private object key and verified by SHA-256. No signed URLs or database files are exported. This declaration covers synthetic task data; the operator must inspect the package before sharing. A configured model label alone does not prove genuine provider use: consult the verification record.\n\nReproduce with the repository README setup and `python -m interface_api.export --synthetic --source-run {source_run_id} --output <new-directory>` plus explicit `--replay-run` IDs.\n",
    )
    manifest = {
        "source_run_id": source_run_id,
        "artifact_id": artifact["artifact_id"],
        "version": artifact["version"],
        "definition_sha256": artifact["definition_sha256"],
        "run_ids": [r["run_id"] for r in runs],
        "export_path": paths,
        "files": files,
        "synthetic_data_declared": True,
    }
    write("manifest.json", json.dumps(manifest, indent=2) + "\n")
    return manifest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-run", required=True)
    parser.add_argument("--replay-run", action="append", default=[])
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--synthetic", action="store_true")
    args = parser.parse_args()
    settings = Settings()
    db = Database(settings.database_path)
    db.migrate()
    store = Storage.from_settings(settings)
    if store is None:
        raise SystemExit("Private storage is not configured")
    store.verify_store()
    manifest = export_example(
        Repository(db),
        store,
        args.source_run,
        args.replay_run,
        args.output,
        args.synthetic,
    )
    print(
        json.dumps(
            {"artifact_id": manifest["artifact_id"], "files": len(manifest["files"])}
        )
    )


if __name__ == "__main__":
    main()
