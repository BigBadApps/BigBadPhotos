Repo: BigBadPhotos (Flask/Python backend). You're implementing Phase P04 ("Preflight checks") of a larger plan adding "photo sessions" to this app.

Plan doc: docs/superpowers/plans/2026-08-10-photo-sessions.md → Task 4 (P4)
Phase brief: docs/superpowers/plans/phases/P04.md
Spec: docs/superpowers/specs/2026-08-10-photo-sessions-design.md

FIRST: create and check out branch `bbaf/bbp-sessions-P04` from `bbaf/bigbadphotos-sessions` (this branch already has Task 0 + P01 + P02 + P03 merged — 108 passing tests as baseline). Do not touch backend/tests/conftest.py or tests/conftest.py.

Interpreter is `.venv/bin/python` (3.14.6) at repo root — use it for every command, not `python3`/`python`. No new runtime dependencies.

## File allowlist — ONLY create/modify these
- backend/preflight.py (create)
- backend/tests/test_preflight.py (create)

Do not touch anything else. In particular not app.py, backend/session_worker.py, backend/scoring.py, backend/topaz.py, backend/google_auth.py, backend/google_drive.py, backend/db.py, backend/sessions.py, requirements.txt, CLAUDE.md, AGENTS.md, Procfile, nixpacks.toml, railpack.toml, .env, .github/. If you believe a file outside the allowlist must change, stop and say so instead of changing it.

## Background — interfaces you consume (already merged, read them before writing code)

- `backend/sessions.py` — `sessions.get(session_id) -> dict | None`. Session dicts have camelCase keys including `editMode` (one of `'off'|'auto'|'topaz'`), `sourceFolderId`, `exportFolderId`, `archiveFolderId`.
- `backend/google_drive.py` — `folder_meta(access_token: str, folder_id: str) -> dict` returns `{'id', 'name', 'canAddChildren': bool, 'trashed': bool}`. Raises on non-2xx (read the top of the file for the exact exception type it uses — same convention as every other function in that module, `resp.raise_for_status()`).
- `backend/google_auth.py` — `get_manager() -> GoogleAuthManager`. `GoogleAuthManager.available() -> bool` (true if a refresh token + client id/secret are configured). `GoogleAuthManager.get_access_token() -> str`, raises `GoogleAuthError` if not connected or refresh fails.
- `backend/topaz.py` — `resolve_binary(explicit: str | None = None) -> str` raises `TopazError` if the binary is missing or not executable. `EXIT_MEANINGS[254] = ("invalid_login", "Invalid log token — open Topaz Photo AI and sign in (license check).")`. There is no cheap "am I logged in" probe in this module — the only way to observe exit 254 is to actually invoke Topaz via `process(...)`. Design `run()`'s default `topaz` dep sensibly given this constraint (e.g. resolve_binary() catches "missing" cheaply; for "signed in", either accept that this check may need to invoke Topaz on a trivial/throwaway input, or document why you chose a lighter probe — use your judgment, note the tradeoff in your final report). Tests must fully control this via the injected `deps['topaz']` regardless of what the real default does.

## Task — TDD, in this exact order

### Interfaces to produce (exact names/signatures)

- `run(session: dict, token_provider: Callable[[], str], deps: dict | None = None) -> list[dict]`
- Each entry: `{'check': str, 'ok': bool, 'detail': str, 'fix': str}`
- Check ids, in this exact order: `google_auth`, `source_folder`, `export_folder`, `archive_folder`, `topaz`, `imaging_libs`, `disk_space`, `database`
- `deps` keys: `drive`, `topaz`, `auth` — each defaulting to the real modules (`backend.google_drive`, `backend.topaz`, `backend.google_auth`) when not supplied.

### Rules

- `topaz` check is **skipped entirely** (omitted from the returned list) unless `session['editMode'] == 'topaz'`.
- `topaz` check distinguishes "binary not found" from "exit 254 / not signed in" and gives different fix text (table below). Never attempt to bypass the license check.
- Every failing check (`ok=False`) has non-empty `fix` text. Write a test that loops all checks and asserts this.
- `run()` never raises. An unexpected exception inside any single check becomes `ok=False` for that check, with the exception text in `detail`, and does not stop the other checks from running. Write a test that injects a dependency that raises/explodes and confirms `run()` still returns a full list without raising.
- `disk_space` checks the volume holding `~/.bigbadphotos` for more than 5 GB free via `shutil.disk_usage`.
- `database` check should exercise `backend.db` (e.g. attempt `db.migrate(db.connect())` or equivalent) to confirm the SQLite file is reachable/writable.

### Fix strings — copy verbatim, exact text

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

### Step 1: Write backend/tests/test_preflight.py

One test per check, both directions (pass and fail), plus:
- a test that every failing check across all checks has non-empty `fix` text
- a test that `topaz` is omitted from the result list entirely when `session['editMode'] != 'topaz'`
- a test that `run()` never raises even when an injected dep explodes (e.g. a fake `drive.folder_meta` that raises an arbitrary exception) — assert the corresponding check comes back `ok=False` with the exception text in `detail`, and the rest of the list is still fully populated.

Inject fakes via the `deps` dict — do not monkeypatch the real modules for these tests; that's what `deps` is for.

Run `.venv/bin/python -m pytest backend/tests/test_preflight.py -q` — expect FAIL (`No module named 'backend.preflight'`).

### Step 2: Implement backend/preflight.py

### Step 3: Run the tests

Run `.venv/bin/python -m pytest backend/tests/test_preflight.py -q` — expect PASS.

Then run the full baseline: `.venv/bin/python -m pytest backend/tests tests -q` — expect ALL PASS (baseline is 108 passed before your changes).

### Step 4: Commit

```
git add backend/preflight.py backend/tests/test_preflight.py
git commit -m "feat(preflight): pre-run checks with named fixes"
```
(conventional commit; keep subject line under 50 chars, add a short body if your repo's commit hook requires one)

## Definition of done
- All eight checks implemented, in the plan's exact order, with fix strings copied verbatim from the table above.
- The `topaz` check is omitted entirely unless `editMode == "topaz"`, and distinguishes "binary missing" from "exit 254 / not signed in".
- `run()` never raises — covered by a test that injects an exploding dependency.

## Your final report MUST include
1. The full pasted output of `.venv/bin/python -m pytest backend/tests tests -q` (the final full-suite run). A summary is not evidence — paste the actual terminal output.
2. Confirmation you touched only the 2 allowlisted files (paste `git diff --name-only bbaf/bigbadphotos-sessions...HEAD`).
3. How you wired the real (non-test) `topaz` dep for the "signed in" probe, and why — this wasn't fully specified and required a judgment call.
4. Any other deviation from the spec above, and why.
