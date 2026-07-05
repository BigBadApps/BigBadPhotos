"""Autonomous session worker: Drive folder -> score -> (Topaz) -> Google Photos.

Runs as a daemon thread inside Flask (or standalone via __main__). All Google
traffic uses a token_provider callable (the refresh-token manager), so runs
survive access-token expiry. Dedupe ledger = .bbp.json sidecars in the Drive
source folder (shared schema with the browser autonomous mode) plus an
in-memory processed set.
"""
from __future__ import annotations

import json
import os
import threading
import time
import traceback
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from backend import google_drive, google_photos, scoring, topaz

SIDECAR_SUFFIX = '.bbp.json'
JPEG_EXTS = {'jpg', 'jpeg'}
DEFAULT_STAGING = os.path.join(os.path.expanduser('~'), '.bigbadphotos', 'sessions')
MAX_ERRORS_KEPT = 20
RANK_BATCH = 100


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def _read_iso(path: str) -> Optional[int]:
    """EXIF ISO via Pillow; None when unavailable."""
    try:
        from PIL import Image
        with Image.open(path) as im:
            exif = im.getexif()
            iso = exif.get(34855)  # ISOSpeedRatings
            return int(iso) if iso else None
    except Exception:
        return None


@dataclass
class SessionConfig:
    source_folder_id: str
    album_id: str
    threshold: float = 0.6
    edit: bool = True
    poll_seconds: int = 30
    staging_root: str = DEFAULT_STAGING

    @classmethod
    def from_dict(cls, data: dict) -> 'SessionConfig':
        src = (data.get('sourceFolderId') or '').strip()
        alb = (data.get('albumId') or '').strip()
        if not src:
            raise ValueError('sourceFolderId is required')
        if not alb:
            raise ValueError('albumId is required')
        threshold = float(data.get('threshold', 0.6))
        if not 0.0 <= threshold <= 1.0:
            raise ValueError('threshold must be between 0 and 1')
        poll = int(data.get('pollSeconds', 30))
        if poll < 1:
            raise ValueError('pollSeconds must be >= 1')
        return cls(
            source_folder_id=src,
            album_id=alb,
            threshold=threshold,
            edit=bool(data.get('edit', True)),
            poll_seconds=poll,
            staging_root=data.get('stagingRoot') or DEFAULT_STAGING,
        )

    def to_dict(self) -> dict:
        return {
            'sourceFolderId': self.source_folder_id,
            'albumId': self.album_id,
            'threshold': self.threshold,
            'edit': self.edit,
            'pollSeconds': self.poll_seconds,
        }


def build_sidecar(filename: str, result: dict, threshold: float, exported: bool,
                  published: dict | None = None, edit_info: dict | None = None,
                  pipeline_error: str | None = None) -> dict:
    """Python mirror of frontend/src/utils/bbpSidecar.js buildSidecarPayload."""
    payload = {
        'schema': 'bigbadphotos.processed.v1',
        'processed_at': _now_iso(),
        'filename': filename,
        'overall_score': result.get('overall_score'),
        'rank': result.get('rank'),
        'exported': exported,
        'threshold_used': threshold,
        'metrics': {
            'sharpness': result.get('sharpness'),
            'exposure': result.get('exposure'),
            'noise': result.get('noise'),
            'contrast': result.get('contrast'),
        },
        'subject': result.get('subject'),
        'composition': result.get('composition'),
        'burst_group': result.get('burst_group'),
        'burst_size': result.get('burst_size'),
        'is_burst_best': result.get('is_burst_best'),
    }
    if published:
        payload['published'] = published
    if edit_info:
        payload['edit'] = edit_info
    if pipeline_error:
        payload['pipeline_error'] = pipeline_error
    return payload


