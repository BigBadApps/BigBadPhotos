"""Route tests for the photo-session API surface (P6).

Sessions/run/photo/settings routes exercise the real `sessions` and `pipeline`
modules against a temp SQLite DB (via `db.reset_for_tests`), while anything
that would touch real Google/Drive (preflight checks, start_run, thumbnails,
folder browsing) is monkeypatched — same spirit as how test_autonomous_routes.py
fakes `google_auth._manager`.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
os.environ.setdefault('BBP_DEBUG', '1')

import pytest

import app as appmod
from backend import db, google_auth


class FakeMgr:
    def __init__(self, ok=True):
        self.ok = ok

    def available(self):
        return self.ok

    def get_access_token(self):
        return 'TOK'


@pytest.fixture(autouse=True)
def _tmp_db(tmp_path):
    db.reset_for_tests(str(tmp_path / 'test.db'))
    yield


@pytest.fixture(autouse=True)
def _fake_google_manager(monkeypatch):
    monkeypatch.setattr(google_auth, '_manager', FakeMgr(ok=True))


def _client():
    appmod.app.config['TESTING'] = True
    c = appmod.app.test_client()
    with c.session_transaction() as s:
        s['user'] = {'email': 'dev@local'}
    return c


def _create_session(c, **over):
    data = {'name': 'Soccer', 'sourceFolderId': 'src', 'exportFolderId': 'exp'}
    data.update(over)
    r = c.post('/sessions', json=data)
    assert r.status_code == 200, r.get_json()
    return r.get_json()['session']['id']


def _insert_run(session_id, status='running'):
    conn = db.get()
    cur = conn.execute(
        "INSERT INTO runs (session_id, started_at, status) VALUES (?, 't', ?)",
        (session_id, status))
    conn.commit()
    return cur.lastrowid


def _insert_photo(run_id, drive_file_id='d1', filename='a.jpg', state='awaiting_review'):
    conn = db.get()
    cur = conn.execute(
        'INSERT INTO photos (run_id, drive_file_id, filename, state, claimed_at, updated_at)'
        ' VALUES (?, ?, ?, ?, ?, ?)',
        (run_id, drive_file_id, filename, state, 't', 't'))
    conn.commit()
    return dict(conn.execute('SELECT * FROM photos WHERE id = ?',
                             (cur.lastrowid,)).fetchone())


# -- unauthenticated requests must be rejected (proves enforce_auth gap is closed) --

_ROUTE_SPECS = [
    ('GET', '/sessions'),
    ('POST', '/sessions'),
    ('GET', '/sessions/1'),
    ('PUT', '/sessions/1'),
    ('DELETE', '/sessions/1'),
    ('POST', '/sessions/1/preflight'),
    ('POST', '/sessions/1/start'),
    ('POST', '/runs/active/stop'),
    ('GET', '/runs/active'),
    ('GET', '/runs/1/photos'),
    ('POST', '/runs/1/approve-all'),
    ('POST', '/photos/1/decision'),
    ('GET', '/photos/1/thumb'),
    ('GET', '/drive/folders'),
    ('POST', '/drive/folders'),
    ('GET', '/settings'),
    ('PUT', '/settings'),
]


@pytest.mark.parametrize('method,path', _ROUTE_SPECS)
def test_route_requires_auth(monkeypatch, method, path):
    # IS_DEBUG auto-creates a dev session, which would mask a broken gate.
    # HAS_AUTH was already pinned True at import time, so flipping IS_DEBUG
    # makes enforce_auth reach its real "not authenticated" branch.
    monkeypatch.setattr(appmod, 'IS_DEBUG', False)
    c = appmod.app.test_client()
    r = c.open(path, method=method)
    assert r.status_code == 401
    assert r.get_json()['error'] == 'not_authenticated'


# -- sessions CRUD -------------------------------------------------------------

def test_sessions_list_is_empty_by_default():
    c = _client()
    r = c.get('/sessions')
    assert r.status_code == 200
    assert r.get_json()['sessions'] == []


def test_session_create_get_update_delete_roundtrip():
    c = _client()
    r = c.post('/sessions', json={
        'name': 'Soccer', 'sourceFolderId': 'src', 'exportFolderId': 'exp'})
    assert r.status_code == 200
    sid = r.get_json()['session']['id']
    assert r.get_json()['session']['preset'] == 'balanced'
    assert r.get_json()['session']['autonomous'] is False

    r = c.get(f'/sessions/{sid}')
    assert r.status_code == 200
    assert r.get_json()['session']['name'] == 'Soccer'

    r = c.put(f'/sessions/{sid}', json={'threshold': 0.8, 'autonomous': True})
    assert r.status_code == 200
    assert r.get_json()['session']['threshold'] == pytest.approx(0.8)
    assert r.get_json()['session']['autonomous'] is True
    assert r.get_json()['session']['preset'] == 'custom'

    r = c.delete(f'/sessions/{sid}')
    assert r.status_code == 200
    r = c.get(f'/sessions/{sid}')
    assert r.status_code == 404


def test_create_rejects_invalid_config_with_400_bad_config():
    c = _client()
    r = c.post('/sessions', json={'name': '', 'sourceFolderId': 'src', 'exportFolderId': 'exp'})
    assert r.status_code == 400
    assert r.get_json()['error'] == 'bad_config'


def test_unknown_session_returns_404():
    c = _client()
    r = c.get('/sessions/999')
    assert r.status_code == 404
    assert r.get_json()['error'] == 'not_found'


def test_delete_session_with_active_run_409():
    c = _client()
    sid = _create_session(c)
    _insert_run(sid, status='running')
    r = c.delete(f'/sessions/{sid}')
    assert r.status_code == 409
    assert r.get_json()['error'] == 'run_in_progress'
    assert c.get(f'/sessions/{sid}').status_code == 200  # still there


def test_put_repointing_folder_with_active_run_409():
    c = _client()
    sid = _create_session(c)
    _insert_run(sid, status='running')
    r = c.put(f'/sessions/{sid}', json={'sourceFolderId': 'other'})
    assert r.status_code == 409
    assert r.get_json()['error'] == 'run_in_progress'
    r = c.put(f'/sessions/{sid}', json={'exportFolderId': 'other'})
    assert r.status_code == 409


def test_put_non_folder_fields_with_active_run_allowed():
    c = _client()
    sid = _create_session(c)
    _insert_run(sid, status='running')
    r = c.put(f'/sessions/{sid}', json={'threshold': 0.9, 'pollSeconds': 60})
    assert r.status_code == 200
    assert r.get_json()['session']['threshold'] == pytest.approx(0.9)


def test_put_unknown_session_404():
    c = _client()
    r = c.put('/sessions/999', json={'threshold': 0.5})
    assert r.status_code == 404


def test_delete_unknown_session_404():
    c = _client()
    r = c.delete('/sessions/999')
    assert r.status_code == 404


# -- preflight -----------------------------------------------------------------

def test_preflight_returns_checks(monkeypatch):
    c = _client()
    sid = _create_session(c)
    checks = [{'check': 'google_auth', 'ok': True, 'detail': 'connected', 'fix': ''}]
    monkeypatch.setattr(appmod.preflight, 'run', lambda session, tp: checks)
    r = c.post(f'/sessions/{sid}/preflight')
    assert r.status_code == 200
    assert r.get_json()['checks'] == checks


def test_preflight_unknown_session_404():
    c = _client()
    r = c.post('/sessions/999/preflight')
    assert r.status_code == 404
    assert r.get_json()['error'] == 'not_found'


# -- start a run ---------------------------------------------------------------

def test_start_run_happy_path(monkeypatch):
    c = _client()
    sid = _create_session(c)
    calls = []

    def fake_start(session_id, tp):
        calls.append((session_id, tp))
        return {'runId': 1, 'sessionId': session_id, 'sessionName': 'Soccer'}

    monkeypatch.setattr(appmod.pipeline, 'start_run', fake_start)
    r = c.post(f'/sessions/{sid}/start')
    assert r.status_code == 200
    assert r.get_json()['runId'] == 1
    assert calls == [(sid, appmod._google_token)]


def test_start_run_conflict_409(monkeypatch):
    c = _client()
    sid = _create_session(c)

    def boom(session_id, tp):
        raise appmod.pipeline.RunConflict('a run is already active')

    monkeypatch.setattr(appmod.pipeline, 'start_run', boom)
    r = c.post(f'/sessions/{sid}/start')
    assert r.status_code == 409
    assert r.get_json()['error'] == 'already_running'


def test_start_run_requires_server_google(monkeypatch):
    monkeypatch.setattr(google_auth, '_manager', FakeMgr(ok=False))
    c = _client()
    sid = _create_session(c)
    r = c.post(f'/sessions/{sid}/start')
    assert r.status_code == 401
    assert r.get_json()['error'] == 'server_google_not_connected'


def test_start_run_unknown_session_404():
    c = _client()
    r = c.post('/sessions/999/start')
    assert r.status_code == 404
    assert r.get_json()['error'] == 'not_found'


# -- runs ----------------------------------------------------------------------

def test_runs_active_idle_shape():
    c = _client()
    r = c.get('/runs/active')
    assert r.status_code == 200
    body = r.get_json()
    assert body['running'] is False
    assert 'counts' in body
    assert 'errors' in body


def test_runs_active_stop_route():
    c = _client()
    r = c.post('/runs/active/stop')
    assert r.status_code == 200
    assert 'stopped' in r.get_json()


def test_runs_photos_lists_and_filters():
    c = _client()
    run_id = _insert_run(_create_session(c))
    _insert_photo(run_id, drive_file_id='d1', filename='a.jpg', state='awaiting_review')
    _insert_photo(run_id, drive_file_id='d2', filename='b.jpg', state='failed')
    c2 = _client()

    r = c2.get(f'/runs/{run_id}/photos')
    assert r.status_code == 200
    assert len(r.get_json()['photos']) == 2

    r = c2.get(f'/runs/{run_id}/photos?state=awaiting_review')
    photos = r.get_json()['photos']
    assert len(photos) == 1
    assert photos[0]['filename'] == 'a.jpg'
    assert photos[0]['state'] == 'awaiting_review'

    r = c2.get(f'/runs/{run_id}/photos?state=awaiting_review&limit=1&offset=1')
    assert r.get_json()['photos'] == []


def test_runs_photos_unknown_run_404():
    c = _client()
    r = c.get('/runs/999/photos')
    assert r.status_code == 404
    assert r.get_json()['error'] == 'not_found'


def test_approve_all_route(monkeypatch):
    c = _client()
    run_id = _insert_run(_create_session(c))
    monkeypatch.setattr(appmod.pipeline, 'approve_all', lambda rid: 3)
    r = c.post(f'/runs/{run_id}/approve-all')
    assert r.status_code == 200
    assert r.get_json()['count'] == 3


def test_approve_all_unknown_run_404():
    c = _client()
    r = c.post('/runs/999/approve-all')
    assert r.status_code == 404
    assert r.get_json()['error'] == 'not_found'


# -- photo decisions -----------------------------------------------------------

def test_decision_keep_via_real_pipeline():
    c = _client()
    run_id = _insert_run(_create_session(c))
    row = _insert_photo(run_id)
    r = c.post(f"/photos/{row['id']}/decision", json={'decision': 'keep'})
    assert r.status_code == 200
    assert r.get_json()['photo']['state'] == 'approved'


def test_decision_reject_via_real_pipeline():
    c = _client()
    run_id = _insert_run(_create_session(c))
    row = _insert_photo(run_id)
    r = c.post(f"/photos/{row['id']}/decision", json={'decision': 'reject'})
    assert r.status_code == 200
    assert r.get_json()['photo']['state'] == 'rejected'


def test_decision_invalid_400_bad_config():
    c = _client()
    run_id = _insert_run(_create_session(c))
    row = _insert_photo(run_id)
    r = c.post(f"/photos/{row['id']}/decision", json={'decision': 'maybe'})
    assert r.status_code == 400
    assert r.get_json()['error'] == 'bad_config'


def test_decision_unknown_photo_404():
    c = _client()
    r = c.post('/photos/999/decision', json={'decision': 'keep'})
    assert r.status_code == 404
    assert r.get_json()['error'] == 'not_found'


# -- thumbnail proxy -----------------------------------------------------------

def test_thumb_streams_bytes_through_server_token_and_never_redirects(monkeypatch):
    c = _client()
    run_id = _insert_run(_create_session(c))
    row = _insert_photo(run_id)
    calls = []

    def fake_stream(token, file_id, **kw):
        calls.append((token, file_id, kw))
        return (chunk for chunk in [b'fake-image-bytes']), 'a.jpg', 'image/jpeg'

    monkeypatch.setattr(appmod.google_drive, 'stream_file', fake_stream)
    r = c.get(f"/photos/{row['id']}/thumb")
    # definition of done: it streams, never a 3xx
    assert not (300 <= r.status_code < 400)
    assert r.status_code == 200
    assert r.get_data() == b'fake-image-bytes'
    assert r.headers.get('Cache-Control') == 'private, max-age=3600'
    assert calls and calls[0][0] == 'TOK' and calls[0][1] == row['drive_file_id']


def test_thumb_unknown_photo_404():
    c = _client()
    r = c.get('/photos/999/thumb')
    assert r.status_code == 404
    assert r.get_json()['error'] == 'not_found'


def test_thumb_drive_failure_502(monkeypatch):
    c = _client()
    run_id = _insert_run(_create_session(c))
    row = _insert_photo(run_id)

    def boom(token, file_id, **kw):
        raise RuntimeError('drive exploded')

    monkeypatch.setattr(appmod.google_drive, 'stream_file', boom)
    r = c.get(f"/photos/{row['id']}/thumb")
    assert r.status_code == 502
    assert r.get_json()['error'] == 'drive_error'


# -- drive folders -------------------------------------------------------------

def test_drive_folders_browse(monkeypatch):
    c = _client()
    calls = []

    def fake_list(token, parent):
        calls.append((token, parent))
        return [{'id': 'f1', 'name': 'Inbox'}]

    monkeypatch.setattr(appmod.google_drive, 'list_folders', fake_list)
    r = c.get('/drive/folders?parent=root')
    assert r.status_code == 200
    assert r.get_json()['items'] == [{'id': 'f1', 'name': 'Inbox'}]
    assert calls == [('TOK', 'root')]


def test_drive_folders_browse_upstream_failure_502(monkeypatch):
    c = _client()

    def boom(token, parent):
        raise RuntimeError('drive exploded')

    monkeypatch.setattr(appmod.google_drive, 'list_folders', boom)
    r = c.get('/drive/folders?parent=root')
    assert r.status_code == 502
    assert r.get_json()['error'] == 'drive_error'


def test_drive_folders_create(monkeypatch):
    c = _client()
    calls = []

    def fake_create(token, parent_id, name):
        calls.append((token, parent_id, name))
        return {'id': 'f2', 'name': 'NewFolder'}

    monkeypatch.setattr(appmod.google_drive, 'create_folder', fake_create)
    r = c.post('/drive/folders', json={'parentId': 'f1', 'name': 'NewFolder'})
    assert r.status_code == 200
    assert r.get_json()['folder'] == {'id': 'f2', 'name': 'NewFolder'}
    assert calls == [('TOK', 'f1', 'NewFolder')]


def test_drive_folders_create_requires_parent_and_name():
    c = _client()
    r = c.post('/drive/folders', json={'parentId': 'f1'})
    assert r.status_code == 400
    assert r.get_json()['error'] == 'bad_config'


# -- settings ------------------------------------------------------------------

def test_settings_get_roundtrips_known_keys():
    c = _client()
    r = c.get('/settings')
    assert r.status_code == 200
    body = r.get_json()
    assert set(body) == {'inboxFolderId', 'inboxFolderName', 'sessionsRoot'}
    assert all(v is None for v in body.values())

    r = c.put('/settings', json={'inboxFolderId': 'inbox-1', 'sessionsRoot': 'root-2'})
    assert r.status_code == 200
    body = r.get_json()
    assert body['inboxFolderId'] == 'inbox-1'
    assert body['sessionsRoot'] == 'root-2'
    assert body['inboxFolderName'] is None

    r = c.get('/settings')
    assert r.get_json()['inboxFolderId'] == 'inbox-1'
    assert r.get_json()['sessionsRoot'] == 'root-2'


def test_settings_put_ignores_unknown_keys():
    c = _client()
    r = c.put('/settings', json={'notAKnownKey': 'x'})
    assert r.status_code == 200
    assert r.get_json() == {'inboxFolderId': None, 'inboxFolderName': None,
                            'sessionsRoot': None}


# -- /autonomous/* aliases route through the pipeline ---------------------------

def test_autonomous_start_uses_pipeline_when_session_id_given(monkeypatch):
    c = _client()
    sid = _create_session(c)
    calls = []

    def fake_start(session_id, tp):
        calls.append((session_id, tp))
        return {'runId': 5, 'sessionId': session_id, 'sessionName': 'Soccer'}

    monkeypatch.setattr(appmod.pipeline, 'start_run', fake_start)
    r = c.post('/autonomous/start', json={'sessionId': sid})
    assert r.status_code == 200
    assert r.get_json()['runId'] == 5
    assert calls == [(sid, appmod._google_token)]


def test_autonomous_start_without_session_id_400():
    c = _client()
    r = c.post('/autonomous/start', json={'albumId': 'a'})
    assert r.status_code == 400


def test_autonomous_stop_uses_pipeline(monkeypatch):
    c = _client()
    monkeypatch.setattr(appmod.pipeline, 'stop_run', lambda: True)
    r = c.post('/autonomous/stop')
    assert r.status_code == 200
    assert r.get_json()['stopped'] is True


def test_autonomous_status_uses_pipeline(monkeypatch):
    c = _client()
    monkeypatch.setattr(
        appmod.pipeline, 'active_status',
        lambda: {'running': False, 'runId': None, 'counts': {}, 'errors': []})
    r = c.get('/autonomous/status')
    assert r.status_code == 200
    assert r.get_json()['running'] is False
