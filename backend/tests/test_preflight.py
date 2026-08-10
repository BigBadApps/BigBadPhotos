"""Tests for backend.preflight — one test per check, both directions."""
import os
import sys
import types

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from backend import db, preflight

GB = 1024 ** 3

FIX = {
    'google_auth': 'Open http://localhost:8001/google/oauth/start in a browser on the Mac Mini to reconnect Google.',
    'source_folder': 'Pick a different source folder, or confirm the inbox folder id in Settings.',
    'export_folder': 'Pick a different export folder, or create a new one from the session form.',
    'archive_folder': 'The _archive folder will be created on start; check that the sessions root folder is writable.',
    'topaz_254': 'Open Topaz Photo AI on the Mac Mini and sign in, then re-run preflight.',
    'topaz_missing': "Set TOPAZ_BINARY, or switch this session's edit mode to Auto or Off.",
    'imaging_libs': 'Reinstall dependencies: .venv/bin/python -m pip install -r requirements.txt',
    'disk_space': 'Free space on the volume holding ~/.bigbadphotos, or set BBP_STAGING_ROOT to a larger volume.',
    'database': 'Run: .venv/bin/python -c "from backend import db; db.migrate(db.connect())"',
}

OFF_ORDER = [
    'google_auth', 'source_folder', 'export_folder', 'archive_folder',
    'imaging_libs', 'disk_space', 'database',
]
TOPAZ_ORDER = OFF_ORDER[:4] + ['topaz'] + OFF_ORDER[4:]


@pytest.fixture(autouse=True)
def _fresh_db(tmp_path):
    db.reset_for_tests(str(tmp_path / 'preflight.db'))
    yield
    db.reset_for_tests(None)


# --- fakes -----------------------------------------------------------------

class FakeManager:
    def __init__(self, available=True, token='tok', raise_on_token=False):
        self._available = available
        self._token = token
        self._raise_on_token = raise_on_token

    def available(self):
        return self._available

    def get_access_token(self):
        if self._raise_on_token:
            raise RuntimeError('token refresh failed: invalid_grant')
        return self._token


class FakeAuth:
    def __init__(self, **kwargs):
        self.manager = FakeManager(**kwargs)

    def get_manager(self):
        return self.manager


class FakeDrive:
    def __init__(self, metas=None, exploding=()):
        self.metas = dict(metas or {})
        self.exploding = set(exploding)

    def folder_meta(self, token, folder_id):
        if folder_id in self.exploding:
            raise RuntimeError(f'drive exploded for {folder_id}')
        try:
            return self.metas[folder_id]
        except KeyError:
            raise RuntimeError(f'folder not found: {folder_id}')


class FakeTopaz:
    def __init__(self, process_result=None, raise_resolve=None, raise_process=None):
        self.process_result = process_result
        self.raise_resolve = raise_resolve
        self.raise_process = raise_process

    def resolve_binary(self):
        if self.raise_resolve:
            raise self.raise_resolve
        return '/fake/topaz'

    def process(self, *args, **kwargs):
        if self.raise_process:
            raise self.raise_process
        return self.process_result


def _topaz_result(exit_code, detail='ok'):
    return types.SimpleNamespace(
        exit_code=exit_code, detail=detail, ok=exit_code in (0, 1),
    )


def _folder(folder_id, name, can_add=True, trashed=False):
    return {'id': folder_id, 'name': name, 'canAddChildren': can_add, 'trashed': trashed}


# --- helpers ---------------------------------------------------------------

def _session(**over):
    s = {
        'id': 1,
        'name': 'Test Session',
        'sourceFolderId': 'src-1',
        'exportFolderId': 'exp-1',
        'archiveFolderId': None,
        'editMode': 'off',
    }
    s.update(over)
    return s


def _good_deps():
    return {
        'auth': FakeAuth(),
        'drive': FakeDrive(metas={
            'src-1': _folder('src-1', 'Inbox'),
            'exp-1': _folder('exp-1', 'Export'),
        }),
        'topaz': FakeTopaz(process_result=_topaz_result(0)),
    }


