"""Pipeline state-machine tests — injected fakes, no network, no threads.

Follows the FakeDrive / FakeRanker pattern from test_session_worker.py,
extended with ensure_folder and move_file, and drives Pipeline.poll_once()
directly against a temp SQLite DB.
"""
import json
import os
import shutil
import sys
from datetime import datetime, timezone

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

import cv2

from backend import db, pipeline, sessions


def _now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def _jpeg_bytes(seed=0):
    img = (np.random.default_rng(seed).random((80, 120)) * 255).astype('uint8')
    ok, buf = cv2.imencode('.jpg', img)
    return buf.tobytes()


class _ErrResponse:
    def __init__(self, status_code):
        self.status_code = status_code


class DriveHTTPError(Exception):
    """Minimal stand-in for the drive layer's HTTP failures."""

    def __init__(self, status_code, message='drive error'):
        super().__init__(message)
        self.response = _ErrResponse(status_code)


class FakeDrive:
    """In-memory Drive. files: {name: bytes}; every call is recorded.

    `_parents` tracks which folder each named file (by upload/original
    filename, or `<name>.bbp.json` sidecar name) currently lives in, so
    `find_child_by_name` can answer honestly — this is what makes the
    idempotent-retry behavior in `_export`/`_archive` actually testable.
    """

    def __init__(self, files):
        self.files = dict(files)
        self.uploads = []       # (parent_id, filename, bytes)
        self.moves = []         # (file_id, new_parent_id, old_parent_id)
        self.ensure_calls = []  # (parent_id, name)
        self.find_calls = []    # (parent_id, name)
        self._parents = {}      # name -> current parent_id

    def list_all(self, token, folder_id):
        return [{'id': f'id-{n}', 'name': n, 'mimeType': 'image/jpeg'}
                for n in self.files]

    def download_file(self, token, file_id, filename=None, mime_type=None):
        name = file_id[len('id-'):]
        return self.files[name], name, 'image/jpeg'

    def upload_file(self, token, parent_id, filename, data, mime_type=None):
        self.uploads.append((parent_id, filename, data))
        self._parents[filename] = parent_id
        return {'id': f'id-{filename}'}

    def ensure_folder(self, token, parent_id, name):
        self.ensure_calls.append((parent_id, name))
        return {'id': f'id-{name}', 'name': name}

    def move_file(self, token, file_id, new_parent_id, old_parent_id=None):
        self.moves.append((file_id, new_parent_id, old_parent_id))
        name = file_id[len('id-'):] if file_id.startswith('id-') else file_id
        self._parents[name] = new_parent_id
        return {'id': file_id}

    def find_child_by_name(self, token, parent_id, name, folders_only=False):
        self.find_calls.append((parent_id, name))
        if self._parents.get(name) == parent_id:
            return {'id': f'id-{name}', 'name': name}
        return None


class UploadFailing(FakeDrive):
    """FakeDrive whose upload_file always raises an HTTP-style error."""

    def __init__(self, files, status_code):
        super().__init__(files)
        self.status_code = status_code

    def upload_file(self, token, parent_id, filename, data, mime_type=None):
        raise DriveHTTPError(self.status_code)


class FakeRanker:
    """keep_* scores high, skip_* scores low; is_burst_best from not_best set."""

    def __init__(self, not_best=()):
        self.not_best = set(not_best)

    def rank_images(self, tasks, max_workers=None):
        results = []
        for i, (tid, fname, _b) in enumerate(tasks):
            score = 0.9 if fname.startswith('keep') else 0.2
            results.append({
                'id': tid, 'filename': fname, 'sharpness': score,
                'overall_score': score, 'rank': i + 1,
                'is_burst_best': fname not in self.not_best,
                'burst_group': None, 'burst_size': None,
                'exposure': {'exposure_score': score}, 'noise': {'noise_score': score},
                'contrast': {'contrast_score': score},
                'subject': {'face_count': 0}, 'composition': {'composition_score': score},
            })
        return results, []


