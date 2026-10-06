from contextlib import contextmanager
from pathlib import Path
import fcntl
import sqlite3
import threading


class Database:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.RLock()

    @contextmanager
    def connect(self):
        conn = sqlite3.connect(self.path, isolation_level=None, timeout=5)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA foreign_keys=ON')
        conn.execute('PRAGMA busy_timeout=5000')
        conn.execute('PRAGMA synchronous=FULL')
        try:
            yield conn
        finally:
            conn.close()

    @contextmanager
    def transaction(self):
        with self._lock, self.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            try:
                yield conn
                conn.commit()
            except BaseException:
                conn.rollback()
                raise

    def migrate(self):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with (self.path.parent / 'migration.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            with self.connect() as conn:
                version = conn.execute('PRAGMA user_version').fetchone()[0]
                if version > 1:
                    raise ValueError('Database schema is newer than this application')
                conn.execute('PRAGMA journal_mode=WAL')
            if version == 0:
                sql = (Path(__file__).parent / 'migrations/0001_initial.sql').read_text()
                with self.transaction() as conn:
                    statement = ''
                    for line in sql.splitlines(keepends=True):
                        statement += line
                        if sqlite3.complete_statement(statement):
                            conn.execute(statement)
                            statement = ''
                    if statement.strip():
                        raise ValueError('Incomplete migration SQL')
                    conn.execute('PRAGMA user_version=1')
            with self.connect() as conn:
                if conn.execute('PRAGMA integrity_check').fetchone()[0] != 'ok' or conn.execute('PRAGMA foreign_key_check').fetchall():
                    raise ValueError('Database integrity check failed')
        return 1
