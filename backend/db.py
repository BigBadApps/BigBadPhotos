"""SQLite store for photo sessions.

One file at ~/.bigbadphotos/bbp.db. WAL mode because a worker thread and Flask
request threads write concurrently. Connections are thread-local: sqlite3
objects are not safe to share across threads.
"""
from __future__ import annotations

import os
import sqlite3
import threading

SCHEMA_VERSION = 3

DEFAULT_PATH = os.path.join(os.path.expanduser('~'), '.bigbadphotos', 'bbp.db')

_local = threading.local()
_configured_path: str | None = None

SCHEMA_V1 = """
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  source_folder_id TEXT NOT NULL,
  source_folder_name TEXT,
  export_folder_id TEXT NOT NULL,
  export_folder_name TEXT,
  archive_folder_id TEXT,
  autonomous INTEGER NOT NULL DEFAULT 0,
  preset TEXT NOT NULL DEFAULT 'balanced',
  threshold REAL NOT NULL DEFAULT 0.60,
  burst_best_only INTEGER NOT NULL DEFAULT 1,
  edit_mode TEXT NOT NULL DEFAULT 'off',
  edit_strength TEXT NOT NULL DEFAULT 'medium',
  poll_seconds INTEGER NOT NULL DEFAULT 30,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL,
  last_poll_at TEXT,
  phase TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active
  ON runs(status) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  drive_file_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  state TEXT NOT NULL,
  overall_score REAL,
  metrics_json TEXT,
  edit_json TEXT,
  exported_file_id TEXT,
  error_code TEXT,
  error_detail TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, drive_file_id)
);

CREATE INDEX IF NOT EXISTS photos_run_state ON photos(run_id, state);

CREATE TABLE IF NOT EXISTS run_errors (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  code TEXT NOT NULL,
  detail TEXT NOT NULL,
  fix TEXT
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""

# v2: per-row completion flags for the two Drive-side archive sub-steps.
# Filenames are not unique across a run (camera numbering can repeat across
# cards/folders), so "does Drive already have a file with this name" is not
# a safe idempotency check — it can match a *different* photo's file and
# cause this row's own move/upload to be silently skipped. These flags are
# scoped to the row itself, immune to filename collisions.
SCHEMA_V2 = """
ALTER TABLE photos ADD COLUMN moved_to_archive INTEGER NOT NULL DEFAULT 0;
ALTER TABLE photos ADD COLUMN sidecar_uploaded INTEGER NOT NULL DEFAULT 0;
ALTER TABLE photos ADD COLUMN uploaded_to_export INTEGER NOT NULL DEFAULT 0;
"""

# v3: client-facing photo gallery tokens, visitor favorites, visitor comments,
# and gallery config columns on sessions.
SCHEMA_V3 = """
CREATE TABLE IF NOT EXISTS gallery_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  label TEXT DEFAULT 'Main Gallery',
  scope TEXT DEFAULT 'exports',
  expires_at TEXT,
  revoked INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gallery_tokens_session ON gallery_tokens(session_id);
CREATE INDEX IF NOT EXISTS idx_gallery_tokens_token ON gallery_tokens(token);

CREATE TABLE IF NOT EXISTS gallery_favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id INTEGER NOT NULL REFERENCES gallery_tokens(id) ON DELETE CASCADE,
  photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  visitor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(token_id, photo_id, visitor_id)
);

CREATE INDEX IF NOT EXISTS idx_gallery_favorites_token_photo ON gallery_favorites(token_id, photo_id);

CREATE TABLE IF NOT EXISTS gallery_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id INTEGER NOT NULL REFERENCES gallery_tokens(id) ON DELETE CASCADE,
  photo_id INTEGER REFERENCES photos(id) ON DELETE CASCADE,
  visitor_id TEXT NOT NULL,
  display_name TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gallery_comments_token ON gallery_comments(token_id);
CREATE INDEX IF NOT EXISTS idx_gallery_comments_photo ON gallery_comments(photo_id);

ALTER TABLE sessions ADD COLUMN gallery_enabled INTEGER DEFAULT 1;
ALTER TABLE sessions ADD COLUMN favorites_folder_id TEXT;
ALTER TABLE sessions ADD COLUMN favorites_folder_name TEXT;
"""


def connect(path: str | None = None) -> sqlite3.Connection:
    path = path or _configured_path or DEFAULT_PATH
    os.makedirs(os.path.dirname(path), exist_ok=True)
    conn = sqlite3.connect(path, timeout=5.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA foreign_keys=ON')
    conn.execute('PRAGMA busy_timeout=5000')
    return conn


def migrate(conn: sqlite3.Connection) -> int:
    current = conn.execute('PRAGMA user_version').fetchone()[0]
    if current < 1:
        conn.executescript(SCHEMA_V1)
        conn.execute('PRAGMA user_version=1')
        conn.commit()
        current = 1
    if current < 2:
        conn.executescript(SCHEMA_V2)
        conn.execute('PRAGMA user_version=2')
        conn.commit()
        current = 2
    if current < 3:
        conn.executescript(SCHEMA_V3)
        conn.execute('PRAGMA user_version=3')
        conn.commit()
        current = 3
    return conn.execute('PRAGMA user_version').fetchone()[0]


def get() -> sqlite3.Connection:
    conn = getattr(_local, 'conn', None)
    if conn is None:
        conn = connect()
        migrate(conn)
        _local.conn = conn
    return conn


def reset_for_tests(path: str) -> None:
    """Point every subsequent get() at `path` and drop cached handles."""
    global _configured_path
    _configured_path = path
    _local.conn = None
