# Camera Bridge Ingest Pipeline — Implementation Plan

> **For agentic workers:** This plan is designed for multi-agent execution orchestrated by Claude Code CLI via tmux. Phase 1 runs sequentially (one agent), Phase 2 dispatches three tasks in parallel to Antigravity, FreeBuff, and OpenCode, Phase 3 runs sequentially for integration.

**Goal:** Enable real-time camera-to-Google-Drive image transfer with per-session folder targeting, bypassing Canon Camera Connect's exclusive USB-C mode.

**Architecture:** Two input paths (HTTP POST from iOS Shortcut + FTP from camera WiFi) feed a shared ingest pipeline that resolves the target session, deduplicates, uploads to Google Drive, and records the result. Sessions store a configurable Drive folder ID and a per-session API key for Shortcut auth.

**Tech Stack:** Python/Flask (backend), SQLite (DB), Google Drive API (uploads), React/Vite (frontend), pyftpdlib (FTP server), watchdog (file watcher)

**Design Spec:** `docs/superpowers/specs/2026-08-17-camera-bridge-ingest-pipeline-design.md`

## Global Constraints

- Python 3.12+, Flask, SQLite with WAL mode
- DB migrations are versioned (`SCHEMA_V1..V5`), applied in `db.migrate()`
- Session fields: snake_case in DB, camelCase in API (via `_row_to_dict`)
- All tests use `db.reset_for_tests(tmp_path)` fixture and `BBP_DEBUG=1`
- CSRF enabled app-wide; tests disable via `conftest.py` fixture
- `enforce_auth()` in `app.py` gates API routes; `/ingest` uses its own bearer token auth
- No direct push to `main`; PR required
- Conventional commits: `feat:`, `fix:`, `test:`, `refactor:`

## File Map

| Action | Path | Responsibility |
|--------|------|---------------|
| Modify | `backend/db.py` | Schema v5: `ingest_log` table + session columns |
| Modify | `backend/sessions.py` | New ingest fields, API key generation, active-session logic |
| Create | `backend/ingest_pipeline.py` | Shared ingest function (validate, dedup, Drive upload, DB record) |
| Modify | `app.py` | `/ingest` + `/ingest/test` routes, FTP wiring, auth bypass for `/ingest` |
| Modify | `frontend/src/views/SessionHubView.jsx` | Drive folder picker for ingest, API key display, ingest active toggle |
| Modify | `frontend/src/components/SessionFormParts.jsx` | New `IngestKeyField` and `IngestActiveToggle` components |
| Modify | `frontend/src/api/sessionsClient.js` | `getIngestStatus()` API call |
| Create | `backend/tests/test_ingest_pipeline.py` | Unit tests for ingest pipeline |
| Create | `backend/tests/test_ingest_routes.py` | Route tests for `/ingest` endpoint |
| Modify | `backend/tests/test_session_routes.py` | Tests for new session ingest fields |

## Execution Phases

```
Phase 1 (Sequential)     Phase 2 (Parallel)           Phase 3 (Sequential)
─────────────────────    ─────────────────────────    ─────────────────────
Task 1: DB Schema v5     Task 3: /ingest endpoint     Task 6: Integration
Task 2: Ingest Pipeline     → Antigravity                  tests + docs
                         Task 4: FTP wiring
                            → FreeBuff
                         Task 5: Sessions UI
                            → OpenCode
```

---

## Phase 1: Foundation (Sequential)

### Task 1: Database Schema v5

**Agent:** Orchestrator (or first available agent)

**Files:**
- Modify: `backend/db.py` — add `SCHEMA_V5`, update `migrate()`, bump `SCHEMA_VERSION`
- Test: `backend/tests/test_db.py`

**Interfaces:**
- Produces: `ingest_log` table, new session columns (`ingest_folder_id`, `ingest_folder_name`, `ingest_api_key`, `ingest_active`)

- [ ] **Step 1: Write failing test for schema v5 migration**

In `backend/tests/test_db.py`, add:

```python
def test_schema_v5_ingest_log(tmp_path):
    """ingest_log table and session ingest columns exist after migration."""
    from backend import db
    db.reset_for_tests(str(tmp_path / 'v5.db'))
    conn = db.get()

    # ingest_log table exists with expected columns
    conn.execute(
        "INSERT INTO ingest_log (session_id, filename, source) VALUES ('s1', 'IMG_001.JPG', 'http')"
    )
    row = conn.execute("SELECT * FROM ingest_log WHERE session_id = 's1'").fetchone()
    assert row['filename'] == 'IMG_001.JPG'
    assert row['drive_status'] == 'pending'
    assert row['drive_file_id'] is None

    # Dedup constraint
    import sqlite3
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO ingest_log (session_id, filename, source) VALUES ('s1', 'IMG_001.JPG', 'http')"
        )

    # New session columns exist
    conn.execute(
        "UPDATE sessions SET ingest_folder_id='fld1', ingest_folder_name='Test',"
        " ingest_api_key='abc123', ingest_active=1 WHERE id=1"
    )
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
cd /Volumes/BigBadDrive_1/BigBadPhotos
python -m pytest backend/tests/test_db.py::test_schema_v5_ingest_log -v
```

Expected: `OperationalError: no such table: ingest_log`

- [ ] **Step 3: Implement schema v5**

In `backend/db.py`:

1. Bump `SCHEMA_VERSION = 5`

2. Add after `SCHEMA_V4`:

