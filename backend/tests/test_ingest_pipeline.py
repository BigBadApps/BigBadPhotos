import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
os.environ.setdefault('BBP_DEBUG', '1')

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


def _create_session_with_ingest(session_id=1, folder_id='drive_folder_1', active=True):
    conn = db.get()
    conn.execute(
        "INSERT INTO sessions (id, name, source_folder_id, export_folder_id,"
        " ingest_folder_id, ingest_api_key, ingest_active, created_at, updated_at)"
        " VALUES (?, ?, 'src', 'exp', ?, 'testkey123', ?, 't', 't')",
        (session_id, f'Test{session_id}', folder_id, int(active)),
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
    assert call_args[0][0] == 'TOK'
    assert call_args[0][1] == 'drive_folder_1'
    assert call_args[0][2] == 'IMG_001.JPG'


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