class SessionWorker:
    def __init__(self, config: SessionConfig, token_provider: Callable[[], str],
                 deps: dict[str, Any] | None = None):
        self.config = config
        self.token_provider = token_provider
        deps = deps or {}
        self._drive = deps.get('drive', google_drive)
        self._photos = deps.get('photos', google_photos)
        self._ranker = deps.get('ranker', scoring)
        self._topaz = deps.get('topaz', topaz)

        self._thread: threading.Thread | None = None
        self._stop_evt = threading.Event()
        self._lock = threading.Lock()
        self._processed: set[str] = set()

        self._phase = 'idle'
        self._counts = {'seen': 0, 'scored': 0, 'published': 0, 'skipped': 0, 'failed': 0}
        self._errors: list[str] = []
        self._last_poll_at: str | None = None

        self._session_id = datetime.now().strftime('%Y%m%d-%H%M%S')
        self._staging = os.path.join(os.path.expanduser(config.staging_root), self._session_id)

    # -- lifecycle ------------------------------------------------------------

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            raise RuntimeError('worker already running')
        self._stop_evt.clear()
        self._thread = threading.Thread(target=self._loop, name='bbp-session-worker', daemon=True)
        self._thread.start()

    def stop(self, wait: bool = True) -> None:
        self._stop_evt.set()
        if wait and self._thread and self._thread.is_alive():
            self._thread.join(timeout=10)
        self._set_phase('stopped')

    def status(self) -> dict:
        with self._lock:
            return {
                'running': bool(self._thread and self._thread.is_alive()
                                and not self._stop_evt.is_set()),
                'phase': self._phase,
                'config': self.config.to_dict(),
                'counts': dict(self._counts),
                'lastPollAt': self._last_poll_at,
                'errors': list(self._errors),
            }

    # -- internals ------------------------------------------------------------

    def _set_phase(self, phase: str) -> None:
        with self._lock:
            self._phase = phase

    def _add_error(self, msg: str) -> None:
        with self._lock:
            self._errors.append(msg)
            del self._errors[:-MAX_ERRORS_KEPT]

    def _bump(self, key: str, n: int = 1) -> None:
        with self._lock:
            self._counts[key] += n

    def _loop(self) -> None:
        while not self._stop_evt.is_set():
            try:
                self.poll_once()
            except google_photos.PhotosApiError as exc:
                if exc.status_code in (401, 403):
                    self._add_error(f'Google auth problem: {exc}')
                    self._set_phase('auth_error')
                    return
                self._add_error(str(exc))
            except Exception as exc:
                self._add_error(f'poll failed: {exc}')
                traceback.print_exc()
            if self._stop_evt.is_set():
                break
            self._set_phase('watching')
            self._stop_evt.wait(self.config.poll_seconds)
        self._set_phase('stopped')

    def poll_once(self) -> dict:
        """One pipeline pass. Public so tests drive it without threads."""
        self._set_phase('polling')
        with self._lock:
            self._last_poll_at = _now_iso()
        token = self.token_provider()

        listing = self._drive.list_all(token, self.config.source_folder_id)
        sidecars = {f['name'] for f in listing if f['name'].endswith(SIDECAR_SUFFIX)}
        candidates = []
        for f in listing:
            name = f['name']
            if name.endswith(SIDECAR_SUFFIX):
                continue
            ext = name.rsplit('.', 1)[-1].lower() if '.' in name else ''
            if ext not in JPEG_EXTS:
                continue
            if name in self._processed or f'{name}{SIDECAR_SUFFIX}' in sidecars:
                self._processed.add(name)
                continue
            candidates.append(f)

        if not candidates:
            return self.status()
        self._bump('seen', len(candidates))

        raw_dir = os.path.join(self._staging, 'raw')
        os.makedirs(raw_dir, exist_ok=True)

        tasks = []
        for f in candidates:
            try:
                data, name, _mime = self._drive.download_file(
                    token, f['id'], filename=f['name'], mime_type=f.get('mimeType'))
                local = os.path.join(raw_dir, name)
                with open(local, 'wb') as fh:
                    fh.write(data)
                tasks.append((f['id'], name, data))
            except Exception as exc:
                self._add_error(f'download failed for {f["name"]}: {exc}')
                self._processed.add(f['name'])

        for i in range(0, len(tasks), RANK_BATCH):
            if self._stop_evt.is_set():
                break
            self._process_batch(token, tasks[i:i + RANK_BATCH], raw_dir)
        return self.status()

    def _process_batch(self, token: str, tasks: list, raw_dir: str) -> None:
        self._set_phase('scoring')
        results, errors = self._ranker.rank_images(tasks)
        for e in errors:
            self._add_error(f'scoring failed for {e["filename"]}: {e["detail"]}')
            self._processed.add(e['filename'])
            self._bump('failed')
        self._bump('scored', len(results))

        for r in results:
            if self._stop_evt.is_set():
                return
            name = r['filename']
            qualifies = (isinstance(r.get('overall_score'), (int, float))
                         and r['overall_score'] >= self.config.threshold
                         and r.get('is_burst_best') is not False)
            published = None
            edit_info = None
            pipeline_error = None

            if qualifies:
                publish_path = os.path.join(raw_dir, name)
                publish_name = name
                if self.config.edit and self._topaz is not None:
                    self._set_phase('editing')
                    edited_dir = os.path.join(self._staging, 'edited')
                    enhancements = self._topaz.route_by_iso(_read_iso(publish_path))
                    try:
                        res = self._topaz.process(
                            inputs=[publish_path], output_dir=edited_dir,
                            enhancements=enhancements)
                        if res.ok and res.outputs:
                            publish_path = res.outputs[0]
                            publish_name = os.path.basename(publish_path)
                            edit_info = {'enhancements': enhancements,
                                         'edited_filename': publish_name,
                                         'edited_at': _now_iso(), 'status': 'ok'}
                        else:
                            edit_info = {'enhancements': enhancements,
                                         'status': 'failed',
                                         'detail': getattr(res, 'status', 'unknown')}
                            self._add_error(f'Topaz failed for {name}; publishing original')
                    except Exception as exc:
                        edit_info = {'enhancements': enhancements,
                                     'status': 'failed', 'detail': str(exc)}
                        self._add_error(f'Topaz error for {name}: {exc}; publishing original')

                self._set_phase('publishing')
                try:
                    with open(publish_path, 'rb') as fh:
                        payload = fh.read()
                    upload_token = self._photos.upload_bytes(
                        token, publish_name, payload)
                    created = self._photos.batch_create(token, self.config.album_id, [
                        {'uploadToken': upload_token, 'filename': publish_name,
                         'description': f'BigBadPhotos score {r["overall_score"]:.2f}'},
                    ])
                    first = created[0] if created else {'ok': False, 'error': 'no result'}
                    if first.get('ok'):
                        published = {'albumId': self.config.album_id,
                                     'mediaItemId': first.get('mediaItemId'),
                                     'publishedAt': _now_iso()}
                        self._bump('published')
                    else:
                        pipeline_error = f'photos rejected item: {first.get("error")}'
                        self._bump('failed')
                except google_photos.PhotosApiError as exc:
                    if exc.status_code in (401, 403):
                        raise  # handled by _loop -> auth_error phase
                    pipeline_error = str(exc)
                    self._bump('failed')
                    self._add_error(f'publish failed for {name}: {exc}')
                except Exception as exc:
                    pipeline_error = str(exc)
                    self._bump('failed')
                    self._add_error(f'publish failed for {name}: {exc}')
            else:
                self._bump('skipped')

            sidecar = build_sidecar(
                name, r, self.config.threshold,
                exported=bool(published), published=published,
                edit_info=edit_info, pipeline_error=pipeline_error)
            try:
                self._drive.upload_file(
                    token, self.config.source_folder_id,
                    f'{name}{SIDECAR_SUFFIX}',
                    json.dumps(sidecar, indent=2).encode('utf-8'),
                    'application/json')
            except Exception as exc:
                self._add_error(f'sidecar write failed for {name}: {exc}')
            self._processed.add(name)


