# Photo Sessions Implementation Plan

> **For agentic workers:** This plan is executed one phase at a time by an external
> agent under Agent Orchestrator. Each phase has a brief at
> `docs/superpowers/plans/phases/PNN-<name>.md` that names your file allowlist and
> your test command. Execute only your phase. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Named photo sessions that carry a shot from the camera, through a Google
Drive inbox, scoring, optional editing, into a Google Drive export folder — autonomous
or human-gated — hosted on the Mac Mini and reachable over Tailscale.

**Architecture:** Evolve the existing singleton `backend/session_worker.py` into a
session-aware, SQLite-backed state machine (`backend/pipeline.py`). SQLite at
`~/.bigbadphotos/bbp.db` holds named session configs, run state, and a per-photo state
row, so restarts resume and the review queue is a query. Google Drive replaces Google
Photos as the export destination. All Drive traffic goes through the server's stored
refresh token, so phones on Tailscale need no Google auth.

**Tech Stack:** Python 3.14 (`.venv`), Flask 3.1, sqlite3 (stdlib), OpenCV 4.10
(headless), Pillow 12.2, NumPy 2.2, pytest 9.1; React 19 + Vite 8 + zustand frontend.

**Design spec:** `docs/superpowers/specs/2026-08-10-photo-sessions-design.md`

## Global Constraints

- Python interpreter is `.venv/bin/python` (3.14.6). CLAUDE.md claims 3.12 — it is stale.
- Every test command in this plan is run as `.venv/bin/python -m pytest …` from the repo root.
- Never push to `main`. Phase branches target the integration branch `bbaf/bigbadphotos-sessions`.
- Conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`.
- Keep `.env` and secrets out of commits.
- No new runtime dependencies without saying so explicitly in the phase brief. `pytest-mock` (dev) is the only one this plan adds.
- All new Flask routes sit behind the existing `enforce_auth()` and `CSRFProtect`.
- Backend modules return **camelCase** dicts ready for `jsonify`; SQL columns stay snake_case. The mapping lives in the module that owns the table, never in a route.
- Topaz's license check (exit code 254) is never bypassed. Report it; do not work around it.
- Existing files not named in a phase's allowlist are not to be touched.

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `backend/db.py` | create | SQLite connection, PRAGMAs, schema, migrations |
| `backend/sessions.py` | create | Session config + app-settings CRUD and validation |
| `backend/auto_edit.py` | create | The Auto image filter (pure function over files) |
| `backend/preflight.py` | create | Pre-run checks with named fixes |
| `backend/pipeline.py` | create | Session-aware run loop and photo state machine |
| `backend/google_drive.py` | modify | `create_folder`, `find_child_by_name`, `move_file`, `folder_meta` |
| `backend/audit.py` | modify | Labels mode for threshold calibration |
| `app.py` | modify | Session/run/photo/settings routes, thumbnail proxy |
| `backend/tests/conftest.py` | create | Disable CSRF under test; shared fixtures |
| `backend/tests/test_db.py` | create | Schema and migration tests |
| `backend/tests/test_sessions.py` | create | Config CRUD and validation tests |
| `backend/tests/test_auto_edit.py` | create | Filter bounds and EXIF tests |
| `backend/tests/test_preflight.py` | create | Check-by-check tests |
| `backend/tests/test_pipeline.py` | create | State machine tests against a fake Drive |
| `backend/tests/test_session_routes.py` | create | Route tests |
| `backend/tests/test_drive_folders.py` | create | Drive helper tests |
| `frontend/src/api/sessionsClient.js` | create | Typed fetch wrappers for the new routes |
| `frontend/src/views/SessionsView.jsx` | create | List + create/edit form |
| `frontend/src/views/RunView.jsx` | create | Preflight, live status, stop |
| `frontend/src/views/ReviewQueueView.jsx` | create | Drive-backed keep/reject grid |
| `frontend/src/hooks/useSessionRun.js` | create | Status polling hook |
| `backend/session_worker.py` | delete (P9) | Superseded by `pipeline.py` |
| `frontend/src/components/ServerAutonomousPanel.jsx` | delete (P9) | Superseded by RunView |
| `frontend/src/hooks/useServerAutonomous.js` | delete (P9) | Superseded by `useSessionRun` |

---

## Task 0: Green the baseline

**Owner:** Claude (not an agent). Blocks every other phase — the agent contract is
"paste passing test output", which is meaningless against a red suite.

**Files:**
- Create: `backend/tests/conftest.py`
- Create: `tests/conftest.py`
- Modify: `requirements-dev.txt` (create)

**Interfaces:**
- Consumes: nothing
- Produces: a green `pytest` baseline; `WTF_CSRF_ENABLED=False` under test

Current baseline: `5 failed, 63 passed, 1 error`. Causes:
1. `CSRFProtect(app)` (added in PR #52) rejects every test POST with 400. Flask-WTF does not disable CSRF just because `TESTING` is true — it reads `WTF_CSRF_ENABLED`.
2. `tests/test_score_sharpness.py` uses the `mocker` fixture; `pytest-mock` is not installed.

- [ ] **Step 1: Reproduce**

Run: `.venv/bin/python -m pytest backend/tests tests -q`
Expected: `5 failed, 63 passed, 1 error`

- [ ] **Step 2: Add the CSRF-disabling conftest**

`backend/tests/conftest.py` and `tests/conftest.py` both get:

```python
"""Shared pytest configuration.

CSRFProtect is enabled app-wide in app.py. Flask-WTF keys CSRF off
WTF_CSRF_ENABLED, not TESTING, so tests that POST must turn it off explicitly.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
os.environ.setdefault('BBP_DEBUG', '1')

import pytest


@pytest.fixture(autouse=True)
def _disable_csrf():
    import app as appmod
    prev = appmod.app.config.get('WTF_CSRF_ENABLED', True)
    appmod.app.config['WTF_CSRF_ENABLED'] = False
    yield
    appmod.app.config['WTF_CSRF_ENABLED'] = prev
```

- [ ] **Step 3: Add the dev requirement**

`requirements-dev.txt`:

```
-r requirements.txt
pytest>=9.0
pytest-mock>=3.14
```

Then: `.venv/bin/python -m pip install -r requirements-dev.txt`

- [ ] **Step 4: Verify green**

Run: `.venv/bin/python -m pytest backend/tests tests -q`
Expected: `69 passed` (0 failed, 0 errors)

- [ ] **Step 5: Commit**

```bash
git add backend/tests/conftest.py tests/conftest.py requirements-dev.txt
git commit -m "test: disable CSRF under pytest and pin pytest-mock"
```

---

## Task 1 (P1): SQLite store and session configs

**Files:**
- Create: `backend/db.py`
- Create: `backend/sessions.py`
- Test: `backend/tests/test_db.py`, `backend/tests/test_sessions.py`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `db.connect(path: str | None = None) -> sqlite3.Connection`
  - `db.migrate(conn: sqlite3.Connection) -> int` (returns the schema version)
  - `db.get() -> sqlite3.Connection` (thread-local, auto-migrated)
  - `db.reset_for_tests(path: str) -> None`
  - `db.SCHEMA_VERSION: int = 1`
  - `sessions.PRESETS: dict[str, float] = {'strict': 0.72, 'balanced': 0.60, 'loose': 0.45}`
  - `sessions.EDIT_MODES = ('off', 'auto', 'topaz')`
  - `sessions.STRENGTHS = ('light', 'medium')`
  - `sessions.SessionError(ValueError)`
  - `sessions.create(data: dict) -> dict`
  - `sessions.get(session_id: int) -> dict | None`
  - `sessions.list_all() -> list[dict]`
  - `sessions.update(session_id: int, data: dict) -> dict`
  - `sessions.delete(session_id: int) -> None`
  - `sessions.get_setting(key: str) -> str | None`
  - `sessions.set_setting(key: str, value: str) -> None`
  - Session dicts are camelCase: `{'id', 'name', 'sourceFolderId', 'sourceFolderName', 'exportFolderId', 'exportFolderName', 'archiveFolderId', 'autonomous', 'preset', 'threshold', 'burstBestOnly', 'editMode', 'editStrength', 'pollSeconds', 'createdAt', 'updatedAt'}`

- [ ] **Step 1: Write the failing schema test**

`backend/tests/test_db.py`:

```python
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
        names = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        assert {'sessions', 'runs', 'photos', 'run_errors', 'app_settings'} <= names


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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `.venv/bin/python -m pytest backend/tests/test_db.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'backend.db'`

- [ ] **Step 3: Implement `backend/db.py`**

```python
"""SQLite store for photo sessions.

