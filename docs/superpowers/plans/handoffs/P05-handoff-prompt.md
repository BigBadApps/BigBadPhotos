Repo: BigBadPhotos (Flask/Python backend). You're implementing Phase P05 ("Pipeline state machine") of a larger plan adding "photo sessions" to this app. This is the largest and highest-risk phase in the plan — route it to your strongest available coding agent, and budget real time for it.

Plan doc: docs/superpowers/plans/2026-08-10-photo-sessions.md → Task 5 (P5)
Phase brief: docs/superpowers/plans/phases/P05.md
Spec: docs/superpowers/specs/2026-08-10-photo-sessions-design.md

FIRST: create and check out branch `bbaf/bbp-sessions-P05` from `bbaf/bigbadphotos-sessions` (this branch already has Task 0 + P01 + P02 + P03 merged — 108 passing tests as baseline; P04 may or may not be merged yet depending on timing, check `git log --oneline -10` and don't worry either way, your allowlist doesn't overlap it). Do not touch backend/tests/conftest.py or tests/conftest.py.

Interpreter is `.venv/bin/python` (3.14.6) at repo root — use it for every command, not `python3`/`python`. No new runtime dependencies.

## File allowlist — ONLY create/modify these
- backend/pipeline.py (create)
- backend/tests/test_pipeline.py (create)

Do not touch anything else. In particular not app.py, backend/session_worker.py, backend/scoring.py, backend/topaz.py, backend/google_auth.py, backend/google_drive.py, backend/db.py, backend/sessions.py, backend/auto_edit.py, requirements.txt, CLAUDE.md, AGENTS.md, Procfile, nixpacks.toml, railpack.toml, .env, .github/. If you believe a file outside the allowlist must change, stop and say so instead of changing it. `backend/session_worker.py` is explicitly READ FOR REFERENCE ONLY — do not modify it.

## Background — interfaces you consume (already merged/existing, read them before writing code)

### backend/db.py (merged, P01)
- `db.get() -> sqlite3.Connection` — thread-local, auto-migrated.
- Relevant tables (see `backend/db.py` for full DDL):
  - `sessions(id, name, source_folder_id, source_folder_name, export_folder_id, export_folder_name, archive_folder_id, autonomous, preset, threshold, burst_best_only, edit_mode, edit_strength, poll_seconds, created_at, updated_at)`
  - `runs(id, session_id, started_at, ended_at, status, last_poll_at, phase)` — unique index `runs_one_active` enforces only one row with `status='running'` at a time (a second concurrent INSERT with status='running' raises `sqlite3.IntegrityError`).
  - `photos(id, run_id, drive_file_id, filename, state, overall_score, metrics_json, edit_json, exported_file_id, error_code, error_detail, attempts, claimed_at, updated_at)` — `UNIQUE(run_id, drive_file_id)` makes re-claiming after restart a no-op via `INSERT OR IGNORE`.
  - `run_errors(id, run_id, at, code, detail, fix)`

### backend/sessions.py (merged, P01)
- `sessions.get(session_id: int) -> dict | None` — camelCase dict: `id, name, sourceFolderId, sourceFolderName, exportFolderId, exportFolderName, archiveFolderId, autonomous (bool), preset, threshold (float), burstBestOnly (bool), editMode ('off'|'auto'|'topaz'), editStrength ('light'|'medium'), pollSeconds, createdAt, updatedAt`.

### backend/google_drive.py (merged, P02 — signatures exact, already implemented)
- `list_all(access_token: str, folder_id: str) -> list[dict]` — returns dicts `{'id','name','mimeType','size','modifiedTime'}` for every non-folder file (images AND `.bbp.json` sidecars) in the folder.
- `download_file(access_token: str, file_id: str, *, filename: str | None = None, mime_type: str | None = None) -> tuple[bytes, str, str]` — returns `(content_bytes, name, mime)`.
- `upload_file(access_token: str, parent_id: str, filename: str, data: bytes, mime_type: str | None = None) -> dict` — returns the Drive API's created-file JSON (has `'id'`). Raises `RuntimeError` on non-2xx (this one function uses `RuntimeError`, not the module's other exception type — confirmed from source).
- `ensure_folder(access_token: str, parent_id: str, name: str) -> dict` → `{'id','name'}`.
- `move_file(access_token: str, file_id: str, new_parent_id: str, old_parent_id: str | None = None) -> dict`.

