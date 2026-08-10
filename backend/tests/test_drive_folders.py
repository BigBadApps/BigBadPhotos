# backend/tests/test_drive_folders.py
"""Tests for the Drive folder helpers: create_folder, find_child_by_name,
ensure_folder, move_file, folder_meta.

`google_drive.requests` is monkeypatched with a fake object whose get/post/
patch methods record the call (url, params, json body) and return canned
FakeResponse objects, so no real network access happens.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

import requests as real_requests

from backend import google_drive


class FakeResponse:
    def __init__(self, json_data=None, status_code=200):
        self.status_code = status_code
        self._json_data = json_data if json_data is not None else {}

    def json(self):
        return self._json_data

    def raise_for_status(self):
        if self.status_code >= 400:
            raise real_requests.exceptions.HTTPError(
                f'{self.status_code} error'
            )


class FakeRequests:
    """Records every get/post/patch call and returns canned responses in order."""

    def __init__(self, responses=None):
        self.calls = []
        self._responses = list(responses) if responses else []
        self._default = FakeResponse({})

    def queue(self, response):
        self._responses.append(response)

    def _record(self, method, url, headers=None, params=None, json=None, **kwargs):
        self.calls.append({
            'method': method,
            'url': url,
            'headers': headers,
            'params': params,
            'json': json,
        })
        if self._responses:
            return self._responses.pop(0)
        return self._default

    def get(self, url, headers=None, params=None, timeout=None, **kwargs):
        return self._record('GET', url, headers=headers, params=params, **kwargs)

    def post(self, url, headers=None, params=None, json=None, timeout=None, **kwargs):
        return self._record('POST', url, headers=headers, params=params, json=json, **kwargs)

    def patch(self, url, headers=None, params=None, json=None, timeout=None, **kwargs):
        return self._record('PATCH', url, headers=headers, params=params, json=json, **kwargs)


def _install_fake(monkeypatch, responses=None):
    fake = FakeRequests(responses)
    monkeypatch.setattr(google_drive, 'requests', fake)
    return fake


def test_create_folder_returns_id_and_name(monkeypatch):
    fake = _install_fake(monkeypatch, [
        FakeResponse({'id': 'F1', 'name': 'New Shoot'}),
    ])
    result = google_drive.create_folder('TOKEN', 'PARENT1', 'New Shoot')
    assert result == {'id': 'F1', 'name': 'New Shoot'}

    call = fake.calls[0]
    assert call['method'] == 'POST'
    assert call['json']['mimeType'] == 'application/vnd.google-apps.folder'
    assert call['json']['parents'] == ['PARENT1']
    assert call['json']['name'] == 'New Shoot'


def test_find_child_by_name_returns_none_when_empty(monkeypatch):
    _install_fake(monkeypatch, [
        FakeResponse({'files': []}),
    ])
    result = google_drive.find_child_by_name('TOKEN', 'PARENT1', 'Nope')
    assert result is None


def test_find_child_by_name_escapes_apostrophe(monkeypatch):
    fake = _install_fake(monkeypatch, [
        FakeResponse({'files': []}),
    ])
    google_drive.find_child_by_name('TOKEN', 'PARENT1', "Bob's Shoot")

    call = fake.calls[0]
    q = call['params']['q']
    assert "Bob\\'s Shoot" in q
    assert "Bob's Shoot" not in q


def test_ensure_folder_returns_existing_without_create(monkeypatch):
    fake = _install_fake(monkeypatch, [
        FakeResponse({'files': [{'id': 'F1', 'name': 'Existing', 'mimeType': google_drive.FOLDER_MIME}]}),
    ])
    result = google_drive.ensure_folder('TOKEN', 'PARENT1', 'Existing')
    assert result == {'id': 'F1', 'name': 'Existing', 'mimeType': google_drive.FOLDER_MIME}

    methods = [c['method'] for c in fake.calls]
    assert 'POST' not in methods


def test_ensure_folder_creates_when_not_found(monkeypatch):
    fake = _install_fake(monkeypatch, [
        FakeResponse({'files': []}),
        FakeResponse({'id': 'F2', 'name': 'Brand New'}),
    ])
    result = google_drive.ensure_folder('TOKEN', 'PARENT1', 'Brand New')
    assert result == {'id': 'F2', 'name': 'Brand New'}

    methods = [c['method'] for c in fake.calls]
    assert methods == ['GET', 'POST']


def test_move_file_with_explicit_old_parent(monkeypatch):
    fake = _install_fake(monkeypatch, [
        FakeResponse({'id': 'FILE1', 'name': 'pic.jpg', 'parents': ['NEW']}),
    ])
    google_drive.move_file('TOKEN', 'FILE1', 'NEW', old_parent_id='OLD')

    assert len(fake.calls) == 1
    call = fake.calls[0]
    assert call['method'] == 'PATCH'
    assert call['params']['addParents'] == 'NEW'
    assert call['params']['removeParents'] == 'OLD'


def test_move_file_without_old_parent_looks_up_current(monkeypatch):
    fake = _install_fake(monkeypatch, [
        FakeResponse({'parents': ['OLD1', 'OLD2']}),
        FakeResponse({'id': 'FILE1', 'name': 'pic.jpg', 'parents': ['NEW']}),
    ])
    google_drive.move_file('TOKEN', 'FILE1', 'NEW')

    assert len(fake.calls) == 2
    get_call, patch_call = fake.calls
    assert get_call['method'] == 'GET'
    assert patch_call['method'] == 'PATCH'
    assert patch_call['params']['addParents'] == 'NEW'
    assert patch_call['params']['removeParents'] == 'OLD1,OLD2'


def test_folder_meta_returns_real_bool(monkeypatch):
    _install_fake(monkeypatch, [
        FakeResponse({
            'id': 'F1',
            'name': 'Shoot',
            'trashed': False,
            'capabilities': {'canAddChildren': True},
        }),
    ])
    result = google_drive.folder_meta('TOKEN', 'F1')
    assert result['canAddChildren'] is True
    assert isinstance(result['canAddChildren'], bool)
    assert result['trashed'] is False
    assert result['id'] == 'F1'
    assert result['name'] == 'Shoot'


def test_files_url_encodes_id_and_blocks_path_injection():
    # A crafted file_id must not be able to inject extra path segments into
    # the Drive API request (e.g. escape /files/<id> into a different path).
    assert google_drive._files_url('abc123') == \
        'https://www.googleapis.com/drive/v3/files/abc123'
    # '/' is percent-encoded so it can't be interpreted as a path separator —
    # the crafted id stays a single opaque path segment, it can't escape it.
    injected = google_drive._files_url('../admin')
    assert '/' not in injected.rsplit('/files/', 1)[1]
    assert injected == 'https://www.googleapis.com/drive/v3/files/..%2Fadmin'
    assert google_drive._files_url('a/b') == \
        'https://www.googleapis.com/drive/v3/files/a%2Fb'
