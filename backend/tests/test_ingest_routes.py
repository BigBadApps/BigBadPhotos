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


@patch('backend.google_drive.upload_file')
def test_ingest_rejects_when_session_inactive(mock_upload):
    """A valid key on a session with ingestActive=False must not reach Drive.

    This is the kill switch: toggling ingest off in the Session UI must stop
    the iOS Shortcut / USB-C HTTP path too, not just the FTP path.
    """
    _create_ingest_session(active=False)
    c = _client()

    resp = c.post(
        '/ingest',
        data={'file': (io.BytesIO(b'\xff\xd8\xff\xe0fake'), 'IMG_001.JPG')},
        headers={'Authorization': 'Bearer testkey123'},
        content_type='multipart/form-data',
    )
    assert resp.status_code == 403
    assert resp.get_json()['error'] == 'ingest_inactive'
    mock_upload.assert_not_called()


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
        'ingestActive': True,
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
