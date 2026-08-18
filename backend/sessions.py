"""Named session configs and app-wide settings, backed by backend.db."""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone

from backend import db

PRESETS: dict[str, float] = {'strict': 0.72, 'balanced': 0.60, 'loose': 0.45}
EDIT_MODES = ('off', 'auto', 'topaz')
STRENGTHS = ('light', 'medium')


class SessionError(ValueError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def _row_to_dict(row: sqlite3.Row) -> dict:
    return {
        'id': row['id'],
        'name': row['name'],
        'sourceFolderId': row['source_folder_id'],
        'sourceFolderName': row['source_folder_name'],
        'exportFolderId': row['export_folder_id'],
        'exportFolderName': row['export_folder_name'],
        'archiveFolderId': row['archive_folder_id'],
        'autonomous': bool(row['autonomous']),
        'preset': row['preset'],
        'threshold': row['threshold'],
        'burstBestOnly': bool(row['burst_best_only']),
        'editMode': row['edit_mode'],
        'editStrength': row['edit_strength'],
        'pollSeconds': row['poll_seconds'],
        'galleryEnabled': bool(row['gallery_enabled']) if row['gallery_enabled'] is not None else True,
        'favoritesFolderId': row['favorites_folder_id'],
        'favoritesFolderName': row['favorites_folder_name'],
        'createdAt': row['created_at'],
        'updatedAt': row['updated_at'],
    }


def _validate(merged: dict) -> dict:
    name = str(merged.get('name', '')).strip()
    source_folder_id = str(merged.get('sourceFolderId', '')).strip()
    export_folder_id = str(merged.get('exportFolderId', '')).strip()
    if not name:
        raise SessionError('name is required')
    if not source_folder_id:
        raise SessionError('sourceFolderId is required')
    if not export_folder_id:
        raise SessionError('exportFolderId is required')

    preset = merged.get('preset', 'balanced')
    threshold_explicit = merged.get('threshold', None)
    if threshold_explicit is not None:
        preset = 'custom'
        threshold = float(threshold_explicit)
    elif preset in PRESETS:
        threshold = PRESETS[preset]
    else:
        threshold = float(merged.get('threshold', PRESETS['balanced']))

    if not (0.0 <= threshold <= 1.0):
        raise SessionError('threshold must be between 0.0 and 1.0')

    poll_seconds = int(merged.get('pollSeconds', 30))
    if poll_seconds < 1:
        raise SessionError('pollSeconds must be >= 1')

    edit_mode = merged.get('editMode', 'off')
    if edit_mode not in EDIT_MODES:
        raise SessionError(f'editMode must be one of {EDIT_MODES}')

    edit_strength = merged.get('editStrength', 'medium')
    if edit_strength not in STRENGTHS:
        raise SessionError(f'editStrength must be one of {STRENGTHS}')

    gallery_enabled = merged.get('galleryEnabled')
    if gallery_enabled is None:
        gallery_enabled = merged.get('gallery_enabled', True)
    gallery_enabled = bool(gallery_enabled)

    favorites_folder_id = merged.get('favoritesFolderId', merged.get('favorites_folder_id'))
    if favorites_folder_id is not None:
        favorites_folder_id = str(favorites_folder_id).strip() or None

    favorites_folder_name = merged.get('favoritesFolderName', merged.get('favorites_folder_name'))
    if favorites_folder_name is not None:
        favorites_folder_name = str(favorites_folder_name).strip() or None

    return {
        'name': name,
        'sourceFolderId': source_folder_id,
        'sourceFolderName': merged.get('sourceFolderName'),
        'exportFolderId': export_folder_id,
        'exportFolderName': merged.get('exportFolderName'),
        'archiveFolderId': merged.get('archiveFolderId'),
        'autonomous': bool(merged.get('autonomous', False)),
        'preset': preset,
        'threshold': threshold,
        'burstBestOnly': bool(merged.get('burstBestOnly', True)),
        'editMode': edit_mode,
        'editStrength': edit_strength,
        'pollSeconds': poll_seconds,
        'galleryEnabled': gallery_enabled,
        'favoritesFolderId': favorites_folder_id,
        'favoritesFolderName': favorites_folder_name,
    }


def create(data: dict) -> dict:
    validated = _validate(data)
    now = _now()
    conn = db.get()
    try:
        cur = conn.execute(
            "INSERT INTO sessions (name, source_folder_id, source_folder_name,"
            " export_folder_id, export_folder_name, archive_folder_id,"
            " autonomous, preset, threshold, burst_best_only, edit_mode,"
            " edit_strength, poll_seconds, gallery_enabled, favorites_folder_id,"
            " favorites_folder_name, created_at, updated_at) VALUES"
            " (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                validated['name'],
                validated['sourceFolderId'],
                validated['sourceFolderName'],
                validated['exportFolderId'],
                validated['exportFolderName'],
                validated['archiveFolderId'],
                int(validated['autonomous']),
                validated['preset'],
                validated['threshold'],
                int(validated['burstBestOnly']),
                validated['editMode'],
                validated['editStrength'],
                validated['pollSeconds'],
                int(validated['galleryEnabled']),
                validated['favoritesFolderId'],
                validated['favoritesFolderName'],
                now,
                now,
            ),
        )
        conn.commit()
    except sqlite3.IntegrityError as exc:
        conn.rollback()
        raise SessionError(f'session name already exists: {validated["name"]}') from exc

    session_id = cur.lastrowid
    from backend import gallery
    token_obj = gallery.create_token(session_id)
    session_dict = get(session_id)
    if session_dict is not None and token_obj:
        session_dict['gallery_token'] = token_obj['token']
        session_dict['galleryToken'] = token_obj['token']
        session_dict['gallery_url'] = f"/gallery/{token_obj['token']}"
        session_dict['galleryUrl'] = f"/gallery/{token_obj['token']}"
    return session_dict