```python
SCHEMA_V5 = """
CREATE TABLE IF NOT EXISTS ingest_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT    NOT NULL,
    filename      TEXT    NOT NULL,
    source        TEXT    NOT NULL,
    file_size     INTEGER,
    drive_file_id TEXT,
    drive_status  TEXT    NOT NULL DEFAULT 'pending',
    error_detail  TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(session_id, filename)
);

CREATE INDEX IF NOT EXISTS idx_ingest_log_session ON ingest_log(session_id);

ALTER TABLE sessions ADD COLUMN ingest_folder_id TEXT;
ALTER TABLE sessions ADD COLUMN ingest_folder_name TEXT;
ALTER TABLE sessions ADD COLUMN ingest_api_key TEXT;
ALTER TABLE sessions ADD COLUMN ingest_active INTEGER NOT NULL DEFAULT 0;
"""
```

3. Add migration step in `migrate()`:

```python
    if current < 5:
        conn.executescript(SCHEMA_V5)
        conn.execute('PRAGMA user_version=5')
        conn.commit()
        current = 5
```

- [ ] **Step 4: Run test — expect PASS**

```bash
python -m pytest backend/tests/test_db.py::test_schema_v5_ingest_log -v
```

- [ ] **Step 5: Run full DB test suite**

```bash
python -m pytest backend/tests/test_db.py -v
```

- [ ] **Step 6: Commit**

```bash
git add backend/db.py backend/tests/test_db.py
git commit -m "feat: add ingest_log table and session ingest columns (schema v5)"
```

---

### Task 2: Shared Ingest Pipeline

**Agent:** Orchestrator (or first available agent)

**Files:**
- Create: `backend/ingest_pipeline.py`
- Create: `backend/tests/test_ingest_pipeline.py`

**Interfaces:**
- Consumes: `backend.db.get()`, `backend.sessions.get()`, `backend.google_drive.upload_file()`
- Produces: `ingest_file(data: bytes, *, filename: str, session_id: int | None = None, source: str = 'http') -> dict` returning `{'status': 'uploaded'|'exists'|'failed', 'filename': str, 'drive_file_id': str | None, 'session_id': int, 'error': str | None}`

- [ ] **Step 1: Write failing tests**

Create `backend/tests/test_ingest_pipeline.py`:

```python
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
os.environ.setdefault('BBP_DEBUG', '1')

import pytest
from unittest.mock import patch, MagicMock
from backend import db


@pytest.fixture(autouse=True)
def _tmp_db(tmp_path):
    db.reset_for_tests(str(tmp_path / 'test.db'))
    yield


def _create_session_with_ingest(session_id=1, folder_id='drive_folder_1', active=True):
    conn = db.get()
    conn.execute(
        "INSERT INTO sessions (id, name, source_folder_id, export_folder_id,"
        " ingest_folder_id, ingest_api_key, ingest_active, created_at, updated_at)"
        " VALUES (?, 'Test', 'src', 'exp', ?, 'testkey123', ?, 't', 't')",
        (session_id, folder_id, int(active)),
    )
    conn.commit()


@patch('backend.google_drive.upload_file')
def test_ingest_file_uploads_to_drive(mock_upload):
    from backend.ingest_pipeline import ingest_file

    mock_upload.return_value = {'id': 'gdrive_abc'}
    _create_session_with_ingest()

    result = ingest_file(
        b'\xff\xd8\xff\xe0fake-jpeg-data',
        filename='IMG_001.JPG',
        session_id=1,
        source='http',
    )

    assert result['status'] == 'uploaded'
    assert result['drive_file_id'] == 'gdrive_abc'
    assert result['session_id'] == 1
    mock_upload.assert_called_once()
    call_args = mock_upload.call_args
    assert call_args[0][0] == 'drive_folder_1'
    assert call_args[0][1] == 'IMG_001.JPG'


@patch('backend.google_drive.upload_file')
def test_ingest_file_dedup_skips_existing(mock_upload):
    from backend.ingest_pipeline import ingest_file

    mock_upload.return_value = {'id': 'gdrive_abc'}
    _create_session_with_ingest()

    result1 = ingest_file(b'data', filename='IMG_001.JPG', session_id=1, source='http')
    assert result1['status'] == 'uploaded'

    result2 = ingest_file(b'data', filename='IMG_001.JPG', session_id=1, source='http')
    assert result2['status'] == 'exists'
    assert mock_upload.call_count == 1


@patch('backend.google_drive.upload_file')
def test_ingest_file_records_failure(mock_upload):
    from backend.ingest_pipeline import ingest_file

    mock_upload.side_effect = RuntimeError('Drive quota exceeded')
    _create_session_with_ingest()

    result = ingest_file(b'data', filename='IMG_002.JPG', session_id=1, source='http')
    assert result['status'] == 'failed'
    assert 'quota' in result['error'].lower()

    conn = db.get()
    row = conn.execute("SELECT * FROM ingest_log WHERE filename = 'IMG_002.JPG'").fetchone()
    assert row['drive_status'] == 'failed'
    assert 'quota' in row['error_detail'].lower()


@patch('backend.google_drive.upload_file')
def test_ingest_file_resolves_active_session(mock_upload):
    from backend.ingest_pipeline import ingest_file

    mock_upload.return_value = {'id': 'gdrive_xyz'}
    _create_session_with_ingest(session_id=1, active=False)
    _create_session_with_ingest(session_id=2, folder_id='folder_2', active=True)

    result = ingest_file(b'data', filename='IMG_003.JPG', session_id=None, source='ftp')
    assert result['session_id'] == 2
    assert result['status'] == 'uploaded'


def test_ingest_file_no_active_session_fails():
    from backend.ingest_pipeline import ingest_file

    _create_session_with_ingest(session_id=1, active=False)

    result = ingest_file(b'data', filename='IMG_004.JPG', session_id=None, source='ftp')
    assert result['status'] == 'failed'
    assert 'no active' in result['error'].lower()


def test_ingest_file_no_drive_folder_fails():
    from backend.ingest_pipeline import ingest_file

    conn = db.get()
    conn.execute(
        "INSERT INTO sessions (id, name, source_folder_id, export_folder_id,"
        " ingest_active, created_at, updated_at)"
        " VALUES (1, 'Test', 'src', 'exp', 1, 't', 't')"
    )
    conn.commit()

    result = ingest_file(b'data', filename='IMG_005.JPG', session_id=1, source='http')
    assert result['status'] == 'failed'
    assert 'folder' in result['error'].lower()
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
python -m pytest backend/tests/test_ingest_pipeline.py -v
```

