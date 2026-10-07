import sqlite3
from pathlib import Path

import pytest


def test_database_is_transactional_and_only_eight_tables(tmp_path):
    from interface_api.db import Database

    db = Database(tmp_path / "data" / "test.sqlite3")
    db.migrate()
    with db.connect() as c:
        assert c.execute("PRAGMA user_version").fetchone()[0] == 2
        assert c.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        names = {
            r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        assert names == {
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
    repo = Repository(db)
    life, source, artifact, validation = bundle(repo, tmp_path)
    life.publish_validated(
        source["run_id"], artifact["artifact_id"], validation["run_id"]
    )
    with db.connect() as c:
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
    assert db.migrate() == 2
    db.migrate()
    with db.connect() as c:
        assert {
            name: list(c.execute(f"SELECT * FROM {name}")) for name in tables
        } == before
        assert not c.execute("PRAGMA foreign_key_check").fetchall()
        assert c.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert {
            tuple(row)
            for row in c.execute(
                "SELECT type,name FROM sqlite_master WHERE type IN ('index','trigger')"
            )
        } == guards
        with pytest.raises(sqlite3.IntegrityError, match="selection is immutable"):
            c.execute("UPDATE runs SET binding_snapshot_json=NULL")
        with pytest.raises(sqlite3.IntegrityError, match="append only"):
            c.execute("DELETE FROM run_events")
        with pytest.raises(sqlite3.IntegrityError, match="artifact is immutable"):
            c.execute("UPDATE artifacts SET state='draft'")
        with pytest.raises(sqlite3.IntegrityError, match="CHECK constraint"):
            c.execute("UPDATE runs SET result_json='invalid JSON'")
