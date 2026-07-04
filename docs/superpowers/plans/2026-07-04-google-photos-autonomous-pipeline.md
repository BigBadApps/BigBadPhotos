# Google Photos + Server-Side Autonomous Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish selected/edited photos to app-created Google Photos albums, and run the full Drive→score→Topaz→Photos pipeline as an unattended worker on the Mac, controlled from the phone.

**Architecture:** Authorization-code OAuth with a server-side refresh token feeds both the existing Drive proxy and a new Photos proxy. The scoring core is extracted from `app.py` into `backend/scoring.py` so a new `backend/session_worker.py` thread can score in-process, edit via `backend/topaz.py`, and publish via `backend/google_photos.py`. The React app gains an album picker, a Photos export path, and a server-worker control panel.

**Tech Stack:** Flask, requests, OpenCV, Pillow (EXIF), Zustand/React (Vite 8), Google Photos Library API v1, Google OAuth 2.0.

**Spec:** `docs/superpowers/specs/2026-07-04-google-photos-autonomous-pipeline-design.md`

## Global Constraints

- Branch `bbaf/bigbadphotos-bobs-photo-services`; conventional commits; **never push**; PRs need Robert's approval.
- **Do NOT modify** these files (Robert's uncommitted work in progress): `frontend/src/index.css`, `frontend/src/views/CompareView.jsx`, `frontend/src/views/CullingView.jsx`, `frontend/src/views/EditView.jsx`, `frontend/src/views/LandingView.jsx`.
- pytest is NOT installed. Backend tests follow the `backend/tests/test_topaz.py` pattern: plain functions + `__main__` runner. Run with `.venv/bin/python backend/tests/test_<name>.py` from repo root (add repo root to `sys.path` in each test file).
- Frontend has no unit test runner; verification = `cd frontend && npm run build` (Vite 8 / rolldown — do not use `npx esbuild`).
- Photos API constraint: app-created albums only (`photoslibrary.appendonly`, `photoslibrary.readonly.appcreateddata`). Never reference removed scopes (`photoslibrary`, `photoslibrary.readonly`, `photoslibrary.sharing`).
- Secrets stay in `.env` (gitignored). New env: `GOOGLE_CLIENT_SECRET`, optional `BBP_TOKEN_PATH`.
- Sidecar schema stays `bigbadphotos.processed.v1` — worker adds optional `published` and `edit` keys; existing readers must keep working.
- All `requests` calls carry explicit `timeout=`.

---

### Task 1: Google auth manager (`backend/google_auth.py`)

**Files:**
- Create: `backend/google_auth.py`
- Test: `backend/tests/test_google_auth.py`

**Interfaces:**
- Consumes: env `GOOGLE_CLIENT_ID`/`VITE_GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `BBP_TOKEN_PATH`.
- Produces (used by Tasks 2, 4, 11):
  - `OAUTH_SCOPES: list[str]`
  - `class GoogleAuthError(Exception)`
  - `class GoogleAuthManager` — `__init__(self, token_path=None, client_id=None, client_secret=None)`, `available() -> bool`, `get_access_token() -> str` (raises `GoogleAuthError`), `store_tokens(token_response: dict) -> None`, `clear() -> None`
  - `build_auth_url(client_id: str, redirect_uri: str, state: str) -> str`
  - `exchange_code(client_id: str, client_secret: str, code: str, redirect_uri: str) -> dict`
  - `get_manager() -> GoogleAuthManager` (module singleton)

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_google_auth.py
"""Tests for backend.google_auth. Standalone runner (no pytest)."""
import json
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from backend import google_auth


def _mgr(tmpdir, **kw):
    return google_auth.GoogleAuthManager(
        token_path=os.path.join(tmpdir, 'tok.json'),
        client_id=kw.get('client_id', 'cid'),
        client_secret=kw.get('client_secret', 'csec'),
    )


def test_unavailable_without_token_file():
    with tempfile.TemporaryDirectory() as d:
        m = _mgr(d)
        assert m.available() is False


def test_store_then_available_and_file_mode_600():
    with tempfile.TemporaryDirectory() as d:
        m = _mgr(d)
        m.store_tokens({'refresh_token': 'r1', 'access_token': 'a1', 'expires_in': 3600})
        assert m.available() is True
        mode = os.stat(m.token_path).st_mode & 0o777
        assert mode == 0o600, f"expected 600, got {oct(mode)}"
        data = json.loads(open(m.token_path).read())
        assert data['refresh_token'] == 'r1'


def test_store_preserves_refresh_token_when_response_omits_it():
    # Google omits refresh_token on repeat consent — must not lose the stored one.
    with tempfile.TemporaryDirectory() as d:
        m = _mgr(d)
        m.store_tokens({'refresh_token': 'r1', 'access_token': 'a1', 'expires_in': 3600})
        m.store_tokens({'access_token': 'a2', 'expires_in': 3600})
        data = json.loads(open(m.token_path).read())
        assert data['refresh_token'] == 'r1'
        assert data['access_token'] == 'a2'


def test_get_access_token_returns_cached_when_fresh():
    with tempfile.TemporaryDirectory() as d:
        m = _mgr(d)
        m.store_tokens({'refresh_token': 'r1', 'access_token': 'fresh', 'expires_in': 3600})
        calls = []
        m._refresh = lambda: calls.append(1)  # must not be called
        assert m.get_access_token() == 'fresh'
        assert calls == []


def test_get_access_token_refreshes_when_stale(monkey=None):
    with tempfile.TemporaryDirectory() as d:
        m = _mgr(d)
        m.store_tokens({'refresh_token': 'r1', 'access_token': 'old', 'expires_in': 30})
        # expires_in 30s is inside the 120s margin -> refresh path
        def fake_post(url, data=None, timeout=None):
            class R:
                ok = True
                def json(self):
                    return {'access_token': 'newtok', 'expires_in': 3600}
                def raise_for_status(self):
                    pass
            assert data['grant_type'] == 'refresh_token'
            assert data['refresh_token'] == 'r1'
            return R()
        google_auth.requests.post, orig = fake_post, google_auth.requests.post
        try:
            assert m.get_access_token() == 'newtok'
        finally:
            google_auth.requests.post = orig


def test_get_access_token_raises_without_credentials():
    with tempfile.TemporaryDirectory() as d:
        m = google_auth.GoogleAuthManager(
            token_path=os.path.join(d, 'tok.json'), client_id='', client_secret='')
        try:
            m.get_access_token()
        except google_auth.GoogleAuthError:
            return
        raise AssertionError('expected GoogleAuthError')


def test_build_auth_url_contains_required_params():
    url = google_auth.build_auth_url('cid', 'http://localhost:8002/google/oauth/callback', 'st8')
    assert 'accounts.google.com/o/oauth2/v2/auth' in url
    assert 'access_type=offline' in url
    assert 'prompt=consent' in url
    assert 'state=st8' in url
    assert 'photoslibrary.appendonly' in url
    assert 'photoslibrary.readonly.appcreateddata' in url
    assert 'auth%2Fdrive' in url  # url-encoded drive scope


def test_clear_removes_file():
    with tempfile.TemporaryDirectory() as d:
        m = _mgr(d)
        m.store_tokens({'refresh_token': 'r1', 'access_token': 'a1', 'expires_in': 3600})
        m.clear()
        assert m.available() is False


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"PASS  {t.__name__}")
        except Exception as e:
            failed += 1
            print(f"FAIL  {t.__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python backend/tests/test_google_auth.py`
Expected: FAIL / ImportError — `backend.google_auth` does not exist.

- [ ] **Step 3: Write the implementation**

```python
# backend/google_auth.py
"""Server-side Google OAuth (authorization-code flow) with a persisted refresh token.

Single-owner app: one token file holds the owner's Google credentials so the
Drive/Photos proxies and the autonomous worker can run unattended. The file
lives outside the repo (default ~/.bigbadphotos/google_token.json, mode 600).
"""
from __future__ import annotations

import json
import os
import threading
import time
from typing import Any
from urllib.parse import urlencode

import requests

GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

# Drive scope matches frontend DRIVE_SCOPES.write; Photos scopes are the only
# ones that still allow uploads + listing app-created albums (post-2025-03-31 API).
OAUTH_SCOPES = [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/photoslibrary.appendonly',
    'https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata',
]

DEFAULT_TOKEN_PATH = os.path.join(os.path.expanduser('~'), '.bigbadphotos', 'google_token.json')

# Refresh when fewer than this many seconds of validity remain.
EXPIRY_MARGIN_S = 120


class GoogleAuthError(Exception):
    pass


def build_auth_url(client_id: str, redirect_uri: str, state: str) -> str:
    params = {
        'client_id': client_id,
        'redirect_uri': redirect_uri,
        'response_type': 'code',
        'scope': ' '.join(OAUTH_SCOPES),
        'access_type': 'offline',
        'prompt': 'consent',
        'include_granted_scopes': 'true',
        'state': state,
    }
    return f'{GOOGLE_AUTH_URL}?{urlencode(params)}'


def exchange_code(client_id: str, client_secret: str, code: str, redirect_uri: str) -> dict:
    resp = requests.post(GOOGLE_TOKEN_URL, data={
        'client_id': client_id,
        'client_secret': client_secret,
        'code': code,
        'grant_type': 'authorization_code',
        'redirect_uri': redirect_uri,
    }, timeout=30)
    if not resp.ok:
        detail = resp.text
        try:
            detail = resp.json().get('error_description', detail)
        except ValueError:
            pass
        raise GoogleAuthError(f'code exchange failed: {detail}')
    return resp.json()


class GoogleAuthManager:
    def __init__(self, token_path: str | None = None,
                 client_id: str | None = None, client_secret: str | None = None):
        self.token_path = token_path or os.environ.get('BBP_TOKEN_PATH') or DEFAULT_TOKEN_PATH
        self.client_id = client_id if client_id is not None else (
            os.environ.get('GOOGLE_CLIENT_ID', '') or os.environ.get('VITE_GOOGLE_CLIENT_ID', ''))
        self.client_secret = client_secret if client_secret is not None else (
            os.environ.get('GOOGLE_CLIENT_SECRET', ''))
        self._lock = threading.Lock()

    # -- persistence ---------------------------------------------------------

    def _load(self) -> dict[str, Any] | None:
        try:
            with open(self.token_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def _write(self, data: dict[str, Any]) -> None:
        os.makedirs(os.path.dirname(self.token_path), exist_ok=True)
        tmp = f'{self.token_path}.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.token_path)

    def store_tokens(self, token_response: dict) -> None:
        with self._lock:
            existing = self._load() or {}
            refresh = token_response.get('refresh_token') or existing.get('refresh_token')
            data = {
                'refresh_token': refresh,
                'access_token': token_response.get('access_token'),
                'expires_at': time.time() + float(token_response.get('expires_in', 0)),
                'scope': token_response.get('scope', existing.get('scope', '')),
                'stored_at': time.time(),
            }
            self._write(data)

    def clear(self) -> None:
        with self._lock:
            try:
                os.remove(self.token_path)
            except OSError:
                pass

    # -- token access --------------------------------------------------------

    def available(self) -> bool:
        data = self._load()
        return bool(data and data.get('refresh_token') and self.client_id and self.client_secret)

    def get_access_token(self) -> str:
        if not self.client_id or not self.client_secret:
            raise GoogleAuthError('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured')
        with self._lock:
            data = self._load()
            if not data or not data.get('refresh_token'):
                raise GoogleAuthError('no stored Google credentials — connect via /google/oauth/start')
            if data.get('access_token') and data.get('expires_at', 0) - time.time() > EXPIRY_MARGIN_S:
                return data['access_token']
            return self._refresh_locked(data)

    def _refresh_locked(self, data: dict[str, Any]) -> str:
        resp = requests.post(GOOGLE_TOKEN_URL, data={
            'client_id': self.client_id,
            'client_secret': self.client_secret,
            'refresh_token': data['refresh_token'],
            'grant_type': 'refresh_token',
        }, timeout=30)
        if not resp.ok:
            detail = resp.text
            try:
                detail = resp.json().get('error_description', detail)
            except ValueError:
                pass
            raise GoogleAuthError(f'token refresh failed: {detail}')
        payload = resp.json()
        data['access_token'] = payload['access_token']
        data['expires_at'] = time.time() + float(payload.get('expires_in', 3600))
        self._write(data)
        return data['access_token']


_manager: GoogleAuthManager | None = None
_manager_lock = threading.Lock()


def get_manager() -> GoogleAuthManager:
    global _manager
    with _manager_lock:
        if _manager is None:
            _manager = GoogleAuthManager()
        return _manager
```

Note for the test's `test_get_access_token_refreshes_when_stale`: it monkeypatches `google_auth.requests.post`; the implementation above calls `requests.post` at module attribute level, so the patch works. `_refresh` in `test_get_access_token_returns_cached_when_fresh` refers to a non-existent method intentionally — assigning it just proves no network call happens (the cached branch returns first). If the implementation names differ, adjust the TEST, not the design.

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python backend/tests/test_google_auth.py`
Expected: `8/8 passed`

- [ ] **Step 5: Commit**

```bash
git add backend/google_auth.py backend/tests/test_google_auth.py
git commit -m "feat(auth): add Google auth manager with refresh-token persistence"
```

---

### Task 2: OAuth routes + server-token preference in app.py + setup doc

**Files:**
- Modify: `app.py` (imports at top; `_drive_token()` at line ~203; `drive_status` ~215; `auth_config` ~171; new routes after `/auth/password`)
- Create: `docs/GOOGLE_SETUP.md`
- Test: `backend/tests/test_oauth_routes.py`

**Interfaces:**
- Consumes: Task 1 (`google_auth.get_manager()`, `build_auth_url`, `exchange_code`, `GoogleAuthError`).
- Produces:
  - `GET /google/oauth/start` — 302 to Google (requires session user; 401 JSON otherwise)
  - `GET /google/oauth/callback` — 302 to `/?googleAuth=connected` or `/?googleAuth=error&detail=...`
  - `_google_token() -> str | None` in app.py — server manager token first, else `session['google_drive_token']` (used by Drive routes now, Photos routes in Task 4)
  - `/auth/config` gains `"serverGoogle": bool` and `"worker": bool`
  - `/drive/status` gains `"serverGoogleAuth": bool`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_oauth_routes.py
"""Flask test-client tests for /google/oauth/* and token preference."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
os.environ.setdefault('BBP_DEBUG', '1')  # dev session auto-created by enforce_auth

import app as appmod
from backend import google_auth


def _client():
    appmod.app.config['TESTING'] = True
    return appmod.app.test_client()


def test_oauth_start_requires_session():
    c = _client()
    # No session cookie yet and route creates none itself
    r = c.get('/google/oauth/start')
    assert r.status_code in (302, 401)


def test_oauth_start_redirects_to_google_when_configured():
    c = _client()
    with c.session_transaction() as s:
        s['user'] = {'email': 'dev@local'}
    orig_id, orig_secret = appmod.GOOGLE_CLIENT_ID, os.environ.get('GOOGLE_CLIENT_SECRET')
    appmod.GOOGLE_CLIENT_ID = 'cid'
    os.environ['GOOGLE_CLIENT_SECRET'] = 'csec'
    try:
        r = c.get('/google/oauth/start')
        assert r.status_code == 302
        assert 'accounts.google.com' in r.headers['Location']
    finally:
        appmod.GOOGLE_CLIENT_ID = orig_id
        if orig_secret is None:
            os.environ.pop('GOOGLE_CLIENT_SECRET', None)


def test_oauth_callback_rejects_bad_state():
    c = _client()
    with c.session_transaction() as s:
        s['user'] = {'email': 'dev@local'}
        s['google_oauth_state'] = 'good'
    r = c.get('/google/oauth/callback?state=evil&code=x')
    assert r.status_code == 302
    assert 'googleAuth=error' in r.headers['Location']


def test_google_token_prefers_manager(tmp_path=None):
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        mgr = google_auth.GoogleAuthManager(
            token_path=os.path.join(d, 't.json'), client_id='cid', client_secret='cs')
        mgr.store_tokens({'refresh_token': 'r', 'access_token': 'MGRTOK', 'expires_in': 3600})
        orig = google_auth._manager
        google_auth._manager = mgr
        try:
            with appmod.app.test_request_context('/'):
                appmod.session['google_drive_token'] = 'SESSTOK'
                assert appmod._google_token() == 'MGRTOK'
        finally:
            google_auth._manager = orig


def test_google_token_falls_back_to_session():
    orig = google_auth._manager
    google_auth._manager = google_auth.GoogleAuthManager(
        token_path='/nonexistent/nope.json', client_id='', client_secret='')
    try:
        with appmod.app.test_request_context('/'):
            appmod.session['google_drive_token'] = 'SESSTOK'
            assert appmod._google_token() == 'SESSTOK'
    finally:
        google_auth._manager = orig


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"PASS  {t.__name__}")
        except Exception as e:
            failed += 1
            print(f"FAIL  {t.__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python backend/tests/test_oauth_routes.py`
Expected: FAIL — routes and `_google_token` missing (404s / AttributeError).

- [ ] **Step 3: Implement app.py changes**

Add import near the top (after `from backend import topaz`):

```python
from backend import google_auth
```

Replace `_drive_token` (app.py:203-204) with:

```python
def _drive_token() -> str | None:
    return session.get('google_drive_token')


def _google_token() -> str | None:
    """Server-stored refresh-token credentials first, then the session token."""
    mgr = google_auth.get_manager()
    if mgr.available():
        try:
            return mgr.get_access_token()
        except google_auth.GoogleAuthError:
            pass  # fall back to the browser-granted session token
    return _drive_token()
```

Update the four Drive call sites (`drive_browse`, `drive_download`, `drive_upload` use `_drive_token()` as argument; `_drive_auth_error` checks it) to use `_google_token()`:

```python
def _drive_auth_error():
    if not session.get('user'):
        return jsonify({'error': 'not_authenticated'}), 401
    if not _google_token():
        return jsonify({'error': 'drive_not_authorized'}), 401
    return None
```

and in each route body replace `_drive_token()` with `_google_token()` (e.g. `google_drive.list_images(_google_token(), parent_id)`).

In `drive_status` (line ~228) extend the response:

```python
    return jsonify({
        'authenticated': bool(user),
        'driveAuthorized': bool(user and _google_token()),
        'serverGoogleAuth': google_auth.get_manager().available(),
    })
```

In `auth_config` (line ~174) extend the response dict:

```python
        'drive': bool(GOOGLE_CLIENT_ID),
        'serverGoogle': google_auth.get_manager().available(),
        'worker': google_auth.get_manager().available(),
```

Add the OAuth routes after `auth_password` (line ~200):

```python
@app.get('/google/oauth/start')
def google_oauth_start():
    """Begin the server-side authorization-code flow (owner connects once)."""
    if not session.get('user'):
        return jsonify({'error': 'not_authenticated'}), 401
    client_secret = os.environ.get('GOOGLE_CLIENT_SECRET', '')
    if not GOOGLE_CLIENT_ID or not client_secret:
        return jsonify({'error': 'server_google_not_configured',
                        'detail': 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET'}), 400
    state = secrets.token_urlsafe(24)
    session['google_oauth_state'] = state
    redirect_uri = request.host_url.rstrip('/') + '/google/oauth/callback'
    from flask import redirect
    return redirect(google_auth.build_auth_url(GOOGLE_CLIENT_ID, redirect_uri, state))


@app.get('/google/oauth/callback')
def google_oauth_callback():
    from flask import redirect
    if not session.get('user'):
        return redirect('/?googleAuth=error&detail=not_authenticated')
    state = request.args.get('state', '')
    if not state or state != session.pop('google_oauth_state', None):
        return redirect('/?googleAuth=error&detail=bad_state')
    if request.args.get('error'):
        return redirect(f"/?googleAuth=error&detail={request.args['error']}")
    code = request.args.get('code', '')
    if not code:
        return redirect('/?googleAuth=error&detail=missing_code')
    redirect_uri = request.host_url.rstrip('/') + '/google/oauth/callback'
    try:
        tokens = google_auth.exchange_code(
            GOOGLE_CLIENT_ID, os.environ.get('GOOGLE_CLIENT_SECRET', ''), code, redirect_uri)
    except google_auth.GoogleAuthError as e:
        return redirect(f'/?googleAuth=error&detail={str(e)[:120]}')
    google_auth.get_manager().store_tokens(tokens)
    return redirect('/?googleAuth=connected')
```

- [ ] **Step 4: Write docs/GOOGLE_SETUP.md**

```markdown
# Google Cloud setup for BigBadPhotos (Drive + Photos + server worker)

One-time steps in https://console.cloud.google.com for the project that owns
your existing `GOOGLE_CLIENT_ID`.

## 1. Enable APIs
- APIs & Services → Library → enable **Photos Library API** (Drive API is already enabled).

## 2. Consent screen scopes
- APIs & Services → OAuth consent screen → Edit → Scopes → add:
  - `https://www.googleapis.com/auth/photoslibrary.appendonly`
  - `https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata`
- Keep the app in Testing mode and make sure your Google account is listed
  under **Test users** (avoids verification review; expect the "unverified app"
  interstitial once).

## 3. OAuth client
- APIs & Services → Credentials → your existing **Web application** client:
  - Authorized redirect URIs → add `http://localhost:8002/google/oauth/callback`
    (plus the port you actually run Flask on, if different).
  - Copy the **Client secret**.

## 4. Environment
Add to the project `.env` (never commit):

    GOOGLE_CLIENT_SECRET=<client secret>

Optional: `BBP_TOKEN_PATH=/custom/path/google_token.json` (default
`~/.bigbadphotos/google_token.json`, chmod 600).

## 5. Connect
Start Flask locally, sign in to BigBadPhotos, then visit
`http://localhost:8002/google/oauth/start` and approve. You land back on the
app with `?googleAuth=connected`. `/auth/config` now reports
`"serverGoogle": true` — Drive proxying, Photos export, and the autonomous
worker all run off the stored refresh token from then on.

Note: any signed-in BigBadPhotos user acts with the owner's stored Google
credentials — this is a single-owner deployment by design.
```

- [ ] **Step 5: Run tests**

Run: `.venv/bin/python backend/tests/test_oauth_routes.py` → `5/5 passed`
Run: `.venv/bin/python backend/tests/test_google_auth.py` → still `8/8 passed`

- [ ] **Step 6: Commit**

```bash
git add app.py docs/GOOGLE_SETUP.md backend/tests/test_oauth_routes.py
git commit -m "feat(auth): server-side Google OAuth code flow with token preference"
```

---

### Task 3: Google Photos API module (`backend/google_photos.py`)

**Files:**
- Create: `backend/google_photos.py`
- Test: `backend/tests/test_google_photos.py`

**Interfaces:**
- Consumes: nothing internal (mirrors `backend/google_drive.py` style: raw `requests` + bearer header).
- Produces (used by Tasks 4, 10):
  - `list_albums(access_token: str) -> list[dict]` — each `{'id','title','mediaItemsCount','coverPhotoBaseUrl'}`
  - `create_album(access_token: str, title: str) -> dict` — `{'id','title',...}`
  - `upload_bytes(access_token: str, filename: str, data: bytes, mime_type: str = 'image/jpeg') -> str` — upload token
  - `batch_create(access_token: str, album_id: str | None, items: list[dict]) -> list[dict]` — items `{'uploadToken','filename','description'?}`; returns per-item `{'filename','ok','mediaItemId'?,'error'?}`; chunks of ≤50
  - `PhotosApiError(RuntimeError)` with `.status_code`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_google_photos.py
"""Tests for backend.google_photos with a fake requests layer."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from backend import google_photos


class FakeResp:
    def __init__(self, status=200, payload=None, text=''):
        self.status_code = status
        self.ok = status < 400
        self._payload = payload
        self.text = text or (str(payload) if payload else '')
    def json(self):
        if self._payload is None:
            raise ValueError('no json')
        return self._payload


class FakeRequests:
    def __init__(self):
        self.calls = []
        self.responses = []
    def _pop(self):
        return self.responses.pop(0)
    def get(self, url, headers=None, params=None, timeout=None):
        self.calls.append(('GET', url, params))
        return self._pop()
    def post(self, url, headers=None, params=None, json=None, data=None, timeout=None):
        self.calls.append(('POST', url, json if json is not None else data))
        return self._pop()


def _patch():
    fake = FakeRequests()
    google_photos.requests = fake
    return fake


def test_list_albums_paginates():
    fake = _patch()
    fake.responses = [
        FakeResp(200, {'albums': [{'id': 'a1', 'title': 'T1'}], 'nextPageToken': 'p2'}),
        FakeResp(200, {'albums': [{'id': 'a2', 'title': 'T2'}]}),
    ]
    albums = google_photos.list_albums('tok')
    assert [a['id'] for a in albums] == ['a1', 'a2']
    assert fake.calls[1][2].get('pageToken') == 'p2'


def test_list_albums_empty_library():
    fake = _patch()
    fake.responses = [FakeResp(200, {})]  # API omits 'albums' when none exist
    assert google_photos.list_albums('tok') == []


def test_create_album_posts_title():
    fake = _patch()
    fake.responses = [FakeResp(200, {'id': 'new1', 'title': 'BBP 2026-07-04'})]
    album = google_photos.create_album('tok', 'BBP 2026-07-04')
    assert album['id'] == 'new1'
    method, url, body = fake.calls[0]
    assert method == 'POST' and url.endswith('/albums')
    assert body == {'album': {'title': 'BBP 2026-07-04'}}


def test_upload_bytes_returns_token():
    fake = _patch()
    fake.responses = [FakeResp(200, None, text='UPLOAD_TOKEN_X')]
    tok = google_photos.upload_bytes('tok', 'img.jpg', b'\xff\xd8data')
    assert tok == 'UPLOAD_TOKEN_X'


def test_upload_bytes_raises_on_error():
    fake = _patch()
    fake.responses = [FakeResp(403, {'error': {'message': 'denied'}}, text='denied')]
    try:
        google_photos.upload_bytes('tok', 'img.jpg', b'x')
    except google_photos.PhotosApiError as e:
        assert e.status_code == 403
        return
    raise AssertionError('expected PhotosApiError')


def test_batch_create_chunks_of_50():
    fake = _patch()
    items = [{'uploadToken': f't{i}', 'filename': f'f{i}.jpg'} for i in range(60)]
    fake.responses = [
        FakeResp(200, {'newMediaItemResults': [
            {'status': {'message': 'Success'}, 'mediaItem': {'id': f'm{i}'}} for i in range(50)]}),
        FakeResp(200, {'newMediaItemResults': [
            {'status': {'message': 'Success'}, 'mediaItem': {'id': f'm{50+i}'}} for i in range(10)]}),
    ]
    results = google_photos.batch_create('tok', 'alb1', items)
    assert len(results) == 60
    assert all(r['ok'] for r in results)
    assert results[0]['mediaItemId'] == 'm0'
    # two POSTs, each with albumId and <=50 items
    assert len(fake.calls) == 2
    body1 = fake.calls[0][2]
    assert body1['albumId'] == 'alb1'
    assert len(body1['newMediaItems']) == 50


def test_batch_create_surfaces_per_item_failure():
    fake = _patch()
    fake.responses = [FakeResp(200, {'newMediaItemResults': [
        {'status': {'message': 'Success'}, 'mediaItem': {'id': 'm0'}},
        {'status': {'code': 3, 'message': 'NOT_IMAGE'}},
    ]})]
    results = google_photos.batch_create('tok', None, [
        {'uploadToken': 't0', 'filename': 'a.jpg'},
        {'uploadToken': 't1', 'filename': 'b.jpg'},
    ])
    assert results[0]['ok'] is True
    assert results[1]['ok'] is False and 'NOT_IMAGE' in results[1]['error']


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"PASS  {t.__name__}")
        except Exception as e:
            failed += 1
            print(f"FAIL  {t.__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python backend/tests/test_google_photos.py`
Expected: ImportError — module missing.

- [ ] **Step 3: Write the implementation**

```python
# backend/google_photos.py
"""Google Photos Library API helpers (post-2025 API: app-created content only).

Mirrors backend/google_drive.py: plain requests + bearer token. The API can
only list albums this app created and only add media to app-created albums —
that is a Google policy, not a bug.
"""
from __future__ import annotations

from typing import Any

import requests

PHOTOS_API = 'https://photoslibrary.googleapis.com/v1'
BATCH_LIMIT = 50  # mediaItems:batchCreate hard cap


class PhotosApiError(RuntimeError):
    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


def _headers(access_token: str) -> dict[str, str]:
    return {'Authorization': f'Bearer {access_token}'}


def _error_detail(resp) -> str:
    try:
        return resp.json().get('error', {}).get('message', resp.text)
    except ValueError:
        return resp.text


def list_albums(access_token: str) -> list[dict[str, Any]]:
    """All albums created by this app (the API returns no others)."""
    albums: list[dict[str, Any]] = []
    params: dict[str, Any] = {'pageSize': 50}
    while True:
        resp = requests.get(f'{PHOTOS_API}/albums', headers=_headers(access_token),
                            params=params, timeout=30)
        if not resp.ok:
            raise PhotosApiError(_error_detail(resp), resp.status_code)
        payload = resp.json()
        albums.extend(payload.get('albums', []))
        token = payload.get('nextPageToken')
        if not token:
            break
        params['pageToken'] = token
    return albums


def create_album(access_token: str, title: str) -> dict[str, Any]:
    resp = requests.post(f'{PHOTOS_API}/albums', headers=_headers(access_token),
                         json={'album': {'title': title}}, timeout=30)
    if not resp.ok:
        raise PhotosApiError(_error_detail(resp), resp.status_code)
    return resp.json()


def upload_bytes(access_token: str, filename: str, data: bytes,
                 mime_type: str = 'image/jpeg') -> str:
    """Upload raw bytes; returns an upload token for batch_create."""
    headers = {
        **_headers(access_token),
        'Content-Type': 'application/octet-stream',
        'X-Goog-Upload-Content-Type': mime_type,
        'X-Goog-Upload-Protocol': 'raw',
    }
    resp = requests.post(f'{PHOTOS_API}/uploads', headers=headers, data=data, timeout=180)
    if not resp.ok:
        raise PhotosApiError(_error_detail(resp), resp.status_code)
    token = resp.text.strip()
    if not token:
        raise PhotosApiError('empty upload token from Photos API')
    return token


def batch_create(access_token: str, album_id: str | None,
                 items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Create media items from upload tokens, optionally into an app-created album.

    items: [{'uploadToken': str, 'filename': str, 'description': str?}, ...]
    Returns one result per item, order preserved:
      {'filename': str, 'ok': bool, 'mediaItemId': str?, 'error': str?}
    """
    results: list[dict[str, Any]] = []
    for i in range(0, len(items), BATCH_LIMIT):
        chunk = items[i:i + BATCH_LIMIT]
        body: dict[str, Any] = {
            'newMediaItems': [
                {
                    'description': it.get('description', ''),
                    'simpleMediaItem': {
                        'fileName': it['filename'],
                        'uploadToken': it['uploadToken'],
                    },
                }
                for it in chunk
            ],
        }
        if album_id:
            body['albumId'] = album_id
        resp = requests.post(f'{PHOTOS_API}/mediaItems:batchCreate',
                             headers=_headers(access_token), json=body, timeout=120)
        if not resp.ok:
            raise PhotosApiError(_error_detail(resp), resp.status_code)
        item_results = resp.json().get('newMediaItemResults', [])
        for it, res in zip(chunk, item_results):
            status = res.get('status', {})
            ok = status.get('message', '').lower() == 'success' or 'code' not in status
            entry: dict[str, Any] = {'filename': it['filename'], 'ok': ok}
            if ok and res.get('mediaItem', {}).get('id'):
                entry['mediaItemId'] = res['mediaItem']['id']
            if not ok:
                entry['error'] = status.get('message', 'unknown error')
            results.append(entry)
    return results
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python backend/tests/test_google_photos.py`
Expected: `7/7 passed`

- [ ] **Step 5: Commit**

```bash
git add backend/google_photos.py backend/tests/test_google_photos.py
git commit -m "feat(photos): add Google Photos Library API module"
```

---

### Task 4: `/photos/*` Flask routes

**Files:**
- Modify: `app.py` — `enforce_auth` (line ~89), new routes after `drive_upload` (line ~318)
- Test: `backend/tests/test_photos_routes.py`

**Interfaces:**
- Consumes: Task 2 `_google_token()`, Task 3 module.
- Produces (used by Tasks 5, 7):
  - `GET /photos/albums` → `{"albums": [{"id","title","mediaItemsCount"}...]}`
  - `POST /photos/albums` JSON `{"title": str}` → `{"ok": true, "album": {...}}`
  - `POST /photos/upload` multipart (`file`, `albumId`) → `{"ok": true, "filename": str, "mediaItemId": str}` or 502 `{"error": "photos_upload_failed", "detail": str}`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_photos_routes.py
import io
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
os.environ.setdefault('BBP_DEBUG', '1')

import app as appmod
from backend import google_photos


def _client_with_token():
    appmod.app.config['TESTING'] = True
    c = appmod.app.test_client()
    with c.session_transaction() as s:
        s['user'] = {'email': 'dev@local'}
        s['google_drive_token'] = 'SESSTOK'
    return c


def test_albums_requires_google_auth():
    appmod.app.config['TESTING'] = True
    c = appmod.app.test_client()
    with c.session_transaction() as s:
        s['user'] = {'email': 'dev@local'}
    r = c.get('/photos/albums')
    assert r.status_code == 401


def test_list_albums_route():
    c = _client_with_token()
    orig = google_photos.list_albums
    google_photos.list_albums = lambda tok: [{'id': 'a1', 'title': 'T'}]
    try:
        r = c.get('/photos/albums')
        assert r.status_code == 200
        assert r.get_json()['albums'][0]['id'] == 'a1'
    finally:
        google_photos.list_albums = orig


def test_create_album_route_validates_title():
    c = _client_with_token()
    r = c.post('/photos/albums', json={})
    assert r.status_code == 400


def test_upload_route_happy_path():
    c = _client_with_token()
    orig_up, orig_bc = google_photos.upload_bytes, google_photos.batch_create
    google_photos.upload_bytes = lambda tok, fn, data, mime_type='image/jpeg': 'UT1'
    google_photos.batch_create = lambda tok, album, items: [
        {'filename': items[0]['filename'], 'ok': True, 'mediaItemId': 'M1'}]
    try:
        r = c.post('/photos/upload', data={
            'albumId': 'a1',
            'file': (io.BytesIO(b'\xff\xd8jpegdata'), 'pic.jpg'),
        }, content_type='multipart/form-data')
        assert r.status_code == 200, r.get_data(as_text=True)
        body = r.get_json()
        assert body['ok'] is True and body['mediaItemId'] == 'M1'
    finally:
        google_photos.upload_bytes, google_photos.batch_create = orig_up, orig_bc


def test_upload_route_surfaces_item_failure():
    c = _client_with_token()
    orig_up, orig_bc = google_photos.upload_bytes, google_photos.batch_create
    google_photos.upload_bytes = lambda tok, fn, data, mime_type='image/jpeg': 'UT1'
    google_photos.batch_create = lambda tok, album, items: [
        {'filename': items[0]['filename'], 'ok': False, 'error': 'boom'}]
    try:
        r = c.post('/photos/upload', data={
            'albumId': 'a1',
            'file': (io.BytesIO(b'x'), 'pic.jpg'),
        }, content_type='multipart/form-data')
        assert r.status_code == 502
        assert r.get_json()['error'] == 'photos_upload_failed'
    finally:
        google_photos.upload_bytes, google_photos.batch_create = orig_up, orig_bc


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"PASS  {t.__name__}")
        except Exception as e:
            failed += 1
            print(f"FAIL  {t.__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python backend/tests/test_photos_routes.py`
Expected: FAIL — 404 on /photos routes (catch-all serves frontend error JSON with 503, still not 200/401-as-specified).

- [ ] **Step 3: Implement**

In `enforce_auth` (app.py:93) extend the guard:

```python
    if (request.path not in API_ROUTES
            and not request.path.startswith('/drive')
            and not request.path.startswith('/photos')
            and not request.path.startswith('/autonomous')):
        return  # static files, /health, /auth/* all pass through
```

Add import at top: `from backend import google_photos`.

Add after `drive_upload`:

```python
def _photos_auth_error():
    if not session.get('user'):
        return jsonify({'error': 'not_authenticated'}), 401
    if not _google_token():
        return jsonify({'error': 'photos_not_authorized',
                        'detail': 'Connect Google via /google/oauth/start'}), 401
    return None


@app.get('/photos/albums')
def photos_albums():
    err = _photos_auth_error()
    if err:
        return err
    try:
        albums = google_photos.list_albums(_google_token())
    except Exception as exc:
        return jsonify({'error': 'photos_list_failed', 'detail': str(exc)}), 502
    return jsonify({'albums': albums})


@app.post('/photos/albums')
def photos_create_album():
    err = _photos_auth_error()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    title = (data.get('title') or '').strip()
    if not title:
        return jsonify({'error': 'bad_request', 'detail': 'title is required'}), 400
    try:
        album = google_photos.create_album(_google_token(), title)
    except Exception as exc:
        return jsonify({'error': 'photos_create_failed', 'detail': str(exc)}), 502
    return jsonify({'ok': True, 'album': album})


@app.post('/photos/upload')
def photos_upload():
    err = _photos_auth_error()
    if err:
        return err
    album_id = request.form.get('albumId') or ''
    if not album_id:
        return jsonify({'error': 'missing_album_id'}), 400
    if 'file' not in request.files:
        return jsonify({'error': 'missing_file'}), 400
    upload = request.files['file']
    payload = upload.read()
    if not payload:
        return jsonify({'error': 'empty_file'}), 400
    filename = upload.filename or 'upload.jpg'
    try:
        token = _google_token()
        upload_token = google_photos.upload_bytes(
            token, filename, payload, upload.mimetype or 'image/jpeg')
        results = google_photos.batch_create(token, album_id, [
            {'uploadToken': upload_token, 'filename': filename},
        ])
    except Exception as exc:
        return jsonify({'error': 'photos_upload_failed', 'detail': str(exc)}), 502
    result = results[0] if results else {'ok': False, 'error': 'no result returned'}
    if not result.get('ok'):
        return jsonify({'error': 'photos_upload_failed',
                        'detail': result.get('error', 'unknown')}), 502
    return jsonify({'ok': True, 'filename': filename,
                    'mediaItemId': result.get('mediaItemId')})
```

- [ ] **Step 4: Run all backend tests**

Run: `for t in backend/tests/test_google_auth.py backend/tests/test_oauth_routes.py backend/tests/test_google_photos.py backend/tests/test_photos_routes.py backend/tests/test_topaz.py; do .venv/bin/python $t || exit 1; done`
Expected: all suites pass.

- [ ] **Step 5: Commit**

```bash
git add app.py backend/tests/test_photos_routes.py
git commit -m "feat(photos): add /photos album and upload routes"
```

---

### Task 5: Frontend Photos client (`frontend/src/utils/googlePhotos.js`)

**Files:**
- Create: `frontend/src/utils/googlePhotos.js`

**Interfaces:**
- Consumes: Task 4 routes.
- Produces (used by Tasks 6, 7, 12):
  - `listPhotosAlbums() -> Promise<Array<{id,title,mediaItemsCount}>>`
  - `createPhotosAlbum(title: string) -> Promise<{id,title}>`
  - `uploadPhotoToAlbum(albumId: string, file: File) -> Promise<{ok,filename,mediaItemId}>`
  - `isPhotosAuthError(error) -> boolean`
  - `serverGoogleConnectUrl() -> string` (`'/google/oauth/start'`)
  - `defaultAlbumTitle() -> string` (`BBP YYYY-MM-DD`)

- [ ] **Step 1: Write the module** (no unit runner — build-verified in Step 2, exercised via Tasks 6/7)

```javascript
// frontend/src/utils/googlePhotos.js
// Backend-proxied Google Photos access. The API only ever lists/uploads to
// albums this app created (Google Photos Library API post-2025 rules).

async function jsonOrThrow(res, fallbackMsg) {
  if (res.ok) return res.json()
  const body = await res.json().catch(() => ({}))
  const err = new Error(body.detail || body.error || fallbackMsg)
  err.status = res.status
  err.code = body.error
  throw err
}

export function isPhotosAuthError(error) {
  if (error?.status === 401) return true
  const msg = (error?.message || '').toLowerCase()
  return msg.includes('not_authorized') || msg.includes('not_authenticated')
    || msg.includes('connect google')
}

export function serverGoogleConnectUrl() {
  return '/google/oauth/start'
}

export function defaultAlbumTitle() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `BBP ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export async function listPhotosAlbums() {
  const res = await fetch('/photos/albums', { credentials: 'include' })
  const body = await jsonOrThrow(res, 'Could not list Google Photos albums')
  return body.albums || []
}

export async function createPhotosAlbum(title) {
  const res = await fetch('/photos/albums', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  const body = await jsonOrThrow(res, 'Could not create Google Photos album')
  return body.album
}

export async function uploadPhotoToAlbum(albumId, file) {
  const form = new FormData()
  form.append('albumId', albumId)
  form.append('file', file, file.name)
  const res = await fetch('/photos/upload', {
    method: 'POST',
    credentials: 'include',
    body: form,
  })
  return jsonOrThrow(res, 'Could not upload to Google Photos')
}
```

- [ ] **Step 2: Verify build**

Run: `cd frontend && npm run build`
Expected: build succeeds (module tree-shaken until imported; syntax still checked).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/utils/googlePhotos.js
git commit -m "feat(photos): add frontend Google Photos client"
```

---

### Task 6: Album picker component + store slot

**Files:**
- Modify: `frontend/src/store.js` (add `photosAlbum` beside `destDir`, line ~5 and setter beside `setDestDir`, line ~30)
- Create: `frontend/src/components/GooglePhotosAlbumPicker.jsx`

**Interfaces:**
- Consumes: Task 5 client.
- Produces (used by Tasks 7, 12):
  - Store: `photosAlbum: {id, title} | null`, `setPhotosAlbum(album)`
  - `<GooglePhotosAlbumPicker />` — self-contained: reads/writes `photosAlbum` from the store; props `{ compact?: boolean }` only.

- [ ] **Step 1: Store additions**

In `frontend/src/store.js` add after `destDir: null,`:

```javascript
  photosAlbum: null,
```

and after `setDestDir`:

```javascript
  setPhotosAlbum: (album) => set({ photosAlbum: album }),
```

- [ ] **Step 2: Component**

```jsx
// frontend/src/components/GooglePhotosAlbumPicker.jsx
/**
 * Pick or create the target Google Photos album (app-created albums only —
 * the Photos API cannot list or write to hand-made albums).
 * Reads/writes `photosAlbum` in the zustand store.
 */
import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../store'
import {
  listPhotosAlbums, createPhotosAlbum, defaultAlbumTitle,
  isPhotosAuthError, serverGoogleConnectUrl,
} from '../utils/googlePhotos'

export default function GooglePhotosAlbumPicker({ compact = false }) {
  const photosAlbum = useStore(s => s.photosAlbum)
  const setPhotosAlbum = useStore(s => s.setPhotosAlbum)

  const [albums, setAlbums] = useState(null)   // null = not loaded yet
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState(defaultAlbumTitle())
  const [error, setError] = useState(null)
  const [needsConnect, setNeedsConnect] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await listPhotosAlbums()
      setAlbums(list)
      setNeedsConnect(false)
    } catch (err) {
      if (isPhotosAuthError(err)) setNeedsConnect(true)
      else setError(err.message)
      setAlbums([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const handleCreate = async () => {
    const title = newTitle.trim()
    if (!title) return
    setCreating(true)
    setError(null)
    try {
      const album = await createPhotosAlbum(title)
      setPhotosAlbum({ id: album.id, title: album.title })
      await refresh()
    } catch (err) {
      if (isPhotosAuthError(err)) setNeedsConnect(true)
      else setError(err.message)
    } finally {
      setCreating(false)
    }
  }

  if (needsConnect) {
    return (
      <div className="fs-xs" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span className="dim">Google Photos is not connected on the server yet.</span>
        <a
          className="btn btn-primary btn-uppercase"
          href={serverGoogleConnectUrl()}
          style={{ textAlign: 'center', textDecoration: 'none', padding: '10px 12px' }}
        >
          Connect Google Photos
        </a>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <select
          className="fs-xs"
          value={photosAlbum?.id || ''}
          onChange={(e) => {
            const found = (albums || []).find(a => a.id === e.target.value)
            setPhotosAlbum(found ? { id: found.id, title: found.title } : null)
          }}
          style={{
            flex: 1, padding: '8px 10px', borderRadius: 6,
            background: 'var(--bg-3)', color: 'var(--fg-1)', border: '1px solid var(--line)',
          }}
        >
          <option value="">{loading ? 'Loading albums…' : 'Select album…'}</option>
          {(albums || []).map(a => (
            <option key={a.id} value={a.id}>
              {a.title}{a.mediaItemsCount ? ` (${a.mediaItemsCount})` : ''}
            </option>
          ))}
        </select>
        <button className="btn fs-xs" onClick={refresh} disabled={loading} title="Refresh albums">↻</button>
      </div>

      {!compact && (
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            className="fs-xs"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="New album name"
            style={{
              flex: 1, padding: '8px 10px', borderRadius: 6,
              background: 'var(--bg-3)', color: 'var(--fg-1)', border: '1px solid var(--line)',
            }}
          />
          <button className="btn fs-xs" onClick={handleCreate} disabled={creating || !newTitle.trim()}>
            {creating ? 'Creating…' : '+ Create'}
          </button>
        </div>
      )}

      {photosAlbum && (
        <div className="fs-xxs dim">Publishing to: <strong>{photosAlbum.title}</strong></div>
      )}
      {error && <div className="fs-xxs" style={{ color: 'var(--reject)' }}>{error}</div>}
    </div>
  )
}
```

- [ ] **Step 3: Verify build**

Run: `cd frontend && npm run build`
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/store.js frontend/src/components/GooglePhotosAlbumPicker.jsx
git commit -m "feat(photos): album picker component and photosAlbum store slot"
```

---

### Task 7: Manual export to Google Photos

**Files:**
- Modify: `frontend/src/hooks/useExporter.js` (destination branch in `startExport`, line ~52-98; return `hasDestDir` logic line ~251)
- Modify: `frontend/src/views/ReviewExportView.jsx` (destination toggle + album picker near dest-folder UI; `handleExport` line ~109)

**Interfaces:**
- Consumes: Task 5 `uploadPhotoToAlbum`, `isPhotosAuthError`; Task 6 store `photosAlbum` + picker component.
- Produces: `startExport({ fileFormat, includeMaybes, newFolderName, destination })` where `destination: 'folder' | 'photos'` (default `'folder'` — existing callers unchanged).

- [ ] **Step 1: useExporter changes**

Add imports:

```javascript
import { uploadPhotoToAlbum, isPhotosAuthError } from '../utils/googlePhotos'
```

Read the album inside the hook (after `const destDir = useStore(...)`):

```javascript
  const photosAlbum = useStore(state => state.photosAlbum)
```

In `startExport`, accept the new option and add the branch BEFORE the `driveDest` logic. Replace the opening of the function:

```javascript
  const startExport = useCallback(async ({ fileFormat = 'original', includeMaybes = false, newFolderName = '', destination = 'folder' } = {}) => {
    const queue = Object.values(photos).filter(p =>
      p.file && (p.decision === 'keep' || (includeMaybes && p.decision === 'maybe'))
    )
    if (queue.length === 0) {
      setExportError('No photos to export.')
      return
    }

    if (destination === 'photos') {
      if (!photosAlbum?.id) {
        setExportError('Select a Google Photos album first.')
        return
      }
      setExporting(true)
      setExportDone(false)
      setExportError(null)
      setFailedFiles([])
      setExportedCount(0)
      setExportTotal(queue.length)
      const failed = []
      let aborted = false
      try {
        for (let i = 0; i < queue.length; i++) {
          const photo = queue[i]
          try {
            const convertToJpeg = fileFormat === 'jpg' && !photo.isRaw
            const exportName = convertToJpeg
              ? photo.filename.replace(/\.[^.]+$/, '.jpg')
              : photo.filename
            const blob = convertToJpeg ? await encodeAsJpeg(photo.file) : photo.file
            const file = new File([blob], exportName, { type: blob.type || 'image/jpeg' })
            await uploadPhotoToAlbum(photosAlbum.id, file)
          } catch (err) {
            failed.push({ filename: photo.filename, reason: err.message })
            if (isPhotosAuthError(err)) {
              setExportError(`Google Photos session problem: ${err.message}`)
              aborted = true
            }
          }
          setExportedCount(i + 1)
          if (aborted) break
        }
      } finally {
        setFailedFiles(failed)
        setExporting(false)
        if (!aborted) setExportDone(true)
      }
      return
    }
```

(the existing folder/Drive/iOS logic continues unchanged below this block; note Photos destination writes no `bigbad_decisions.json` — albums hold media only). Add `photosAlbum` to the `useCallback` dependency array: `[photos, destDir, photosAlbum]`.

- [ ] **Step 2: ReviewExportView changes**

Add imports:

```jsx
import GooglePhotosAlbumPicker from '../components/GooglePhotosAlbumPicker'
```

Add state + store read inside the component (after `const [newFolderName, setNewFolderName] = useState('')`):

```jsx
  const [destination, setDestination] = useState('folder')
  const photosAlbum = useStore(state => state.photosAlbum)
```

Change `handleExport`:

```jsx
  const handleExport = () => startExport({ fileFormat, includeMaybes, newFolderName, destination })
```

In the destination section of the JSX (where the dest-folder picker button renders — locate the block calling `handlePickDest`), insert a segmented control ABOVE it and gate the two panels:

```jsx
        <div style={{ display: 'flex', gap: 6, marginBottom: 'var(--sp-3)' }}>
          {[['folder', 'Folder / Drive'], ['photos', 'Google Photos']].map(([key, label]) => (
            <button
              key={key}
              className="btn fs-xs"
              onClick={() => setDestination(key)}
              style={{
                flex: 1,
                background: destination === key ? 'color-mix(in oklab, var(--accent) 20%, var(--bg-3))' : 'var(--bg-3)',
                color: destination === key ? 'var(--accent)' : 'var(--fg-2)',
                border: destination === key
                  ? '1px solid color-mix(in oklab, var(--accent) 50%, var(--line))'
                  : '1px solid var(--line)',
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {destination === 'photos'
          ? <GooglePhotosAlbumPicker />
          : /* existing folder picker JSX stays here unchanged */}
```

Update the export button gating: pass `hasDestDir={destination === 'photos' ? !!photosAlbum : hasDestDir}` to `ExportProgress`.

- [ ] **Step 3: Verify build + manual smoke**

Run: `cd frontend && npm run build`
Expected: success.
Manual (needs backend running + Google connected): load folder → keep 2 photos → Review → destination "Google Photos" → create album → export → check album in photos.google.com.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/hooks/useExporter.js frontend/src/views/ReviewExportView.jsx
git commit -m "feat(export): Google Photos album as export destination"
```

---

### Task 8: Extract scoring core to `backend/scoring.py`

**Files:**
- Create: `backend/scoring.py`
- Modify: `app.py` (delete lines ~332-592 scoring functions + cascades; slim `/rank` body lines ~639-830; `/analyze` lines ~608-636; add import)
- Test: `backend/tests/test_scoring.py`

**Interfaces:**
- Consumes: nothing new (moves existing code).
- Produces (used by Tasks 9, 10 and app.py):
  - Everything currently in app.py: `MAX_SCORING_DIM`, `decode_image(bytes)`, `score_sharpness(gray)`, `score_exposure(gray)`, `score_noise(gray)`, `score_contrast(gray)`, `score_faces(gray)`, `compute_phash(gray)`, `hamming_distance(h1,h2)`, `score_composition(gray, box)`, `composite_score(s,e,n,c)` — signatures and return shapes IDENTICAL to app.py today (copy the bodies verbatim, including the Haar cascade module-level loads).
  - NEW: `rank_images(tasks: list[tuple[str, str, bytes]], max_workers: int | None = None) -> tuple[list[dict], list[dict]]` — `(results, ranking_errors)`; `results` rows carry exactly the fields `/rank` returns today (`id, filename, sharpness, overall_score, exposure, noise, contrast, subject, composition, burst_group, burst_size, rank, is_burst_best`), sorted by `overall_score` desc. Body = the current `/rank` logic from "Decode + score concurrently" (line ~690) through the `is_burst_best` loop (line ~820), verbatim except: takes `tasks` instead of reading `request`, returns tuples instead of jsonify.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_scoring.py
"""Behavioral tests for the extracted scoring core using synthetic images."""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

import cv2

from backend import scoring


def _jpeg(img) -> bytes:
    ok, buf = cv2.imencode('.jpg', img)
    assert ok
    return buf.tobytes()


def _sharp_image():
    # High-frequency checkerboard = very sharp
    tile = np.kron(np.indices((64, 64)).sum(axis=0) % 2, np.ones((8, 8))) * 255
    return tile.astype(np.uint8)


def _blurred_image():
    return cv2.GaussianBlur(_sharp_image(), (31, 31), 12)


def test_decode_image_rejects_garbage():
    try:
        scoring.decode_image(b'not an image at all')
    except ValueError:
        return
    raise AssertionError('expected ValueError')


def test_rank_images_orders_sharp_above_blurred():
    results, errors = scoring.rank_images([
        ('a', 'sharp.jpg', _jpeg(_sharp_image())),
        ('b', 'blur.jpg', _jpeg(_blurred_image())),
    ])
    assert errors == []
    assert len(results) == 2
    assert results[0]['rank'] == 1 and results[1]['rank'] == 2
    by_id = {r['id']: r for r in results}
    assert by_id['a']['overall_score'] > by_id['b']['overall_score']


def test_rank_images_groups_near_duplicates_as_burst():
    base = _sharp_image()
    shifted = np.roll(base, 2, axis=1)  # near-identical -> same pHash bucket
    distinct = _blurred_image()
    results, _ = scoring.rank_images([
        ('a', 'a.jpg', _jpeg(base)),
        ('b', 'b.jpg', _jpeg(shifted)),
        ('c', 'c.jpg', _jpeg(distinct)),
    ])
    by_id = {r['id']: r for r in results}
    assert by_id['a']['burst_group'] is not None
    assert by_id['a']['burst_group'] == by_id['b']['burst_group']
    assert by_id['c']['burst_group'] is None or by_id['c']['burst_group'] != by_id['a']['burst_group']
    bests = [r for r in results if r['burst_group'] == by_id['a']['burst_group'] and r['is_burst_best']]
    assert len(bests) == 1


def test_rank_images_reports_errors_per_item():
    results, errors = scoring.rank_images([
        ('good', 'g.jpg', _jpeg(_sharp_image())),
        ('bad', 'b.jpg', b'garbage'),
    ])
    assert len(results) == 1 and results[0]['id'] == 'good'
    assert len(errors) == 1 and errors[0]['id'] == 'bad'


def test_result_fields_match_rank_contract():
    results, _ = scoring.rank_images([('a', 'a.jpg', _jpeg(_sharp_image()))])
    row = results[0]
    for field in ('id', 'filename', 'sharpness', 'overall_score', 'exposure', 'noise',
                  'contrast', 'subject', 'composition', 'burst_group', 'burst_size',
                  'rank', 'is_burst_best'):
        assert field in row, f'missing {field}'
    assert row['exposure'].get('exposure_score') is not None
    assert row['noise'].get('noise_score') is not None


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"PASS  {t.__name__}")
        except Exception as e:
            failed += 1
            print(f"FAIL  {t.__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python backend/tests/test_scoring.py`
Expected: ImportError.

- [ ] **Step 3: Create `backend/scoring.py`**

Move VERBATIM from app.py: the cascade loads (lines 333-334), `MAX_SCORING_DIM` + `decode_image` (341-358), all `score_*` functions, `compute_phash`, `hamming_distance`, `composite_score` (365-591). Module header:

```python
"""Image scoring core — extracted from app.py so the Flask routes and the
autonomous session worker share one implementation. Behavior must stay
byte-identical to the pre-extraction /rank endpoint."""
from __future__ import annotations

import gc
import os
from concurrent.futures import ThreadPoolExecutor
from typing import List

import cv2
import numpy as np

FACE_CASCADE = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
EYE_CASCADE  = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_eye.xml')
```

Then append `rank_images` — the `/rank` body from app.py lines ~690-820 with the request-parsing removed:

```python
def rank_images(tasks: list[tuple[str, str, bytes]],
                max_workers: int | None = None) -> tuple[list[dict], list[dict]]:
    """Score a batch of (id, filename, jpeg_bytes); returns (results, ranking_errors).

    Result rows and ordering are the exact /rank contract: p99-normalised
    sharpness, composite overall_score with blink penalty, pHash burst
    grouping, rank + is_burst_best flags.
    """
    raw_results: List[dict] = []
    ranking_errors: List[dict] = []

    def process_image(task):
        t_id, t_filename, t_bytes = task
        try:
            gray = decode_image(t_bytes)
            subj = score_faces(gray)
            res = {
                "id":            t_id,
                "filename":      t_filename,
                "sharpness_raw": score_sharpness(gray),
                "exposure":      score_exposure(gray),
                "noise":         score_noise(gray),
                "contrast":      score_contrast(gray),
                "subject":       subj,
                "composition":   score_composition(gray, subj.get("primary_face_box")),
                "phash":         compute_phash(gray),
            }
            del gray
            return res
        except Exception as exc:
            return {"error": str(exc), "id": t_id, "filename": t_filename}

    workers = max_workers or min(32, (os.cpu_count() or 4) * 2)
    with ThreadPoolExecutor(max_workers=workers) as executor:
        for result in executor.map(process_image, tasks):
            if "error" in result:
                ranking_errors.append({
                    "id":       result["id"],
                    "filename": result["filename"],
                    "detail":   result["error"],
                })
            else:
                raw_results.append(result)

    gc.collect()

    if not raw_results:
        return [], ranking_errors

    # (…continue with the VERBATIM app.py logic: p99 normalisation, burst
    # grouping via hamming_distance/BURST_THRESHOLD=10, composite + blink
    # penalty, sort, rank + is_burst_best assignment — copy lines ~751-820
    # of app.py unchanged, ending with:)
    return results, ranking_errors
```

The implementer copies the exact code blocks — no re-typing from memory; `git show HEAD:app.py` is the source of truth if app.py was already edited.

- [ ] **Step 4: Slim app.py**

- Delete the moved functions + cascade loads from app.py.
- Add `from backend import scoring` and module-level aliases so nothing else breaks:

```python
from backend.scoring import (
    decode_image, score_sharpness, score_exposure, score_noise,
    score_contrast, score_faces, compute_phash, hamming_distance,
    score_composition, composite_score,
)
```

- `/rank` body after manifest/file parsing (keep validation, batch-size 413, and the empty/all-failed responses exactly as today) becomes:

```python
        results, ranking_errors = scoring.rank_images(tasks)

        if not results:
            if ranking_errors:
                first = ranking_errors[0]
                return jsonify({
                    "error":          "all_scoring_failed",
                    "detail":         first["detail"],
                    "id":             first["id"],
                    "filename":       first["filename"],
                    "ranking_errors": ranking_errors,
                    "model":          "multi-metric-v1",
                    "duration_ms":    int((time.perf_counter() - start) * 1000),
                }), 422
            return jsonify({
                "results":          [],
                "ranking_errors":   [],
                "model":            "multi-metric-v1",
                "duration_ms":      int((time.perf_counter() - start) * 1000),
            })

        return jsonify({
            "results":          results,
            "ranking_errors":   ranking_errors,
            "model":            "multi-metric-v1",
            "duration_ms":      int((time.perf_counter() - start) * 1000),
        })
```

- `/analyze` keeps its shape, calling the imported functions.

- [ ] **Step 5: Run tests + live smoke**

Run: `.venv/bin/python backend/tests/test_scoring.py` → `5/5 passed`
Run all suites: `for t in backend/tests/test_*.py; do .venv/bin/python $t || exit 1; done`
Live check: start Flask (`BBP_DEBUG=1 BBP_PORT=8002 .venv/bin/python app.py`), POST two JPEGs to `/rank` via `test_rank_curl.sh` or curl; confirm response fields unchanged (`results[0]` has `rank`, `is_burst_best`, `overall_score`).

- [ ] **Step 6: Commit**

```bash
git add backend/scoring.py backend/tests/test_scoring.py app.py
git commit -m "refactor(scoring): extract scoring core to backend/scoring.py"
```

---

### Task 9: Audit CLI (`backend/audit.py`)

**Files:**
- Create: `backend/audit.py`
- Create dir: `docs/audits/` (report output)
- Test: `backend/tests/test_audit.py`

**Interfaces:**
- Consumes: Task 8 `scoring.rank_images`; optionally `backend.topaz.process`.
- Produces: `python -m backend.audit <folder> [--threshold 0.6] [--topaz-sample 0] [--out PATH]` → writes a markdown report; `run_audit(folder, threshold, topaz_sample, out_path) -> str` (report path) for tests.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_audit.py
import json
import os
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

import cv2

from backend import audit


def _write_jpegs(d, n=4):
    for i in range(n):
        img = (np.random.default_rng(i).random((120, 160)) * 255).astype('uint8')
        cv2.imwrite(os.path.join(d, f'img{i}.jpg'), img)


def test_run_audit_writes_report():
    with tempfile.TemporaryDirectory() as d:
        _write_jpegs(d)
        out = os.path.join(d, 'report.md')
        path = audit.run_audit(d, threshold=0.6, topaz_sample=0, out_path=out)
        assert os.path.isfile(path)
        text = open(path).read()
        assert '## Latency' in text
        assert '## Score distribution' in text


def test_run_audit_agreement_from_sidecars():
    with tempfile.TemporaryDirectory() as d:
        _write_jpegs(d, n=2)
        # decisions file marks img0 keep, img1 reject
        with open(os.path.join(d, 'bigbad_decisions.json'), 'w') as f:
            json.dump({'schema': 'bigbadphotos.decisions.v1',
                       'decisions': {'img0.jpg': 'keep', 'img1.jpg': 'reject'}}, f)
        out = os.path.join(d, 'report.md')
        audit.run_audit(d, threshold=0.6, topaz_sample=0, out_path=out)
        text = open(out).read()
        assert '## Agreement with your decisions' in text


def test_run_audit_empty_folder_errors():
    with tempfile.TemporaryDirectory() as d:
        try:
            audit.run_audit(d, threshold=0.6, topaz_sample=0,
                            out_path=os.path.join(d, 'r.md'))
        except SystemExit:
            return
        except ValueError:
            return
        raise AssertionError('expected error on empty folder')


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"PASS  {t.__name__}")
        except Exception as e:
            failed += 1
            print(f"FAIL  {t.__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
```

- [ ] **Step 2: Run to verify failure** — `.venv/bin/python backend/tests/test_audit.py` → ImportError.

- [ ] **Step 3: Implementation**

```python
# backend/audit.py
"""Scoring/Topaz benchmark over a real folder. Produces a markdown report.

Usage:
    python -m backend.audit /path/to/session-folder --threshold 0.6 \
        --topaz-sample 3 --out docs/audits/audit-2026-07-04.md

Agreement analysis uses, when present in the folder:
  - bigbad_decisions.json  (exported decisions: keep/maybe/reject per filename)
  - <image>.bbp.json sidecars with a prior overall_score
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import tempfile
import time
from datetime import datetime, timezone

from backend import scoring

JPEG_EXTS = {'.jpg', '.jpeg'}
BATCH = 100
AGREEMENT_THRESHOLDS = [0.4, 0.5, 0.6, 0.7, 0.8]


def _collect(folder: str) -> list[str]:
    names = [n for n in sorted(os.listdir(folder))
             if os.path.splitext(n)[1].lower() in JPEG_EXTS]
    return names


def _load_decisions(folder: str) -> dict[str, str]:
    path = os.path.join(folder, 'bigbad_decisions.json')
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return {k: v for k, v in (data.get('decisions') or {}).items()}
    except (OSError, ValueError):
        return {}


def run_audit(folder: str, threshold: float, topaz_sample: int, out_path: str) -> str:
    names = _collect(folder)
    if not names:
        raise ValueError(f'no JPEGs found in {folder}')

    # ---- scoring latency + results ----
    all_results: list[dict] = []
    all_errors: list[dict] = []
    per_batch_ms: list[float] = []
    t_total = time.perf_counter()
    for i in range(0, len(names), BATCH):
        chunk = names[i:i + BATCH]
        tasks = []
        for n in chunk:
            with open(os.path.join(folder, n), 'rb') as f:
                tasks.append((n, n, f.read()))
        t0 = time.perf_counter()
        results, errors = scoring.rank_images(tasks)
        per_batch_ms.append((time.perf_counter() - t0) * 1000)
        all_results.extend(results)
        all_errors.extend(errors)
    total_s = time.perf_counter() - t_total

    scores = sorted(r['overall_score'] for r in all_results)
    per_image_ms = (sum(per_batch_ms) / max(1, len(all_results)))

    lines = [
        f'# Scoring/Topaz audit — {os.path.basename(os.path.abspath(folder))}',
        '',
        f'- Date: {datetime.now(timezone.utc).isoformat(timespec="seconds")}',
        f'- Folder: `{folder}`',
        f'- Images: {len(names)} JPEG (scored {len(all_results)}, failed {len(all_errors)})',
        f'- Threshold analysed: {threshold}',
        '',
        '## Latency',
        '',
        f'- Total scoring wall time: {total_s:.2f}s',
        f'- Mean per image: {per_image_ms:.1f}ms',
        f'- Batches: {len(per_batch_ms)} × ≤{BATCH} images',
        '',
        '## Score distribution',
        '',
    ]
    if scores:
        def pct(p):
            return scores[min(len(scores) - 1, int(p * (len(scores) - 1)))]
        lines += [
            f'- min {scores[0]:.3f} / p25 {pct(.25):.3f} / median {pct(.5):.3f} '
            f'/ p75 {pct(.75):.3f} / max {scores[-1]:.3f}',
            f'- mean {statistics.fmean(scores):.3f}',
            f'- would publish at {threshold}: '
            f'{sum(1 for r in all_results if r["overall_score"] >= threshold and r["is_burst_best"])}'
            f' of {len(all_results)} (threshold + burst-best gate)',
            '',
        ]

    # ---- agreement vs Robert's decisions ----
    decisions = _load_decisions(folder)
    if decisions:
        lines += ['## Agreement with your decisions', '',
                  '| threshold | agree | keep-missed | junk-kept |', '|---|---|---|---|']
        by_name = {r['filename']: r for r in all_results}
        for th in AGREEMENT_THRESHOLDS:
            agree = missed = junk = 0
            for fname, decision in decisions.items():
                r = by_name.get(fname)
                if not r or decision == 'maybe':
                    continue
                predicted_keep = r['overall_score'] >= th and r['is_burst_best']
                actual_keep = decision == 'keep'
                if predicted_keep == actual_keep:
                    agree += 1
                elif actual_keep:
                    missed += 1
                else:
                    junk += 1
            lines.append(f'| {th} | {agree} | {missed} | {junk} |')
        lines.append('')

    # ---- optional Topaz timing ----
    if topaz_sample > 0:
        from backend import topaz
        sample = [os.path.join(folder, n) for n in names[:topaz_sample]]
        lines += ['## Topaz timing', '']
        with tempfile.TemporaryDirectory() as tmp:
            for path in sample:
                t0 = time.perf_counter()
                try:
                    res = topaz.process(inputs=[path], output_dir=tmp,
                                        enhancements=topaz.route_by_iso(None))
                    ms = (time.perf_counter() - t0) * 1000
                    lines.append(f'- `{os.path.basename(path)}`: '
                                 f'{"ok" if res.ok else "FAILED"} in {ms/1000:.1f}s')
                except Exception as exc:
                    lines.append(f'- `{os.path.basename(path)}`: ERROR {exc}')
        lines.append('')

    if all_errors:
        lines += ['## Scoring failures', ''] + [
            f'- `{e["filename"]}`: {e["detail"]}' for e in all_errors[:20]] + ['']

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))
    return out_path


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description='BigBadPhotos scoring/Topaz audit')
    p.add_argument('folder')
    p.add_argument('--threshold', type=float, default=0.6)
    p.add_argument('--topaz-sample', type=int, default=0)
    p.add_argument('--out', default=None)
    args = p.parse_args(argv)
    out = args.out or os.path.join(
        'docs', 'audits', f'audit-{datetime.now().strftime("%Y-%m-%d-%H%M")}.md')
    try:
        path = run_audit(args.folder, args.threshold, args.topaz_sample, out)
    except ValueError as e:
        print(f'error: {e}', file=sys.stderr)
        return 2
    print(f'report written: {path}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
```

- [ ] **Step 4: Run tests** — `.venv/bin/python backend/tests/test_audit.py` → `3/3 passed`.

- [ ] **Step 5: Commit**

```bash
git add backend/audit.py backend/tests/test_audit.py
git commit -m "feat(audit): scoring/Topaz benchmark CLI with agreement report"
```

**Post-task action (Robert-facing, not code):** run the audit on a real session folder with prior decisions, e.g. `.venv/bin/python -m backend.audit "/path/to/real/session" --topaz-sample 3` and review `docs/audits/`. Tuning decisions come from this report as a separate follow-up change.

---

### Task 10: Session worker (`backend/session_worker.py`)

**Files:**
- Create: `backend/session_worker.py`
- Test: `backend/tests/test_session_worker.py`

**Interfaces:**
- Consumes: `google_drive.list_all/download_file/upload_file`, `google_photos.upload_bytes/batch_create`, `scoring.rank_images`, `topaz.process/route_by_iso`, a `token_provider: Callable[[], str]` (Task 11 wires `google_auth.get_manager().get_access_token`).
- Produces (used by Task 11):
  - `class SessionConfig` — `from_dict(data: dict) -> SessionConfig` (raises `ValueError`); fields `source_folder_id: str`, `album_id: str`, `threshold: float = 0.6`, `edit: bool = True`, `poll_seconds: int = 30`, `staging_root: str`
  - `class SessionWorker(config, token_provider, deps=None)` — `start()`, `stop(wait=True)`, `status() -> dict`, `poll_once() -> dict` (public for tests)
  - Module singleton: `start_worker(config, token_provider) -> SessionWorker` (raises `RuntimeError` if running), `stop_worker() -> bool`, `worker_status() -> dict`
  - Status dict: `{'running': bool, 'phase': str, 'config': dict, 'counts': {'seen','scored','published','skipped','failed'}, 'lastPollAt': iso-str|None, 'errors': [str]}` — phases: `idle|polling|scoring|editing|publishing|watching|auth_error|stopped`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_session_worker.py
"""Worker loop tests with injected fakes — no network, no Topaz, no threads."""
import json
import os
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

import cv2

from backend import session_worker


def _jpeg_bytes(seed=0):
    img = (np.random.default_rng(seed).random((80, 120)) * 255).astype('uint8')
    ok, buf = cv2.imencode('.jpg', img)
    return buf.tobytes()


class FakeDrive:
    def __init__(self, files):
        # files: {name: bytes}; sidecars added via uploads
        self.files = dict(files)
        self.uploads = []  # (parent, filename, bytes)
    def list_all(self, token, folder_id):
        return [{'id': f'id-{n}', 'name': n, 'mimeType': 'image/jpeg'} for n in self.files]
    def download_file(self, token, file_id, filename=None, mime_type=None):
        name = file_id[len('id-'):]
        return self.files[name], name, 'image/jpeg'
    def upload_file(self, token, parent_id, filename, data, mime_type=None):
        self.uploads.append((parent_id, filename, data))
        self.files[filename] = data
        return {'id': f'id-{filename}'}


class FakePhotos:
    def __init__(self):
        self.published = []
    def upload_bytes(self, token, filename, data, mime_type='image/jpeg'):
        return f'ut-{filename}'
    def batch_create(self, token, album_id, items):
        self.published.extend((album_id, it['filename']) for it in items)
        return [{'filename': it['filename'], 'ok': True,
                 'mediaItemId': f"m-{it['filename']}"} for it in items]


class FakeRanker:
    """Deterministic scores keyed by filename prefix: keep_* high, skip_* low."""
    def rank_images(self, tasks, max_workers=None):
        results = []
        for i, (tid, fname, _b) in enumerate(tasks):
            score = 0.9 if fname.startswith('keep') else 0.2
            results.append({
                'id': tid, 'filename': fname, 'sharpness': score,
                'overall_score': score, 'rank': i + 1, 'is_burst_best': True,
                'burst_group': None, 'burst_size': None,
                'exposure': {'exposure_score': score}, 'noise': {'noise_score': score},
                'contrast': {'contrast_score': score},
                'subject': {'face_count': 0}, 'composition': {'composition_score': score},
            })
        return results, []


def _worker(tmp, drive, photos, edit=False):
    cfg = session_worker.SessionConfig.from_dict({
        'sourceFolderId': 'src1', 'albumId': 'alb1',
        'threshold': 0.6, 'edit': edit, 'pollSeconds': 1,
        'stagingRoot': tmp,
    })
    return session_worker.SessionWorker(
        cfg, token_provider=lambda: 'TOK',
        deps={'drive': drive, 'photos': photos, 'ranker': FakeRanker(), 'topaz': None})


def test_config_validation():
    try:
        session_worker.SessionConfig.from_dict({'albumId': 'a'})
    except ValueError:
        return
    raise AssertionError('missing sourceFolderId should raise')


def test_poll_publishes_above_threshold_and_writes_sidecars():
    with tempfile.TemporaryDirectory() as tmp:
        drive = FakeDrive({'keep_1.jpg': _jpeg_bytes(1), 'skip_1.jpg': _jpeg_bytes(2)})
        photos = FakePhotos()
        w = _worker(tmp, drive, photos)
        w.poll_once()
        assert ('alb1', 'keep_1.jpg') in photos.published
        assert all(name != 'skip_1.jpg' for _a, name in photos.published)
        sidecar_names = [f for _p, f, _d in drive.uploads if f.endswith('.bbp.json')]
        assert 'keep_1.jpg.bbp.json' in sidecar_names
        assert 'skip_1.jpg.bbp.json' in sidecar_names
        keep_sc = json.loads([d for _p, f, d in drive.uploads
                              if f == 'keep_1.jpg.bbp.json'][0])
        assert keep_sc['schema'] == 'bigbadphotos.processed.v1'
        assert keep_sc['exported'] is True
        assert keep_sc['published']['mediaItemId'] == 'm-keep_1.jpg'
        st = w.status()
        assert st['counts']['published'] == 1
        assert st['counts']['skipped'] == 1


def test_poll_skips_files_with_existing_sidecar():
    with tempfile.TemporaryDirectory() as tmp:
        drive = FakeDrive({'keep_1.jpg': _jpeg_bytes(1),
                           'keep_1.jpg.bbp.json': b'{}'})
        photos = FakePhotos()
        w = _worker(tmp, drive, photos)
        w.poll_once()
        assert photos.published == []


def test_second_poll_does_not_reprocess():
    with tempfile.TemporaryDirectory() as tmp:
        drive = FakeDrive({'keep_1.jpg': _jpeg_bytes(1)})
        photos = FakePhotos()
        w = _worker(tmp, drive, photos)
        w.poll_once()
        w.poll_once()
        assert len(photos.published) == 1


def test_photos_failure_counts_failed_and_writes_error_sidecar():
    with tempfile.TemporaryDirectory() as tmp:
        drive = FakeDrive({'keep_1.jpg': _jpeg_bytes(1)})
        class BrokenPhotos(FakePhotos):
            def upload_bytes(self, *a, **k):
                raise RuntimeError('photos down')
        w = _worker(tmp, drive, BrokenPhotos())
        w.poll_once()
        st = w.status()
        assert st['counts']['failed'] == 1
        sc = json.loads([d for _p, f, d in drive.uploads
                         if f == 'keep_1.jpg.bbp.json'][0])
        assert sc['exported'] is False
        assert 'photos down' in sc['pipeline_error']


def test_status_shape():
    with tempfile.TemporaryDirectory() as tmp:
        w = _worker(tmp, FakeDrive({}), FakePhotos())
        st = w.status()
        for key in ('running', 'phase', 'config', 'counts', 'lastPollAt', 'errors'):
            assert key in st
        for key in ('seen', 'scored', 'published', 'skipped', 'failed'):
            assert key in st['counts']


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"PASS  {t.__name__}")
        except Exception as e:
            failed += 1
            print(f"FAIL  {t.__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
```

- [ ] **Step 2: Run to verify failure** — ImportError.

- [ ] **Step 3: Implementation**

```python
# backend/session_worker.py
"""Autonomous session worker: Drive folder → score → (Topaz) → Google Photos.

Runs as a daemon thread inside Flask (or standalone via __main__). All Google
traffic uses a token_provider callable (the refresh-token manager), so runs
survive access-token expiry. Dedupe ledger = .bbp.json sidecars in the Drive
source folder (shared schema with the browser autonomous mode) plus an
in-memory processed set.
"""
from __future__ import annotations

import json
import os
import threading
import time
import traceback
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from backend import google_drive, google_photos, scoring, topaz

SIDECAR_SUFFIX = '.bbp.json'
JPEG_EXTS = {'jpg', 'jpeg'}
DEFAULT_STAGING = os.path.join(os.path.expanduser('~'), '.bigbadphotos', 'sessions')
MAX_ERRORS_KEPT = 20
RANK_BATCH = 100


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def _read_iso(path: str) -> Optional[int]:
    """EXIF ISO via Pillow; None when unavailable."""
    try:
        from PIL import Image
        with Image.open(path) as im:
            exif = im.getexif()
            iso = exif.get(34855)  # ISOSpeedRatings
            return int(iso) if iso else None
    except Exception:
        return None


@dataclass
class SessionConfig:
    source_folder_id: str
    album_id: str
    threshold: float = 0.6
    edit: bool = True
    poll_seconds: int = 30
    staging_root: str = DEFAULT_STAGING

    @classmethod
    def from_dict(cls, data: dict) -> 'SessionConfig':
        src = (data.get('sourceFolderId') or '').strip()
        alb = (data.get('albumId') or '').strip()
        if not src:
            raise ValueError('sourceFolderId is required')
        if not alb:
            raise ValueError('albumId is required')
        threshold = float(data.get('threshold', 0.6))
        if not 0.0 <= threshold <= 1.0:
            raise ValueError('threshold must be between 0 and 1')
        poll = int(data.get('pollSeconds', 30))
        if poll < 5:
            raise ValueError('pollSeconds must be >= 5')
        return cls(
            source_folder_id=src,
            album_id=alb,
            threshold=threshold,
            edit=bool(data.get('edit', True)),
            poll_seconds=poll,
            staging_root=data.get('stagingRoot') or DEFAULT_STAGING,
        )

    def to_dict(self) -> dict:
        return {
            'sourceFolderId': self.source_folder_id,
            'albumId': self.album_id,
            'threshold': self.threshold,
            'edit': self.edit,
            'pollSeconds': self.poll_seconds,
        }


def build_sidecar(filename: str, result: dict, threshold: float, exported: bool,
                  published: dict | None = None, edit_info: dict | None = None,
                  pipeline_error: str | None = None) -> dict:
    """Python mirror of frontend/src/utils/bbpSidecar.js buildSidecarPayload."""
    payload = {
        'schema': 'bigbadphotos.processed.v1',
        'processed_at': _now_iso(),
        'filename': filename,
        'overall_score': result.get('overall_score'),
        'rank': result.get('rank'),
        'exported': exported,
        'threshold_used': threshold,
        'metrics': {
            'sharpness': result.get('sharpness'),
            'exposure': result.get('exposure'),
            'noise': result.get('noise'),
            'contrast': result.get('contrast'),
        },
        'subject': result.get('subject'),
        'composition': result.get('composition'),
        'burst_group': result.get('burst_group'),
        'burst_size': result.get('burst_size'),
        'is_burst_best': result.get('is_burst_best'),
    }
    if published:
        payload['published'] = published
    if edit_info:
        payload['edit'] = edit_info
    if pipeline_error:
        payload['pipeline_error'] = pipeline_error
    return payload


class SessionWorker:
    def __init__(self, config: SessionConfig, token_provider: Callable[[], str],
                 deps: dict[str, Any] | None = None):
        self.config = config
        self.token_provider = token_provider
        deps = deps or {}
        self._drive = deps.get('drive', google_drive)
        self._photos = deps.get('photos', google_photos)
        self._ranker = deps.get('ranker', scoring)
        self._topaz = deps.get('topaz', topaz)

        self._thread: threading.Thread | None = None
        self._stop_evt = threading.Event()
        self._lock = threading.Lock()
        self._processed: set[str] = set()

        self._phase = 'idle'
        self._counts = {'seen': 0, 'scored': 0, 'published': 0, 'skipped': 0, 'failed': 0}
        self._errors: list[str] = []
        self._last_poll_at: str | None = None

        self._session_id = datetime.now().strftime('%Y%m%d-%H%M%S')
        self._staging = os.path.join(os.path.expanduser(config.staging_root), self._session_id)

    # -- lifecycle ------------------------------------------------------------

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            raise RuntimeError('worker already running')
        self._stop_evt.clear()
        self._thread = threading.Thread(target=self._loop, name='bbp-session-worker', daemon=True)
        self._thread.start()

    def stop(self, wait: bool = True) -> None:
        self._stop_evt.set()
        if wait and self._thread and self._thread.is_alive():
            self._thread.join(timeout=10)
        self._set_phase('stopped')

    def status(self) -> dict:
        with self._lock:
            return {
                'running': bool(self._thread and self._thread.is_alive()
                                and not self._stop_evt.is_set()),
                'phase': self._phase,
                'config': self.config.to_dict(),
                'counts': dict(self._counts),
                'lastPollAt': self._last_poll_at,
                'errors': list(self._errors),
            }

    # -- internals ------------------------------------------------------------

    def _set_phase(self, phase: str) -> None:
        with self._lock:
            self._phase = phase

    def _add_error(self, msg: str) -> None:
        with self._lock:
            self._errors.append(msg)
            del self._errors[:-MAX_ERRORS_KEPT]

    def _bump(self, key: str, n: int = 1) -> None:
        with self._lock:
            self._counts[key] += n

    def _loop(self) -> None:
        while not self._stop_evt.is_set():
            try:
                self.poll_once()
            except google_photos.PhotosApiError as exc:
                if exc.status_code in (401, 403):
                    self._add_error(f'Google auth problem: {exc}')
                    self._set_phase('auth_error')
                    return
                self._add_error(str(exc))
            except Exception as exc:
                self._add_error(f'poll failed: {exc}')
                traceback.print_exc()
            if self._stop_evt.is_set():
                break
            self._set_phase('watching')
            self._stop_evt.wait(self.config.poll_seconds)
        self._set_phase('stopped')

    def poll_once(self) -> dict:
        """One pipeline pass. Public so tests drive it without threads."""
        self._set_phase('polling')
        with self._lock:
            self._last_poll_at = _now_iso()
        token = self.token_provider()

        listing = self._drive.list_all(token, self.config.source_folder_id)
        sidecars = {f['name'] for f in listing if f['name'].endswith(SIDECAR_SUFFIX)}
        candidates = []
        for f in listing:
            name = f['name']
            if name.endswith(SIDECAR_SUFFIX):
                continue
            ext = name.rsplit('.', 1)[-1].lower() if '.' in name else ''
            if ext not in JPEG_EXTS:
                continue
            if name in self._processed or f'{name}{SIDECAR_SUFFIX}' in sidecars:
                self._processed.add(name)
                continue
            candidates.append(f)

        if not candidates:
            return self.status()
        self._bump('seen', len(candidates))

        raw_dir = os.path.join(self._staging, 'raw')
        os.makedirs(raw_dir, exist_ok=True)

        tasks = []
        for f in candidates:
            try:
                data, name, _mime = self._drive.download_file(
                    token, f['id'], filename=f['name'], mime_type=f.get('mimeType'))
                local = os.path.join(raw_dir, name)
                with open(local, 'wb') as fh:
                    fh.write(data)
                tasks.append((f['id'], name, data))
            except Exception as exc:
                self._add_error(f'download failed for {f["name"]}: {exc}')
                self._processed.add(f['name'])

        for i in range(0, len(tasks), RANK_BATCH):
            if self._stop_evt.is_set():
                break
            self._process_batch(token, tasks[i:i + RANK_BATCH], raw_dir)
        return self.status()

    def _process_batch(self, token: str, tasks: list, raw_dir: str) -> None:
        self._set_phase('scoring')
        results, errors = self._ranker.rank_images(tasks)
        for e in errors:
            self._add_error(f'scoring failed for {e["filename"]}: {e["detail"]}')
            self._processed.add(e['filename'])
            self._bump('failed')
        self._bump('scored', len(results))

        for r in results:
            if self._stop_evt.is_set():
                return
            name = r['filename']
            qualifies = (isinstance(r.get('overall_score'), (int, float))
                         and r['overall_score'] >= self.config.threshold
                         and r.get('is_burst_best') is not False)
            published = None
            edit_info = None
            pipeline_error = None

            if qualifies:
                publish_path = os.path.join(raw_dir, name)
                publish_name = name
                if self.config.edit and self._topaz is not None:
                    self._set_phase('editing')
                    edited_dir = os.path.join(self._staging, 'edited')
                    enhancements = self._topaz.route_by_iso(_read_iso(publish_path))
                    try:
                        res = self._topaz.process(
                            inputs=[publish_path], output_dir=edited_dir,
                            enhancements=enhancements)
                        if res.ok and res.outputs:
                            publish_path = res.outputs[0]
                            publish_name = os.path.basename(publish_path)
                            edit_info = {'enhancements': enhancements,
                                         'edited_filename': publish_name,
                                         'edited_at': _now_iso(), 'status': 'ok'}
                        else:
                            edit_info = {'enhancements': enhancements,
                                         'status': 'failed',
                                         'detail': getattr(res, 'status', 'unknown')}
                            self._add_error(f'Topaz failed for {name}; publishing original')
                    except Exception as exc:
                        edit_info = {'enhancements': enhancements,
                                     'status': 'failed', 'detail': str(exc)}
                        self._add_error(f'Topaz error for {name}: {exc}; publishing original')

                self._set_phase('publishing')
                try:
                    with open(publish_path, 'rb') as fh:
                        payload = fh.read()
                    upload_token = self._photos.upload_bytes(
                        token, publish_name, payload)
                    created = self._photos.batch_create(token, self.config.album_id, [
                        {'uploadToken': upload_token, 'filename': publish_name,
                         'description': f'BigBadPhotos score {r["overall_score"]:.2f}'},
                    ])
                    first = created[0] if created else {'ok': False, 'error': 'no result'}
                    if first.get('ok'):
                        published = {'albumId': self.config.album_id,
                                     'mediaItemId': first.get('mediaItemId'),
                                     'publishedAt': _now_iso()}
                        self._bump('published')
                    else:
                        pipeline_error = f'photos rejected item: {first.get("error")}'
                        self._bump('failed')
                except google_photos.PhotosApiError as exc:
                    if exc.status_code in (401, 403):
                        raise  # handled by _loop -> auth_error phase
                    pipeline_error = str(exc)
                    self._bump('failed')
                    self._add_error(f'publish failed for {name}: {exc}')
                except Exception as exc:
                    pipeline_error = str(exc)
                    self._bump('failed')
                    self._add_error(f'publish failed for {name}: {exc}')
            else:
                self._bump('skipped')

            sidecar = build_sidecar(
                name, r, self.config.threshold,
                exported=bool(published), published=published,
                edit_info=edit_info, pipeline_error=pipeline_error)
            try:
                self._drive.upload_file(
                    token, self.config.source_folder_id,
                    f'{name}{SIDECAR_SUFFIX}',
                    json.dumps(sidecar, indent=2).encode('utf-8'),
                    'application/json')
            except Exception as exc:
                self._add_error(f'sidecar write failed for {name}: {exc}')
            self._processed.add(name)


# -- module singleton ---------------------------------------------------------

_current: SessionWorker | None = None
_current_lock = threading.Lock()


def start_worker(config: SessionConfig, token_provider: Callable[[], str]) -> SessionWorker:
    global _current
    with _current_lock:
        if _current is not None and _current.status()['running']:
            raise RuntimeError('a session is already running')
        _current = SessionWorker(config, token_provider)
        _current.start()
        return _current


def stop_worker() -> bool:
    with _current_lock:
        if _current is None:
            return False
        _current.stop(wait=True)
        return True


def worker_status() -> dict:
    with _current_lock:
        if _current is None:
            return {'running': False, 'phase': 'idle', 'config': None,
                    'counts': {'seen': 0, 'scored': 0, 'published': 0,
                               'skipped': 0, 'failed': 0},
                    'lastPollAt': None, 'errors': []}
        return _current.status()


if __name__ == '__main__':
    import argparse
    from backend import google_auth

    p = argparse.ArgumentParser(description='Run a BigBadPhotos session headless')
    p.add_argument('--config', required=True, help='path to session config JSON')
    args = p.parse_args()
    with open(args.config, 'r', encoding='utf-8') as f:
        cfg = SessionConfig.from_dict(json.load(f))
    mgr = google_auth.get_manager()
    if not mgr.available():
        raise SystemExit('no stored Google credentials — connect via /google/oauth/start first')
    w = SessionWorker(cfg, mgr.get_access_token)
    w.start()
    print(f'session running (poll every {cfg.poll_seconds}s) — Ctrl-C to stop')
    try:
        while True:
            time.sleep(5)
            print(json.dumps(w.status()['counts']))
    except KeyboardInterrupt:
        w.stop()
```

Note the deps dict: tests pass `{'topaz': None}` and `edit=False`; when `edit=True` and `deps['topaz'] is None` the edit step is skipped (the `self._topaz is not None` guard).

- [ ] **Step 4: Run tests** — `.venv/bin/python backend/tests/test_session_worker.py` → `6/6 passed`.

- [ ] **Step 5: Commit**

```bash
git add backend/session_worker.py backend/tests/test_session_worker.py
git commit -m "feat(autonomous): server-side session worker (drive->score->topaz->photos)"
```

---

### Task 11: `/autonomous/*` routes

**Files:**
- Modify: `app.py` (import; routes after `/photos/upload`)
- Test: `backend/tests/test_autonomous_routes.py`

**Interfaces:**
- Consumes: Task 10 module functions; Task 1 manager.
- Produces (used by Task 12):
  - `POST /autonomous/start` JSON = SessionConfig camelCase fields → 200 `{"ok": true, "status": {...}}`; 400 bad config; 401 no server Google auth; 409 already running
  - `POST /autonomous/stop` → `{"ok": true, "stopped": bool}`
  - `GET /autonomous/status` → the worker status dict

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_autonomous_routes.py
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
os.environ.setdefault('BBP_DEBUG', '1')

import app as appmod
from backend import google_auth, session_worker


def _client():
    appmod.app.config['TESTING'] = True
    c = appmod.app.test_client()
    with c.session_transaction() as s:
        s['user'] = {'email': 'dev@local'}
    return c


class FakeMgr:
    def __init__(self, ok=True):
        self.ok = ok
    def available(self):
        return self.ok
    def get_access_token(self):
        return 'TOK'


def test_status_idle_by_default():
    c = _client()
    r = c.get('/autonomous/status')
    assert r.status_code == 200
    assert r.get_json()['running'] is False


def test_start_requires_server_google_auth():
    c = _client()
    orig = google_auth._manager
    google_auth._manager = FakeMgr(ok=False)
    try:
        r = c.post('/autonomous/start', json={'sourceFolderId': 's', 'albumId': 'a'})
        assert r.status_code == 401
    finally:
        google_auth._manager = orig


def test_start_validates_config():
    c = _client()
    orig = google_auth._manager
    google_auth._manager = FakeMgr(ok=True)
    try:
        r = c.post('/autonomous/start', json={'albumId': 'a'})
        assert r.status_code == 400
    finally:
        google_auth._manager = orig


def test_start_conflict_when_running():
    c = _client()
    orig_mgr = google_auth._manager
    google_auth._manager = FakeMgr(ok=True)
    orig_start = session_worker.start_worker
    def boom(cfg, tp):
        raise RuntimeError('a session is already running')
    session_worker.start_worker = boom
    try:
        r = c.post('/autonomous/start', json={'sourceFolderId': 's', 'albumId': 'a', 'edit': False})
        assert r.status_code == 409
    finally:
        google_auth._manager = orig_mgr
        session_worker.start_worker = orig_start


def test_stop_route():
    c = _client()
    r = c.post('/autonomous/stop')
    assert r.status_code == 200
    assert 'stopped' in r.get_json()


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"PASS  {t.__name__}")
        except Exception as e:
            failed += 1
            print(f"FAIL  {t.__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement in app.py**

Add import: `from backend import session_worker`.

```python
@app.post('/autonomous/start')
def autonomous_start():
    mgr = google_auth.get_manager()
    if not mgr.available():
        return jsonify({'error': 'server_google_not_connected',
                        'detail': 'Connect via /google/oauth/start first'}), 401
    data = request.get_json(silent=True) or {}
    try:
        config = session_worker.SessionConfig.from_dict(data)
    except ValueError as e:
        return jsonify({'error': 'bad_config', 'detail': str(e)}), 400
    if config.edit:
        try:
            topaz.resolve_binary()
        except Exception as e:
            return jsonify({'error': 'topaz_unavailable', 'detail': str(e)}), 400
    try:
        session_worker.start_worker(config, mgr.get_access_token)
    except RuntimeError as e:
        return jsonify({'error': 'already_running', 'detail': str(e)}), 409
    return jsonify({'ok': True, 'status': session_worker.worker_status()})


@app.post('/autonomous/stop')
def autonomous_stop():
    stopped = session_worker.stop_worker()
    return jsonify({'ok': True, 'stopped': stopped})


@app.get('/autonomous/status')
def autonomous_status():
    return jsonify(session_worker.worker_status())
```

(`/autonomous` prefix is already inside `enforce_auth` from Task 4.)

- [ ] **Step 4: Run ALL backend suites**

Run: `for t in backend/tests/test_*.py; do .venv/bin/python $t || exit 1; done`
Expected: every suite passes.

- [ ] **Step 5: Commit**

```bash
git add app.py backend/tests/test_autonomous_routes.py
git commit -m "feat(autonomous): start/stop/status routes for session worker"
```

---

### Task 12: Server session UI (hook + panel + gate)

**Files:**
- Create: `frontend/src/hooks/useServerAutonomous.js`
- Create: `frontend/src/components/ServerAutonomousPanel.jsx`
- Modify: `frontend/src/components/AutonomousPanel.jsx` (top of default export: capability gate)

**Interfaces:**
- Consumes: Task 11 routes; Task 6 picker + store `photosAlbum`; store `sourceDir` (`{_drive, folderId}` when Drive).
- Produces:
  - `useServerAutonomous() -> { available, running, status, error, start(config), stop() }` — `available` from `/auth/config` `worker` flag; polls `/autonomous/status` every 5s while running.
  - `<ServerAutonomousPanel />` — self-contained (store reads); rendered by `AutonomousPanel` when `available && sourceDir?._drive`, replacing the legacy UI; legacy props path untouched otherwise.

- [ ] **Step 1: Hook**

```javascript
// frontend/src/hooks/useServerAutonomous.js
// Remote control for the Mac-side session worker (/autonomous/*).
import { useCallback, useEffect, useRef, useState } from 'react'

const POLL_MS = 5000

export function useServerAutonomous() {
  const [available, setAvailable] = useState(false)
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)
  const timerRef = useRef(null)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/autonomous/status', { credentials: 'include' })
      if (!res.ok) throw new Error(`status ${res.status}`)
      const body = await res.json()
      setStatus(body)
      return body
    } catch (err) {
      setError(err.message)
      return null
    }
  }, [])

  useEffect(() => {
    let alive = true
    fetch('/auth/config', { credentials: 'include' })
      .then(r => r.ok ? r.json() : {})
      .then(cfg => { if (alive) setAvailable(!!cfg.worker) })
      .catch(() => {})
    fetchStatus()
    return () => { alive = false }
  }, [fetchStatus])

  useEffect(() => {
    const running = !!status?.running
    clearInterval(timerRef.current)
    if (running) timerRef.current = setInterval(fetchStatus, POLL_MS)
    return () => clearInterval(timerRef.current)
  }, [status?.running, fetchStatus])

  const start = useCallback(async (config) => {
    setError(null)
    const res = await fetch('/autonomous/start', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      setError(body.detail || body.error || 'Could not start session')
      return false
    }
    await fetchStatus()
    return true
  }, [fetchStatus])

  const stop = useCallback(async () => {
    await fetch('/autonomous/stop', { method: 'POST', credentials: 'include' })
    await fetchStatus()
  }, [fetchStatus])

  return { available, running: !!status?.running, status, error, start, stop }
}
```

- [ ] **Step 2: Panel**

```jsx
// frontend/src/components/ServerAutonomousPanel.jsx
/**
 * Phone-first control for the Mac session worker: pick album, set threshold,
 * toggle Topaz edits, start/stop, watch live counts. The Drive source folder
 * comes from the store (same folder the app is browsing).
 */
import { useState } from 'react'
import { useStore } from '../store'
import { useServerAutonomous } from '../hooks/useServerAutonomous'
import GooglePhotosAlbumPicker from './GooglePhotosAlbumPicker'

const PHASE_LABEL = {
  idle: '—', polling: 'Checking Drive…', scoring: 'Scoring…',
  editing: 'Editing (Topaz)…', publishing: 'Publishing…',
  watching: 'Watching for new photos', auth_error: 'Google auth problem',
  stopped: 'Stopped',
}

export default function ServerAutonomousPanel() {
  const sourceDir = useStore(s => s.sourceDir)
  const photosAlbum = useStore(s => s.photosAlbum)
  const { running, status, error, start, stop } = useServerAutonomous()

  const [threshold, setThreshold] = useState(0.6)
  const [edit, setEdit] = useState(true)
  const [starting, setStarting] = useState(false)

  const canStart = !!sourceDir?._drive && !!photosAlbum?.id && !running

  const handleStart = async () => {
    setStarting(true)
    await start({
      sourceFolderId: sourceDir.folderId,
      albumId: photosAlbum.id,
      threshold,
      edit,
      pollSeconds: 30,
    })
    setStarting(false)
  }

  const counts = status?.counts || {}
  const phase = status?.phase || 'idle'

  return (
    <div className="card" style={{ padding: 'var(--sp-5)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div className="meta">Autonomous Session (Mac worker)</div>
          <div className="fs-xxs dim" style={{ marginTop: 2 }}>
            Drive → score → Topaz → Google Photos, runs even when this phone sleeps
          </div>
        </div>
        <button
          onClick={running ? stop : handleStart}
          disabled={(!canStart && !running) || starting}
          className="btn btn-uppercase"
          style={{
            padding: '8px 16px', borderRadius: 6, fontWeight: 700,
            background: running ? 'color-mix(in oklab, var(--accent) 20%, var(--bg-3))' : 'var(--bg-3)',
            color: running ? 'var(--accent)' : 'var(--fg-2)',
            border: '1px solid var(--line)',
            opacity: (!canStart && !running) ? 0.4 : 1,
          }}
        >
          {starting ? 'Starting…' : running ? '⏹ Stop' : '▶ Start'}
        </button>
      </div>

      {!running && (
        <>
          <div>
            <div className="meta" style={{ marginBottom: 6 }}>Google Photos album</div>
            <GooglePhotosAlbumPicker />
          </div>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span className="meta">Quality threshold</span>
              <span className="mono fs-xs" style={{ color: 'var(--accent)' }}>{Math.round(threshold * 100)}%</span>
            </div>
            <input
              type="range" min="0" max="0.95" step="0.05" value={threshold}
              onChange={e => setThreshold(parseFloat(e.target.value))}
              style={{ width: '100%', accentColor: 'var(--accent)' }}
            />
          </div>
          <label className="fs-xs" style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={edit} onChange={e => setEdit(e.target.checked)} />
            Topaz auto-edit before publishing
          </label>
          {!sourceDir?._drive && (
            <div className="fs-xxs dim mono upper" style={{ textAlign: 'center' }}>
              Select a Google Drive source folder to enable
            </div>
          )}
        </>
      )}

      {running && (
        <>
          <div className="fs-sm" style={{ color: 'var(--accent)', fontWeight: 500 }}>
            {PHASE_LABEL[phase] || phase}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--sp-3)' }}>
            {[
              ['New', counts.seen], ['Scored', counts.scored],
              ['Published', counts.published], ['Skipped', counts.skipped],
            ].map(([label, value]) => (
              <div key={label} style={{ textAlign: 'center' }}>
                <div className="mono" style={{ fontSize: 20, fontWeight: 700 }}>{value ?? 0}</div>
                <div className="meta" style={{ marginTop: 2 }}>{label}</div>
              </div>
            ))}
          </div>
          {status?.lastPollAt && (
            <div className="fs-xxs dim mono upper" style={{ textAlign: 'center' }}>
              Last scan: {new Date(status.lastPollAt).toLocaleTimeString()}
            </div>
          )}
        </>
      )}

      {(error || (status?.errors?.length > 0)) && (
        <div style={{
          padding: 'var(--sp-3)', borderRadius: 6, maxHeight: 120, overflowY: 'auto',
          background: 'color-mix(in oklab, var(--reject) 10%, var(--bg-3))',
          border: '1px solid color-mix(in oklab, var(--reject) 30%, var(--line))',
        }}>
          {error && <div className="fs-xxs mono" style={{ color: 'var(--reject)' }}>{error}</div>}
          {(status?.errors || []).map((e, i) => (
            <div key={i} className="fs-xxs mono" style={{ color: 'var(--reject)', marginBottom: 2 }}>{e}</div>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Gate inside AutonomousPanel.jsx**

At the top of `frontend/src/components/AutonomousPanel.jsx` add imports:

```jsx
import { useStore } from '../store'
import { useServerAutonomous } from '../hooks/useServerAutonomous'
import ServerAutonomousPanel from './ServerAutonomousPanel'
```

First lines inside the `AutonomousPanel` function body:

```jsx
  const serverWorker = useServerAutonomous()
  const sourceDir = useStore(s => s.sourceDir)
  if (serverWorker.available && sourceDir?._drive) {
    return <ServerAutonomousPanel />
  }
```

(Hook-order safe: `useServerAutonomous`/`useStore` run unconditionally before the early return; the legacy hooks below them are plain `useState`/`useEffect` already in the component — keep the early return ABOVE none of them. If the existing hooks sit above the insertion point, place the gate return after ALL existing hook calls to respect the rules of hooks.)

- [ ] **Step 4: Verify build + preview smoke**

Run: `cd frontend && npm run build` → success.
Preview (backend + frontend dev servers via the `bigbadphotos-dev` skill setup): with server Google connected, Landing shows the server panel for a Drive source; without, legacy panel renders.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/useServerAutonomous.js frontend/src/components/ServerAutonomousPanel.jsx frontend/src/components/AutonomousPanel.jsx
git commit -m "feat(autonomous): phone-first server session panel with worker gate"
```

---

### Task 13: End-to-end verification (manual, with Robert)

**Files:** none (checklist; findings feed follow-up fixes)

- [ ] **Step 1: Google Cloud setup** — follow `docs/GOOGLE_SETUP.md`; `.env` gets `GOOGLE_CLIENT_SECRET`; restart Flask; `/auth/config` shows `"serverGoogle": true` after visiting `/google/oauth/start`.
- [ ] **Step 2: Manual Photos export** — load a folder, keep 2 photos, Review → destination Google Photos → create album `BBP test` → export → both photos visible at photos.google.com in the album.
- [ ] **Step 3: Worker dry run** — Drive test folder with 3 JPEGs (one duplicate pair) → start session (threshold 0.5, edit OFF) → within a poll: best photos in album, `.bbp.json` sidecars in Drive folder, status counts correct; duplicate publishes only burst-best.
- [ ] **Step 4: Topaz run** — same with edit ON; Topaz desktop logged in; album receives edited files; sidecar `edit.status == "ok"`.
- [ ] **Step 5: Resilience** — while watching: add a new JPEG to Drive (via drive.google.com) → appears in album next poll. Restart Flask mid-session → start session again → already-processed files NOT re-published (sidecar dedupe).
- [ ] **Step 6: Phone test** — phone browser: configure + start session; lock phone 5 min; photos keep arriving in album.
- [ ] **Step 7: Audit on real session** — `.venv/bin/python -m backend.audit <real folder with decisions> --topaz-sample 3`; commit the report; review tuning needs together.
- [ ] **Step 8: Camera chain** — images.canon → Drive source folder → live session end-to-end at next shoot.

---

## Self-review notes

- Spec coverage: auth (T1-2), photos module+routes (T3-4), manual export (T5-7), scoring extraction+audit (T8-9), worker (T10-11), panel (T12), e2e (T13). Railway flag = `worker`/`serverGoogle` both derive from manager availability (no secret on Railway → flags false → legacy UI). ✓
- Type consistency: `_google_token()` (T2) used by T4 routes; `SessionConfig.from_dict` camelCase keys match T12 `start()` payload and T11 route; `rank_images` tuple shape matches T9/T10 callers; sidecar schema matches `bbpSidecar.js` fields plus additive keys. ✓
- Worker `edit=True` default + `deps={'topaz': None}` in tests: guarded by `self._topaz is not None`. Tests pass `edit=False` anyway. ✓