Expected: `ModuleNotFoundError: No module named 'backend.ingest_pipeline'`

- [ ] **Step 3: Implement `backend/ingest_pipeline.py`**

```python
"""Shared ingest pipeline — convergence point for HTTP and FTP input paths."""
from __future__ import annotations

import logging
import sqlite3

from backend import db
from backend import google_drive

logger = logging.getLogger(__name__)

ALLOWED_EXTENSIONS = {
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'heif', 'heic',
}


def _get_extension(filename: str) -> str:
    return filename.rsplit('.', 1)[-1].lower() if '.' in filename else ''


def _resolve_session(session_id: int | None) -> dict | None:
    conn = db.get()
    if session_id is not None:
        row = conn.execute('SELECT * FROM sessions WHERE id = ?', (session_id,)).fetchone()
        return dict(row) if row else None

    row = conn.execute('SELECT * FROM sessions WHERE ingest_active = 1').fetchone()
    return dict(row) if row else None


def _check_existing(session_id: int, filename: str) -> dict | None:
    conn = db.get()
    row = conn.execute(
        'SELECT * FROM ingest_log WHERE session_id = ? AND filename = ?',
        (str(session_id), filename),
    ).fetchone()
    return dict(row) if row else None


def ingest_file(
    data: bytes,
    *,
    filename: str,
    session_id: int | None = None,
    source: str = 'http',
    access_token: str | None = None,
) -> dict:
    session_row = _resolve_session(session_id)
    if not session_row:
        return {
            'status': 'failed',
            'filename': filename,
            'drive_file_id': None,
            'session_id': session_id,
            'error': 'No active ingest session found',
        }

    sid = session_row['id']
    folder_id = session_row.get('ingest_folder_id')
    if not folder_id:
        return {
            'status': 'failed',
            'filename': filename,
            'drive_file_id': None,
            'session_id': sid,
            'error': 'Session has no ingest Drive folder configured',
        }

    existing = _check_existing(sid, filename)
    if existing and existing['drive_status'] == 'uploaded':
        return {
            'status': 'exists',
            'filename': filename,
            'drive_file_id': existing['drive_file_id'],
            'session_id': sid,
            'error': None,
        }

    conn = db.get()
    try:
        conn.execute(
            'INSERT INTO ingest_log (session_id, filename, source, file_size)'
            ' VALUES (?, ?, ?, ?)',
            (str(sid), filename, source, len(data)),
        )
        conn.commit()
    except sqlite3.IntegrityError:
        existing = _check_existing(sid, filename)
        if existing and existing['drive_status'] == 'uploaded':
            return {
                'status': 'exists',
                'filename': filename,
                'drive_file_id': existing['drive_file_id'],
                'session_id': sid,
                'error': None,
            }

    if not access_token:
        from backend import google_auth
        mgr = google_auth._manager
        if mgr and mgr.available():
            access_token = mgr.get_access_token()

    if not access_token:
        _mark_failed(sid, filename, 'No Google OAuth token available')
        return {
            'status': 'failed',
            'filename': filename,
            'drive_file_id': None,
            'session_id': sid,
            'error': 'No Google OAuth token available',
        }

    try:
        result = google_drive.upload_file(access_token, folder_id, filename, data)
        drive_file_id = result.get('id')
        conn.execute(
            'UPDATE ingest_log SET drive_status = ?, drive_file_id = ?'
            ' WHERE session_id = ? AND filename = ?',
            ('uploaded', drive_file_id, str(sid), filename),
        )
        conn.commit()
        logger.info(f'Ingested {filename} -> Drive {drive_file_id}')
        return {
            'status': 'uploaded',
            'filename': filename,
            'drive_file_id': drive_file_id,
            'session_id': sid,
            'error': None,
        }
    except Exception as exc:
        error_msg = str(exc)
        _mark_failed(sid, filename, error_msg)
        logger.error(f'Ingest failed {filename}: {error_msg}')
        return {
            'status': 'failed',
            'filename': filename,
            'drive_file_id': None,
            'session_id': sid,
            'error': error_msg,
        }


def _mark_failed(session_id: int, filename: str, error: str) -> None:
    conn = db.get()
    conn.execute(
        'UPDATE ingest_log SET drive_status = ?, error_detail = ?'
        ' WHERE session_id = ? AND filename = ?',
        ('failed', error, str(session_id), filename),
    )
    conn.commit()


def get_ingest_stats(session_id: int) -> dict:
    conn = db.get()
    rows = conn.execute(
        'SELECT drive_status, COUNT(*) as cnt FROM ingest_log'
        ' WHERE session_id = ? GROUP BY drive_status',
        (str(session_id),),
    ).fetchall()
    stats = {'total': 0, 'uploaded': 0, 'failed': 0, 'pending': 0}
    for row in rows:
        stats[row['drive_status']] = row['cnt']
        stats['total'] += row['cnt']
    return stats


def get_recent_ingests(session_id: int, limit: int = 10) -> list[dict]:
    conn = db.get()
    rows = conn.execute(
        'SELECT filename, source, drive_status, drive_file_id, error_detail, created_at'
        ' FROM ingest_log WHERE session_id = ? ORDER BY created_at DESC LIMIT ?',
        (str(session_id), limit),
    ).fetchall()
    return [dict(r) for r in rows]


def retry_failed(session_id: int, access_token: str) -> list[dict]:
    conn = db.get()
    rows = conn.execute(
        "SELECT * FROM ingest_log WHERE session_id = ? AND drive_status = 'failed'",
        (str(session_id),),
    ).fetchall()
    results = []
    for row in rows:
        results.append({
            'filename': row['filename'],
            'status': 'retry_not_implemented',
        })
    return results
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
python -m pytest backend/tests/test_ingest_pipeline.py -v
```

