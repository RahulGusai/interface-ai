import sqlite3
from pathlib import Path

import pytest


def test_database_is_transactional_and_nine_tables(tmp_path):
    from interface_api.db import Database

    db = Database(tmp_path / "data" / "test.sqlite3")
    db.migrate()
    with db.connect() as c:
        assert c.execute("PRAGMA user_version").fetchone()[0] == 5
        assert c.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        names = {
            r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        assert names == {
            "human_review",
            "runs",
            "artifacts",
            "artifact_assets",
            "run_events",
            "evidence_assets",
            "capabilities",
            "app_deployments",
            "capability_bindings",
        }
    with pytest.raises(RuntimeError):
        with db.transaction() as c:
            c.execute(
                "INSERT INTO app_deployments VALUES ('d','t','p','http://localhost','demo','v',NULL,1,'now','now')"
            )
            raise RuntimeError("rollback")
    with db.connect() as c:
        assert c.execute("SELECT count(*) FROM app_deployments").fetchone()[0] == 0
    db.migrate()


def test_paths_never_escape_repository(tmp_path):
    from interface_api.config import resolve_db_path

    assert resolve_db_path(tmp_path, "data/a.sqlite3") == tmp_path / "data/a.sqlite3"
    with pytest.raises(ValueError):
        resolve_db_path(tmp_path, "../a.sqlite3")
    with pytest.raises(ValueError):
        resolve_db_path(tmp_path, "/tmp/a.sqlite3")


def test_database_newer_than_application_refuses_start(tmp_path):
    from interface_api.db import Database

    path = tmp_path / "new.sqlite3"
    with sqlite3.connect(path) as c:
        c.execute("PRAGMA user_version=99")
    with pytest.raises(ValueError, match="newer"):
        Database(path).migrate()


def test_upgrade_preserves_published_runs_bindings_and_guards(tmp_path, monkeypatch):
    from test_publication import bundle

    from interface_api.db import Database
    from interface_api.repositories import Repository

    db = Database(tmp_path / "legacy.sqlite3")
    sql = (
        Path(__file__).parents[1] / "interface_api/migrations/0001_initial.sql"
    ).read_text()
    with db.connect() as c:
        c.executescript(sql)
        c.execute("PRAGMA user_version=1")
    # Helpers now write policy; create seed using current schema, then remove only
    # the new column to reconstruct a populated v1 database before the upgrade.
    with db.connect() as c:
        c.execute(
            "ALTER TABLE runs ADD COLUMN access_policy TEXT NOT NULL DEFAULT 'READ_ONLY'"
        )
    with db.connect() as c:
        c.execute(
            "CREATE TABLE human_review (review_id TEXT,run_id TEXT,status TEXT,created_at TEXT)"
        )
    repo = Repository(db)
    life, source, artifact, validation = bundle(repo, tmp_path)
    life.publish_validated(
        source["run_id"], artifact["artifact_id"], validation["run_id"]
    )
    with db.connect() as c:
        c.execute("DROP TABLE human_review")
        c.execute("ALTER TABLE runs DROP COLUMN access_policy")
        tables = [
            row[0]
            for row in c.execute("SELECT name FROM sqlite_master WHERE type='table'")
        ]
        before = {name: list(c.execute(f"SELECT * FROM {name}")) for name in tables}
        guards = {
            tuple(row)
            for row in c.execute(
                "SELECT type,name FROM sqlite_master WHERE type IN ('index','trigger')"
            )
        }
        old_schema = list(c.execute("SELECT * FROM sqlite_master"))
    # A failure after both table rebuilds must roll back schema and data.
    read_text = Path.read_text
    with monkeypatch.context() as patch:

        def broken_migration(path, *args, **kwargs):
            text = read_text(path, *args, **kwargs)
            if path.name == "0002_nullable_json.sql":
                return text + "\nSELECT nonexistent_migration_function();\n"
            return text

        patch.setattr(Path, "read_text", broken_migration)
        with pytest.raises(sqlite3.OperationalError, match="nonexistent_migration"):
            db.migrate()
    with db.connect() as c:
        assert c.execute("PRAGMA user_version").fetchone()[0] == 1
        assert list(c.execute("SELECT * FROM sqlite_master")) == old_schema
        assert {
            name: list(c.execute(f"SELECT * FROM {name}")) for name in tables
        } == before
    assert db.migrate() == 5
    db.migrate()
    with db.connect() as c:
        assert {
            name: [
                tuple(row)[:-1] if name == "runs" else tuple(row)
                for row in c.execute(f"SELECT * FROM {name}")
            ]
            for name in tables
        } == {name: [tuple(row) for row in rows] for name, rows in before.items()}
        assert all(
            row[0] == "READ_ONLY" for row in c.execute("SELECT access_policy FROM runs")
        )
        assert not c.execute("PRAGMA foreign_key_check").fetchall()
        assert c.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert {
            tuple(row)
            for row in c.execute(
                "SELECT type,name FROM sqlite_master WHERE type IN ('index','trigger')"
            )
        } >= guards
        with pytest.raises(sqlite3.IntegrityError, match="selection is immutable"):
            c.execute("UPDATE runs SET binding_snapshot_json=NULL")
        with pytest.raises(sqlite3.IntegrityError, match="append only"):
            c.execute("DELETE FROM run_events")
        with pytest.raises(sqlite3.IntegrityError, match="artifact is immutable"):
            c.execute("UPDATE artifacts SET state='draft'")
        with pytest.raises(sqlite3.IntegrityError, match="CHECK constraint"):
            c.execute("UPDATE runs SET result_json='invalid JSON'")


@pytest.mark.parametrize("status", ["pending", "approved"])
def test_v4_upgrade_preserves_legacy_human_reviews(tmp_path, status):
    from conftest import run
    from test_human_review import evidence

    from interface_api.artifact_validation import digest
    from interface_api.db import Database
    from interface_api.repositories import Repository, identifier
    from interface_api.reviews import Reviews

    db = Database(tmp_path / "legacy-review.sqlite3")
    migrations = Path(__file__).parents[1] / "interface_api/migrations"
    with db.connect() as c:
        for name in (
            "0001_initial.sql",
            "0002_nullable_json.sql",
            "0003_access_policy.sql",
            "0004_human_review.sql",
        ):
            c.executescript((migrations / name).read_text())
        c.execute("PRAGMA user_version=4")
    repo = Repository(db)
    row = run(repo, access_policy="READ_WRITE")
    repo.transition(row["run_id"], "running")
    review_id = identifier()
    body = {
        "review_id": review_id,
        "call_id": "old-call",
        "tool": "click",
        "arguments": {},
        "assessment": None,
        "state_fingerprint": "f" * 64,
    }
    sequence = evidence(repo, row, body)
    body["event_sequence"] = sequence
    with db.transaction() as c:
        c.execute(
            "INSERT INTO human_review VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                review_id,
                row["run_id"],
                "old-call",
                "click",
                "{}",
                None,
                None,
                "legacy reason",
                "READ_WRITE",
                repo.rows("evidence_assets", order="")[0]["asset_id"],
                sequence,
                "f" * 64,
                digest(body),
                status,
                "2026-10-14T00:00:00Z",
                "2099-10-14T00:00:00Z",
                None if status == "pending" else "decided",
                "old comment",
            ),
        )
        before = dict(c.execute("SELECT * FROM human_review").fetchone())
    assert db.migrate() == 5
    with db.connect() as c:
        after = dict(c.execute("SELECT * FROM human_review").fetchone())
        assert {key: after[key] for key in before} == before
        assert not c.execute("PRAGMA foreign_key_check").fetchall()
    review = Reviews(repo).get(review_id)
    assert review["target_resolution"] is None
    assert review["selected_candidate_id"] is None
    assert review["refresh_targets"] is False
    assert review["status"] == status
    # The new optional context's null default cannot invalidate an ordinary
    # review's legacy creation retry.
    assert (
        Reviews(repo).create(row["run_id"], body | {"target_resolution": None})
        == review
    )
