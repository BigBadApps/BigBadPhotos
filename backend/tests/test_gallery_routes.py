import os
import sys
import tempfile
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
os.environ.setdefault('BBP_DEBUG', '1')

import app as appmod
from backend import db, gallery, google_auth, sessions


class FakeMgr:
    def __init__(self, ok=True):
        self.ok = ok

    def available(self):
        return self.ok

    def get_access_token(self):
        return 'MOCK_TOKEN'


@pytest.fixture(autouse=True)
def _tmp_db(tmp_path):
    db.reset_for_tests(str(tmp_path / 'test.db'))
    yield


@pytest.fixture(autouse=True)
def _fake_google_manager(monkeypatch):
    monkeypatch.setattr(google_auth, '_manager', FakeMgr(ok=True))


def _auth_client():
    appmod.app.config['TESTING'] = True
    c = appmod.app.test_client()
    with c.session_transaction() as s:
        s['user'] = {'email': 'photographer@example.com'}
    return c


def _public_client():
    appmod.app.config['TESTING'] = True
    return appmod.app.test_client()


def _setup_session_with_photos():
    sess = sessions.create({'name': 'Smith Wedding', 'sourceFolderId': 'src1', 'exportFolderId': 'exp1'})
    conn = db.get()
    run_cur = conn.execute(
        "INSERT INTO runs (session_id, started_at, status) VALUES (?, '2026-08-17T00:00:00Z', 'completed')",
        (sess['id'],),
    )
    run_id = run_cur.lastrowid
    p1 = conn.execute(
        "INSERT INTO photos (run_id, drive_file_id, filename, state, overall_score, claimed_at, updated_at) "
        "VALUES (?, 'd1', 'IMG_1001.JPG', 'exported', 0.95, '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z')",
        (run_id,),
    ).lastrowid
    p2 = conn.execute(
        "INSERT INTO photos (run_id, drive_file_id, filename, state, overall_score, claimed_at, updated_at) "
        "VALUES (?, 'd2', 'IMG_1002.JPG', 'exported', 0.82, '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z')",
        (run_id,),
    ).lastrowid
    conn.commit()
    tokens = gallery.get_tokens_for_session(sess['id'])
    return sess, tokens[0], [p1, p2]


def test_gallery_public_view_valid_and_invalid():
    sess, tok, photos = _setup_session_with_photos()
    c = _public_client()

    # Invalid token -> 404
    r_bad = c.get('/gallery/nonexistent-token')
    assert r_bad.status_code == 404
    assert r_bad.get_json()['error'] == 'not_found'

    # Valid token -> 200 (if frontend/dist exists) or 503 (if missing dist)
    r_good = c.get(f"/gallery/{tok['token']}")
    assert r_good.status_code in (200, 503)


def test_gallery_public_api_info_and_photos():
    sess, tok, photos = _setup_session_with_photos()
    c = _public_client()

    # Info
    r_info = c.get(f"/gallery/api/{tok['token']}/info")
    assert r_info.status_code == 200
    info_data = r_info.get_json()
    assert info_data['sessionName'] == 'Smith Wedding'
    assert info_data['photoCount'] == 2
    assert info_data['galleryLabel'] == 'Main Gallery'

    # Photos list
    r_photos = c.get(f"/gallery/api/{tok['token']}/photos")
    assert r_photos.status_code == 200
    photos_data = r_photos.get_json()
    assert len(photos_data) == 2
    assert photos_data[0]['filename'] == 'IMG_1001.JPG'
    assert r_photos.headers.get('X-Total-Count') == '2'


def test_gallery_public_favorites_lifecycle():
    sess, tok, (p1, p2) = _setup_session_with_photos()
    c = _public_client()

    # Add favorite
    r_add = c.post(f"/gallery/api/{tok['token']}/favorites/{p1}")
    assert r_add.status_code == 201
    assert r_add.get_json()['status'] == 'added'

    # Get favorites
    r_get = c.get(f"/gallery/api/{tok['token']}/favorites")
    assert r_get.status_code == 200
    assert r_get.get_json() == [p1]

    # Delete favorite
    r_del = c.delete(f"/gallery/api/{tok['token']}/favorites/{p1}")
    assert r_del.status_code == 200
    assert r_del.get_json()['status'] == 'removed'

    # Get favorites again
    r_get_after = c.get(f"/gallery/api/{tok['token']}/favorites")
    assert r_get_after.status_code == 200
    assert r_get_after.get_json() == []


