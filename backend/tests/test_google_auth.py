# backend/tests/test_google_auth.py
"""Tests for backend.google_auth. Standalone runner (no pytest)."""
import json
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from backend import google_auth


def _mgr(tmpdir, **kw):
    return google_auth.GoogleAuthManager(
        token_path=os.path.join(tmpdir, 'tok.json'),
        client_id=kw.get('client_id', 'cid'),
        client_secret=kw.get('client_secret', 'csec'),
    )


def test_unavailable_without_token_file():
    with tempfile.TemporaryDirectory() as d:
        m = _mgr(d)
        assert m.available() is False


def test_store_then_available_and_file_mode_600():
    with tempfile.TemporaryDirectory() as d:
        m = _mgr(d)
        m.store_tokens({'refresh_token': 'r1', 'access_token': 'a1', 'expires_in': 3600})
        assert m.available() is True
        mode = os.stat(m.token_path).st_mode & 0o777
        assert mode == 0o600, f"expected 600, got {oct(mode)}"
        data = json.loads(open(m.token_path).read())
        assert data['refresh_token'] == 'r1'


def test_store_preserves_refresh_token_when_response_omits_it():
    # Google omits refresh_token on repeat consent — must not lose the stored one.
    with tempfile.TemporaryDirectory() as d:
        m = _mgr(d)
        m.store_tokens({'refresh_token': 'r1', 'access_token': 'a1', 'expires_in': 3600})
        m.store_tokens({'access_token': 'a2', 'expires_in': 3600})
        data = json.loads(open(m.token_path).read())
        assert data['refresh_token'] == 'r1'
        assert data['access_token'] == 'a2'


def test_get_access_token_returns_cached_when_fresh():
    with tempfile.TemporaryDirectory() as d:
        m = _mgr(d)
        m.store_tokens({'refresh_token': 'r1', 'access_token': 'fresh', 'expires_in': 3600})
        calls = []
        m._refresh = lambda: calls.append(1)  # must not be called
        assert m.get_access_token() == 'fresh'
        assert calls == []


def test_get_access_token_refreshes_when_stale(monkey=None):
    with tempfile.TemporaryDirectory() as d:
        m = _mgr(d)
        m.store_tokens({'refresh_token': 'r1', 'access_token': 'old', 'expires_in': 30})
        # expires_in 30s is inside the 120s margin -> refresh path
        def fake_post(url, data=None, timeout=None):
            class R:
                ok = True
                def json(self):
                    return {'access_token': 'newtok', 'expires_in': 3600}
                def raise_for_status(self):
                    pass
            assert data['grant_type'] == 'refresh_token'
            assert data['refresh_token'] == 'r1'
            return R()
        google_auth.requests.post, orig = fake_post, google_auth.requests.post
        try:
            assert m.get_access_token() == 'newtok'
        finally:
            google_auth.requests.post = orig


def test_get_access_token_raises_without_credentials():
    with tempfile.TemporaryDirectory() as d:
        m = google_auth.GoogleAuthManager(
            token_path=os.path.join(d, 'tok.json'), client_id='', client_secret='')
        try:
            m.get_access_token()
        except google_auth.GoogleAuthError:
            return
        raise AssertionError('expected GoogleAuthError')


def test_build_auth_url_contains_required_params():
    url = google_auth.build_auth_url('cid', 'http://localhost:8002/google/oauth/callback', 'st8')
    assert 'accounts.google.com/o/oauth2/v2/auth' in url
    assert 'access_type=offline' in url
    assert 'prompt=consent' in url
    assert 'state=st8' in url
    assert 'photoslibrary.appendonly' in url
    assert 'photoslibrary.readonly.appcreateddata' in url
    assert 'auth%2Fdrive' in url  # url-encoded drive scope


def test_clear_removes_file():
    with tempfile.TemporaryDirectory() as d:
        m = _mgr(d)
        m.store_tokens({'refresh_token': 'r1', 'access_token': 'a1', 'expires_in': 3600})
        m.clear()
        assert m.available() is False


def test_refresh_network_error_raises_google_auth_error():
    with tempfile.TemporaryDirectory() as d:
        m = _mgr(d)
        m.store_tokens({'refresh_token': 'r1', 'access_token': 'old', 'expires_in': 30})
        # expires_in 30s is inside the 120s margin -> refresh path

        def fake_post(url, data=None, timeout=None):
            raise google_auth.requests.exceptions.RequestException('net down')

        google_auth.requests.post, orig = fake_post, google_auth.requests.post
        try:
            m.get_access_token()
        except google_auth.GoogleAuthError:
            return
        finally:
            google_auth.requests.post = orig
        raise AssertionError('expected GoogleAuthError')


def test_exchange_code_network_error_raises_google_auth_error():
    def fake_post(url, data=None, timeout=None):
        raise google_auth.requests.exceptions.RequestException('net down')

    google_auth.requests.post, orig = fake_post, google_auth.requests.post
    try:
        google_auth.exchange_code('c', 's', 'code', 'uri')
    except google_auth.GoogleAuthError:
        return
    finally:
        google_auth.requests.post = orig
    raise AssertionError('expected GoogleAuthError')


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
