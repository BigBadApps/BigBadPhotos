import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from backend import db


def test_migrate_creates_tables_and_sets_version():
    with tempfile.TemporaryDirectory() as tmp:
        conn = db.connect(os.path.join(tmp, 'x.db'))
        version = db.migrate(conn)
        assert version == db.SCHEMA_VERSION
        assert version == 3
        names = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        assert {
            'sessions', 'runs', 'photos', 'run_errors', 'app_settings',
            'gallery_tokens', 'gallery_favorites', 'gallery_comments'
        } <= names

        # Verify new sessions columns exist
        cols = {r[1] for r in conn.execute("PRAGMA table_info(sessions)")}
        assert {'gallery_enabled', 'favorites_folder_id', 'favorites_folder_name'} <= cols


def test_migrate_is_idempotent():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, 'x.db')
        conn = db.connect(path)
        db.migrate(conn)
        assert db.migrate(conn) == db.SCHEMA_VERSION


def test_pragmas_are_set():
    with tempfile.TemporaryDirectory() as tmp:
        conn = db.connect(os.path.join(tmp, 'x.db'))
        db.migrate(conn)
        assert conn.execute('PRAGMA journal_mode').fetchone()[0].lower() == 'wal'
        assert conn.execute('PRAGMA foreign_keys').fetchone()[0] == 1


def test_only_one_running_run_allowed():
    import sqlite3
    with tempfile.TemporaryDirectory() as tmp:
        conn = db.connect(os.path.join(tmp, 'x.db'))
        db.migrate(conn)
        conn.execute(
            "INSERT INTO sessions (name, source_folder_id, export_folder_id,"
            " created_at, updated_at) VALUES ('a','src','exp','t','t')")
        conn.execute("INSERT INTO runs (session_id, started_at, status)"
                     " VALUES (1,'t','running')")
        try:
            conn.execute("INSERT INTO runs (session_id, started_at, status)"
                         " VALUES (1,'t','running')")
            assert False, 'second running run should be rejected'
        except sqlite3.IntegrityError:
            pass
