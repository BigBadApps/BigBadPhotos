import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from backend import db, sessions


@pytest.fixture(autouse=True)
def _tmp_db():
    with tempfile.TemporaryDirectory() as tmp:
        db.reset_for_tests(os.path.join(tmp, 'test.db'))
        yield


def _valid(**over):
    data = {'name': 'Soccer', 'sourceFolderId': 'src', 'exportFolderId': 'exp'}
    data.update(over)
    return data


def test_create_applies_defaults():
    s = sessions.create(_valid())
    assert s['id'] > 0
    assert s['preset'] == 'balanced'
    assert s['threshold'] == pytest.approx(0.60)
    assert s['editMode'] == 'off'
    assert s['autonomous'] is False
    assert s['burstBestOnly'] is True
    assert s['galleryEnabled'] is True
    assert s['favoritesFolderId'] is None
    assert s['favoritesFolderName'] is None
    assert s['gallery_token'] is not None
    assert s['gallery_url'] == f"/gallery/{s['gallery_token']}"


def test_preset_sets_threshold():
    s = sessions.create(_valid(preset='strict'))
    assert s['threshold'] == pytest.approx(sessions.PRESETS['strict'])


def test_explicit_threshold_marks_custom():
    s = sessions.create(_valid(preset='strict', threshold=0.5))
    assert s['preset'] == 'custom'
    assert s['threshold'] == pytest.approx(0.5)


@pytest.mark.parametrize('bad', [
    {'name': ''},
    {'sourceFolderId': ''},
    {'exportFolderId': ''},
    {'threshold': 1.5},
    {'threshold': -0.1},
    {'editMode': 'magic'},
    {'editStrength': 'nuclear'},
    {'pollSeconds': 0},
])
def test_validation_rejects(bad):
    with pytest.raises(sessions.SessionError):
        sessions.create(_valid(**bad))


def test_duplicate_name_rejected():
    sessions.create(_valid())
    with pytest.raises(sessions.SessionError):
        sessions.create(_valid())


def test_update_and_list_and_delete():
    s = sessions.create(_valid())
    up = sessions.update(s['id'], {
        'threshold': 0.8,
        'autonomous': True,
        'galleryEnabled': False,
        'favoritesFolderId': 'fav-123',
        'favoritesFolderName': 'Soccer - Favorites',
    })
    assert up['threshold'] == pytest.approx(0.8)
    assert up['autonomous'] is True
    assert up['preset'] == 'custom'
    assert up['galleryEnabled'] is False
    assert up['favoritesFolderId'] == 'fav-123'
    assert up['favoritesFolderName'] == 'Soccer - Favorites'
    assert len(sessions.list_all()) == 1
    sessions.delete(s['id'])
    assert sessions.get(s['id']) is None


def test_create_with_ingest_active_persists_and_is_exclusive():
    s1 = sessions.create(_valid(name='S1', ingestActive=True))
    assert s1['ingestActive'] is True

    s2 = sessions.create(_valid(name='S2', ingestActive=True))
    assert s2['ingestActive'] is True
    assert sessions.get(s1['id'])['ingestActive'] is False


def test_update_ingest_active_persists_and_is_exclusive():
    s1 = sessions.create(_valid(name='S1'))
    s2 = sessions.create(_valid(name='S2'))

    sessions.update(s1['id'], {'ingestActive': True})
    assert sessions.get(s1['id'])['ingestActive'] is True

    sessions.update(s2['id'], {'ingestActive': True})
    assert sessions.get(s2['id'])['ingestActive'] is True
    assert sessions.get(s1['id'])['ingestActive'] is False

    sessions.update(s2['id'], {'ingestActive': False})
    assert sessions.get(s2['id'])['ingestActive'] is False


def test_failed_create_with_duplicate_name_does_not_silently_clear_active_session():
    """A rejected duplicate-name create must not leave a pending, uncommitted
    'ingest_active = 0' write sitting on the connection for a later
    unrelated write to accidentally commit."""
    active = sessions.create(_valid(name='Active', ingestActive=True))

    with pytest.raises(sessions.SessionError):
        sessions.create(_valid(name='Active', ingestActive=True))

    assert sessions.get(active['id'])['ingestActive'] is True

    # An unrelated write on the same (thread-local) connection must not
    # resurrect and commit the rejected session's stale transaction.
    sessions.create(_valid(name='Unrelated'))
    assert sessions.get(active['id'])['ingestActive'] is True


def test_failed_update_with_duplicate_name_does_not_silently_clear_active_session():
    active = sessions.create(_valid(name='Active', ingestActive=True))
    other = sessions.create(_valid(name='Other'))

    with pytest.raises(sessions.SessionError):
        sessions.update(other['id'], {'name': 'Active', 'ingestActive': True})

    assert sessions.get(active['id'])['ingestActive'] is True

    sessions.create(_valid(name='Unrelated2'))
    assert sessions.get(active['id'])['ingestActive'] is True


def test_set_ingest_active_rolls_back_on_any_exception(monkeypatch):
    """The clear-then-set pair must not leak a partial write into a later,
    unrelated commit on the same thread-local connection if the second
    UPDATE (or anything else mid-transaction) throws — not just on
    sqlite3.IntegrityError specifically."""
    s1 = sessions.create(_valid(name='S1', ingestActive=True))
    s2 = sessions.create(_valid(name='S2'))

    real_conn = db.get()
    calls = []

    class _FlakyConn:
        """Proxies the real thread-local connection, failing the 2nd execute()."""

        def execute(self, sql, *args, **kwargs):
            calls.append(sql)
            if len(calls) == 2:
                raise RuntimeError('simulated mid-transaction failure')
            return real_conn.execute(sql, *args, **kwargs)

        def __enter__(self):
            return real_conn.__enter__()

        def __exit__(self, *exc_info):
            return real_conn.__exit__(*exc_info)

        def __getattr__(self, name):
            return getattr(real_conn, name)

    monkeypatch.setattr(sessions.db, 'get', lambda: _FlakyConn())
    with pytest.raises(RuntimeError):
        sessions.set_ingest_active(s2['id'])
    monkeypatch.undo()

    # The first UPDATE (clearing s1's active flag) must not have leaked.
    assert sessions.get(s1['id'])['ingestActive'] is True

    # An unrelated write on the same thread-local connection must not
    # resurrect and commit the aborted transaction.
    sessions.create(_valid(name='Unrelated3'))
    assert sessions.get(s1['id'])['ingestActive'] is True


def test_settings_roundtrip():
    assert sessions.get_setting('inbox_folder_id') is None
    sessions.set_setting('inbox_folder_id', 'folder-123')
    assert sessions.get_setting('inbox_folder_id') == 'folder-123'
    sessions.set_setting('inbox_folder_id', 'folder-456')
    assert sessions.get_setting('inbox_folder_id') == 'folder-456'