class FakeAutoEdit:
    def __init__(self, fail=False):
        self.calls = []
        self.fail = fail

    def apply(self, src_path, dst_path, strength='medium'):
        self.calls.append((src_path, dst_path, strength))
        if self.fail:
            raise RuntimeError('edit boom')
        shutil.copy(src_path, dst_path)
        return {'status': 'ok', 'strength': strength, 'applied': {}, 'outputPath': dst_path}


class _TopazResult:
    def __init__(self, outputs=None, ok=True, status='success', detail=''):
        self.outputs = outputs or []
        self.ok = ok
        self.status = status
        self.detail = detail
        self.exit_code = 0


class FakeTopaz:
    def __init__(self):
        self.calls = []

    def route_by_iso(self, iso):
        return {'noise': True, 'sharpen': True}

    def process(self, inputs, output_dir=None, enhancements=None, **kw):
        self.calls.append((inputs, output_dir, enhancements))
        src = inputs[0]
        out = os.path.join(output_dir, 'edited.jpg')
        shutil.copy(src, out)
        return _TopazResult(outputs=[out])


@pytest.fixture(autouse=True)
def _tmp_db(tmp_path, monkeypatch):
    db.reset_for_tests(str(tmp_path / 'test.db'))
    monkeypatch.setenv('BBP_STAGING_ROOT', str(tmp_path / 'staging'))
    # pipeline._active is module-level state shared across every test in this
    # process; without clearing it, a leaked entry from one test (e.g. a
    # start_run() whose Pipeline is never stopped) can silently satisfy an
    # unrelated later test via an accidental run_id collision (fresh temp DBs
    # all restart autoincrement at 1). Reset it on both sides of every test.
    pipeline._active.clear()
    yield
    pipeline._active.clear()


def _session(**over):
    data = {'name': 'Soccer', 'sourceFolderId': 'src1', 'exportFolderId': 'exp1',
            'autonomous': True, 'threshold': 0.6, 'burstBestOnly': True,
            'editMode': 'off', 'editStrength': 'medium', 'pollSeconds': 1}
    data.update(over)
    return sessions.create(data)


def _run(session_id, status='running'):
    conn = db.get()
    cur = conn.execute(
        "INSERT INTO runs (session_id, started_at, status, phase) VALUES (?, ?, ?, 'idle')",
        (session_id, _now(), status))
    conn.commit()
    return cur.lastrowid


def _deps(drive, ranker=None, editor=None, topaz=None):
    return {
        'drive': drive,
        'scoring': ranker or FakeRanker(),
        'auto_edit': editor or FakeAutoEdit(),
        'topaz': topaz or FakeTopaz(),
    }


def _pipe(session, run_id, drive, **over):
    deps = _deps(drive, **over)
    return pipeline.Pipeline(session, run_id, lambda: 'TOK', deps=deps)


def _rows(run_id):
    return [dict(r) for r in db.get().execute(
        'SELECT * FROM photos WHERE run_id = ? ORDER BY id', (run_id,)).fetchall()]


def _image_exports(drive, export_folder):
    return [u for u in drive.uploads
            if u[0] == export_folder and not u[1].endswith('.bbp.json')]


# -- the fourteen plan scenarios -------------------------------------------------

def test_claim_ignores_sidecars_and_non_jpegs():
    drive = FakeDrive({'keep_1.jpg': _jpeg_bytes(1), 'keep_2.jpg': _jpeg_bytes(2),
                       'keep_1.jpg.bbp.json': b'{}', 'notes.txt': b'x',
                       'clip.mp4': b'y'})
    s = _session()
    run_id = _run(s['id'])
    _pipe(s, run_id, drive).poll_once()
    rows = _rows(run_id)
    assert sorted(r['filename'] for r in rows) == ['keep_1.jpg', 'keep_2.jpg']
    assert {r['drive_file_id'] for r in rows} == {'id-keep_1.jpg', 'id-keep_2.jpg'}