One file at ~/.bigbadphotos/bbp.db. WAL mode because a worker thread and Flask
request threads write concurrently. Connections are thread-local: sqlite3
objects are not safe to share across threads.
"""
from __future__ import annotations

import os
import sqlite3
import threading

SCHEMA_VERSION = 1

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
        conn.execute(f'PRAGMA user_version={SCHEMA_VERSION}')
        conn.commit()
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
```

- [ ] **Step 4: Run the schema tests**

Run: `.venv/bin/python -m pytest backend/tests/test_db.py -q`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/db.py backend/tests/test_db.py
git commit -m "feat(db): SQLite store with sessions, runs, photos schema"
```

- [ ] **Step 6: Write the failing session-config tests**

`backend/tests/test_sessions.py`:

```python
import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from backend import db, sessions


@pytest.fixture(autouse=True)
def _tmp_db():
    with tempfile.TemporaryDirectory() as tmp:
        db.reset_for_tests(os.path.join(tmp, 'test.db'))
        yield


def _valid(**over):
    data = {'name': 'Soccer', 'sourceFolderId': 'src', 'exportFolderId': 'exp'}
    data.update(over)
    return data


def test_create_applies_defaults():
    s = sessions.create(_valid())
    assert s['id'] > 0
    assert s['preset'] == 'balanced'
    assert s['threshold'] == pytest.approx(0.60)
    assert s['editMode'] == 'off'
    assert s['autonomous'] is False
    assert s['burstBestOnly'] is True


def test_preset_sets_threshold():
    s = sessions.create(_valid(preset='strict'))
    assert s['threshold'] == pytest.approx(sessions.PRESETS['strict'])


def test_explicit_threshold_marks_custom():
    s = sessions.create(_valid(preset='strict', threshold=0.5))
    assert s['preset'] == 'custom'
    assert s['threshold'] == pytest.approx(0.5)


@pytest.mark.parametrize('bad', [
    {'name': ''},
    {'sourceFolderId': ''},
    {'exportFolderId': ''},
    {'threshold': 1.5},
    {'threshold': -0.1},
    {'editMode': 'magic'},
    {'editStrength': 'nuclear'},
    {'pollSeconds': 0},
])
def test_validation_rejects(bad):
    with pytest.raises(sessions.SessionError):
        sessions.create(_valid(**bad))


def test_duplicate_name_rejected():
    sessions.create(_valid())
    with pytest.raises(sessions.SessionError):
        sessions.create(_valid())


def test_update_and_list_and_delete():
    s = sessions.create(_valid())
    up = sessions.update(s['id'], {'threshold': 0.8, 'autonomous': True})
    assert up['threshold'] == pytest.approx(0.8)
    assert up['autonomous'] is True
    assert up['preset'] == 'custom'
    assert len(sessions.list_all()) == 1
    sessions.delete(s['id'])
    assert sessions.get(s['id']) is None


def test_settings_roundtrip():
    assert sessions.get_setting('inbox_folder_id') is None
    sessions.set_setting('inbox_folder_id', 'folder-123')
    assert sessions.get_setting('inbox_folder_id') == 'folder-123'
    sessions.set_setting('inbox_folder_id', 'folder-456')
    assert sessions.get_setting('inbox_folder_id') == 'folder-456'
```

- [ ] **Step 7: Run and watch it fail**

Run: `.venv/bin/python -m pytest backend/tests/test_sessions.py -q`
Expected: FAIL — `No module named 'backend.sessions'`

- [ ] **Step 8: Implement `backend/sessions.py`**

Rules the tests pin down, restated so there is no guessing:
- `preset` in `PRESETS` and no explicit `threshold` → threshold comes from the preset.
- An explicit `threshold` always wins and forces `preset='custom'`.
- `name`, `sourceFolderId`, `exportFolderId` are required and non-empty after strip.
- `0.0 <= threshold <= 1.0`; `pollSeconds >= 1`; `editMode in EDIT_MODES`; `editStrength in STRENGTHS`.
- A duplicate `name` raises `SessionError`, not `sqlite3.IntegrityError`.
- `autonomous` and `burstBestOnly` are real Python bools in the returned dict, stored as 0/1.
- `update()` accepts a partial dict and re-validates the merged result.
- Timestamps are `datetime.now(timezone.utc).isoformat(timespec='seconds')`.

Use a single `_row_to_dict(row) -> dict` for the snake_case → camelCase mapping and a
single `_validate(merged: dict) -> dict` used by both `create` and `update`.

- [ ] **Step 9: Run the session tests**

Run: `.venv/bin/python -m pytest backend/tests/test_sessions.py -q`
Expected: PASS (13 tests, counting the parametrized cases)

- [ ] **Step 10: Full suite, then commit**

Run: `.venv/bin/python -m pytest backend/tests tests -q`
Expected: all pass, no regressions

```bash
git add backend/sessions.py backend/tests/test_sessions.py
git commit -m "feat(sessions): named session configs and app settings"
```

---

## Task 2 (P2): Drive folder helpers

**Files:**
- Modify: `backend/google_drive.py`
- Test: `backend/tests/test_drive_folders.py`

**Interfaces:**
- Consumes: existing `_headers(access_token)` and the module's `requests` usage
- Produces:
  - `create_folder(access_token: str, parent_id: str, name: str) -> dict` → `{'id', 'name'}`
  - `find_child_by_name(access_token: str, parent_id: str, name: str, folders_only: bool = False) -> dict | None`
  - `ensure_folder(access_token: str, parent_id: str, name: str) -> dict` — find, else create
  - `move_file(access_token: str, file_id: str, new_parent_id: str, old_parent_id: str | None = None) -> dict`
  - `folder_meta(access_token: str, folder_id: str) -> dict` → includes `{'id', 'name', 'canAddChildren': bool, 'trashed': bool}`

Notes the implementer needs:
- Folder MIME type is `application/vnd.google-apps.folder`.
- `move_file` is `PATCH /drive/v3/files/{id}?addParents=NEW&removeParents=OLD`. When
  `old_parent_id` is `None`, first `GET …?fields=parents` and remove all current parents.
- `folder_meta` needs `fields=id,name,trashed,capabilities(canAddChildren)`.
- Escape single quotes in `name` for the `q` parameter (`name.replace("'", "\\'")`),
  otherwise a folder named `Bob's Shoot` breaks the query.
- Match the module's existing error handling: raise the same exception type
  `google_drive` already raises on non-2xx. Read the top of the file and follow it.

- [ ] **Step 1: Write failing tests with a stubbed `requests`**

`backend/tests/test_drive_folders.py` — stub `google_drive.requests` with a fake whose
`get`/`post`/`patch` record the URL, params, and JSON body and return canned responses.
Cover: create returns id+name; find returns `None` on empty `files`; find escapes an
apostrophe in the name; `ensure_folder` does not create when found; `move_file` sends
both `addParents` and `removeParents`; `move_file` with `old_parent_id=None` looks up
parents first; `folder_meta` surfaces `canAddChildren` as a bool.

- [ ] **Step 2: Run and watch it fail**

Run: `.venv/bin/python -m pytest backend/tests/test_drive_folders.py -q`
Expected: FAIL — `AttributeError: module 'backend.google_drive' has no attribute 'create_folder'`

- [ ] **Step 3: Implement the five functions**

- [ ] **Step 4: Run the tests**

Run: `.venv/bin/python -m pytest backend/tests/test_drive_folders.py backend/tests -q`
Expected: PASS, no regressions

- [ ] **Step 5: Commit**

```bash
git add backend/google_drive.py backend/tests/test_drive_folders.py
git commit -m "feat(drive): folder create, lookup, move, and capability helpers"
```

---

## Task 3 (P3): The Auto filter

**Files:**
- Create: `backend/auto_edit.py`
- Test: `backend/tests/test_auto_edit.py`

**Interfaces:**
- Consumes: nothing from other tasks (pure function over file paths)
- Produces:
  - `STRENGTHS = ('light', 'medium')`
  - `SCALE = {'light': 0.35, 'medium': 0.70}`
  - `compute_adjustments(bgr: np.ndarray) -> dict` → `{'exposureGain': float, 'gamma': float, 'saturationScale': float, 'wbGains': [float, float, float]}`
  - `apply(src_path: str, dst_path: str, strength: str = 'medium') -> dict` → `{'status': 'ok', 'strength': str, 'applied': <adjustments>, 'outputPath': str}`
  - `AutoEditError(Exception)`

Behaviour the tests pin down:
- **Exposure** — gain toward a target mean luminance of `0.50` in the 0–1 range, clamped to `[0.85, 1.20]`. An already well-exposed frame gets a gain within `0.98–1.02`.
- **Contrast** — global gamma correction on the L channel in LAB, clamped to `[0.85, 1.25]`.
- **Saturation** — HSV S multiplied by a scale clamped to `[0.97, 1.10]`; a frame that is already vivid gets a scale at or below `1.0`.
- **White balance** — gray-world per-channel gains, each clamped to `[0.95, 1.05]`.
- `strength='light'` uses scale `0.35`, `medium` uses `0.70` — both interpolate from identity toward the computed adjustment.
- Output is JPEG quality 92. EXIF from the source is carried over using
  `PIL.Image.open(src).info.get('exif')` and passed to `save(..., exif=...)`.
- The source file is never modified — assert its bytes are unchanged afterwards.
- No channel may clip: for an input with max < 250, the output max stays < 255.
- A missing source raises `AutoEditError`; an unreadable image raises `AutoEditError`.
- `strength` outside `STRENGTHS` raises `AutoEditError`.

- [ ] **Step 1: Write the failing tests**

Generate fixtures with OpenCV rather than shipping binaries — a dark frame
(mean ≈ 40), a bright frame (mean ≈ 215), a neutral frame (mean ≈ 128), and a
saturated frame. Assert:

```python
def test_dark_frame_gets_positive_gain(tmp_path):
    src = _write_frame(tmp_path, mean=40)
    dst = tmp_path / 'out.jpg'
    info = auto_edit.apply(str(src), str(dst), 'medium')
    assert info['applied']['exposureGain'] > 1.0
    assert _mean(str(dst)) > _mean(str(src))


def test_gain_is_clamped(tmp_path):
    src = _write_frame(tmp_path, mean=5)
    info = auto_edit.apply(str(src), str(tmp_path / 'o.jpg'), 'medium')
    assert 0.75 <= info['applied']['exposureGain'] <= 1.35


def test_light_is_half_of_medium(tmp_path):
    src = _write_frame(tmp_path, mean=40)
    med = auto_edit.apply(str(src), str(tmp_path / 'm.jpg'), 'medium')
    lit = auto_edit.apply(str(src), str(tmp_path / 'l.jpg'), 'light')
    assert lit['applied']['exposureGain'] == pytest.approx(
        1 + (med['applied']['exposureGain'] - 1) * 0.5, rel=1e-6)


def test_source_untouched(tmp_path):
    src = _write_frame(tmp_path, mean=128)
    before = src.read_bytes()
    auto_edit.apply(str(src), str(tmp_path / 'o.jpg'), 'medium')
    assert src.read_bytes() == before


def test_no_highlight_clipping(tmp_path):
    src = _write_frame(tmp_path, mean=200, maximum=249)
    auto_edit.apply(str(src), str(dst := tmp_path / 'o.jpg'), 'medium')
    assert int(cv2.imread(str(dst)).max()) < 255


def test_exif_preserved(tmp_path):
    src = _write_frame_with_exif(tmp_path, iso=1600)
    auto_edit.apply(str(src), str(dst := tmp_path / 'o.jpg'), 'medium')
    assert Image.open(str(dst)).getexif().get(34855) == 1600


def test_bad_strength_raises(tmp_path):
    src = _write_frame(tmp_path, mean=128)
    with pytest.raises(auto_edit.AutoEditError):
        auto_edit.apply(str(src), str(tmp_path / 'o.jpg'), 'nuclear')
```

- [ ] **Step 2: Run and watch it fail**

Run: `.venv/bin/python -m pytest backend/tests/test_auto_edit.py -q`
Expected: FAIL — `No module named 'backend.auto_edit'`

- [ ] **Step 3: Implement `backend/auto_edit.py`**

Order of operations matters and is fixed: white balance → exposure → gamma contrast →
saturation.

- [ ] **Step 4: Run the tests**

Run: `.venv/bin/python -m pytest backend/tests/test_auto_edit.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/auto_edit.py backend/tests/test_auto_edit.py
git commit -m "feat(edit): bounded Auto filter for exposure, contrast, saturation, WB"
```

---

## Task 4 (P4): Preflight

**Depends on:** Task 1

**Files:**
- Create: `backend/preflight.py`
- Test: `backend/tests/test_preflight.py`

**Interfaces:**
- Consumes: `sessions.get()`, `google_drive.folder_meta` (Task 2 — but tests inject a fake, so P4 can start before P2 merges)
- Produces:
  - `run(session: dict, token_provider: Callable[[], str], deps: dict | None = None) -> list[dict]`
  - Each entry: `{'check': str, 'ok': bool, 'detail': str, 'fix': str}`
  - Check ids, in order: `google_auth`, `source_folder`, `export_folder`, `archive_folder`, `topaz`, `imaging_libs`, `disk_space`, `database`
  - `deps` keys: `drive`, `topaz`, `auth` — defaulting to the real modules

Rules:
- `topaz` is **skipped** (omitted from the list entirely) unless `session['editMode'] == 'topaz'`.
- `topaz` distinguishes "binary not found" from "exit 254 / not signed in" and gives different fix text. Never attempt to bypass the license check.
- Every failing check has non-empty `fix` text. Assert that in a test that loops all checks.
- `run()` never raises. An unexpected exception inside a check becomes `ok=False` with the exception text in `detail`.
- `disk_space` checks the volume holding `~/.bigbadphotos` for more than 5 GB free via `shutil.disk_usage`.

Fix strings, verbatim:

| check | fix |
| --- | --- |
| `google_auth` | `Open http://localhost:8001/google/oauth/start in a browser on the Mac Mini to reconnect Google.` |
| `source_folder` | `Pick a different source folder, or confirm the inbox folder id in Settings.` |
| `export_folder` | `Pick a different export folder, or create a new one from the session form.` |
| `archive_folder` | `The _archive folder will be created on start; check that the sessions root folder is writable.` |
| `topaz` (missing) | `Set TOPAZ_BINARY, or switch this session's edit mode to Auto or Off.` |
| `topaz` (exit 254) | `Open Topaz Photo AI on the Mac Mini and sign in, then re-run preflight.` |
| `imaging_libs` | `Reinstall dependencies: .venv/bin/python -m pip install -r requirements.txt` |
| `disk_space` | `Free space on the volume holding ~/.bigbadphotos, or set BBP_STAGING_ROOT to a larger volume.` |
| `database` | `Run: .venv/bin/python -c "from backend import db; db.migrate(db.connect())"` |

- [ ] **Step 1: Write the failing tests** — one per check, both directions, plus the
  "every failing check has fix text" loop and the "topaz omitted when editMode != topaz" case.
- [ ] **Step 2: Run and watch it fail**

Run: `.venv/bin/python -m pytest backend/tests/test_preflight.py -q`
Expected: FAIL — `No module named 'backend.preflight'`

- [ ] **Step 3: Implement `backend/preflight.py`**
- [ ] **Step 4: Run the tests** — Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add backend/preflight.py backend/tests/test_preflight.py
git commit -m "feat(preflight): pre-run checks with named fixes"
```

---

## Task 5 (P5): The pipeline state machine

**Depends on:** Tasks 1, 2, 3. The largest phase — route it to the strongest agent.

**Files:**
- Create: `backend/pipeline.py`
- Test: `backend/tests/test_pipeline.py`
- Read for reference (do not modify): `backend/session_worker.py`

**Interfaces:**
- Consumes: `db.get()`, `sessions.get()`, `google_drive.{list_all, download_file, upload_file, ensure_folder, move_file}`, `scoring.rank_images`, `auto_edit.apply`, `topaz.{process, route_by_iso}`
- Produces:
  - `STATES = ('claimed', 'downloaded', 'scored', 'awaiting_review', 'approved', 'rejected', 'editing', 'exporting', 'exported', 'archived', 'failed')`
  - `class Pipeline` with `__init__(self, session: dict, run_id: int, token_provider, deps: dict | None = None)`, `poll_once() -> dict`, `start() -> None`, `stop(wait: bool = True) -> None`
  - `start_run(session_id: int, token_provider) -> dict` — raises `RunConflict` if a run is already active
  - `stop_run() -> bool`
  - `active_status() -> dict` → `{'running', 'runId', 'sessionId', 'sessionName', 'phase', 'counts': {state: int}, 'lastPollAt', 'errors': [{'at','code','detail','fix'}]}`
  - `apply_decision(photo_id: int, decision: str) -> dict` — `'keep'` → `approved`, `'reject'` → `rejected`
  - `approve_all(run_id: int) -> int` — returns the number moved
  - `class RunConflict(RuntimeError)`
  - `deps` keys: `drive`, `scoring`, `auto_edit`, `topaz`

`session_worker.py`'s `poll_once`, `build_sidecar`, and `_read_iso` are the starting
point — carry the working logic across, then replace the in-memory `_processed` set
and the Photos publish step with DB state and Drive export.

Per-poll sequence:

1. `_claim()` — `drive.list_all(token, source_folder_id)`; skip names ending `.bbp.json`; skip extensions outside `{jpg, jpeg}`; `INSERT OR IGNORE` a `photos` row per new `drive_file_id` in state `claimed`. The `UNIQUE(run_id, drive_file_id)` index makes re-claiming after a restart a no-op.
2. `_download()` — for every `claimed` row, download to `<staging>/<run_id>/raw/<filename>`, then `downloaded`. Failure → `failed` with `error_code='download_failed'`.
3. `_score()` — batches of 100 `downloaded` rows through `scoring.rank_images(tasks)`; write `overall_score` and `metrics_json`; state → `scored`. Scoring errors → `failed`, `error_code='score_failed'`.
4. `_gate()` — for every `scored` row: keeper when `overall_score >= session['threshold']` and (`not burstBestOnly` or `metrics['is_burst_best'] is not False`). Keeper + `autonomous` → `editing`. Keeper + not autonomous → `awaiting_review`. Not a keeper → `rejected`.
5. `_edit()` — for every `editing` row: `off` → straight to `exporting`; `auto` → `auto_edit.apply(raw, edited, session['editStrength'])`; `topaz` → `topaz.process(inputs=[raw], output_dir=edited_dir, enhancements=topaz.route_by_iso(_read_iso(raw)))`. **Edit failure is non-fatal**: record `edit_json={'status':'failed','detail':…}` and continue to `exporting` with the original.
6. `_export()` — upload the edited file (or the original) to `export_folder_id`; store `exported_file_id`; state → `exported`.
7. `_archive()` — `ensure_folder` the `_archive` child once per run and cache `archive_folder_id` on the session row; `move_file` the original out of the source folder; write the `.bbp.json` sidecar into `_archive`; state → `archived`. `rejected` rows go through `_archive()` too — they skip edit and export.

Cross-cutting rules:
- Each `_step` is a separate method that selects by state and commits per row, so a crash between rows loses at most one row's progress.
- Transient failures (`requests.exceptions.RequestException`, HTTP 429, HTTP 5xx) → increment `attempts`, leave the state unchanged, retry next poll, up to 3 attempts, then `failed` with `error_code='retries_exhausted'`.
- HTTP 401/403 → write a `run_errors` row with `code='auth'` and the `google_auth` fix string, set `runs.status='auth_error'`, and stop the loop. Do not burn through the inbox.
- Any other exception → that one row goes `failed`; the run continues.
- `stop()` sets an event; the loop finishes the row in flight, sets `runs.status='stopped'` and `ended_at`, then exits.

- [ ] **Step 1: Write the failing state-machine tests**

Reuse the `FakeDrive` pattern already in `backend/tests/test_session_worker.py:22-34`,
extended with `ensure_folder` and `move_file`. Cover, one test each:

- a fresh poll claims every JPEG and ignores `.bbp.json` and non-JPEG files
- a second poll claims nothing new (idempotent)
- autonomous ON: a high-scoring photo ends `archived` with a non-null `exported_file_id`, and the export landed in `export_folder_id`
- autonomous OFF: a high-scoring photo stops at `awaiting_review` and nothing is exported
- `apply_decision(photo_id, 'keep')` moves it to `approved`, and the next poll exports it
- `apply_decision(photo_id, 'reject')` archives it without exporting
- a low-scoring photo ends `archived`, `exported_file_id is None`
- `burstBestOnly` rejects a photo whose `is_burst_best` is `False`
- `editMode='auto'` calls `auto_edit.apply` exactly once per keeper
- an `auto_edit` exception still exports the original and records `edit_json['status'] == 'failed'`
- a 500 from `upload_file` bumps `attempts` and leaves the state at `exporting`; a fourth poll marks it `failed` with `error_code='retries_exhausted'`
- a 401 from `upload_file` sets `runs.status='auth_error'` and stops the loop
- a simulated restart (new `Pipeline` over the same `run_id`) resumes without a duplicate export
- `start_run` twice raises `RunConflict`

- [ ] **Step 2: Run and watch them fail**

Run: `.venv/bin/python -m pytest backend/tests/test_pipeline.py -q`
Expected: FAIL — `No module named 'backend.pipeline'`

- [ ] **Step 3: Implement `backend/pipeline.py`**
- [ ] **Step 4: Run the tests** — Expected: PASS
- [ ] **Step 5: Full suite** — `.venv/bin/python -m pytest backend/tests tests -q`, no regressions
- [ ] **Step 6: Commit**

```bash
git add backend/pipeline.py backend/tests/test_pipeline.py
git commit -m "feat(pipeline): session-aware photo state machine with Drive export"
```

---

## Task 6 (P6): REST routes and the thumbnail proxy

**Depends on:** Task 5

**Files:**
- Modify: `app.py`
- Test: `backend/tests/test_session_routes.py`

**Interfaces:**
- Consumes: everything from Tasks 1–5
- Produces: the HTTP surface in the spec's API section

Every route sits behind the existing `enforce_auth()` and returns
`{'error': <code>, 'detail': <text>}` with the right status on failure. Status codes
are fixed:

| Condition | Status | `error` |
| --- | --- | --- |
| Validation failure (`SessionError`) | 400 | `bad_config` |
| Unknown session / run / photo | 404 | `not_found` |
| Start while a run is active (`RunConflict`) | 409 | `already_running` |
| Delete or re-point folders on a session with an active run | 409 | `run_in_progress` |
| Google not connected | 401 | `server_google_not_connected` |
| Drive/Photos upstream failure | 502 | `drive_error` |

`GET /photos/<id>/thumb` streams `https://www.googleapis.com/drive/v3/files/<drive_file_id>?alt=media`
through the server token with `Cache-Control: private, max-age=3600`. It must
**not** redirect to a Google URL — the phone has no Google credentials. Return 404 when
the photo id is unknown, 502 when Drive fails.

Keep `/autonomous/start|stop|status` working as thin aliases onto the new functions
for one phase; Task 9 deletes them.

- [ ] **Step 1: Write failing route tests** — happy path plus every status-code row above, using the `_client()` pattern from `backend/tests/test_autonomous_routes.py:11-17` and a monkeypatched `pipeline`.
- [ ] **Step 2: Run and watch them fail** — `.venv/bin/python -m pytest backend/tests/test_session_routes.py -q`
- [ ] **Step 3: Implement the routes in `app.py`**
- [ ] **Step 4: Run the tests, then the full suite**
- [ ] **Step 5: Commit**

```bash
git add app.py backend/tests/test_session_routes.py
git commit -m "feat(api): session, run, photo, and settings routes with thumb proxy"
```

---

## Task 7 (P7): SessionsView and RunView

**Depends on:** Task 6. Parallel with Task 8.

**Files:**
- Create: `frontend/src/api/sessionsClient.js`
- Create: `frontend/src/views/SessionsView.jsx`
- Create: `frontend/src/views/RunView.jsx`
- Create: `frontend/src/hooks/useSessionRun.js`
- Modify: `frontend/src/App.jsx` (route registration only)
- Modify: `frontend/src/components/BottomNavBar.jsx` (one nav entry)
- Modify: `frontend/src/store.js` (session slice only)

**Interfaces:**
- Consumes: the Task 6 routes
- Produces:
  - `sessionsClient.{listSessions, createSession, getSession, updateSession, deleteSession, preflight, startRun, stopRun, activeRun, listPhotos, decide, approveAll, getSettings, putSettings, createDriveFolder}`
  - `useSessionRun()` → `{status, loading, error, refresh, stop}`, polling `GET /runs/active` every 3 s while a run is active and backing off to 15 s when idle
  - Store slice: `sessions`, `activeSession`, `runStatus`

Follow the existing Obsidian Lens system: CSS tokens from `frontend/src/index.css`,
`Icon.jsx` for icons, no new icon or CSS framework. Reuse
`GoogleDriveFolderPicker.jsx` for folder selection and extend it with a **＋ Create
folder** action wired to `POST /drive/folders`. Every view must be usable one-handed on
an iPhone — that is the primary device.

- [ ] **Step 1: Write `sessionsClient.js`** with CSRF handling matching `frontend/src/utils/csrf.js`
- [ ] **Step 2: Build SessionsView** — list, create/edit form, delete with confirm
- [ ] **Step 3: Build `useSessionRun` and RunView** — preflight results with fix text, phase, counts by state, error list, Stop
- [ ] **Step 4: Register the route and nav entry**
- [ ] **Step 5: Verify the build**

Run: `cd frontend && npm run build`
Expected: exit 0, no warnings about missing imports

- [ ] **Step 6: Commit**

```bash
git add frontend/src
git commit -m "feat(ui): sessions list, session form, and live run view"
```

---

## Task 8 (P8): ReviewQueueView

**Depends on:** Task 6. Parallel with Task 7.

**Files:**
- Create: `frontend/src/views/ReviewQueueView.jsx`
- Modify: `frontend/src/App.jsx` (route registration only)

**Interfaces:**
- Consumes: `sessionsClient.{listPhotos, decide, approveAll}` from Task 7. If Task 7
  has not merged yet, write the minimal fetch wrappers you need inline in your own
  file and leave a `// TODO(P7): replace with sessionsClient` marker — the reviewer
  will collapse them.
- Produces: nothing other tasks depend on

Behaviour:
- Grid of `awaiting_review` photos, thumbnails from `GET /photos/<id>/thumb`
- Tap a thumbnail to open it large; keep/reject buttons plus the keyboard shortcuts already used in `CullingView.jsx` (`P` keep, `R` reject)
- Optimistic update, rolled back on a failed request
- "Approve all" with a confirm step showing the count
- Empty state distinguishes "nothing awaiting review" from "no active run"

- [ ] **Step 1: Build the view**
- [ ] **Step 2: Verify the build** — `cd frontend && npm run build`, exit 0
- [ ] **Step 3: Commit**

```bash
git add frontend/src/views/ReviewQueueView.jsx frontend/src/App.jsx
git commit -m "feat(ui): Drive-backed review queue with keep, reject, approve-all"
```

---

## Task 9 (P9): Remove the superseded singleton worker

**Depends on:** Tasks 7 and 8

**Files:**
- Delete: `backend/session_worker.py`, `backend/tests/test_session_worker.py`, `backend/tests/test_autonomous_routes.py`
- Delete: `frontend/src/components/ServerAutonomousPanel.jsx`, `frontend/src/hooks/useServerAutonomous.js`
- Modify: `app.py` (drop `/autonomous/*` and the `session_worker` import)
- Modify: `frontend/src/App.jsx` (drop the panel)
- Modify: `CLAUDE.md`, `AGENTS.md` (document the session flow, drop the stale bits)

- [ ] **Step 1: Confirm nothing still imports them**

Run: `grep -rn "session_worker\|ServerAutonomousPanel\|useServerAutonomous\|/autonomous/" --include=*.py --include=*.jsx --include=*.js . | grep -v node_modules`
Expected: only the files being deleted

- [ ] **Step 2: Delete and unwire**
- [ ] **Step 3: Full suite plus frontend build**

Run: `.venv/bin/python -m pytest backend/tests tests -q && cd frontend && npm run build`
Expected: all pass, exit 0

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: remove singleton autonomous worker superseded by sessions"
```

---

## Task 10 (P10): E2E run and scoring calibration

**Owner:** Robert + Claude. Not an agent phase.

**Files:**
- Modify: `backend/audit.py`
- Create: `docs/CALIBRATION.md`

**Interfaces:**
- Produces: `audit.calibrate(labels_csv: str, image_dir: str, thresholds: list[float]) -> dict` and an `--labels` CLI flag

- [ ] **Step 1: Add the labels mode to `audit.py`** — read `filename,verdict` CSV, score every image, sweep thresholds 0.30–0.80 in 0.05 steps, print precision, recall, F1, and a confusion matrix per step
- [ ] **Step 2: Robert labels ~150 real frames** into `labels.csv`
- [ ] **Step 3: Run the sweep, set `PRESETS` from the measurements**, and commit the numbers with the report in `docs/CALIBRATION.md`
- [ ] **Step 4: Live E2E** — shoot a frame, confirm image.canon delivers it to the inbox, watch it flow to the export folder, confirm the original lands in `_archive/`
- [ ] **Step 5: Resilience** — restart Flask mid-run and confirm the run resumes with no duplicate export
- [ ] **Step 6: Commit**

```bash
git add backend/audit.py docs/CALIBRATION.md
git commit -m "feat(audit): threshold calibration sweep against labelled photos"
```

---

## Phase 0 (P0): Host the app on the Mac Mini

**Owner:** Robert + Claude. Independent of every code phase; can run first or last.

- [ ] **Step 1: Pin the port and secrets** — set `BBP_PORT=8001`, a stable `FLASK_SECRET_KEY` (`python -c "import secrets;print(secrets.token_hex(32))"`), and `BBP_PASSWORD` in `.env`
- [ ] **Step 2: Bind to loopback only** — `BBP_HOSTNAME=127.0.0.1`, so nothing is exposed on the LAN
- [ ] **Step 3: Publish over Tailscale**

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8001
```

This terminates TLS with a Tailscale-issued cert on the Magic DNS name, which removes
the need for `BBP_CERT`/`BBP_KEY` and `setup_https.sh` entirely.

- [ ] **Step 4: Confirm the Magic DNS name** — `tailscale status --json | python3 -c "import json,sys;print(json.load(sys.stdin)['Self']['DNSName'])"`
- [ ] **Step 5: Run at boot** — a `launchd` LaunchAgent at `~/Library/LaunchAgents/com.bigbadapps.bigbadphotos.plist` running `start.sh` with `KeepAlive` and `RunAtLoad`, logging to `~/Library/Logs/bigbadphotos.log`. A LaunchAgent (not a LaunchDaemon) is required because Topaz needs the logged-in GUI session.
- [ ] **Step 6: Stop the Mini sleeping** — `sudo pmset -a sleep 0 disksleep 0` (Robert runs this; it needs a password)
- [ ] **Step 7: Connect Google once** — open `http://localhost:8001/google/oauth/start` in a browser **on the Mini**, and confirm `/auth/config` reports `"serverGoogle": true`
- [ ] **Step 8: Verify from the phone** — load the Magic DNS URL over Tailscale, sign in with `BBP_PASSWORD`, confirm `/health` and that no Google consent screen appears

---

## Dependency graph

```
Task 0 ──┬── P1 ──┬── P4
         │        └── P5 ── P6 ──┬── P7 ──┬── P9 ── P10
         ├── P2 ─────── P5       │        │
         └── P3 ─────── P5       └── P8 ──┘
P0 (independent)
```

Day one fans out to three agents: P1, P2, P3.

## Self-review notes

- Spec coverage checked section by section. `app_settings` (inbox wiring) is covered by
  Task 1 Step 6 and Task 6. The one-active-run invariant is covered by the partial
  unique index test in Task 1 and the `RunConflict` test in Task 5. Calibration is
  Task 10.
- Signatures used in later tasks match the `Produces` blocks of earlier tasks:
  `ensure_folder`/`move_file` (P2 → P5), `auto_edit.apply` (P3 → P5),
  `pipeline.active_status`/`apply_decision`/`approve_all` (P5 → P6 → P7/P8).
- Known deviation from the old plan: Google Photos is no longer the session export
  target. The `/photos/*` routes and the manual exporter are untouched.