### backend/scoring.py (existing, untouched)
- `rank_images(tasks: list[tuple[str, str, bytes]], max_workers: int | None = None) -> tuple[list[dict], list[dict]]` — `tasks` is `(id, filename, jpeg_bytes)` tuples; returns `(results, ranking_errors)`. Each result dict includes at least: `id, filename, overall_score (float), rank, sharpness, exposure, noise, contrast, subject, composition, burst_group (int|None), burst_size (int|None), is_burst_best (bool)`. `is_burst_best` is `True` for unique (non-burst) photos and for the highest-scoring photo in a burst group, `False` for the rest of that burst.

### backend/auto_edit.py (merged, P03)
- `apply(src_path: str, dst_path: str, strength: str = 'medium') -> dict` → `{'status':'ok','strength','applied','outputPath'}`. Raises `AutoEditError` on failure (missing/corrupt source, bad strength).

### backend/topaz.py (existing, untouched)
- `process(inputs: list[str], output_dir: str | None = None, *, enhancements: dict | None = None, ..., binary: str | None = None, timeout_s: float = 600.0) -> TopazResult` — `TopazResult` has `.ok (bool)`, `.status`, `.exit_code`, `.detail`, `.outputs (list[str])`. Raises `TopazError` for config problems (e.g. missing binary); subprocess failures come back as a `TopazResult` with `ok=False`, not an exception.
- `route_by_iso(iso: int | None) -> dict[str, bool]` — returns an `enhancements` dict suitable for `process(...)`.