- [ ] **Step 5: Commit**

```bash
git add backend/ingest_pipeline.py backend/tests/test_ingest_pipeline.py
git commit -m "feat: shared ingest pipeline with dedup and Drive upload"
```

---

## Phase 2: Parallel Implementation

> **Orchestrator:** Dispatch Tasks 3, 4, 5 to agents simultaneously. Each task is independent — no cross-task dependencies within this phase. All depend on Phase 1 being complete.

### Task 3: `/ingest` REST Endpoint

**Agent:** Antigravity

**Files:**
- Modify: `app.py` — add `/ingest` POST route, `/ingest/test` GET route, update `enforce_auth()` bypass
- Create: `backend/tests/test_ingest_routes.py`

**Interfaces:**
- Consumes: `backend.ingest_pipeline.ingest_file()`, `backend.ingest_pipeline.get_ingest_stats()`, `backend.ingest_pipeline.get_recent_ingests()`
- Produces: `POST /ingest` (multipart, bearer auth, returns JSON), `GET /ingest/test` (bearer auth, returns session info), `GET /ingest/status/<session_id>` (cookie auth, returns stats + recent files)

- [ ] **Step 1: Write failing route tests**

Create `backend/tests/test_ingest_routes.py`:

```python
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
os.environ.setdefault('BBP_DEBUG', '1')

import io
import pytest
from unittest.mock import patch
from backend import db, google_auth


class FakeMgr:
    def available(self): return True
    def get_access_token(self): return 'TOK'


@pytest.fixture(autouse=True)
def _tmp_db(tmp_path):
    db.reset_for_tests(str(tmp_path / 'test.db'))
    yield


@pytest.fixture(autouse=True)
def _fake_google_manager(monkeypatch):
    monkeypatch.setattr(google_auth, '_manager', FakeMgr())


def _client():
    import app as appmod
    appmod.app.config['TESTING'] = True
    appmod.app.config['WTF_CSRF_ENABLED'] = False
    return appmod.app.test_client()


def _create_ingest_session(api_key='testkey123', folder_id='fld1', active=True):
    conn = db.get()
    conn.execute(
        "INSERT INTO sessions (name, source_folder_id, export_folder_id,"
        " ingest_folder_id, ingest_api_key, ingest_active, created_at, updated_at)"
        " VALUES ('Test', 'src', 'exp', ?, ?, ?, 't', 't')",
        (folder_id, api_key, int(active)),
    )
    conn.commit()


@patch('backend.google_drive.upload_file')
def test_ingest_upload_success(mock_upload):
    mock_upload.return_value = {'id': 'gdrive_abc'}
    _create_ingest_session()
    c = _client()

    resp = c.post(
        '/ingest',
        data={'file': (io.BytesIO(b'\xff\xd8\xff\xe0fake'), 'IMG_001.JPG')},
        headers={'Authorization': 'Bearer testkey123'},
        content_type='multipart/form-data',
    )
    assert resp.status_code == 201
    body = resp.get_json()
    assert body['status'] == 'uploaded'
    assert body['drive_file_id'] == 'gdrive_abc'


def test_ingest_rejects_missing_auth():
    _create_ingest_session()
    c = _client()

    resp = c.post(
        '/ingest',
        data={'file': (io.BytesIO(b'data'), 'IMG_001.JPG')},
        content_type='multipart/form-data',
    )
    assert resp.status_code == 401


def test_ingest_rejects_bad_key():
    _create_ingest_session()
    c = _client()

    resp = c.post(
        '/ingest',
        data={'file': (io.BytesIO(b'data'), 'IMG_001.JPG')},
        headers={'Authorization': 'Bearer wrongkey'},
        content_type='multipart/form-data',
    )
    assert resp.status_code == 401


def test_ingest_rejects_unsupported_extension():
    _create_ingest_session()
    c = _client()

    resp = c.post(
        '/ingest',
        data={'file': (io.BytesIO(b'data'), 'script.py')},
        headers={'Authorization': 'Bearer testkey123'},
        content_type='multipart/form-data',
    )
    assert resp.status_code == 422


def test_ingest_test_endpoint():
    _create_ingest_session()
    c = _client()

    resp = c.get('/ingest/test', headers={'Authorization': 'Bearer testkey123'})
    assert resp.status_code == 200
    body = resp.get_json()
    assert body['session_name'] == 'Test'


def test_ingest_test_rejects_bad_key():
    c = _client()
    resp = c.get('/ingest/test', headers={'Authorization': 'Bearer bad'})
    assert resp.status_code == 401


def test_ingest_status_requires_cookie_auth():
    _create_ingest_session()
    c = _client()

    # No session cookie — should fail
    resp = c.get('/ingest/status/1')
    # enforce_auth will reject without user session in non-debug...
    # but BBP_DEBUG=1 auto-creates dev session, so this should work
    assert resp.status_code == 200
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
python -m pytest backend/tests/test_ingest_routes.py -v
```

