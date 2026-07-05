"""Tests for backend.google_photos with a fake requests layer."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from backend import google_photos


class FakeResp:
    def __init__(self, status=200, payload=None, text=''):
        self.status_code = status
        self.ok = status < 400
        self._payload = payload
        self.text = text or (str(payload) if payload else '')
    def json(self):
        if self._payload is None:
            raise ValueError('no json')
        return self._payload


class FakeRequests:
    def __init__(self):
        self.calls = []
        self.responses = []
    def _pop(self):
        return self.responses.pop(0)
    def get(self, url, headers=None, params=None, timeout=None):
        self.calls.append(('GET', url, params))
        return self._pop()
    def post(self, url, headers=None, params=None, json=None, data=None, timeout=None):
        self.calls.append(('POST', url, json if json is not None else data))
        return self._pop()


def _patch():
    fake = FakeRequests()
    google_photos.requests = fake
    return fake


def test_list_albums_paginates():
    fake = _patch()
    fake.responses = [
        FakeResp(200, {'albums': [{'id': 'a1', 'title': 'T1'}], 'nextPageToken': 'p2'}),
        FakeResp(200, {'albums': [{'id': 'a2', 'title': 'T2'}]}),
    ]
    albums = google_photos.list_albums('tok')
    assert [a['id'] for a in albums] == ['a1', 'a2']
    assert fake.calls[1][2].get('pageToken') == 'p2'


def test_list_albums_empty_library():
    fake = _patch()
    fake.responses = [FakeResp(200, {})]  # API omits 'albums' when none exist
    assert google_photos.list_albums('tok') == []


def test_create_album_posts_title():
    fake = _patch()
    fake.responses = [FakeResp(200, {'id': 'new1', 'title': 'BBP 2026-07-04'})]
    album = google_photos.create_album('tok', 'BBP 2026-07-04')
    assert album['id'] == 'new1'
    method, url, body = fake.calls[0]
    assert method == 'POST' and url.endswith('/albums')
    assert body == {'album': {'title': 'BBP 2026-07-04'}}


def test_upload_bytes_returns_token():
    fake = _patch()
    fake.responses = [FakeResp(200, None, text='UPLOAD_TOKEN_X')]
    tok = google_photos.upload_bytes('tok', 'img.jpg', b'\xff\xd8data')
    assert tok == 'UPLOAD_TOKEN_X'


def test_upload_bytes_raises_on_error():
    fake = _patch()
    fake.responses = [FakeResp(403, {'error': {'message': 'denied'}}, text='denied')]
    try:
        google_photos.upload_bytes('tok', 'img.jpg', b'x')
    except google_photos.PhotosApiError as e:
        assert e.status_code == 403
        return
    raise AssertionError('expected PhotosApiError')


def test_batch_create_chunks_of_50():
    fake = _patch()
    items = [{'uploadToken': f't{i}', 'filename': f'f{i}.jpg'} for i in range(60)]
    fake.responses = [
        FakeResp(200, {'newMediaItemResults': [
            {'status': {'message': 'Success'}, 'mediaItem': {'id': f'm{i}'}} for i in range(50)]}),
        FakeResp(200, {'newMediaItemResults': [
            {'status': {'message': 'Success'}, 'mediaItem': {'id': f'm{50+i}'}} for i in range(10)]}),
    ]
    results = google_photos.batch_create('tok', 'alb1', items)
    assert len(results) == 60
    assert all(r['ok'] for r in results)
    assert results[0]['mediaItemId'] == 'm0'
    # two POSTs, each with albumId and <=50 items
    assert len(fake.calls) == 2
    body1 = fake.calls[0][2]
    assert body1['albumId'] == 'alb1'
    assert len(body1['newMediaItems']) == 50


def test_batch_create_surfaces_per_item_failure():
    fake = _patch()
    fake.responses = [FakeResp(200, {'newMediaItemResults': [
        {'status': {'message': 'Success'}, 'mediaItem': {'id': 'm0'}},
        {'status': {'code': 3, 'message': 'NOT_IMAGE'}},
    ]})]
    results = google_photos.batch_create('tok', None, [
        {'uploadToken': 't0', 'filename': 'a.jpg'},
        {'uploadToken': 't1', 'filename': 'b.jpg'},
    ])
    assert results[0]['ok'] is True
    assert results[1]['ok'] is False and 'NOT_IMAGE' in results[1]['error']


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