# -- module singleton ---------------------------------------------------------

_current: SessionWorker | None = None
_current_lock = threading.Lock()


def start_worker(config: SessionConfig, token_provider: Callable[[], str]) -> SessionWorker:
    global _current
    with _current_lock:
        if _current is not None and _current.status()['running']:
            raise RuntimeError('a session is already running')
        _current = SessionWorker(config, token_provider)
        _current.start()
        return _current


def stop_worker() -> bool:
    with _current_lock:
        if _current is None:
            return False
        _current.stop(wait=True)
        return True


def worker_status() -> dict:
    with _current_lock:
        if _current is None:
            return {'running': False, 'phase': 'idle', 'config': None,
                    'counts': {'seen': 0, 'scored': 0, 'published': 0,
                               'skipped': 0, 'failed': 0},
                    'lastPollAt': None, 'errors': []}
        return _current.status()


if __name__ == '__main__':
    import argparse
    from backend import google_auth

    p = argparse.ArgumentParser(description='Run a BigBadPhotos session headless')
    p.add_argument('--config', required=True, help='path to session config JSON')
    args = p.parse_args()
    with open(args.config, 'r', encoding='utf-8') as f:
        cfg = SessionConfig.from_dict(json.load(f))
    mgr = google_auth.get_manager()
    if not mgr.available():
        raise SystemExit('no stored Google credentials -- connect via /google/oauth/start first')
    w = SessionWorker(cfg, mgr.get_access_token)
    w.start()
    print(f'session running (poll every {cfg.poll_seconds}s) -- Ctrl-C to stop')
    try:
        while True:
            time.sleep(5)
            print(json.dumps(w.status()['counts']))
    except KeyboardInterrupt:
        w.stop()
