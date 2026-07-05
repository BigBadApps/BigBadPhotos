"""Worker loop tests with injected fakes — no network, no Topaz, no threads."""
import json
import os
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

import cv2

from backend import session_worker


def _jpeg_bytes(seed=0):
    img = (np.random.default_rng(seed).random((80, 120)) * 255).astype('uint8')
    ok, buf = cv2.imencode('.jpg', img)
    return buf.tobytes()


class FakeDrive:
    def __init__(self, files):
        # files: {name: bytes}; sidecars added via uploads
        self.files = dict(files)
        self.uploads = []  # (parent, filename, bytes)
    def list_all(self, token, folder_id):
        return [{'id': f'id-{n}', 'name': n, 'mimeType': 'image/jpeg'} for n in self.files]
    def download_file(self, token, file_id, filename=None, mime_type=None):
        name = file_id[len('id-'):]
        return self.files[name], name, 'image/jpeg'
    def upload_file(self, token, parent_id, filename, data, mime_type=None):
        self.uploads.append((parent_id, filename, data))
        self.files[filename] = data
        return {'id': f'id-{filename}'}


class FakePhotos:
    def __init__(self):
        self.published = []
    def upload_bytes(self, token, filename, data, mime_type='image/jpeg'):
        return f'ut-{filename}'
    def batch_create(self, token, album_id, items):
        self.published.extend((album_id, it['filename']) for it in items)
        return [{'filename': it['filename'], 'ok': True,
                 'mediaItemId': f"m-{it['filename']}"} for it in items]


class FakeRanker:
    """Deterministic scores keyed by filename prefix: keep_* high, skip_* low."""
    def rank_images(self, tasks, max_workers=None):
        results = []
        for i, (tid, fname, _b) in enumerate(tasks):
            score = 0.9 if fname.startswith('keep') else 0.2
            results.append({
                'id': tid, 'filename': fname, 'sharpness': score,
                'overall_score': score, 'rank': i + 1, 'is_burst_best': True,
                'burst_group': None, 'burst_size': None,
                'exposure': {'exposure_score': score}, 'noise': {'noise_score': score},
                'contrast': {'contrast_score': score},
                'subject': {'face_count': 0}, 'composition': {'composition_score': score},
            })
        return results, []


def _worker(tmp, drive, photos, edit=False):
    cfg = session_worker.SessionConfig.from_dict({
        'sourceFolderId': 'src1', 'albumId': 'alb1',
        'threshold': 0.6, 'edit': edit, 'pollSeconds': 1,
        'stagingRoot': tmp,
    })
    return session_worker.SessionWorker(
        cfg, token_provider=lambda: 'TOK',
        deps={'drive': drive, 'photos': photos, 'ranker': FakeRanker(), 'topaz': None})


def test_config_validation():
    try:
        session_worker.SessionConfig.from_dict({'albumId': 'a'})
    except ValueError:
        return
    raise AssertionError('missing sourceFolderId should raise')


def test_poll_publishes_above_threshold_and_writes_sidecars():
    with tempfile.TemporaryDirectory() as tmp:
        drive = FakeDrive({'keep_1.jpg': _jpeg_bytes(1), 'skip_1.jpg': _jpeg_bytes(2)})
        photos = FakePhotos()
        w = _worker(tmp, drive, photos)
        w.poll_once()
        assert ('alb1', 'keep_1.jpg') in photos.published
        assert all(name != 'skip_1.jpg' for _a, name in photos.published)
        sidecar_names = [f for _p, f, _d in drive.uploads if f.endswith('.bbp.json')]
        assert 'keep_1.jpg.bbp.json' in sidecar_names
        assert 'skip_1.jpg.bbp.json' in sidecar_names
        keep_sc = json.loads([d for _p, f, d in drive.uploads
                              if f == 'keep_1.jpg.bbp.json'][0])
        assert keep_sc['schema'] == 'bigbadphotos.processed.v1'
        assert keep_sc['exported'] is True
        assert keep_sc['published']['mediaItemId'] == 'm-keep_1.jpg'
        st = w.status()
        assert st['counts']['published'] == 1
        assert st['counts']['skipped'] == 1


def test_poll_skips_files_with_existing_sidecar():
    with tempfile.TemporaryDirectory() as tmp:
        drive = FakeDrive({'keep_1.jpg': _jpeg_bytes(1),
                           'keep_1.jpg.bbp.json': b'{}'})
        photos = FakePhotos()
        w = _worker(tmp, drive, photos)
        w.poll_once()
        assert photos.published == []


def test_second_poll_does_not_reprocess():
    with tempfile.TemporaryDirectory() as tmp:
        drive = FakeDrive({'keep_1.jpg': _jpeg_bytes(1)})
        photos = FakePhotos()
        w = _worker(tmp, drive, photos)
        w.poll_once()
        w.poll_once()
        assert len(photos.published) == 1


def test_photos_failure_counts_failed_and_writes_error_sidecar():
    with tempfile.TemporaryDirectory() as tmp:
        drive = FakeDrive({'keep_1.jpg': _jpeg_bytes(1)})
        class BrokenPhotos(FakePhotos):
            def upload_bytes(self, *a, **k):
                raise RuntimeError('photos down')
        w = _worker(tmp, drive, BrokenPhotos())
        w.poll_once()
        st = w.status()
        assert st['counts']['failed'] == 1
        sc = json.loads([d for _p, f, d in drive.uploads
                         if f == 'keep_1.jpg.bbp.json'][0])
        assert sc['exported'] is False
        assert 'photos down' in sc['pipeline_error']


def test_status_shape():
    with tempfile.TemporaryDirectory() as tmp:
        w = _worker(tmp, FakeDrive({}), FakePhotos())
        st = w.status()
        for key in ('running', 'phase', 'config', 'counts', 'lastPollAt', 'errors'):
            assert key in st
        for key in ('seen', 'scored', 'published', 'skipped', 'failed'):
            assert key in st['counts']


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
