import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

import pytest

from backend import db


def test_migrate_creates_tables_and_sets_version():
    with tempfile.TemporaryDirectory() as tmp:
        conn = db.connect(os.path.join(tmp, 'x.db'))
        version = db.migrate(conn)
        assert version == db.SCHEMA_VERSION
        assert version == 5
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


def test_migrate_from_v2_with_existing_data():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, 'legacy_v2.db')
        conn = db.connect(path)
        # Create v1 and v2 schema manually
        conn.executescript(db.SCHEMA_V1)
        conn.executescript(db.SCHEMA_V2)
        conn.execute('PRAGMA user_version=2')
        conn.commit()

        # Insert sample session and photo data
        conn.execute(
            "INSERT INTO sessions (name, source_folder_id, export_folder_id, created_at, updated_at) "
            "VALUES ('Senior Portrait', 'src123', 'exp123', '2026-01-01', '2026-01-01')"
        )
        conn.execute(
            "INSERT INTO runs (session_id, started_at, status) VALUES (1, '2026-01-01', 'completed')"
        )
        conn.execute(
            "INSERT INTO photos (run_id, drive_file_id, filename, state, overall_score, claimed_at, updated_at) "
            "VALUES (1, 'photo123', 'IMG_0001.JPG', 'exported', 0.88, '2026-01-01', '2026-01-01')"
        )
        conn.commit()

        # Now run migrate
        new_version = db.migrate(conn)
        assert new_version == db.SCHEMA_VERSION
        assert new_version == 5

        # Check existing session preserved and has default gallery_enabled=1
        session_row = conn.execute("SELECT name, gallery_enabled, favorites_folder_id FROM sessions WHERE id = 1").fetchone()
        assert session_row['name'] == 'Senior Portrait'
        assert session_row['gallery_enabled'] == 1
        assert session_row['favorites_folder_id'] is None

        # Check existing photo preserved
        photo_row = conn.execute("SELECT filename, overall_score FROM photos WHERE id = 1").fetchone()
        assert photo_row['filename'] == 'IMG_0001.JPG'
        assert photo_row['overall_score'] == 0.88

        # Check new tables exist and can accept foreign keys to existing data
        conn.execute(
            "INSERT INTO gallery_tokens (session_id, token, label, created_at, updated_at) "
            "VALUES (1, 'test-token-xyz', 'Main Gallery', '2026-01-01', '2026-01-01')"
        )
        token_id = conn.execute("SELECT id FROM gallery_tokens WHERE token = 'test-token-xyz'").fetchone()[0]
        conn.execute(
            "INSERT INTO gallery_favorites (token_id, photo_id, visitor_id, created_at) "
            "VALUES (?, 1, 'visitor-1', '2026-01-01')",
            (token_id,)
        )
        conn.execute(
            "INSERT INTO gallery_comments (token_id, photo_id, visitor_id, body, created_at) "
            "VALUES (?, 1, 'visitor-1', 'Love this one!', '2026-01-01')",
            (token_id,)
        )
        conn.commit()

        fav_count = conn.execute("SELECT COUNT(*) FROM gallery_favorites WHERE token_id = ?", (token_id,)).fetchone()[0]
        assert fav_count == 1


def test_schema_v5_ingest_log(tmp_path):
    """ingest_log table and session ingest columns exist after migration."""
    db.reset_for_tests(str(tmp_path / 'v5.db'))
    conn = db.get()

    conn.execute(
        "INSERT INTO ingest_log (session_id, filename, source) VALUES ('s1', 'IMG_001.JPG', 'http')"
    )
    row = conn.execute("SELECT * FROM ingest_log WHERE session_id = 's1'").fetchone()
    assert row['filename'] == 'IMG_001.JPG'
    assert row['drive_status'] == 'pending'
    assert row['drive_file_id'] is None

    import sqlite3
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO ingest_log (session_id, filename, source) VALUES ('s1', 'IMG_001.JPG', 'http')"
        )

    conn.execute(
        "INSERT INTO sessions (name, source_folder_id, export_folder_id, created_at, updated_at)"
        " VALUES ('Test', 'src', 'exp', 't', 't')"
    )
    conn.execute(
        "UPDATE sessions SET ingest_folder_id='fld1', ingest_folder_name='Test',"
        " ingest_api_key='abc123', ingest_active=1 WHERE id=1"
    )