def test_gallery_public_comments_lifecycle():
    sess, tok, (p1, p2) = _setup_session_with_photos()
    c = _public_client()

    # Post gallery comment
    r_c1 = c.post(
        f"/gallery/api/{tok['token']}/comments",
        json={'body': 'Such wonderful photos!', 'displayName': 'Aunt Clara'},
    )
    assert r_c1.status_code == 201
    assert r_c1.get_json()['body'] == 'Such wonderful photos!'
    assert r_c1.get_json()['display_name'] == 'Aunt Clara'

    # Post photo comment
    r_c2 = c.post(
        f"/gallery/api/{tok['token']}/comments",
        json={'photoId': p1, 'body': 'The lighting here is stunning!'},
    )
    assert r_c2.status_code == 201

    # Get all gallery comments
    r_list = c.get(f"/gallery/api/{tok['token']}/comments")
    assert r_list.status_code == 200
    assert len(r_list.get_json()) == 2

    # Get comments for specific photo
    r_p1_comments = c.get(f"/gallery/api/{tok['token']}/comments?photoId={p1}")
    assert r_p1_comments.status_code == 200
    assert len(r_p1_comments.get_json()) == 1
    assert r_p1_comments.get_json()[0]['body'] == 'The lighting here is stunning!'


def test_photographer_gallery_endpoints():
    sess, tok, (p1, p2) = _setup_session_with_photos()
    pub = _public_client()
    auth = _auth_client()

    # Visitor adds favorite and comment
    pub.post(f"/gallery/api/{tok['token']}/favorites/{p1}")
    pub.post(f"/gallery/api/{tok['token']}/comments", json={'body': 'Great shot!', 'displayName': 'Guest'})

    # Photographer fetches gallery details
    r_gal = auth.get(f"/sessions/{sess['id']}/gallery")
    assert r_gal.status_code == 200
    gal_body = r_gal.get_json()
    assert gal_body['token'] == tok['token']
    assert gal_body['stats']['favorites_count'] == 1
    assert gal_body['stats']['comments_count'] == 1

    # Photographer fetches aggregated favorites
    r_favs = auth.get(f"/sessions/{sess['id']}/gallery/favorites")
    assert r_favs.status_code == 200
    favs = r_favs.get_json()
    assert len(favs) == 1
    assert favs[0]['photo_id'] == p1
    assert favs[0]['favorite_count'] == 1

    # Photographer fetches comments
    r_comms = auth.get(f"/sessions/{sess['id']}/gallery/comments")
    assert r_comms.status_code == 200
    assert len(r_comms.get_json()) == 1

    # Photographer regenerates token
    r_regen = auth.post(f"/sessions/{sess['id']}/gallery/regenerate")
    assert r_regen.status_code == 200
    new_token_val = r_regen.get_json()['token']
    assert new_token_val != tok['token']

    # Old token should now 404
    r_old_info = pub.get(f"/gallery/api/{tok['token']}/info")
    assert r_old_info.status_code == 404

    # New token works
    r_new_info = pub.get(f"/gallery/api/{new_token_val}/info")
    assert r_new_info.status_code == 200


def test_photographer_approve_favorites(monkeypatch):
    sess, tok, (p1, p2) = _setup_session_with_photos()
    auth = _auth_client()

    fake_ensure_calls = []
    fake_copy_calls = []

    def fake_ensure_folder(token, parent_id, name):
        fake_ensure_calls.append((token, parent_id, name))
        return {'id': 'fav-folder-123', 'name': name}

    def fake_set_public_read(folder_id, token):
        pass

    def fake_copy_file(file_id, folder_id, token):
        fake_copy_calls.append((file_id, folder_id, token))
        return {'id': f"copy-of-{file_id}"}

    monkeypatch.setattr(appmod.google_drive, 'ensure_folder', fake_ensure_folder)
    monkeypatch.setattr(appmod.google_drive, 'set_public_read', fake_set_public_read)
    monkeypatch.setattr(appmod.google_drive, 'copy_file', fake_copy_file)

    r_approve = auth.post(
        f"/sessions/{sess['id']}/gallery/approve-favorites",
        json={'photo_ids': [p1]},
    )
    assert r_approve.status_code == 201
    res = r_approve.get_json()
    assert res['favoritesFolderId'] == 'fav-folder-123'
    assert res['copied_count'] == 1
    assert 'favoritesToken' in res
    assert len(fake_copy_calls) == 1