def _run(session, token_provider=None, deps=None):
    return preflight.run(
        session, token_provider or (lambda: 'tok'), deps or _good_deps(),
    )


def _by_id(results, check_id):
    for r in results:
        if r['check'] == check_id:
            return r
    raise AssertionError(f'no check named {check_id!r} in {[r["check"] for r in results]}')


# --- google_auth -----------------------------------------------------------

def test_google_auth_pass():
    results = _run(_session())
    assert _by_id(results, 'google_auth')['ok'] is True


def test_google_auth_fails_when_not_available():
    results = _run(_session(), deps={'auth': FakeAuth(available=False)})
    entry = _by_id(results, 'google_auth')
    assert entry['ok'] is False
    assert entry['fix'] == FIX['google_auth']


def test_google_auth_fails_when_token_refresh_fails():
    results = _run(_session(), deps={'auth': FakeAuth(raise_on_token=True)})
    entry = _by_id(results, 'google_auth')
    assert entry['ok'] is False
    assert entry['fix'] == FIX['google_auth']


# --- folder checks ---------------------------------------------------------

def test_source_folder_pass():
    results = _run(_session())
    assert _by_id(results, 'source_folder')['ok'] is True


def test_source_folder_fails_when_folder_missing():
    results = _run(_session(), deps={'drive': FakeDrive(metas={})})
    entry = _by_id(results, 'source_folder')
    assert entry['ok'] is False
    assert entry['fix'] == FIX['source_folder']
    assert 'src-1' in entry['detail']


def test_export_folder_pass():
    results = _run(_session())
    assert _by_id(results, 'export_folder')['ok'] is True


def test_export_folder_fails_when_not_writable():
    results = _run(_session(), deps={'drive': FakeDrive(metas={
        'src-1': _folder('src-1', 'Inbox'),
        'exp-1': _folder('exp-1', 'Export', can_add=False),
    })})
    entry = _by_id(results, 'export_folder')
    assert entry['ok'] is False
    assert entry['fix'] == FIX['export_folder']


def test_export_folder_fails_when_trashed():
    results = _run(_session(), deps={'drive': FakeDrive(metas={
        'src-1': _folder('src-1', 'Inbox'),
        'exp-1': _folder('exp-1', 'Export', trashed=True),
    })})
    entry = _by_id(results, 'export_folder')
    assert entry['ok'] is False
    assert entry['fix'] == FIX['export_folder']


def test_archive_folder_passes_when_not_created_yet():
    results = _run(_session(archiveFolderId=None))
    entry = _by_id(results, 'archive_folder')
    assert entry['ok'] is True


def test_archive_folder_passes_when_writable():
    results = _run(_session(archiveFolderId='arch-1'), deps={'drive': FakeDrive(metas={
        'src-1': _folder('src-1', 'Inbox'),
        'exp-1': _folder('exp-1', 'Export'),
        'arch-1': _folder('arch-1', '_archive'),
    })})
    assert _by_id(results, 'archive_folder')['ok'] is True


def test_archive_folder_fails_when_not_writable():
    results = _run(_session(archiveFolderId='arch-1'), deps={'drive': FakeDrive(metas={
        'src-1': _folder('src-1', 'Inbox'),
        'exp-1': _folder('exp-1', 'Export'),
        'arch-1': _folder('arch-1', '_archive', can_add=False),
    })})
    entry = _by_id(results, 'archive_folder')
    assert entry['ok'] is False
    assert entry['fix'] == FIX['archive_folder']


# --- topaz -----------------------------------------------------------------

def test_topaz_omitted_when_edit_mode_is_not_topaz():
    results = _run(_session(editMode='off'))
    assert 'topaz' not in [r['check'] for r in results]
    assert [r['check'] for r in results] == OFF_ORDER


def test_topaz_pass():
    results = _run(_session(editMode='topaz'))
    assert _by_id(results, 'topaz')['ok'] is True


