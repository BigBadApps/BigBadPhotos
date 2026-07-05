import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
os.environ.setdefault('BBP_DEBUG', '1')

import app as appmod
from backend import google_auth, session_worker


def _client():
    appmod.app.config['TESTING'] = True
    c = appmod.app.test_client()
    with c.session_transaction() as s:
        s['user'] = {'email': 'dev@local'}
    return c


class FakeMgr:
    def __init__(self, ok=True):
        self.ok = ok
    def available(self):
        return self.ok
    def get_access_token(self):
        return 'TOK'


def test_status_idle_by_default():
    c = _client()
    r = c.get('/autonomous/status')
    assert r.status_code == 200
    assert r.get_json()['running'] is False


def test_start_requires_server_google_auth():
    c = _client()
    orig = google_auth._manager
    google_auth._manager = FakeMgr(ok=False)
    try:
        r = c.post('/autonomous/start', json={'sourceFolderId': 's', 'albumId': 'a'})
        assert r.status_code == 401
    finally:
        google_auth._manager = orig


def test_start_validates_config():
    c = _client()
    orig = google_auth._manager
    google_auth._manager = FakeMgr(ok=True)
    try:
        r = c.post('/autonomous/start', json={'albumId': 'a'})
        assert r.status_code == 400
    finally:
        google_auth._manager = orig


def test_start_conflict_when_running():
    c = _client()
    orig_mgr = google_auth._manager
    google_auth._manager = FakeMgr(ok=True)
    orig_start = session_worker.start_worker
    def boom(cfg, tp):
        raise RuntimeError('a session is already running')
    session_worker.start_worker = boom
    try:
        r = c.post('/autonomous/start', json={'sourceFolderId': 's', 'albumId': 'a', 'edit': False})
        assert r.status_code == 409
    finally:
        google_auth._manager = orig_mgr
        session_worker.start_worker = orig_start


def test_stop_route():
    c = _client()
    r = c.post('/autonomous/stop')
    assert r.status_code == 200
    assert 'stopped' in r.get_json()


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