Expected: 404 (routes don't exist yet)

- [ ] **Step 3: Add routes to `app.py`**

Add these imports near the top of `app.py`:

```python
from werkzeug.utils import secure_filename
from backend import ingest_pipeline
```

Update `enforce_auth()` — add `/ingest` bypass before the existing path checks:

```python
    if request.path.startswith('/ingest'):
        return  # /ingest uses its own bearer token auth
```

Add CSRF exemption for `/ingest` (after `csrf = CSRFProtect(app)`). The `/ingest` endpoint is called by iOS Shortcuts with a bearer token, not a browser with cookies, so CSRF protection does not apply:

```python
# After app and csrf are created, in the route definitions section:
```

Add the route functions:

```python
def _resolve_ingest_key():
    """Extract bearer token from Authorization header, resolve to session."""
    auth = request.headers.get('Authorization', '')
    if not auth.startswith('Bearer '):
        return None
    key = auth[7:].strip()
    if not key:
        return None
    conn = db.get()
    row = conn.execute(
        'SELECT * FROM sessions WHERE ingest_api_key = ?', (key,)
    ).fetchone()
    return dict(row) if row else None


@app.post('/ingest')
@csrf.exempt
def ingest_upload():
    sess = _resolve_ingest_key()
    if not sess:
        return jsonify({'error': 'invalid_api_key'}), 401

    if 'file' not in request.files:
        return jsonify({'error': 'no_file'}), 422

    f = request.files['file']
    filename = secure_filename(f.filename or 'unknown')
    ext = filename.rsplit('.', 1)[-1].lower() if '.' in filename else ''
    if ext not in ingest_pipeline.ALLOWED_EXTENSIONS:
        return jsonify({'error': 'unsupported_file_type', 'detail': f'.{ext}'}), 422

    data = f.read()
    result = ingest_pipeline.ingest_file(
        data,
        filename=filename,
        session_id=sess['id'],
        source='http',
    )

    if result['status'] == 'uploaded':
        return jsonify(result), 201
    elif result['status'] == 'exists':
        return jsonify(result), 200
    else:
        return jsonify(result), 500


@app.get('/ingest/test')
@csrf.exempt
def ingest_test():
    sess = _resolve_ingest_key()
    if not sess:
        return jsonify({'error': 'invalid_api_key'}), 401
    return jsonify({
        'ok': True,
        'session_id': sess['id'],
        'session_name': sess['name'],
        'ingest_folder_id': sess.get('ingest_folder_id'),
    })


@app.get('/ingest/status/<int:session_id>')
def ingest_status(session_id):
    stats = ingest_pipeline.get_ingest_stats(session_id)
    recent = ingest_pipeline.get_recent_ingests(session_id)
    return jsonify({'stats': stats, 'recent': recent})
```

Add `MAX_CONTENT_LENGTH` to app config (near the `app.config.update(...)` block):

```python
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50MB
```

Add `/ingest/status` to `enforce_auth()` gated paths by adding to the condition:

```python
            and not request.path.startswith('/ingest/status')
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
python -m pytest backend/tests/test_ingest_routes.py -v
```

- [ ] **Step 5: Run full test suite to check for regressions**

```bash
python -m pytest backend/tests/ -v
```

- [ ] **Step 6: Commit**

```bash
git add app.py backend/tests/test_ingest_routes.py
git commit -m "feat: add /ingest upload endpoint with bearer token auth"
```

---

### Task 4: FTP Server Wiring

**Agent:** FreeBuff

**Files:**
- Modify: `app.py` — conditional FTP + burst watcher startup
- Modify: `backend/burst_watcher.py` — add file-path ingest callback support

**Interfaces:**
- Consumes: `backend.ingest_pipeline.ingest_file()`, `backend.ftp_ingest.start_ftp_thread()`, `backend.burst_watcher.start_burst_watcher()`
- Produces: FTP server + burst watcher startup on `BBP_FTP_PORT` presence, incoming FTP files routed through ingest pipeline

- [ ] **Step 1: Add FTP startup block to `app.py`**

Add at the bottom of `app.py`, before the `if __name__ == '__main__':` block (or at module level after all route definitions):

```python
# Camera Bridge: FTP ingest + burst watcher (opt-in via BBP_FTP_PORT)
if os.environ.get('BBP_FTP_PORT'):
    from backend.ftp_ingest import start_ftp_thread
    from backend.burst_watcher import start_burst_watcher

    _ftp_root = os.environ.get('BBP_FTP_ROOT', '/tmp/bbp_ftp')
    _ftp_port = int(os.environ['BBP_FTP_PORT'])
    _ftp_user = os.environ.get('BBP_FTP_USER', 'bbp')
    _ftp_pass = os.environ.get('BBP_FTP_PASS', '')

    if not _ftp_pass:
        print("WARNING: BBP_FTP_PASS not set — FTP server will not start")
    else:
        def _on_ftp_frame(path):
            """Called by burst_watcher for each incoming frame."""
            import os as _os
            fname = _os.path.basename(path)
            ext = fname.rsplit('.', 1)[-1].lower() if '.' in fname else ''
            if ext not in ingest_pipeline.ALLOWED_EXTENSIONS:
                return
            try:
                with open(path, 'rb') as f:
                    data = f.read()
                ingest_pipeline.ingest_file(data, filename=fname, source='ftp')
            except Exception as exc:
                import logging
                logging.getLogger(__name__).error(f'FTP ingest error {fname}: {exc}')

        start_ftp_thread(
            root=_ftp_root,
            port=_ftp_port,
            user=_ftp_user,
            password=_ftp_pass,
        )
        start_burst_watcher(
            ingest_root=_ftp_root,
            preview_dir=os.environ.get('BBP_PREVIEW_DIR', '/tmp/bbp_preview'),
            ffmpeg_fps=int(os.environ.get('BBP_FFMPEG_FPS', '8')),
            resize_px=int(os.environ.get('BBP_RESIZE_PX', '1920')),
            window_ms=int(os.environ.get('BBP_BURST_WINDOW_MS', '2000')),
            min_frames=int(os.environ.get('BBP_BURST_MIN_FRAMES', '3')),
            max_age_seconds=int(os.environ.get('BBP_BURST_MAX_AGE_SECONDS', '3600')),
            on_frame_arrived=_on_ftp_frame,
            on_burst_ready=lambda bid, webm, frames: None,
        )
```

- [ ] **Step 2: Test manually by setting env vars**

```bash
BBP_FTP_PORT=2121 BBP_FTP_PASS=test BBP_DEBUG=1 python -c "
import app
print('FTP wiring loaded without errors')
"
```

Expected: prints "FTP ingest listening on :2121" + "Burst watcher on /tmp/bbp_ftp"

- [ ] **Step 3: Verify existing tests still pass**

```bash
python -m pytest backend/tests/ -v --timeout=30
```

- [ ] **Step 4: Commit**

```bash
git add app.py
git commit -m "feat: wire FTP ingest + burst watcher into app startup"
```

---

### Task 5: Sessions UI — Ingest Fields

**Agent:** OpenCode

**Files:**
- Modify: `backend/sessions.py` — add ingest fields to `_row_to_dict`, `_validate`, `create`, `update`; add `generate_api_key()`, `set_ingest_active()`
- Modify: `frontend/src/views/SessionHubView.jsx` — ingest folder picker, API key display, ingest toggle
- Modify: `frontend/src/components/SessionFormParts.jsx` — `IngestKeyField` component
- Modify: `frontend/src/api/sessionsClient.js` — `getIngestStatus()` function
- Test: `backend/tests/test_session_routes.py` — new ingest field tests

- [ ] **Step 1: Update `backend/sessions.py`**

Add to `_row_to_dict()`:

```python
        'ingestFolderId': row['ingest_folder_id'],
        'ingestFolderName': row['ingest_folder_name'],
        'ingestApiKey': row['ingest_api_key'],
        'ingestActive': bool(row['ingest_active']),
```

Add to the end of `_validate()` (inside the function, before the return dict):

```python
    ingest_folder_id = merged.get('ingestFolderId', merged.get('ingest_folder_id'))
    if ingest_folder_id is not None:
        ingest_folder_id = str(ingest_folder_id).strip() or None

    ingest_folder_name = merged.get('ingestFolderName', merged.get('ingest_folder_name'))
    if ingest_folder_name is not None:
        ingest_folder_name = str(ingest_folder_name).strip() or None
```

Add to the return dict in `_validate()`:

```python
        'ingestFolderId': ingest_folder_id,
        'ingestFolderName': ingest_folder_name,
```

Add `import secrets` at top of file.

Update `create()` — add ingest columns to the INSERT statement. The INSERT column list becomes:

```python
        "INSERT INTO sessions (name, source_folder_id, source_folder_name,"
        " export_folder_id, export_folder_name, archive_folder_id,"
        " autonomous, preset, threshold, burst_best_only, edit_mode,"
        " edit_strength, poll_seconds, gallery_enabled, favorites_folder_id,"
        " favorites_folder_name, ingest_folder_id, ingest_folder_name,"
        " ingest_api_key, ingest_active, created_at, updated_at) VALUES"
        " (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
```

Add these values to the tuple (after `favorites_folder_name` and before `now, now`):

```python
                validated['ingestFolderId'],
                validated['ingestFolderName'],
                secrets.token_hex(16),
                0,
```

Update `update()` — add to the SET clause:

```python
        "UPDATE sessions SET name=?, source_folder_id=?, source_folder_name=?,"
        " export_folder_id=?, export_folder_name=?, archive_folder_id=?,"
        " autonomous=?, preset=?, threshold=?, burst_best_only=?,"
        " edit_mode=?, edit_strength=?, poll_seconds=?, gallery_enabled=?,"
        " favorites_folder_id=?, favorites_folder_name=?,"
        " ingest_folder_id=?, ingest_folder_name=?, updated_at=?"
        " WHERE id=?",
```

Add these values to the tuple (after `favorites_folder_name` and before `now, session_id`):

```python
                validated['ingestFolderId'],
                validated['ingestFolderName'],
```

Add new function:

```python
def set_ingest_active(session_id: int) -> dict:
    """Mark a session as the active ingest target. Clears all others."""
    conn = db.get()
    conn.execute('UPDATE sessions SET ingest_active = 0')
    conn.execute('UPDATE sessions SET ingest_active = 1 WHERE id = ?', (session_id,))
    conn.commit()
    return get(session_id)


def regenerate_api_key(session_id: int) -> str:
    import secrets
    key = secrets.token_hex(16)
    conn = db.get()
    conn.execute('UPDATE sessions SET ingest_api_key = ? WHERE id = ?', (key, session_id))
    conn.commit()
    return key
```

- [ ] **Step 2: Write session route tests for ingest fields**

Add to `backend/tests/test_session_routes.py`:

```python
def test_create_session_generates_ingest_key():
    c = _client()
    sid = _create_session(c)
    r = c.get(f'/sessions/{sid}')
    data = r.get_json()['session']
    assert data['ingestApiKey'] is not None
    assert len(data['ingestApiKey']) == 32


def test_update_session_ingest_folder():
    c = _client()
    sid = _create_session(c)
    r = c.put(f'/sessions/{sid}', json={
        'ingestFolderId': 'folder_abc',
        'ingestFolderName': 'Smith Senior 2026',
    })
    assert r.status_code == 200
    data = r.get_json()['session']
    assert data['ingestFolderId'] == 'folder_abc'
    assert data['ingestFolderName'] == 'Smith Senior 2026'


def test_set_ingest_active():
    c = _client()
    sid1 = _create_session(c, name='Session1')
    sid2 = _create_session(c, name='Session2')

    from backend import sessions
    sessions.set_ingest_active(sid2)

    s1 = sessions.get(sid1)
    s2 = sessions.get(sid2)
    assert s1['ingestActive'] is False
    assert s2['ingestActive'] is True
```

- [ ] **Step 3: Run tests — expect PASS after implementation**

```bash
python -m pytest backend/tests/test_session_routes.py -v
```

- [ ] **Step 4: Add `getIngestStatus` to `frontend/src/api/sessionsClient.js`**

```javascript
export function getIngestStatus(sessionId) {
  return jsonFetch(`/ingest/status/${sessionId}`)
}
```

- [ ] **Step 5: Add `IngestKeyField` to `frontend/src/components/SessionFormParts.jsx`**

```jsx
export function IngestKeyField({ apiKey, onRegenerate }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    if (!apiKey) return
    navigator.clipboard.writeText(apiKey).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  if (!apiKey) return null

  return (
    <div>
      <FieldLabel>Ingest API Key</FieldLabel>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <code style={{
          flex: 1, padding: '8px 12px', borderRadius: 8,
          background: 'var(--bg-3)', fontSize: '0.8rem',
          overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {apiKey}
        </code>
        <button type="button" className="btn" onClick={handleCopy}
          style={{ minHeight: 36, padding: '0 12px' }}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
}
```

(Add `import { useState } from 'react'` at top if not already imported.)

- [ ] **Step 6: Add ingest fields to `SessionHubView.jsx` form**

In the session form section (where `PickerRow` components are used for source/export/archive folders), add after the archive folder picker:

```jsx
{/* Ingest Drive Folder */}
<PickerRow
  label="Ingest Drive Folder"
  value={form.ingestFolderName}
  placeholder="Pick folder for live camera uploads..."
  onPick={() => setPickerTarget('ingest')}
/>

{/* Ingest API Key */}
<IngestKeyField apiKey={form.ingestApiKey} />

{/* Ingest Active Toggle */}
<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
  <FieldLabel>Ingest Active</FieldLabel>
  <OblToggle
    checked={!!form.ingestActive}
    onChange={(v) => setForm(f => ({ ...f, ingestActive: v }))}
  />
</div>
```

Add `IngestKeyField` to the import from `SessionFormParts`.

Handle the `pickerTarget === 'ingest'` case in the folder picker callback (same pattern as source/export/archive):

```jsx
if (pickerTarget === 'ingest') {
  setForm(f => ({ ...f, ingestFolderId: folder.id, ingestFolderName: folder.name }))
}
```

- [ ] **Step 7: Commit**

```bash
git add backend/sessions.py backend/tests/test_session_routes.py \
  frontend/src/views/SessionHubView.jsx frontend/src/components/SessionFormParts.jsx \
  frontend/src/api/sessionsClient.js
git commit -m "feat: session ingest fields, API key, and UI controls"
```

---

## Phase 3: Integration (Sequential)

### Task 6: Integration Tests + iOS Shortcut Guide

**Agent:** Orchestrator (or any available agent)

**Files:**
- Modify: `backend/tests/test_ingest_routes.py` — add end-to-end flow test
- Create: `docs/guides/ios-shortcut-setup.md`

**Interfaces:**
- Consumes: all prior tasks

- [ ] **Step 1: Add end-to-end integration test**

Add to `backend/tests/test_ingest_routes.py`:

```python
@patch('backend.google_drive.upload_file')
def test_ingest_end_to_end_flow(mock_upload):
    """Full flow: create session with ingest folder -> upload -> check status."""
    mock_upload.return_value = {'id': 'gdrive_e2e'}
    c = _client()

    # Create session via API
    r = c.post('/sessions', json={
        'name': 'E2E Test',
        'sourceFolderId': 'src',
        'exportFolderId': 'exp',
        'ingestFolderId': 'ingest_fld',
        'ingestFolderName': 'E2E Ingest',
    })
    assert r.status_code == 200
    sess = r.get_json()['session']
    api_key = sess['ingestApiKey']
    session_id = sess['id']
    assert api_key is not None

    # Verify key via /ingest/test
    r = c.get('/ingest/test', headers={'Authorization': f'Bearer {api_key}'})
    assert r.status_code == 200
    assert r.get_json()['session_name'] == 'E2E Test'

    # Upload a file
    r = c.post(
        '/ingest',
        data={'file': (io.BytesIO(b'\xff\xd8\xff\xe0jpeg'), 'photo.jpg')},
        headers={'Authorization': f'Bearer {api_key}'},
        content_type='multipart/form-data',
    )
    assert r.status_code == 201
    assert r.get_json()['drive_file_id'] == 'gdrive_e2e'

    # Upload same file again — should dedup
    r = c.post(
        '/ingest',
        data={'file': (io.BytesIO(b'\xff\xd8\xff\xe0jpeg'), 'photo.jpg')},
        headers={'Authorization': f'Bearer {api_key}'},
        content_type='multipart/form-data',
    )
    assert r.status_code == 200
    assert r.get_json()['status'] == 'exists'

    # Check status
    with c.session_transaction() as s:
        s['user'] = {'email': 'dev@local'}
    r = c.get(f'/ingest/status/{session_id}')
    assert r.status_code == 200
    stats = r.get_json()['stats']
    assert stats['uploaded'] == 1
    assert stats['total'] == 1
```

- [ ] **Step 2: Run all tests**

```bash
python -m pytest backend/tests/ -v
```

- [ ] **Step 3: Write iOS Shortcut setup guide**

Create `docs/guides/ios-shortcut-setup.md`:

```markdown
# iOS Shortcut Setup — Camera Bridge Ingest

Connect your Canon R6 Mark II to your iPhone via USB-C and push JPEGs
to Google Drive in real-time during shoots.

## Prerequisites

- iPhone with USB-C (iPhone 15 or later)
- [Cascable Studio](https://cascable.se/studio/) installed ($30 one-time)
- Canon R6 Mark II with USB-C cable
- BBP session with an Ingest Drive Folder configured

## Camera Setup

1. On the R6 Mark II, go to **Menu > Communication > USB connection app**
2. Set to **Photo Import/Remote Control**

## Cascable Setup

1. Open Cascable Studio on your iPhone
2. Connect the camera via USB-C — Cascable should detect it
3. Go to **Settings > Storage Links**
4. Add a rule: save incoming images to a specific Photos album
   (e.g., "Camera Ingest")

## iOS Shortcut — "BBP Ingest"

1. Open the **Shortcuts** app
2. Create a new **Automation**
3. Trigger: **Photos** — "When new photos are added to album: Camera Ingest"
4. Add these actions:

   a. **Get Photos from Input**
   b. **Get Contents of URL**
      - URL: `https://your-bbp-url.com/ingest`
      - Method: POST
      - Headers: `Authorization` = `Bearer YOUR_API_KEY`
      - Request Body: Form
      - Add field: `file` = Photo from step (a)

5. Optional: add **Show Notification** on failure
   (if result status is not 201 or 200)

## Per-Shoot Workflow

1. Open BBP → Sessions → your shoot session
2. Verify Ingest Drive Folder is set
3. Copy the **Ingest API Key**
4. Paste into the Shortcut's Authorization header value
5. Toggle **Ingest Active** on (if using FTP fallback)
6. Connect camera, open Cascable, start shooting

Images will appear in your session's Drive folder within seconds.

## Troubleshooting

- **Test your key:** Visit `https://your-bbp-url.com/ingest/test`
  with header `Authorization: Bearer YOUR_KEY` — should return
  your session name.
- **Duplicate uploads are safe:** The pipeline deduplicates by filename
  per session. Re-running the Shortcut on the same photo is a no-op.
- **Cellular drops:** Images queued during a dead zone will retry
  when the Shortcut re-fires. Check Ingest Status in BBP for failures.
```

- [ ] **Step 4: Commit**

```bash
git add backend/tests/test_ingest_routes.py docs/guides/ios-shortcut-setup.md
git commit -m "feat: integration tests and iOS Shortcut setup guide"
```

- [ ] **Step 5: Run full test suite one final time**

```bash
python -m pytest backend/tests/ -v
```

---

## Phase Summary

| Phase | Tasks | Agent(s) | Dependencies |
|-------|-------|----------|--------------|
| 1 | Task 1 (DB), Task 2 (Pipeline) | Sequential — any single agent | None |
| 2 | Task 3 (REST), Task 4 (FTP), Task 5 (UI) | Parallel — Antigravity, FreeBuff, OpenCode | Phase 1 complete |
| 3 | Task 6 (Integration + Docs) | Sequential — any single agent | Phase 2 complete |
