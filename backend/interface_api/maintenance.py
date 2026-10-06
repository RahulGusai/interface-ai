"""Operator-only backup/restore and conservative object cleanup. No scheduler."""

import argparse
import fcntl
import shutil
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .config import Settings
from .db import Database
from .repositories import Repository
from .storage import Storage

TERMINAL = {"completed", "failed", "cancelled", "interrupted"}


def backup(db: Database, destination: Path):
    if destination.exists():
        raise ValueError("Backup destination already exists")
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        with db.connect() as source, sqlite3.connect(destination) as target:
            source.backup(target)
        destination.chmod(0o600)
    except Exception:
        destination.unlink(missing_ok=True)
        raise


def restore(db: Database, source: Path):
    # Service owns this same advisory lock; restore only while it is stopped.
    db.path.parent.mkdir(parents=True, exist_ok=True)
    with (db.path.parent / "service.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with sqlite3.connect(f"file:{source.resolve()}?mode=ro", uri=True) as candidate:
            if (
                candidate.execute("PRAGMA integrity_check").fetchone()[0] != "ok"
                or candidate.execute("PRAGMA user_version").fetchone()[0] != 1
                or candidate.execute("PRAGMA foreign_key_check").fetchall()
            ):
                raise ValueError("Invalid backup")
        if db.path.exists():
            backup(
                db,
                db.path.with_name(
                    "before-restore-"
                    + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
                    + ".sqlite3"
                ),
            )
        for suffix in ("-wal", "-shm"):
            Path(str(db.path) + suffix).unlink(missing_ok=True)
        shutil.copyfile(source, db.path)
        db.path.chmod(0o600)


def orphan_keys(repo, objects, now=None):
    cutoff = (now or datetime.now(timezone.utc)) - timedelta(hours=24)
    referenced = {
        r["object_key"]
        for table in ("evidence_assets", "artifact_assets")
        for r in repo.rows(table, order="")
    }
    protected_runs = {
        r["run_id"] for r in repo.rows("runs") if r["status"] not in TERMINAL
    }
    protected_artifacts = {
        r["artifact_id"] for r in repo.rows("artifacts") if r["state"] != "published"
    }
    for obj in objects:
        parts = obj.object_name.split("/")
        if (
            len(parts) != 4
            or parts[0] != "v1"
            or parts[1] not in ("runs", "artifacts")
            or obj.last_modified is None
            or obj.last_modified >= cutoff
            or obj.object_name in referenced
        ):
            continue
        if (
            parts[1] == "runs"
            and parts[2] in protected_runs
            or parts[1] == "artifacts"
            and parts[2] in protected_artifacts
        ):
            continue
        yield obj.object_name


def sweep_staging(repo, root):
    if not root.exists():
        return
    cutoff = datetime.now(timezone.utc).timestamp() - 86400
    active = {r["run_id"] for r in repo.rows("runs") if r["status"] not in TERMINAL}
    for path in root.iterdir():
        if (
            path.is_dir()
            and not path.is_symlink()
            and path.name not in active
            and path.stat().st_mtime < cutoff
        ):
            shutil.rmtree(path)


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    for command in ("backup", "restore"):
        sub.add_parser(command).add_argument("path", type=Path)
    cleanup = sub.add_parser("cleanup-assets")
    group = cleanup.add_mutually_exclusive_group()
    group.add_argument("--apply", action="store_true")
    group.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    settings = Settings()
    db = Database(settings.database_path)
    if args.command == "restore":
        restore(db, args.path)
        return
    db.migrate()
    if args.command == "backup":
        backup(db, args.path)
        return
    store = Storage.from_settings(settings)
    if store is None:
        raise SystemExit("Storage is not configured")
    store.verify_store()
    objects = store.internal.list_objects(store.bucket, prefix="v1/", recursive=True)
    for key in orphan_keys(Repository(db), objects):
        print(key)
        if args.apply:
            store.remove(key)


if __name__ == "__main__":
    main()