### backend/session_worker.py (existing — READ ONLY, reference for working logic to carry across)
- `_read_iso(path: str) -> int | None` — EXIF ISO via Pillow, `None` on any failure. Copy this pattern (or an equivalent) into `pipeline.py`; do not import it from `session_worker` (keep the new module decoupled from the old one you're about to make obsolete in P09).
- `poll_once()`, `build_sidecar()` in this file are the *prior* (Photos-album-based) implementation of this same idea — useful for understanding the working claim/download/score/gate/edit flow, but you are replacing its in-memory `_processed` set and Photos-publish step with DB state (`photos` table) and Drive export (`upload_file` + `move_file` to `_archive`). Do not copy `build_sidecar`'s Photos-specific fields; your sidecar is described in the archive step below.
- `backend/tests/test_session_worker.py` lines ~1-50 have a `FakeDrive`/`FakeRanker` pattern you should reuse and extend (add `ensure_folder` and `move_file` to your fake) for `test_pipeline.py`'s fakes.

## Task

### Interfaces to produce (exact names/signatures)

- `STATES = ('claimed', 'downloaded', 'scored', 'awaiting_review', 'approved', 'rejected', 'editing', 'exporting', 'exported', 'archived', 'failed')`
- `class Pipeline:`
  - `__init__(self, session: dict, run_id: int, token_provider, deps: dict | None = None)`
  - `poll_once(self) -> dict` — runs one pass of the full per-poll sequence below and returns a summary dict of what happened.
  - `start(self) -> None` — runs `poll_once()` in a background loop on `session['pollSeconds']` interval until `stop()` is called.
  - `stop(self, wait: bool = True) -> None` — see stop semantics below.
- `start_run(session_id: int, token_provider) -> dict` — creates a new `runs` row with `status='running'`, constructs and starts a `Pipeline`, returns something describing the run (at least `runId`). Raises `RunConflict` if a run is already active (rely on the `runs_one_active` unique index / catch the resulting `sqlite3.IntegrityError` and re-raise as `RunConflict`).
- `stop_run() -> bool` — stops the currently active run if any; returns whether it did anything.
- `active_status() -> dict` → `{'running': bool, 'runId', 'sessionId', 'sessionName', 'phase', 'counts': {state: int}, 'lastPollAt', 'errors': [{'at','code','detail','fix'}]}`.
- `apply_decision(photo_id: int, decision: str) -> dict` — `decision='keep'` → row state becomes `approved`; `decision='reject'` → row state becomes `rejected`. Returns the updated photo row (as a dict).
- `approve_all(run_id: int) -> int` — bulk-approves every `awaiting_review` row for that run; returns the count moved.
- `class RunConflict(RuntimeError):`
- `deps` dict keys: `drive`, `scoring`, `auto_edit`, `topaz` — each defaults to the real module (`backend.google_drive`, `backend.scoring`, `backend.auto_edit`, `backend.topaz`) when not supplied via the constructor.

### Per-poll sequence (fixed order, one method per step)

1. **`_claim()`** — `drive.list_all(token, session['sourceFolderId'])`; skip names ending `.bbp.json`; skip extensions outside `{jpg, jpeg}` (case-insensitive); `INSERT OR IGNORE INTO photos (...)` a row per new `drive_file_id`, state `claimed`. The `UNIQUE(run_id, drive_file_id)` index makes re-claiming after a restart a no-op — rely on it, don't hand-roll dedup.
2. **`_download()`** — for every `claimed` row: download to `<staging>/<run_id>/raw/<filename>` (create dirs as needed), then state → `downloaded`. Failure → state `failed`, `error_code='download_failed'`, `error_detail=str(exc)`.
3. **`_score()`** — batch `downloaded` rows in groups of up to 100 through `scoring.rank_images(tasks)` where each task is `(photo_id_as_str_or_int, filename, jpeg_bytes_read_from_disk)`; write `overall_score` and `metrics_json` (JSON-serialize the full result dict — sharpness/exposure/noise/contrast/subject/composition/burst_group/burst_size/is_burst_best — so `_gate()` and the archive sidecar can read it back), state → `scored`. Scoring errors for a row → `failed`, `error_code='score_failed'`.
4. **`_gate()`** — for every `scored` row: it's a **keeper** when `overall_score >= session['threshold']` AND (`not session['burstBestOnly']` OR `metrics['is_burst_best'] is not False`) (i.e. `is_burst_best` missing/None/True all count as eligible — only an explicit `False` disqualifies). Keeper + `session['autonomous']` → `editing`. Keeper + not autonomous → `awaiting_review`. Not a keeper → `rejected`.
5. **`_edit()`** — for every `editing` row: `session['editMode']`:
   - `'off'` → straight to `exporting` (no-op edit).
   - `'auto'` → `auto_edit.apply(raw_path, edited_path, session['editStrength'])`.
   - `'topaz'` → `topaz.process(inputs=[raw_path], output_dir=edited_dir, enhancements=topaz.route_by_iso(_read_iso(raw_path)))`.
   **Edit failure is non-fatal**: catch it, record `edit_json = {'status': 'failed', 'detail': str(exc)}` on the row, and continue to `exporting` using the *original* (unedited) file. A successful edit records `edit_json = {'status': 'ok', ...}` (whatever the underlying call returned) and `exporting` uses the edited file.
6. **`_export()`** — for every `exporting` row: `upload_file(token, session['exportFolderId'], filename, file_bytes)` (edited file if one exists and succeeded, else original); store `exported_file_id` from the response; state → `exported`.
7. **`_archive()`** — for every `exported` row AND every `rejected` row (rejected rows skip edit/export and go straight here): `ensure_folder(token, session_root_or_source_parent, '_archive')` once per run, cache the resulting `archive_folder_id` back onto the `sessions` row (or in-memory on the `Pipeline` instance — your call, but don't re-call `ensure_folder` every poll once you have it); `move_file` the original out of `session['sourceFolderId']` into the archive folder; write a `.bbp.json` sidecar file into the archive folder via `upload_file` (JSON body — include at minimum `filename`, `overall_score`, `metrics`, `exported` bool, `exported_file_id` if any, `processed_at`); state → `archived`.

### Cross-cutting rules

- Each `_step` method selects rows by state and commits per-row (not batched at the end), so a crash between rows loses at most one row's progress.
- **Transient failures** (`requests.exceptions.RequestException`, HTTP 429, HTTP 5xx) during any network-touching step: increment that row's `attempts`, leave its state unchanged, let it retry on the next poll, up to 3 attempts total, then state → `failed`, `error_code='retries_exhausted'`.
- **HTTP 401/403** during any network-touching step: write a `run_errors` row with `code='auth'` and the `google_auth` fix string (`'Open http://localhost:8001/google/oauth/start in a browser on the Mac Mini to reconnect Google.'` — same string P04's preflight uses), set `runs.status='auth_error'`, and **stop the loop entirely** — do not keep burning through the inbox against a dead token.
- **Any other exception** for a given row: that row alone goes `failed` (with `error_detail=str(exc)`); the run continues processing other rows.
- **`stop(wait=True)`**: sets a stop event/flag; the in-flight row (or in-flight `poll_once()` call) finishes; then `runs.status='stopped'` and `ended_at` is set; then the background loop exits. `wait=True` blocks the caller until the loop thread has actually exited; `wait=False` signals and returns immediately.
- A **second `Pipeline` constructed over the same `run_id`** (simulating a restart) must resume cleanly with **no duplicate export** — rows already `exported`/`archived` stay put; rows mid-flight pick back up at their current state. This is the point of the `UNIQUE(run_id, drive_file_id)` claim dedup and per-row state persistence — don't add any additional in-memory dedup set that wouldn't survive a restart.

### Step 1: Write the failing state-machine tests in backend/tests/test_pipeline.py

Reuse the `FakeDrive` pattern from `backend/tests/test_session_worker.py` (lines ~22-34), extended with `ensure_folder` and `move_file` methods. Write one test per scenario, at minimum:

1. A fresh poll claims every JPEG and ignores `.bbp.json` and non-JPEG files.
2. A second poll claims nothing new (idempotent).
3. Autonomous ON: a high-scoring photo ends `archived` with a non-null `exported_file_id`, and the export landed in `export_folder_id` (assert against the fake's recorded uploads).
4. Autonomous OFF: a high-scoring photo stops at `awaiting_review` and nothing is exported.
5. `apply_decision(photo_id, 'keep')` moves it to `approved`, and the next poll exports it.
6. `apply_decision(photo_id, 'reject')` archives it without exporting.
7. A low-scoring photo ends `archived` with `exported_file_id is None`.
8. `burstBestOnly` rejects a photo whose `is_burst_best` is `False`.
9. `editMode='auto'` calls `auto_edit.apply` exactly once per keeper (assert call count on the fake).
10. An `auto_edit` exception still exports the original and records `edit_json['status'] == 'failed'`.
11. A 500 from `upload_file` bumps `attempts` and leaves the state at `exporting`; a fourth poll (after 3 failed attempts) marks it `failed` with `error_code='retries_exhausted'`.
12. A 401 from `upload_file` sets `runs.status='auth_error'` and stops the loop (assert no further rows get processed after that poll).
13. A simulated restart — build a second `Pipeline` over the same `run_id` — resumes without a duplicate export (assert the fake's upload call count / uploaded file list doesn't grow for already-exported rows).
14. `start_run` called twice (same or different session, both trying to be `running` concurrently) raises `RunConflict`.

Use `db.reset_for_tests(...)` (from `backend/db.py`, same pattern as `backend/tests/test_sessions.py`) in an autouse fixture so each test gets a clean temp SQLite file.

Run `.venv/bin/python -m pytest backend/tests/test_pipeline.py -q` — expect FAIL (`No module named 'backend.pipeline'`).

### Step 2: Implement backend/pipeline.py

### Step 3: Run the tests

Run `.venv/bin/python -m pytest backend/tests/test_pipeline.py -q` — expect PASS (all 14 scenarios, possibly more test functions than 14 if you split any into multiple assertions-per-concern).

Then run the full baseline: `.venv/bin/python -m pytest backend/tests tests -q` — expect ALL PASS, no regressions (baseline is 108 passed before your changes, possibly higher if P04 has already merged — check the count before you start and diff against that).

### Step 4: Commit

```
git add backend/pipeline.py backend/tests/test_pipeline.py
git commit -m "feat(pipeline): session-aware photo state machine"
```
(conventional commit; keep subject line under 50 chars, add a short body if your repo's commit hook requires one — mention Drive export + DB-backed state vs. session_worker's in-memory/Photos approach)

## Definition of done
- All fourteen scenarios listed in Step 1 have a test and pass.
- `backend/session_worker.py` was read for reference and left completely untouched (it gets removed in a later phase, P09 — not your job).
- Restart-resume is proven by a test that builds a second `Pipeline` over the same `run_id` and asserts no duplicate export.
- A 401 sets `runs.status = "auth_error"` and stops the loop; a 500 retries three times then fails that one row.

## Your final report MUST include
1. The full pasted output of `.venv/bin/python -m pytest backend/tests tests -q` (the final full-suite run). A summary is not evidence — paste the actual terminal output.
2. Confirmation you touched only the 2 allowlisted files (paste `git diff --name-only bbaf/bigbadphotos-sessions...HEAD`), and confirm `backend/session_worker.py` shows zero diff.
3. Walk through, in your own words, exactly how the restart-resume test proves no duplicate export — this is the part most likely to have a subtle bug.
4. Any deviation from the spec above, and why — in particular flag anywhere you had to make a judgment call the plan didn't fully pin down (e.g. exact staging directory layout, exact sidecar JSON shape, how `_archive_folder_id` gets cached across polls).