def test_second_poll_claims_nothing_new():
    drive = FakeDrive({'keep_1.jpg': _jpeg_bytes(1), 'skip_1.jpg': _jpeg_bytes(2)})
    s = _session()
    run_id = _run(s['id'])
    pipe = _pipe(s, run_id, drive)
    pipe.poll_once()
    assert len(_rows(run_id)) == 2
    pipe.poll_once()
    assert len(_rows(run_id)) == 2


def test_autonomous_high_score_archives_with_export():
    drive = FakeDrive({'keep_1.jpg': _jpeg_bytes(1)})
    s = _session(autonomous=True)
    run_id = _run(s['id'])
    pipe = _pipe(s, run_id, drive)
    pipe.poll_once()
    row = _rows(run_id)[0]
    assert row['state'] == 'archived'
    assert row['exported_file_id'] is not None
    assert [u[1] for u in _image_exports(drive, 'exp1')] == ['keep_1.jpg']
    # the original was moved into the (once-ensured) archive folder
    assert drive.moves == [('id-keep_1.jpg', 'id-_archive', 'src1')]
    assert drive.ensure_calls == [('src1', '_archive')]
    # ensure_folder is not re-called on later polls
    pipe.poll_once()
    assert drive.ensure_calls == [('src1', '_archive')]


def test_manual_high_score_stops_at_awaiting_review():
    drive = FakeDrive({'keep_1.jpg': _jpeg_bytes(1)})
    s = _session(autonomous=False)
    run_id = _run(s['id'])
    _pipe(s, run_id, drive).poll_once()
    row = _rows(run_id)[0]
    assert row['state'] == 'awaiting_review'
    assert row['exported_file_id'] is None
    assert drive.uploads == []


def test_apply_decision_keep_exports_next_poll():
    drive = FakeDrive({'keep_1.jpg': _jpeg_bytes(1)})
    s = _session(autonomous=False)
    run_id = _run(s['id'])
    pipe = _pipe(s, run_id, drive)
    pipe.poll_once()
    row = _rows(run_id)[0]
    assert row['state'] == 'awaiting_review'
    updated = pipeline.apply_decision(row['id'], 'keep')
    assert updated['state'] == 'approved'
    pipe.poll_once()
    row = _rows(run_id)[0]
    assert row['state'] == 'archived'
    assert row['exported_file_id'] is not None
    assert [u[1] for u in _image_exports(drive, 'exp1')] == ['keep_1.jpg']


def test_apply_decision_reject_archives_without_export():
    drive = FakeDrive({'keep_1.jpg': _jpeg_bytes(1)})
    s = _session(autonomous=False)
    run_id = _run(s['id'])
    pipe = _pipe(s, run_id, drive)
    pipe.poll_once()
    row = _rows(run_id)[0]
    updated = pipeline.apply_decision(row['id'], 'reject')
    assert updated['state'] == 'rejected'
    pipe.poll_once()
    row = _rows(run_id)[0]
    assert row['state'] == 'archived'
    assert row['exported_file_id'] is None
    assert _image_exports(drive, 'exp1') == []
    # the rejected original still gets moved and sidecared
    assert any(m[0] == 'id-keep_1.jpg' for m in drive.moves)
    assert any(u[1] == 'keep_1.jpg.bbp.json' for u in drive.uploads)


def test_low_score_archives_without_export():
    drive = FakeDrive({'skip_1.jpg': _jpeg_bytes(1)})
    s = _session(autonomous=True)
    run_id = _run(s['id'])
    _pipe(s, run_id, drive).poll_once()
    row = _rows(run_id)[0]
    assert row['state'] == 'archived'
    assert row['exported_file_id'] is None
    assert _image_exports(drive, 'exp1') == []
    assert any(u[1] == 'skip_1.jpg.bbp.json' for u in drive.uploads)