def test_topaz_fails_when_binary_missing():
    results = _run(_session(editMode='topaz'), deps={
        'topaz': FakeTopaz(raise_resolve=RuntimeError(
            "Topaz binary not found at '/nonexistent'")),
    })
    entry = _by_id(results, 'topaz')
    assert entry['ok'] is False
    assert entry['fix'] == FIX['topaz_missing']


def test_topaz_fails_when_exit_254_not_signed_in():
    results = _run(_session(editMode='topaz'), deps={
        'topaz': FakeTopaz(process_result=_topaz_result(254, detail='invalid login')),
    })
    entry = _by_id(results, 'topaz')
    assert entry['ok'] is False
    assert entry['fix'] == FIX['topaz_254']
    assert '254' in entry['detail']


# --- imaging_libs ----------------------------------------------------------

def test_imaging_libs_pass():
    results = _run(_session())
    assert _by_id(results, 'imaging_libs')['ok'] is True


def test_imaging_libs_fails_when_import_broken(monkeypatch):
    def _broken():
        raise ImportError("No module named 'cv2'")

    monkeypatch.setattr(preflight, '_imaging_import', _broken)
    results = _run(_session())
    entry = _by_id(results, 'imaging_libs')
    assert entry['ok'] is False
    assert entry['fix'] == FIX['imaging_libs']


# --- disk_space ------------------------------------------------------------

def test_disk_space_pass(monkeypatch):
    monkeypatch.setattr(
        preflight.shutil, 'disk_usage',
        lambda p: types.SimpleNamespace(free=20 * GB),
    )
    results = _run(_session())
    assert _by_id(results, 'disk_space')['ok'] is True


def test_disk_space_fails_when_low(monkeypatch):
    monkeypatch.setattr(
        preflight.shutil, 'disk_usage',
        lambda p: types.SimpleNamespace(free=4 * GB),
    )
    results = _run(_session())
    entry = _by_id(results, 'disk_space')
    assert entry['ok'] is False
    assert entry['fix'] == FIX['disk_space']


# --- database --------------------------------------------------------------

def test_database_pass():
    results = _run(_session())
    assert _by_id(results, 'database')['ok'] is True


def test_database_fails_when_unwritable(tmp_path):
    blocker = tmp_path / 'blocker'
    blocker.write_text('x')
    db.reset_for_tests(str(blocker / 'x.db'))
    results = _run(_session())
    entry = _by_id(results, 'database')
    assert entry['ok'] is False
    assert entry['fix'] == FIX['database']
    assert entry['detail']


# --- cross-cutting ---------------------------------------------------------

def test_check_order_with_topaz():
    results = _run(_session(editMode='topaz'))
    assert [r['check'] for r in results] == TOPAZ_ORDER


def test_every_failing_check_has_fix():
    deps = {
        'auth': FakeAuth(available=False),
        'drive': FakeDrive(metas={}),
        'topaz': FakeTopaz(raise_resolve=RuntimeError('missing')),
    }
    results = _run(_session(editMode='topaz', archiveFolderId='arch-1'), deps=deps)
    failures = [r for r in results if not r['ok']]
    assert failures, 'expected at least one failing check'
    for r in failures:
        assert r['fix'], f"check {r['check']!r} has empty fix text"
    assert {'google_auth', 'source_folder', 'export_folder', 'archive_folder', 'topaz'} <= {
        r['check'] for r in failures
    }


def test_run_never_raises_with_exploding_dep():
    exploding = FakeDrive(
        metas={'exp-1': _folder('exp-1', 'Export')},
        exploding={'src-1'},
    )
    results = _run(_session(), deps={'drive': exploding})
    source = _by_id(results, 'source_folder')
    assert source['ok'] is False
    assert 'drive exploded for src-1' in source['detail']
    assert [r['check'] for r in results] == OFF_ORDER
    assert len(results) == len(OFF_ORDER)


def test_run_never_raises_when_token_provider_explodes():
    def _boom():
        raise RuntimeError('no access token')

    results = _run(_session(), token_provider=_boom)
    assert _by_id(results, 'source_folder')['ok'] is False
    assert 'no access token' in _by_id(results, 'source_folder')['detail']
    assert [r['check'] for r in results] == OFF_ORDER