def get(session_id: int) -> dict | None:
    conn = db.get()
    row = conn.execute('SELECT * FROM sessions WHERE id = ?', (session_id,)).fetchone()
    return _row_to_dict(row) if row else None


def list_all() -> list[dict]:
    conn = db.get()
    rows = conn.execute('SELECT * FROM sessions ORDER BY id').fetchall()
    return [_row_to_dict(row) for row in rows]


def update(session_id: int, data: dict) -> dict:
    existing = get(session_id)
    if existing is None:
        raise SessionError(f'session not found: {session_id}')

    merged = dict(existing)
    merged.update(data)

    if 'threshold' not in data:
        # No explicit threshold in this call. If the (possibly newly chosen)
        # preset is a known preset, let _validate() derive the threshold from
        # it. Otherwise (session is/stays 'custom'), carry the existing
        # explicit threshold forward so it isn't lost.
        current_preset = data.get('preset', existing['preset'])
        if current_preset in PRESETS:
            merged.pop('threshold', None)
        else:
            merged['threshold'] = existing['threshold']

    validated = _validate(merged)

    now = _now()
    conn = db.get()
    try:
        conn.execute(
            "UPDATE sessions SET name=?, source_folder_id=?, source_folder_name=?,"
            " export_folder_id=?, export_folder_name=?, archive_folder_id=?,"
            " autonomous=?, preset=?, threshold=?, burst_best_only=?,"
            " edit_mode=?, edit_strength=?, poll_seconds=?, gallery_enabled=?,"
            " favorites_folder_id=?, favorites_folder_name=?, updated_at=?"
            " WHERE id=?",
            (
                validated['name'],
                validated['sourceFolderId'],
                validated['sourceFolderName'],
                validated['exportFolderId'],
                validated['exportFolderName'],
                validated['archiveFolderId'],
                int(validated['autonomous']),
                validated['preset'],
                validated['threshold'],
                int(validated['burstBestOnly']),
                validated['editMode'],
                validated['editStrength'],
                validated['pollSeconds'],
                int(validated['galleryEnabled']),
                validated['favoritesFolderId'],
                validated['favoritesFolderName'],
                now,
                session_id,
            ),
        )
        conn.commit()
    except sqlite3.IntegrityError as exc:
        conn.rollback()
        raise SessionError(f'session name already exists: {validated["name"]}') from exc
    return get(session_id)


def delete(session_id: int) -> None:
    conn = db.get()
    conn.execute('DELETE FROM sessions WHERE id = ?', (session_id,))
    conn.commit()


def get_setting(key: str) -> str | None:
    conn = db.get()
    row = conn.execute('SELECT value FROM app_settings WHERE key = ?', (key,)).fetchone()
    return row['value'] if row else None


def set_setting(key: str, value: str) -> None:
    conn = db.get()
    conn.execute(
        'INSERT INTO app_settings (key, value) VALUES (?, ?)'
        ' ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        (key, value),
    )
    conn.commit()
