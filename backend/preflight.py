"""Pre-run checks for a photo session, each with a named fix.

`run()` returns a list of `{'check', 'ok', 'detail', 'fix'}` entries and never
raises: an unexpected exception inside any single check becomes `ok=False` for
that check (exception text in `detail`) without stopping the other checks.
"""
from __future__ import annotations

import os
import shutil
import tempfile

from backend import db, google_auth, google_drive, topaz

FIX = {
    'google_auth': 'Open http://localhost:8001/google/oauth/start in a browser on the Mac Mini to reconnect Google.',
    'source_folder': 'Pick a different source folder, or confirm the inbox folder id in Settings.',
    'export_folder': 'Pick a different export folder, or create a new one from the session form.',
    'archive_folder': 'The _archive folder will be created on start; check that the sessions root folder is writable.',
    'topaz': 'Open Topaz Photo AI on the Mac Mini and sign in, then re-run preflight.',
    'imaging_libs': 'Reinstall dependencies: .venv/bin/python -m pip install -r requirements.txt',
    'disk_space': 'Free space on the volume holding ~/.bigbadphotos, or set BBP_STAGING_ROOT to a larger volume.',
    'database': 'Run: .venv/bin/python -c "from backend import db; db.migrate(db.connect())"',
}

TOPAZ_MISSING_FIX = "Set TOPAZ_BINARY, or switch this session's edit mode to Auto or Off."

MIN_FREE_BYTES = 5 * 1024 ** 3

_BBP_HOME = os.path.join(os.path.expanduser('~'), '.bigbadphotos')

_DEFAULT_DEPS = {'drive': google_drive, 'topaz': topaz, 'auth': google_auth}


def _guarded(check_id: str, fn) -> dict:
    try:
        entry = fn()
        entry.setdefault('check', check_id)
        return entry
    except Exception as exc:  # noqa: BLE001 - run() must never raise
        return {'check': check_id, 'ok': False, 'detail': str(exc), 'fix': FIX[check_id]}


def _check_google_auth(auth) -> dict:
    manager = auth.get_manager()
    if not manager.available():
        return {
            'ok': False,
            'detail': 'no stored Google credentials',
            'fix': FIX['google_auth'],
        }
    token = manager.get_access_token()
    if not token:
        return {
            'ok': False,
            'detail': 'Google refresh returned an empty access token',
            'fix': FIX['google_auth'],
        }
    return {'ok': True, 'detail': 'Google is connected'}


def _folder_entry(check_id: str, folder_id: str, meta: dict | None, require_can_add: bool) -> dict:
    if not meta or not meta.get('id'):
        return {'ok': False, 'detail': f'folder not found: {folder_id}', 'fix': FIX[check_id]}
    name = meta.get('name') or folder_id
    if meta.get('trashed'):
        return {'ok': False, 'detail': f'folder is in the trash: {name}', 'fix': FIX[check_id]}
    if require_can_add and not meta.get('canAddChildren'):
        return {'ok': False, 'detail': f'folder is not writable: {name}', 'fix': FIX[check_id]}
    return {'ok': True, 'detail': f'folder ok: {name}'}


def _check_source_folder(drive, session: dict, token_provider) -> dict:
    folder_id = session.get('sourceFolderId') or ''
    meta = drive.folder_meta(token_provider(), folder_id)
    return _folder_entry('source_folder', folder_id, meta, require_can_add=False)


def _check_export_folder(drive, session: dict, token_provider) -> dict:
    folder_id = session.get('exportFolderId') or ''
    meta = drive.folder_meta(token_provider(), folder_id)
    return _folder_entry('export_folder', folder_id, meta, require_can_add=True)


def _check_archive_folder(drive, session: dict, token_provider) -> dict:
    folder_id = session.get('archiveFolderId')
    if not folder_id:
        return {'ok': True, 'detail': 'The _archive folder will be created on start.'}
    meta = drive.folder_meta(token_provider(), folder_id)
    return _folder_entry('archive_folder', folder_id, meta, require_can_add=True)


