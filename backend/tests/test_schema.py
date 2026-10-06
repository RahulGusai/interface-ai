import sqlite3
from pathlib import Path
import pytest


def test_database_is_transactional_and_only_eight_tables(tmp_path):
    from interface_api.db import Database
    db = Database(tmp_path / 'data' / 'test.sqlite3')
    db.migrate()
    with db.connect() as c:
        assert c.execute('PRAGMA user_version').fetchone()[0] == 1
        assert c.execute('PRAGMA foreign_keys').fetchone()[0] == 1
        names = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert names == {'runs','artifacts','artifact_assets','run_events','evidence_assets','capabilities','app_deployments','capability_bindings'}
    with pytest.raises(RuntimeError):
        with db.transaction() as c:
            c.execute("INSERT INTO app_deployments VALUES ('d','t','p','http://localhost','demo','v',NULL,1,'now','now')")
            raise RuntimeError('rollback')
    with db.connect() as c:
        assert c.execute('SELECT count(*) FROM app_deployments').fetchone()[0] == 0
    db.migrate()


def test_paths_never_escape_repository(tmp_path):
    from interface_api.config import resolve_db_path
    assert resolve_db_path(tmp_path, 'data/a.sqlite3') == tmp_path / 'data/a.sqlite3'
    with pytest.raises(ValueError):
        resolve_db_path(tmp_path, '../a.sqlite3')
    with pytest.raises(ValueError):
        resolve_db_path(tmp_path, '/tmp/a.sqlite3')


def test_database_newer_than_application_refuses_start(tmp_path):
    from interface_api.db import Database
    path = tmp_path / 'new.sqlite3'
    with sqlite3.connect(path) as c:
        c.execute('PRAGMA user_version=99')
    with pytest.raises(ValueError, match='newer'):
        Database(path).migrate()