def test_burst_best_only_rejects_non_best():
    drive = FakeDrive({'keep_burst_1.jpg': _jpeg_bytes(1)})
    s = _session(autonomous=True, burstBestOnly=True)
    run_id = _run(s['id'])
    _pipe(s, run_id, drive, ranker=FakeRanker(not_best={'keep_burst_1.jpg'})).poll_once()
    row = _rows(run_id)[0]
    assert row['state'] == 'archived'
    assert row['exported_file_id'] is None
    # same photo is a keeper when burstBestOnly is off
    conn = db.get()
    conn.execute('UPDATE runs SET status = ? WHERE id = ?', ('stopped', run_id))
    conn.commit()
    drive2 = FakeDrive({'keep_burst_1.jpg': _jpeg_bytes(1)})
    s2 = _session(name='Soccer2', autonomous=True, burstBestOnly=False)
    run2 = _run(s2['id'])
    _pipe(s2, run2, drive2, ranker=FakeRanker(not_best={'keep_burst_1.jpg'})).poll_once()
    row2 = _rows(run2)[0]
    assert row2['state'] == 'archived'
    assert row2['exported_file_id'] is not None


def test_auto_edit_called_once_per_keeper():
    drive = FakeDrive({'keep_1.jpg': _jpeg_bytes(1), 'skip_1.jpg': _jpeg_bytes(2)})
    editor = FakeAutoEdit()
    s = _session(autonomous=True, editMode='auto')
    run_id = _run(s['id'])
    _pipe(s, run_id, drive, editor=editor).poll_once()
    assert len(editor.calls) == 1
    assert editor.calls[0][2] == 'medium'
    keep_row = [r for r in _rows(run_id) if r['filename'] == 'keep_1.jpg'][0]
    assert keep_row['state'] == 'archived'
    assert keep_row['exported_file_id'] is not None


def test_auto_edit_exception_exports_original():
    drive = FakeDrive({'keep_1.jpg': _jpeg_bytes(1)})
    editor = FakeAutoEdit(fail=True)
    s = _session(autonomous=True, editMode='auto')
    run_id = _run(s['id'])
    _pipe(s, run_id, drive, editor=editor).poll_once()
    row = _rows(run_id)[0]
    assert row['state'] == 'archived'
    assert row['exported_file_id'] is not None
    assert json.loads(row['edit_json'])['status'] == 'failed'
    assert [u[1] for u in _image_exports(drive, 'exp1')] == ['keep_1.jpg']


def test_upload_500_retries_then_fails():
    drive = UploadFailing({'keep_1.jpg': _jpeg_bytes(1)}, 500)
    s = _session(autonomous=True)
    run_id = _run(s['id'])
    pipe = _pipe(s, run_id, drive)
    pipe.poll_once()
    row = _rows(run_id)[0]
    assert row['state'] == 'exporting'
    assert row['attempts'] == 1
    pipe.poll_once()
    row = _rows(run_id)[0]
    assert row['state'] == 'exporting'
    assert row['attempts'] == 2
    pipe.poll_once()
    row = _rows(run_id)[0]
    assert row['state'] == 'exporting'
    assert row['attempts'] == 3
    # fourth poll: three failed attempts recorded, give up on this row
    pipe.poll_once()
    row = _rows(run_id)[0]
    assert row['state'] == 'failed'
    assert row['error_code'] == 'retries_exhausted'


def test_upload_401_message_only_runtime_error_still_stops():
    # google_drive.upload_file surfaces a 401 as a message-only RuntimeError
    # (no .response and no '(401)' in the text) — the auth phrases must catch it.
    class UploadAuthMessage(FakeDrive):
        def upload_file(self, token, parent_id, filename, data, mime_type=None):
            raise RuntimeError('Request is missing required authentication credential.'
                               ' Expected OAuth 2 access token, login cookie or other'
                               ' authentication credentials.')

    drive = UploadAuthMessage({'keep_1.jpg': _jpeg_bytes(1)})
    s = _session(autonomous=True)
    run_id = _run(s['id'])
    _pipe(s, run_id, drive).poll_once()
    run = dict(db.get().execute('SELECT * FROM runs WHERE id = ?', (run_id,)).fetchone())
    assert run['status'] == 'auth_error'
    assert drive.uploads == []


