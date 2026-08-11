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
    up = sessions.update(s['id'], {'threshold': 0.8, 'autonomous': True})
    assert up['threshold'] == pytest.approx(0.8)
    assert up['autonomous'] is True
    assert up['preset'] == 'custom'
    assert len(sessions.list_all()) == 1
    sessions.delete(s['id'])
    assert sessions.get(s['id']) is None


def test_settings_roundtrip():
    assert sessions.get_setting('inbox_folder_id') is None
    sessions.set_setting('inbox_folder_id', 'folder-123')
    assert sessions.get_setting('inbox_folder_id') == 'folder-123'
    sessions.set_setting('inbox_folder_id', 'folder-456')
    assert sessions.get_setting('inbox_folder_id') == 'folder-456'
