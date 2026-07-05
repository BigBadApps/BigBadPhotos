# backend/tests/test_photos_routes.py
import io
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
os.environ.setdefault('BBP_DEBUG', '1')

import app as appmod
from backend import google_photos


def _client_with_token():
    appmod.app.config['TESTING'] = True
    c = appmod.app.test_client()
    with c.session_transaction() as s:
        s['user'] = {'email': 'dev@local'}
        s['google_drive_token'] = 'SESSTOK'
    return c


def test_albums_requires_google_auth():
    appmod.app.config['TESTING'] = True
    c = appmod.app.test_client()
    with c.session_transaction() as s:
        s['user'] = {'email': 'dev@local'}
    r = c.get('/photos/albums')
    assert r.status_code == 401


def test_list_albums_route():
    c = _client_with_token()
    orig = google_photos.list_albums
    google_photos.list_albums = lambda tok: [{'id': 'a1', 'title': 'T'}]
    try:
        r = c.get('/photos/albums')
        assert r.status_code == 200
        assert r.get_json()['albums'][0]['id'] == 'a1'
    finally:
        google_photos.list_albums = orig


def test_create_album_route_validates_title():
    c = _client_with_token()
    r = c.post('/photos/albums', json={})
    assert r.status_code == 400


def test_upload_route_happy_path():
    c = _client_with_token()
    orig_up, orig_bc = google_photos.upload_bytes, google_photos.batch_create
    google_photos.upload_bytes = lambda tok, fn, data, mime_type='image/jpeg': 'UT1'
    google_photos.batch_create = lambda tok, album, items: [
        {'filename': items[0]['filename'], 'ok': True, 'mediaItemId': 'M1'}]
    try:
        r = c.post('/photos/upload', data={
            'albumId': 'a1',
            'file': (io.BytesIO(b'\xff\xd8jpegdata'), 'pic.jpg'),
        }, content_type='multipart/form-data')
        assert r.status_code == 200, r.get_data(as_text=True)
        body = r.get_json()
        assert body['ok'] is True and body['mediaItemId'] == 'M1'
    finally:
        google_photos.upload_bytes, google_photos.batch_create = orig_up, orig_bc


def test_upload_route_surfaces_item_failure():
    c = _client_with_token()
    orig_up, orig_bc = google_photos.upload_bytes, google_photos.batch_create
    google_photos.upload_bytes = lambda tok, fn, data, mime_type='image/jpeg': 'UT1'
    google_photos.batch_create = lambda tok, album, items: [
        {'filename': items[0]['filename'], 'ok': False, 'error': 'boom'}]
    try:
        r = c.post('/photos/upload', data={
            'albumId': 'a1',
            'file': (io.BytesIO(b'x'), 'pic.jpg'),
        }, content_type='multipart/form-data')
        assert r.status_code == 502
        assert r.get_json()['error'] == 'photos_upload_failed'
    finally:
        google_photos.upload_bytes, google_photos.batch_create = orig_up, orig_bc


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"PASS  {t.__name__}")
        except Exception as e:
            failed += 1
            print(f"FAIL  {t.__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
