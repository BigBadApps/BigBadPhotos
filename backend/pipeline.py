"""Session-aware photo pipeline: Drive inbox -> score -> edit -> export -> archive.

Replaces the singleton session_worker flow with a DB-backed per-photo state
machine. Each file in the source folder gets a row in the `photos` table whose
`state` column drives the pipeline; the `runs_one_active` partial unique index
enforces a single running run. Per-row commits mean a crash between rows loses
at most one row's progress, and a restart (a fresh Pipeline over the same
run_id) resumes from DB state with no duplicate export.

Drive is the export destination (Google Photos is not involved): keepers are
uploaded to the session's export folder, then the original and a `.bbp.json`
sidecar move into a `_archive` child of the source folder.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any, Callable

import requests

from backend import auto_edit, db, google_drive, scoring, sessions, topaz

STATES = (
    'claimed', 'downloaded', 'scored', 'awaiting_review', 'approved',
    'rejected', 'editing', 'exporting', 'exported', 'archived', 'failed',
)

SIDECAR_SUFFIX = '.bbp.json'
JPEG_EXTS = {'jpg', 'jpeg'}
DEFAULT_STAGING = os.path.join(os.path.expanduser('~'), '.bigbadphotos', 'sessions')
RANK_BATCH = 100
MAX_ATTEMPTS = 3

AUTH_FIX = ('Open http://localhost:8001/google/oauth/start in a browser '
            'on the Mac Mini to reconnect Google.')


class RunConflict(RuntimeError):
    """Raised when start_run is called while another run is already active."""


class RunNotActive(RuntimeError):
    """Raised when a decision targets a run that isn't currently running —
    accepting it would strand the photo in 'approved'/'rejected' with no
    poll loop left to export or archive it."""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def _read_iso(path: str) -> int | None:
    """EXIF ISO via Pillow; None when unavailable."""
    try:
        from PIL import Image
        with Image.open(path) as im:
            exif = im.getexif()
            iso = exif.get(34855)  # ISOSpeedRatings
            return int(iso) if iso else None
    except Exception:
        return None


def _status_code_from(exc: BaseException) -> int | None:
    """Best-effort HTTP status code from an exception the drive layer raised."""
    resp = getattr(exc, 'response', None)
    code = getattr(resp, 'status_code', None) if resp is not None else None
    if code is not None:
        return int(code)
    m = re.search(r'\((\d{3})\)', str(exc))
    return int(m.group(1)) if m else None


# Google OAuth failure phrases that appear in the message-only RuntimeError
# google_drive.upload_file raises (it hides the HTTP status, unlike the other
# drive helpers which raise requests.HTTPError with .response.status_code).
_AUTH_PHRASES = (
    'insufficient authentication',
    'authentication credential',
    'invalid credentials',
    'authentication scopes',
)


def _is_auth_error(exc: BaseException) -> bool:
    if _status_code_from(exc) in (401, 403):
        return True
    msg = str(exc).lower()
    return any(phrase in msg for phrase in _AUTH_PHRASES)


def _is_transient(exc: BaseException) -> bool:
    """True when the step should leave the row alone and retry next poll."""
    code = _status_code_from(exc)
    if code in (401, 403):
        return False
    if code == 429 or (code is not None and 500 <= code < 600):
        return True
    # network-level failures (connection refused, timeout, ...) without a status
    return isinstance(exc, requests.exceptions.RequestException)


class Pipeline:
    """One run of the photo pipeline for a session, backed by the `photos` table."""

    def __init__(self, session: dict, run_id: int,
                 token_provider: Callable[[], str],
                 deps: dict | None = None):
        self.session = dict(session)
        self.run_id = run_id
        self.token_provider = token_provider
        deps = deps or {}
        self._drive = deps.get('drive', google_drive)
        self._scoring = deps.get('scoring', scoring)
        self._auto_edit = deps.get('auto_edit', auto_edit)
        self._topaz = deps.get('topaz', topaz)

        self._stop_evt = threading.Event()
        self._thread: threading.Thread | None = None
        self._auth_error = False
        # Cache the archive folder id: in-memory for this run, and persisted
        # onto the sessions row so a restarted run reuses it instead of
        # re-calling ensure_folder. Fall back to the persisted value when the
        # caller passed a stale session dict (e.g. a restart mid-run).
        self._archive_folder_id = self.session.get('archiveFolderId')
        if not self._archive_folder_id and self.session.get('id'):
            row = db.get().execute(
                'SELECT archive_folder_id FROM sessions WHERE id = ?',
                (self.session['id'],)).fetchone()
            if row and row['archive_folder_id']:
                self._archive_folder_id = row['archive_folder_id']
                self.session['archiveFolderId'] = self._archive_folder_id

        root = os.environ.get('BBP_STAGING_ROOT') or DEFAULT_STAGING
        self._staging = os.path.join(root, str(run_id))

    # -- lifecycle ------------------------------------------------------------

    def start(self) -> None:
        """Run poll_once() in a background loop until stop() is called."""
        if self._thread and self._thread.is_alive():
            raise RuntimeError('pipeline already running')
        self._stop_evt.clear()
        self._thread = threading.Thread(
            target=self._loop, name=f'bbp-pipeline-{self.run_id}', daemon=True)
        self._thread.start()

    def stop(self, wait: bool = True) -> None:
        """Signal the loop to stop. The in-flight poll finishes, then the run
        is marked 'stopped' and the thread exits. wait=True blocks until then."""
        self._stop_evt.set()
        if wait and self._thread and self._thread.is_alive():
            self._thread.join(timeout=30)

    def _loop(self) -> None:
        try:
            while not self._stop_evt.is_set():
                if self._auth_error:
                    break
                try:
                    self.poll_once()
                except Exception as exc:  # never let a bad poll kill the loop
                    self._record_run_error('poll_failed', str(exc))
                if self._stop_evt.is_set():
                    break
                self._set_phase('watching')
                self._stop_evt.wait(self.session.get('pollSeconds', 30))
        finally:
            self._finalize_stop()

    def _finalize_stop(self) -> None:
        conn = db.get()
        row = conn.execute(
            'SELECT status FROM runs WHERE id = ?', (self.run_id,)).fetchone()
        if row and row['status'] == 'running':
            conn.execute(
                'UPDATE runs SET status = ?, ended_at = ? WHERE id = ?',
                ('stopped', _now_iso(), self.run_id))
            conn.commit()
        with _active_lock:
            _active.pop(self.run_id, None)

    # -- per-poll sequence ----------------------------------------------------

    def poll_once(self) -> dict:
        """One pass of the full pipeline sequence; returns a run summary."""
        conn = db.get()
        conn.execute('UPDATE runs SET last_poll_at = ? WHERE id = ?',
                     (_now_iso(), self.run_id))
        conn.commit()
        if self._auth_error:
            return self._status()
        token = self.token_provider()
        try:
            self._claim(token)
            if self._auth_error:
                return self._status()
            self._set_phase('downloading')
            self._download(token)
            if self._auth_error:
                return self._status()
            self._set_phase('scoring')
            self._score()
            if self._auth_error:
                return self._status()
            self._set_phase('gating')
            self._gate()
            if self._auth_error:
                return self._status()
            self._set_phase('editing')
            self._edit()
            if self._auth_error:
                return self._status()
            self._set_phase('exporting')
            self._export(token)
            if self._auth_error:
                return self._status()
            self._set_phase('archiving')
            self._archive(token)
        finally:
            self._set_phase('auth_error' if self._auth_error else 'watching')
        return self._status()

    # -- step 1: claim ---------------------------------------------------------

    def _claim(self, token: str) -> None:
        if self._auth_error:
            return
        try:
            listing = self._drive.list_all(token, self.session['sourceFolderId'])
        except Exception as exc:
            if _is_auth_error(exc):
                self._trigger_auth_error(exc)
            # transient/other listing failure: nothing claimed this poll,
            # existing rows stay put and the next poll retries.
            return
        now = _now_iso()
        conn = db.get()
        for f in listing:
            name = f.get('name', '')
            if name.endswith(SIDECAR_SUFFIX):
                continue
            ext = name.rsplit('.', 1)[-1].lower() if '.' in name else ''
            if ext not in JPEG_EXTS:
                continue
            # UNIQUE(run_id, drive_file_id) makes re-claiming after a restart
            # a no-op; rely on it instead of hand-rolled dedup.
            conn.execute(
                'INSERT OR IGNORE INTO photos'
                ' (run_id, drive_file_id, filename, state, claimed_at, updated_at)'
                ' VALUES (?, ?, ?, ?, ?, ?)',
                (self.run_id, f.get('id'), name, 'claimed', now, now))
        conn.commit()

    # -- step 2: download -------------------------------------------------------

    def _download(self, token: str) -> None:
        if self._auth_error:
            return
        for row in self._select_rows('claimed'):
            if self._auth_error:
                return
            try:
                data, _name, _mime = self._drive.download_file(
                    token, row['drive_file_id'], filename=row['filename'])
                os.makedirs(self._raw_dir, exist_ok=True)
                with open(self._raw_path(row), 'wb') as fh:
                    fh.write(data)
                self._set_photo_state(row['id'], state='downloaded')
            except Exception as exc:
                self._handle_step_exception(row, exc, 'download_failed')

    # -- step 3: score -----------------------------------------------------------

    def _score(self) -> None:
        if self._auth_error:
            return
        rows = self._select_rows('downloaded')
        for start in range(0, len(rows), RANK_BATCH):
            if self._auth_error:
                return
            batch = rows[start:start + RANK_BATCH]
            tasks = []
            for row in batch:
                try:
                    with open(self._raw_path(row), 'rb') as fh:
                        data = fh.read()
                    tasks.append((row['id'], row['filename'], data))
                except Exception as exc:
                    self._fail_row(row, 'score_failed', str(exc))
            if not tasks:
                continue
            try:
                results, errors = self._scoring.rank_images(tasks)
            except Exception as exc:
                for row in batch:
                    self._fail_row(row, 'score_failed', str(exc))
                continue
            by_id = {r['id']: r for r in batch}
            for err in errors:
                row = by_id.get(err.get('id'))
                if row is not None:
                    self._fail_row(row, 'score_failed',
                                   err.get('detail') or 'scoring failed')
            for result in results:
                row = by_id.get(result.get('id'))
                if row is None:
                    continue
                self._set_photo_state(
                    row['id'], state='scored',
                    overall_score=result.get('overall_score'),
                    metrics_json=json.dumps(result))

    # -- step 4: gate -------------------------------------------------------------

    def _gate(self) -> None:
        if self._auth_error:
            return
        threshold = self.session.get('threshold', 0.6)
        burst_best_only = bool(self.session.get('burstBestOnly', True))
        autonomous = bool(self.session.get('autonomous', False))
        for row in self._select_rows('scored'):
            if self._auth_error:
                return
            metrics = self._metrics_of(row)
            score = row['overall_score']
            keeper = (
                isinstance(score, (int, float)) and score >= threshold
                and (not burst_best_only or metrics.get('is_burst_best') is not False)
            )
            if keeper:
                self._set_photo_state(
                    row['id'],
                    state='editing' if autonomous else 'awaiting_review')
            else:
                self._set_photo_state(row['id'], state='rejected')

    # -- step 5: edit ----------------------------------------------------------

    def _edit(self) -> None:
        if self._auth_error:
            return
        mode = self.session.get('editMode', 'off')
        strength = self.session.get('editStrength', 'medium')
        # 'approved' rows (kept via apply_decision) take the same path as
        # autonomous keepers: edit, then export.
        for row in self._select_rows(('editing', 'approved')):
            if self._auth_error:
                return
            raw = self._raw_path(row)
            edit_json = None
            if mode == 'auto':
                try:
                    os.makedirs(self._edited_dir, exist_ok=True)
                    dst = os.path.join(self._edited_dir, row['filename'])
                    info = self._auto_edit.apply(raw, dst, strength)
                    edit_json = {**info}
                    edit_json.setdefault('outputPath', dst)
                except Exception as exc:
                    edit_json = {'status': 'failed', 'detail': str(exc)}
            elif mode == 'topaz':
                try:
                    os.makedirs(self._edited_dir, exist_ok=True)
                    enhancements = self._topaz.route_by_iso(_read_iso(raw))
                    res = self._topaz.process(
                        inputs=[raw], output_dir=self._edited_dir,
                        enhancements=enhancements)
                    if res.ok and getattr(res, 'outputs', None):
                        edit_json = {'status': 'ok',
                                     'outputPath': res.outputs[0],
                                     'enhancements': enhancements}
                    else:
                        edit_json = {'status': 'failed',
                                     'detail': (getattr(res, 'detail', None)
                                                or getattr(res, 'status', 'unknown'))}
                except Exception as exc:
                    edit_json = {'status': 'failed', 'detail': str(exc)}
            # mode 'off' (or an unknown mode): straight to export, no edit file.
            # A failed edit is non-fatal: export falls back to the original.
            self._set_photo_state(
                row['id'], state='exporting',
                edit_json=json.dumps(edit_json) if edit_json else None)

    # -- step 6: export ---------------------------------------------------------

    def _export(self, token: str) -> None:
        if self._auth_error:
            return
        for row in self._select_rows('exporting'):
            if self._auth_error:
                return
            try:
                export_id = self._find_or_upload(
                    token, self.session['exportFolderId'], row['filename'],
                    lambda: self._export_path(row))
                self._set_photo_state(
                    row['id'], state='exported', exported_file_id=export_id)
            except Exception as exc:
                self._handle_step_exception(row, exc, 'export_failed')

    def _find_or_upload(self, token: str, parent_id: str, filename: str,
                        path_fn, mime_type: str | None = None) -> str:
        """Upload `filename` into `parent_id`, but first check whether a file
        by that name already landed there — makes retries after a transient
        failure (Drive created the file, but the response was lost) idempotent
        instead of creating a duplicate on every retry."""
        existing = self._drive.find_child_by_name(token, parent_id, filename)
        if existing:
            return existing['id']
        path = path_fn()
        with open(path, 'rb') as fh:
            data = fh.read()
        created = self._drive.upload_file(token, parent_id, filename, data, mime_type)
        return created.get('id')

    # -- step 7: archive ---------------------------------------------------------

    def _archive(self, token: str) -> None:
        if self._auth_error:
            return
        rows = self._select_rows(('exported', 'rejected'))
        if not rows:
            return
        if not self._archive_folder_id:
            try:
                self._ensure_archive_folder(token)
            except Exception as exc:
                if _is_auth_error(exc):
                    self._trigger_auth_error(exc)
                # transient/other: leave rows as-is, retry next poll
                return
        archive_id = self._archive_folder_id
        for row in rows:
            if self._auth_error:
                return
            try:
                # Both the move and the sidecar upload are checked before
                # acting, so a retry after a transient failure between them
                # (move succeeds, sidecar upload times out) resumes cleanly
                # instead of re-moving an already-archived file or uploading
                # a second sidecar.
                if not self._drive.find_child_by_name(
                        token, archive_id, row['filename']):
                    self._drive.move_file(
                        token, row['drive_file_id'], archive_id,
                        self.session['sourceFolderId'])
                sidecar_name = f"{row['filename']}{SIDECAR_SUFFIX}"
                if not self._drive.find_child_by_name(
                        token, archive_id, sidecar_name):
                    sidecar = self._build_sidecar(row)
                    self._drive.upload_file(
                        token, archive_id, sidecar_name,
                        json.dumps(sidecar).encode('utf-8'), 'application/json')
                self._set_photo_state(row['id'], state='archived')
            except Exception as exc:
                self._handle_step_exception(row, exc, 'archive_failed')

    def _ensure_archive_folder(self, token: str) -> str:
        """Find-or-create `_archive` under the source folder; cache + persist."""
        folder = self._drive.ensure_folder(
            token, self.session['sourceFolderId'], '_archive')
        archive_id = folder.get('id')
        self._archive_folder_id = archive_id
        conn = db.get()
        conn.execute(
            'UPDATE sessions SET archive_folder_id = ?, updated_at = ? WHERE id = ?',
            (archive_id, _now_iso(), self.session['id']))
        conn.commit()
        self.session['archiveFolderId'] = archive_id
        return archive_id

    # -- error handling -----------------------------------------------------------

    def _handle_step_exception(self, row: dict, exc: BaseException,
                               error_code: str) -> None:
        if _is_auth_error(exc):
            self._trigger_auth_error(exc)
            return
        if _is_transient(exc):
            if row['attempts'] >= MAX_ATTEMPTS:
                self._fail_row(row, 'retries_exhausted', str(exc))
            else:
                self._set_photo_state(row['id'], attempts=row['attempts'] + 1)
            return
        self._fail_row(row, error_code, str(exc))

    def _trigger_auth_error(self, exc: BaseException) -> None:
        self._record_run_error('auth', str(exc), fix=AUTH_FIX)
        conn = db.get()
        conn.execute('UPDATE runs SET status = ? WHERE id = ?',
                     ('auth_error', self.run_id))
        conn.commit()
        self._auth_error = True
        self._stop_evt.set()

    def _record_run_error(self, code: str, detail: str,
                          fix: str | None = None) -> None:
        conn = db.get()
        conn.execute(
            'INSERT INTO run_errors (run_id, at, code, detail, fix)'
            ' VALUES (?, ?, ?, ?, ?)',
            (self.run_id, _now_iso(), code, detail, fix))
        conn.commit()

    def _fail_row(self, row: dict, error_code: str, detail: str) -> None:
        self._set_photo_state(
            row['id'], state='failed', error_code=error_code,
            error_detail=detail)

    # -- small helpers ------------------------------------------------------------

    def _set_photo_state(self, photo_id: int, **fields) -> None:
        fields.setdefault('updated_at', _now_iso())
        cols = ', '.join(f'{k} = ?' for k in fields)
        conn = db.get()
        conn.execute(f'UPDATE photos SET {cols} WHERE id = ?',
                     (*fields.values(), photo_id))
        conn.commit()

    def _select_rows(self, state: str | tuple[str, ...]) -> list[dict]:
        conn = db.get()
        if isinstance(state, tuple):
            placeholders = ','.join('?' * len(state))
            rows = conn.execute(
                f'SELECT * FROM photos WHERE run_id = ?'
                f' AND state IN ({placeholders}) ORDER BY id',
                (self.run_id, *state)).fetchall()
        else:
            rows = conn.execute(
                'SELECT * FROM photos WHERE run_id = ? AND state = ? ORDER BY id',
                (self.run_id, state)).fetchall()
        return [dict(r) for r in rows]

    def _metrics_of(self, row: dict) -> dict:
        if not row.get('metrics_json'):
            return {}
        try:
            parsed = json.loads(row['metrics_json'])
            return parsed if isinstance(parsed, dict) else {}
        except ValueError:
            return {}

    def _set_phase(self, phase: str) -> None:
        conn = db.get()
        conn.execute('UPDATE runs SET phase = ? WHERE id = ?',
                     (phase, self.run_id))
        conn.commit()

    @property
    def _raw_dir(self) -> str:
        return os.path.join(self._staging, 'raw')

    @property
    def _edited_dir(self) -> str:
        return os.path.join(self._staging, 'edited')

    def _raw_path(self, row: dict) -> str:
        return os.path.join(self._raw_dir, row['filename'])

    def _export_path(self, row: dict) -> str:
        """The edited file when the edit succeeded, else the original."""
        if row.get('edit_json'):
            edit = self._metrics_of({'metrics_json': row['edit_json']})
            path = edit.get('outputPath') if edit.get('status') == 'ok' else None
            if path and os.path.isfile(path):
                return path
        return self._raw_path(row)

    def _build_sidecar(self, row: dict) -> dict:
        return {
            'schema': 'bigbadphotos.processed.v1',
            'filename': row['filename'],
            'overall_score': row['overall_score'],
            'metrics': self._metrics_of(row),
            'exported': bool(row['exported_file_id']),
            'exported_file_id': row['exported_file_id'],
            'processed_at': _now_iso(),
        }

    def _status(self) -> dict:
        return run_status(self.run_id)


# -- module-level API ---------------------------------------------------------

_active: dict[int, Pipeline] = {}
_active_lock = threading.Lock()


def run_status(run_id: int) -> dict:
    conn = db.get()
    run = conn.execute('SELECT * FROM runs WHERE id = ?', (run_id,)).fetchone()
    if run is None:
        return {'running': False, 'runId': run_id, 'sessionId': None,
                'sessionName': None, 'phase': None,
                'counts': {s: 0 for s in STATES},
                'lastPollAt': None, 'errors': []}
    counts = {s: 0 for s in STATES}
    for row in conn.execute(
            'SELECT state, COUNT(*) AS c FROM photos WHERE run_id = ? GROUP BY state',
            (run_id,)):
        counts[row['state']] = row['c']
    errors = [
        {'at': e['at'], 'code': e['code'], 'detail': e['detail'], 'fix': e['fix']}
        for e in conn.execute(
            'SELECT * FROM run_errors WHERE run_id = ? ORDER BY id DESC LIMIT 20',
            (run_id,))
    ]
    session_name = None
    if run['session_id'] is not None:
        session = sessions.get(run['session_id'])
        if session:
            session_name = session.get('name')
    return {
        'running': run['status'] == 'running',
        'runId': run['id'],
        'sessionId': run['session_id'],
        'sessionName': session_name,
        'phase': run['phase'],
        'counts': counts,
        'lastPollAt': run['last_poll_at'],
        'errors': errors,
    }


def active_status() -> dict:
    """Status of the most recent run (idle shape when there has never been one)."""
    conn = db.get()
    run = conn.execute('SELECT id FROM runs ORDER BY id DESC LIMIT 1').fetchone()
    if run is None:
        return {'running': False, 'runId': None, 'sessionId': None,
                'sessionName': None, 'phase': None,
                'counts': {s: 0 for s in STATES},
                'lastPollAt': None, 'errors': []}
    return run_status(run['id'])


def start_run(session_id: int, token_provider: Callable[[], str]) -> dict:
    """Create a running run row and start its Pipeline. Raises RunConflict if
    another run is already active (the runs_one_active index enforces it)."""
    session = sessions.get(session_id)
    if session is None:
        raise ValueError(f'session not found: {session_id}')
    conn = db.get()
    try:
        cur = conn.execute(
            'INSERT INTO runs (session_id, started_at, status, phase)'
            ' VALUES (?, ?, ?, ?)',
            (session_id, _now_iso(), 'running', 'starting'))
        conn.commit()
    except sqlite3.IntegrityError as exc:
        raise RunConflict(
            'a run is already active; stop it before starting another') from exc
    run_id = cur.lastrowid
    pipe = Pipeline(session, run_id, token_provider)
    with _active_lock:
        _active[run_id] = pipe
    pipe.start()
    return {'runId': run_id, 'sessionId': session_id, 'sessionName': session['name']}


def stop_run() -> bool:
    """Stop the currently active run if any; returns whether it did anything."""
    with _active_lock:
        run_ids = list(_active.keys())
        pipes = [_active.pop(rid) for rid in run_ids]
    if not pipes:
        return False
    for pipe in pipes:
        pipe.stop(wait=False)
    return True


def _run_status(run_id: int) -> str | None:
    row = db.get().execute(
        'SELECT status FROM runs WHERE id = ?', (run_id,)).fetchone()
    return row['status'] if row else None


def apply_decision(photo_id: int, decision: str) -> dict:
    """'keep' -> approved, 'reject' -> rejected. Returns the updated photo row.

    Raises RunNotActive if the photo's run isn't 'running' *at the moment of
    the update*. The run-status check and the state write happen in a single
    atomic UPDATE (not a separate SELECT then UPDATE) — otherwise stop_run()
    could land in the gap between them and strand the photo in
    'approved'/'rejected' with no poll loop left to process it."""
    if decision not in ('keep', 'reject'):
        raise ValueError(f"decision must be 'keep' or 'reject', got {decision!r}")
    conn = db.get()
    row = conn.execute('SELECT * FROM photos WHERE id = ?', (photo_id,)).fetchone()
    if row is None:
        raise KeyError(f'photo not found: {photo_id}')
    new_state = 'approved' if decision == 'keep' else 'rejected'
    cur = conn.execute(
        'UPDATE photos SET state = ?, updated_at = ? WHERE id = ? AND EXISTS ('
        '  SELECT 1 FROM runs WHERE runs.id = photos.run_id AND runs.status = ?'
        ')',
        (new_state, _now_iso(), photo_id, 'running'))
    conn.commit()
    if cur.rowcount == 0:
        raise RunNotActive(
            f"run {row['run_id']} is not active; resume it before deciding")
    updated = conn.execute('SELECT * FROM photos WHERE id = ?', (photo_id,)).fetchone()
    return dict(updated)


def approve_all(run_id: int) -> int:
    """Bulk-approve every awaiting_review photo for the run; returns count moved.

    Raises RunNotActive if the run isn't 'running' — checked atomically as
    part of the same UPDATE as the mutation (see apply_decision's docstring
    for why a separate check-then-act would race with stop_run())."""
    conn = db.get()
    cur = conn.execute(
        'UPDATE photos SET state = ?, updated_at = ?'
        ' WHERE run_id = ? AND state = ? AND EXISTS ('
        '   SELECT 1 FROM runs WHERE runs.id = ? AND runs.status = ?'
        ')',
        ('approved', _now_iso(), run_id, 'awaiting_review', run_id, 'running'))
    conn.commit()
    if cur.rowcount == 0 and _run_status(run_id) != 'running':
        # rowcount can legitimately be 0 because nothing was awaiting_review —
        # only raise once we've confirmed inactivity was the actual cause.
        raise RunNotActive(f'run {run_id} is not active; resume it before approving')
    return cur.rowcount
