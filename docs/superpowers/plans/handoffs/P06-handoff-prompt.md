Repo: BigBadPhotos (Flask/Python backend). You're implementing Phase P06 ("REST routes and the thumbnail proxy") of a larger plan adding "photo sessions" to this app. This phase is the seam between the pipeline state machine (P05) and the frontend (P07/P08) — get the HTTP contract right, since two other phases will build directly on top of what you return here.

Plan doc: docs/superpowers/plans/2026-08-10-photo-sessions.md → Task 6 (P6)
Spec doc: docs/superpowers/specs/2026-08-10-photo-sessions-design.md (read the "API" and "Preflight" sections in full before starting)

FIRST: create and check out branch `bbaf/bbp-sessions-P06` from `bbaf/bigbadphotos-sessions` (this branch has Task 0 + P01 + P02 + P03 + P04 + P05 merged — 153 passing tests as baseline). Do not touch backend/tests/conftest.py or tests/conftest.py.

Interpreter is `.venv/bin/python` (3.14.6) at repo root — use it for every command, not `python3`/`python`. No new runtime dependencies.

## File allowlist — ONLY create/modify these
- `app.py` (modify: add routes; keep `/autonomous/*` as thin aliases for this phase — Task 9 deletes them later)
- `backend/tests/test_session_routes.py` (create)

Do not touch anything else. In particular not backend/session_worker.py, backend/scoring.py, backend/topaz.py, backend/google_auth.py, backend/google_drive.py, backend/db.py, backend/sessions.py, backend/auto_edit.py, backend/pipeline.py, backend/preflight.py, requirements.txt, CLAUDE.md, AGENTS.md, Procfile, nixpacks.toml, railpack.toml, .env, .github/, anything under frontend/. If you believe a file outside the allowlist must change, stop and say so instead of changing it.

## Background — read app.py in full before writing anything

This file already has working patterns for everything you need. Copy its conventions exactly rather than inventing new ones.

- **`enforce_auth()` gap you must close.** `app.py` around line 117 has:
  ```python
  API_ROUTES = {'/analyze', '/rank', '/edit', '/edit/file'}

  @app.before_request
  def enforce_auth():
      if request.path == '/drive/status':
          return
      if (request.path not in API_ROUTES
              and not request.path.startswith('/drive')
              and not request.path.startswith('/photos')
              and not request.path.startswith('/autonomous')):
          return  # static files, /health, /auth/* all pass through
      ...
  ```
  `API_ROUTES` is an **exact-match** set — it does not support path params like `/sessions/<id>`. None of your new routes (`/sessions`, `/sessions/<id>`, `/sessions/<id>/preflight`, `/sessions/<id>/start`, `/runs/active`, `/runs/active/stop`, `/runs/<id>/photos`, `/runs/<id>/approve-all`, `/settings`) will be gated by auth unless you extend this check. Add `/sessions` and `/runs` to the `startswith` checks (same pattern as `/drive`/`/photos`/`/autonomous`), and add `/settings` there too (or as an exact match — your call, but test it). **This is the single easiest thing to silently get wrong** — the phase's definition of done requires a test per route proving unauthenticated access is rejected, so you'll catch it if you check.
- **Token provider.** `_google_token()` (around line 279) is already the right thing to pass as `token_provider` to `pipeline.start_run()`, `pipeline.Pipeline`, and `preflight.run()` — it prefers the server-stored refresh token (`google_auth.get_manager().get_access_token`) and falls back to the browser-granted session token. Use it directly; don't reimplement token resolution.
- **Thumbnail proxy — don't reinvent this.** `backend/google_drive.py` already has `stream_file(access_token, file_id, *, filename=None, mime_type=None) -> tuple[generator, name, mime]`, and `app.py`'s existing `/drive/files/<file_id>` route (around line 356) shows the exact pattern:
  ```python
  body, resolved_name, resolved_mime = google_drive.stream_file(_google_token(), file_id, ...)
  return Response(body, mimetype=resolved_mime, headers={'Content-Disposition': f'inline; filename="{resolved_name}"'})
  ```
  `/photos/<id>/thumb` follows the same pattern: look up the photo's `drive_file_id` from the `photos` table (via `backend.db.get()` — `SELECT drive_file_id FROM photos WHERE id = ?`), 404 if the photo id doesn't exist, then `google_drive.stream_file(_google_token(), drive_file_id)` and return a `Response` with `headers={'Cache-Control': 'private, max-age=3600'}`. **Never redirect** — the phone client has no Google credentials of its own, only `BBP_PASSWORD`. Return 502 (not a redirect, not a 500) when `stream_file` raises.