def test_upload_401_sets_auth_error_and_stops_loop():
    drive = UploadFailing({'keep_1.jpg': _jpeg_bytes(1), 'keep_2.jpg': _jpeg_bytes(2)}, 401)
    s = _session(autonomous=True)
    run_id = _run(s['id'])
    pipe = _pipe(s, run_id, drive)
    pipe.poll_once()
    run = dict(db.get().execute('SELECT * FROM runs WHERE id = ?', (run_id,)).fetchone())
    assert run['status'] == 'auth_error'
    errs = db.get().execute(
        'SELECT * FROM run_errors WHERE run_id = ?', (run_id,)).fetchall()
    assert [e['code'] for e in errs] == ['auth']
    assert errs[0]['fix'] == pipeline.AUTH_FIX
    # the second photo never got exported and nothing moves on later polls
    rows = _rows(run_id)
    assert [r['state'] for r in rows] == ['exporting', 'exporting']
    uploads_before = list(drive.uploads)
    pipe.poll_once()
    assert drive.uploads == uploads_before
    assert [r['state'] for r in _rows(run_id)] == ['exporting', 'exporting']


def test_restart_resumes_without_duplicate_export():
    drive = FakeDrive({'keep_1.jpg': _jpeg_bytes(1)})
    s = _session(autonomous=True)
    run_id = _run(s['id'])
    pipe1 = _pipe(s, run_id, drive)
    pipe1.poll_once()
    assert [u[1] for u in _image_exports(drive, 'exp1')] == ['keep_1.jpg']

    # a new photo lands in the inbox, then the run "restarts": a fresh Pipeline
    # is constructed over the SAME run_id.
    drive.files['keep_2.jpg'] = _jpeg_bytes(2)
    pipe2 = _pipe(s, run_id, drive)
    pipe2.poll_once()

    exports = _image_exports(drive, 'exp1')
    assert [u[1] for u in exports] == ['keep_1.jpg', 'keep_2.jpg']
    # keep_1 was NOT re-exported, and the archived rows were not re-moved
    assert [u[1] for u in exports].count('keep_1.jpg') == 1
    assert [u[1] for u in exports].count('keep_2.jpg') == 1
    assert [m[0] for m in drive.moves].count('id-keep_1.jpg') == 1
    # no duplicate claims and the archive folder was not re-ensured
    assert len(_rows(run_id)) == 2
    assert all(r['state'] == 'archived' for r in _rows(run_id))
    assert drive.ensure_calls == [('src1', '_archive')]


def test_start_run_twice_raises_run_conflict(monkeypatch):
    s = _session()

    class FakePipeline:
        def __init__(self, *a, **k):
            pass

        def start(self):
            pass

        def stop(self, wait=True):
            pass

    monkeypatch.setattr(pipeline, 'Pipeline', FakePipeline)
    first = pipeline.start_run(s['id'], lambda: 'TOK')
    assert first['runId'] > 0
    with pytest.raises(pipeline.RunConflict):
        pipeline.start_run(s['id'], lambda: 'TOK')
    # a different session is also blocked while one run is active
    s2 = _session(name='Other')
    with pytest.raises(pipeline.RunConflict):
        pipeline.start_run(s2['id'], lambda: 'TOK')


# -- a few more interface behaviors worth pinning ---------------------------------

