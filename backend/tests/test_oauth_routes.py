# backend/tests/test_oauth_routes.py
"""Flask test-client tests for /google/oauth/* and token preference."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
os.environ.setdefault('BBP_DEBUG', '1')  # dev session auto-created by enforce_auth

import app as appmod
from backend import google_auth


def _client():
    appmod.app.config['TESTING'] = True
    return appmod.app.test_client()


def test_oauth_start_requires_session():
    c = _client()
    # No session cookie yet and route creates none itself
    r = c.get('/google/oauth/start')
    assert r.status_code in (302, 401)


def test_oauth_start_redirects_to_google_when_configured():
    c = _client()
    with c.session_transaction() as s:
        s['user'] = {'email': 'dev@local'}
    orig_id, orig_secret = appmod.GOOGLE_CLIENT_ID, os.environ.get('GOOGLE_CLIENT_SECRET')
    appmod.GOOGLE_CLIENT_ID = 'cid'
    os.environ['GOOGLE_CLIENT_SECRET'] = 'csec'
    try:
        r = c.get('/google/oauth/start')
        assert r.status_code == 302
        assert 'accounts.google.com' in r.headers['Location']
    finally:
        appmod.GOOGLE_CLIENT_ID = orig_id
        if orig_secret is None:
            os.environ.pop('GOOGLE_CLIENT_SECRET', None)


def test_oauth_callback_rejects_bad_state():
    c = _client()
    with c.session_transaction() as s:
        s['user'] = {'email': 'dev@local'}
        s['google_oauth_state'] = 'good'
    r = c.get('/google/oauth/callback?state=evil&code=x')
    assert r.status_code == 302
    assert 'googleAuth=error' in r.headers['Location']


def test_google_token_prefers_manager(tmp_path=None):
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        mgr = google_auth.GoogleAuthManager(
            token_path=os.path.join(d, 't.json'), client_id='cid', client_secret='cs')
        mgr.store_tokens({'refresh_token': 'r', 'access_token': 'MGRTOK', 'expires_in': 3600})
        orig = google_auth._manager
        google_auth._manager = mgr
        try:
            with appmod.app.test_request_context('/'):
                appmod.session['google_drive_token'] = 'SESSTOK'
                assert appmod._google_token() == 'MGRTOK'
        finally:
            google_auth._manager = orig


def test_google_token_falls_back_to_session():
    orig = google_auth._manager
    google_auth._manager = google_auth.GoogleAuthManager(
        token_path='/nonexistent/nope.json', client_id='', client_secret='')
    try:
        with appmod.app.test_request_context('/'):
            appmod.session['google_drive_token'] = 'SESSTOK'
            assert appmod._google_token() == 'SESSTOK'
    finally:
        google_auth._manager = orig


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