- **`/drive/folders` — a real spec/code mismatch, use your judgment.** The spec's API table lists `GET /drive/folders?parent= browse (exists)`, but the actual existing route is `GET /drive/browse` (params `parentId`, `mode`), not `/drive/folders`. There is no existing `POST /drive/folders` either (create-folder), though `backend/google_drive.py` has `create_folder`/`ensure_folder` from P02 ready to use. Add `GET /drive/folders?parent=` and `POST /drive/folders` as the spec names them (reusing `google_drive.list_folders`/`create_folder` — same auth-check pattern as `drive_browse`). Leave the existing `/drive/browse` route alone; it's used by other code outside your allowlist. Note this deviation in your final report.
- **`/autonomous/*` aliasing.** The existing `/autonomous/start|stop|status` routes (around line 474) call into `backend.session_worker` (the module P05's `pipeline.py` replaces). Per the plan: "Keep `/autonomous/start|stop|status` working as thin aliases onto the new functions for one phase; Task 9 deletes them." Make them call `pipeline.start_run`/`pipeline.stop_run`/`pipeline.active_status` instead of `session_worker`. You'll need to adapt `/autonomous/start`'s request body (it currently expects `session_worker.SessionConfig.from_dict(data)`, a different shape than a session id) — the simplest correct approach: if the body includes a `sessionId`, call `pipeline.start_run(session_id, _google_token)`; otherwise return 400. Use your judgment on exact shape here since the plan doesn't pin it down precisely — the important thing is these three routes don't 500 and still round-trip through the new pipeline module. Do not modify `backend/session_worker.py` itself.

### Interfaces you consume (all merged already — read the actual source, this is a summary)

- `backend/sessions.py`: `sessions.create/get/list_all/update/delete(...)`, `sessions.get_setting(key)`, `sessions.set_setting(key, value)`. Raises `sessions.SessionError` on validation failure. Session dicts are camelCase (see `backend/sessions.py` for the exact field list).
- `backend/pipeline.py`: `pipeline.start_run(session_id, token_provider) -> dict` (raises `pipeline.RunConflict`), `pipeline.stop_run() -> bool`, `pipeline.active_status() -> dict` (shape: `{'running','runId','sessionId','sessionName','phase','counts','lastPollAt','errors'}`), `pipeline.apply_decision(photo_id, decision) -> dict` (`decision` is `'keep'` or `'reject'`; raises `KeyError` if photo not found, `ValueError` if decision is invalid), `pipeline.approve_all(run_id) -> int`.
- `backend/preflight.py`: `preflight.run(session: dict, token_provider) -> list[dict]` — each entry `{'check','ok','detail','fix'}`.
- `backend/db.py`: `db.get() -> sqlite3.Connection` (thread-local, auto-migrated). The `photos` table: `id, run_id, drive_file_id, filename, state, overall_score, metrics_json, edit_json, exported_file_id, error_code, error_detail, attempts, claimed_at, updated_at`. You'll need to hand-write the `GET /runs/<id>/photos?state=&limit=&offset=` query directly against this table — nothing in `pipeline.py` wraps it for you.
- `backend/google_drive.py`: `stream_file`, `list_folders`, `create_folder` (all already used elsewhere in `app.py` or described above).

## Task

### API surface to add (exact paths/methods, from the spec)

```
GET    /sessions                    list configs
POST   /sessions                    create
GET    /sessions/<id>               read
PUT    /sessions/<id>               update
DELETE /sessions/<id>               delete
POST   /sessions/<id>/preflight     run checks, no side effects
POST   /sessions/<id>/start         start a run
POST   /runs/active/stop            stop the active run
GET    /runs/active                 phase, counts by state, recent errors
GET    /runs/<id>/photos?state=&limit=&offset=
POST   /photos/<id>/decision        {"decision": "keep" | "reject"}
POST   /runs/<id>/approve-all       bulk-keep everything awaiting review
GET    /photos/<id>/thumb           Drive thumbnail proxied with the server token
GET    /drive/folders?parent=       browse (see note above — this is new, distinct from /drive/browse)
POST   /drive/folders               create a folder (new)
GET    /settings                    app-wide wiring (inbox folder, sessions root)
PUT    /settings                    set it
```

Every route sits behind `enforce_auth()` (see the gap above — you must close it) and returns `{'error': <code>, 'detail': <text>}` with the right status on failure. Status codes are fixed:

| Condition | Status | `error` |
| --- | --- | --- |
| Validation failure (`SessionError`) | 400 | `bad_config` |
| Unknown session / run / photo | 404 | `not_found` |
| Start while a run is active (`RunConflict`) | 409 | `already_running` |
| Delete or re-point folders on a session with an active run | 409 | `run_in_progress` |
| Google not connected | 401 | `server_google_not_connected` |
| Drive/Photos upstream failure | 502 | `drive_error` |

Notes on ambiguous cases (use judgment, document your choice):
- "Delete or re-point folders on a session with an active run" (409 `run_in_progress`) — check whether any `runs` row for that `session_id` has `status='running'` before allowing `DELETE /sessions/<id>` or a `PUT /sessions/<id>` that changes `sourceFolderId`/`exportFolderId`. A `PUT` that only changes e.g. `threshold` or `pollSeconds` while a run is active is fine.
- `GET /settings` / `PUT /settings` — wrap `sessions.get_setting`/`sessions.set_setting`. The spec says "app-wide wiring (inbox folder, sessions root)" — represent this as a small JSON object of known keys (e.g. `{'inboxFolderId': ..., 'sessionsRoot': ...}`), reading/writing each key via `get_setting`/`set_setting` individually. Pick reasonable key names consistent with what P01's `app_settings` table already stores (check if anything already calls `set_setting('inbox_folder_id', ...)` anywhere in the existing codebase before inventing a new key name).

### Step 1: Write failing route tests in backend/tests/test_session_routes.py

Use the `_client()` pattern from `backend/tests/test_autonomous_routes.py:11-17` (logs in a fake session user via `session_transaction()`). Monkeypatch `app.pipeline` / `app.preflight` / `app.sessions` (whichever module-level names you import into `app.py`) rather than hitting real Google/Drive — same spirit as how `test_autonomous_routes.py` fakes `google_auth._manager`.

Cover, at minimum:
- Happy path for every route in the table above.
- Every status-code row in the table has at least one test.
- Unauthenticated request (no session user) to each new route returns 401 — this is what proves the `enforce_auth()` gap is actually closed.
- `GET /photos/<id>/thumb` streams bytes through the server token and the response is **not** a 3xx (assert `response.status_code < 300 or response.status_code >= 400`, i.e. explicitly not in the 300-399 range) — there must be a test asserting this exactly, per the phase's definition of done.
- `GET /photos/<id>/thumb` for an unknown photo id returns 404; for a Drive failure returns 502.
- `/autonomous/start|stop|status` still respond (don't 500) and route through `pipeline`, not `session_worker`.

### Step 2: Run and watch them fail

Run `.venv/bin/python -m pytest backend/tests/test_session_routes.py -q` — expect failures (routes don't exist yet).

### Step 3: Implement the routes in app.py

### Step 4: Run the tests, then the full suite

Run `.venv/bin/python -m pytest backend/tests/test_session_routes.py -q` — expect PASS.

Then run the full baseline: `.venv/bin/python -m pytest backend/tests tests -q` — expect ALL PASS, no regressions (baseline is 153 passed before your changes).

### Step 5: Commit

```
git add app.py backend/tests/test_session_routes.py
git commit -m "feat(api): session, run, photo routes with thumb proxy"
```
(conventional commit; keep subject line under 50 chars, add a short body if your repo's commit hook requires one)

## Definition of done
- Every route in the API table above exists behind `enforce_auth()`.
- Every status-code row in the table has a test.
- `GET /photos/<id>/thumb` streams bytes through the server token and never redirects to a googleapis URL — there is a test asserting the response is not a 3xx.

## Your final report MUST include
1. The full pasted output of `.venv/bin/python -m pytest backend/tests tests -q` (the final full-suite run). A summary is not evidence — paste the actual terminal output.
2. Confirmation you touched only the 2 allowlisted files (paste `git diff --name-only bbaf/bigbadphotos-sessions...HEAD`).
3. Exactly how you closed the `enforce_auth()` gap for `/sessions`, `/runs`, and `/settings` — paste the final diff of that function.
4. How you resolved the `/drive/folders` vs `/drive/browse` naming mismatch, and how you shaped `/autonomous/start`'s new request body — both were left to your judgment.
5. Any other deviation from the spec above, and why.