def test_approve_all_bulk_moves_awaiting_review():
    drive = FakeDrive({'keep_1.jpg': _jpeg_bytes(1), 'keep_2.jpg': _jpeg_bytes(2),
                       'skip_1.jpg': _jpeg_bytes(3)})
    s = _session(autonomous=False)
    run_id = _run(s['id'])
    _pipe(s, run_id, drive).poll_once()
    awaiting = [r for r in _rows(run_id) if r['state'] == 'awaiting_review']
    assert len(awaiting) == 2
    assert pipeline.approve_all(run_id) == 2
    assert all(r['state'] == 'approved' for r in _rows(run_id)
               if r['filename'] in ('keep_1.jpg', 'keep_2.jpg'))


def test_active_status_shape_and_counts():
    drive = FakeDrive({'keep_1.jpg': _jpeg_bytes(1), 'skip_1.jpg': _jpeg_bytes(2)})
    s = _session(autonomous=False)
    run_id = _run(s['id'])
    _pipe(s, run_id, drive).poll_once()
    st = pipeline.active_status()
    assert st['running'] is True
    assert st['runId'] == run_id
    assert st['sessionId'] == s['id']
    assert st['sessionName'] == 'Soccer'
    assert st['counts']['awaiting_review'] == 1
    # the low scorer was rejected and (same poll) archived
    assert st['counts']['archived'] == 1
    assert st['counts']['rejected'] == 0
    assert st['phase'] == 'watching'
    assert st['lastPollAt'] is not None
    assert st['errors'] == []
    assert set(st['counts']) == set(pipeline.STATES)


def test_topaz_edits_before_export():
    drive = FakeDrive({'keep_1.jpg': _jpeg_bytes(1)})
    topaz = FakeTopaz()
    s = _session(autonomous=True, editMode='topaz')
    run_id = _run(s['id'])
    _pipe(s, run_id, drive, topaz=topaz).poll_once()
    assert len(topaz.calls) == 1
    row = _rows(run_id)[0]
    assert row['state'] == 'archived'
    assert row['exported_file_id'] is not None
    assert json.loads(row['edit_json'])['status'] == 'ok'


def test_start_and_stop_marks_run_stopped():
    s = _session()
    run_id = _run(s['id'])
    pipe = _pipe(s, run_id, FakeDrive({'keep_1.jpg': _jpeg_bytes(1)}))
    pipe.start()
    pipe.stop(wait=True)
    run = dict(db.get().execute('SELECT * FROM runs WHERE id = ?', (run_id,)).fetchone())
    assert run['status'] == 'stopped'
    assert run['ended_at'] is not None


def test_stop_run_returns_false_when_nothing_running(monkeypatch):
    class FakePipeline:
        def __init__(self, *a, **k):
            pass

        def start(self):
            pass

        def stop(self, wait=True):
            pass

    monkeypatch.setattr(pipeline, 'Pipeline', FakePipeline)
    assert pipeline.stop_run() is False
    s = _session()
    pipeline.start_run(s['id'], lambda: 'TOK')
    assert pipeline.stop_run() is True
    assert pipeline.stop_run() is False


# -- review fixes: idempotent Drive retries, decisions blocked on inactive runs --

class FlakyExportDrive(FakeDrive):
    """The first upload_file call raises a transient (500) error, but only
    after Drive has already "created" the file — simulating a lost response,
    not a lost request. A second call would prove the idempotency check
    failed (it should discover the file via find_child_by_name instead)."""

    def __init__(self, files):
        super().__init__(files)
        self.upload_attempts = 0

    def upload_file(self, token, parent_id, filename, data, mime_type=None):
        if filename.endswith('.bbp.json'):
            # The archive step's sidecar upload is a separate, unrelated
            # call — only the original export upload is flaky here.
            return super().upload_file(token, parent_id, filename, data, mime_type)
        self.upload_attempts += 1
        if self.upload_attempts == 1:
            self._parents[filename] = parent_id
            raise DriveHTTPError(500)
        raise AssertionError(
            'upload_file must not be called again once the file already '
            'exists at the destination — find_child_by_name should have '
            'found it on retry')