def _check_topaz(topaz_module, session: dict) -> dict:
    """Binary present (cheap) then a real license probe via the CLI.

    The only way to observe Topaz's exit 254 (license check) is to invoke the
    binary, so the probe runs `--skipProcessing` on a throwaway 16x16 JPEG —
    the license check happens at startup, before any GPU work, and a signed-in
    install returns exit 0 within a few seconds. Tests inject a fake `topaz`
    dep, so they never touch the real binary.
    """
    try:
        topaz_module.resolve_binary()
    except Exception as exc:  # noqa: BLE001 - binary missing/not executable
        return {'ok': False, 'detail': str(exc), 'fix': TOPAZ_MISSING_FIX}

    from PIL import Image

    with tempfile.TemporaryDirectory() as tmp:
        probe = os.path.join(tmp, 'probe.jpg')
        Image.new('RGB', (16, 16), (128, 128, 128)).save(probe, 'JPEG')
        result = topaz_module.process(
            inputs=[probe], output_dir=tmp, skip_processing=True, timeout_s=90,
        )

    if result.exit_code == 254:
        return {
            'ok': False,
            'detail': 'Topaz is not signed in (exit 254) — open the app and sign in.',
            'fix': FIX['topaz'],
        }
    if result.ok:
        return {'ok': True, 'detail': f'topaz is ready (exit {result.exit_code})'}
    return {'ok': False, 'detail': result.detail, 'fix': FIX['topaz']}


def _imaging_import():
    import cv2
    from PIL import Image
    return cv2, Image


def _check_imaging_libs() -> dict:
    try:
        cv2, _image = _imaging_import()
        cascade = os.path.join(
            cv2.data.haarcascades, 'haarcascade_frontalface_default.xml')
        if not os.path.isfile(cascade):
            return {
                'ok': False,
                'detail': f'missing face cascade: {cascade}',
                'fix': FIX['imaging_libs'],
            }
        return {'ok': True, 'detail': 'opencv, pillow, and face cascades ok'}
    except Exception as exc:  # noqa: BLE001 - broken install
        return {'ok': False, 'detail': str(exc), 'fix': FIX['imaging_libs']}


def _check_disk_space() -> dict:
    os.makedirs(_BBP_HOME, exist_ok=True)
    usage = shutil.disk_usage(_BBP_HOME)
    free_gb = usage.free / (1024 ** 3)
    if usage.free > MIN_FREE_BYTES:
        return {'ok': True, 'detail': f'{free_gb:.1f} GB free on {_BBP_HOME}'}
    return {
        'ok': False,
        'detail': f'only {free_gb:.1f} GB free on {_BBP_HOME}',
        'fix': FIX['disk_space'],
    }


def _check_database() -> dict:
    conn = db.connect()
    try:
        version = db.migrate(conn)
    finally:
        conn.close()
    return {'ok': True, 'detail': f'database reachable and writable (schema v{version})'}


def run(
    session: dict,
    token_provider,
    deps: dict | None = None,
) -> list[dict]:
    """Run every preflight check for `session` and return the results.

    `deps` defaults to the real modules and accepts fakes under the keys
    `drive`, `topaz`, and `auth`. The `topaz` check is omitted entirely unless
    `session['editMode'] == 'topaz'`.
    """
    merged = {**_DEFAULT_DEPS, **(deps or {})}

    results = [
        _guarded('google_auth', lambda: _check_google_auth(merged['auth'])),
        _guarded('source_folder', lambda: _check_source_folder(
            merged['drive'], session, token_provider)),
        _guarded('export_folder', lambda: _check_export_folder(
            merged['drive'], session, token_provider)),
        _guarded('archive_folder', lambda: _check_archive_folder(
            merged['drive'], session, token_provider)),
    ]

    if session.get('editMode') == 'topaz':
        results.append(_guarded('topaz', lambda: _check_topaz(merged['topaz'], session)))

    results.append(_guarded('imaging_libs', _check_imaging_libs))
    results.append(_guarded('disk_space', _check_disk_space))
    results.append(_guarded('database', _check_database))
    return results