def test_export_retry_after_lost_response_does_not_duplicate():
    drive = FlakyExportDrive({'keep_1.jpg': _jpeg_bytes(1)})
    s = _session(autonomous=True)
    run_id = _run(s['id'])
    pipe = _pipe(s, run_id, drive)
    pipe.poll_once()  # upload "succeeds" server-side but raises 500 client-side
    row = _rows(run_id)[0]
    assert row['state'] == 'exporting'
    assert row['attempts'] == 1
    pipe.poll_once()  # retry: found via find_child_by_name, no second upload
    row = _rows(run_id)[0]
    assert row['state'] == 'archived'
    assert row['exported_file_id'] == 'id-keep_1.jpg'
    assert drive.upload_attempts == 1


class FlakyArchiveDrive(FakeDrive):
    """move_file always succeeds; the sidecar upload fails transiently once.
    A correct retry must not re-move the (already-moved) original and must
    not leave the row stuck without ever completing the sidecar."""

    def __init__(self, files):
        super().__init__(files)
        self.move_calls = 0
        self.sidecar_upload_attempts = 0

    def move_file(self, token, file_id, new_parent_id, old_parent_id=None):
        self.move_calls += 1
        return super().move_file(token, file_id, new_parent_id, old_parent_id)

    def upload_file(self, token, parent_id, filename, data, mime_type=None):
        if filename.endswith('.bbp.json'):
            self.sidecar_upload_attempts += 1
            if self.sidecar_upload_attempts == 1:
                raise DriveHTTPError(500)
        return super().upload_file(token, parent_id, filename, data, mime_type)


def test_archive_retry_after_sidecar_failure_does_not_remove_or_reupload():
    # A low scorer skips edit/export and goes straight from gate to archive
    # within the same poll — isolates the archive step cleanly.
    drive = FlakyArchiveDrive({'skip_1.jpg': _jpeg_bytes(1)})
    s = _session(autonomous=True)
    run_id = _run(s['id'])
    pipe = _pipe(s, run_id, drive)
    pipe.poll_once()  # move succeeds; sidecar upload raises 500
    row = _rows(run_id)[0]
    assert row['state'] == 'rejected'
    assert row['attempts'] == 1
    assert drive.move_calls == 1
    pipe.poll_once()  # retry: move_file NOT repeated; sidecar retried and succeeds
    row = _rows(run_id)[0]
    assert row['state'] == 'archived'
    assert drive.move_calls == 1
    assert drive.sidecar_upload_attempts == 2


def test_apply_decision_raises_when_run_not_active():
    drive = FakeDrive({'keep_1.jpg': _jpeg_bytes(1)})
    s = _session(autonomous=False)
    run_id = _run(s['id'])
    _pipe(s, run_id, drive).poll_once()
    row = _rows(run_id)[0]
    assert row['state'] == 'awaiting_review'
    conn = db.get()
    conn.execute('UPDATE runs SET status = ? WHERE id = ?', ('stopped', run_id))
    conn.commit()
    with pytest.raises(pipeline.RunNotActive):
        pipeline.apply_decision(row['id'], 'keep')
    # must not have been silently approved-and-stranded
    assert _rows(run_id)[0]['state'] == 'awaiting_review'


def test_approve_all_raises_when_run_not_active():
    drive = FakeDrive({'keep_1.jpg': _jpeg_bytes(1)})
    s = _session(autonomous=False)
    run_id = _run(s['id'])
    _pipe(s, run_id, drive).poll_once()
    conn = db.get()
    conn.execute('UPDATE runs SET status = ? WHERE id = ?', ('stopped', run_id))
    conn.commit()
    with pytest.raises(pipeline.RunNotActive):
        pipeline.approve_all(run_id)
    assert _rows(run_id)[0]['state'] == 'awaiting_review'
