"""Shared ingest pipeline — convergence point for HTTP and FTP input paths."""
from __future__ import annotations

import logging
import sqlite3

from backend import db
from backend import google_drive

logger = logging.getLogger(__name__)

ALLOWED_EXTENSIONS = {
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'heif', 'heic',
}


def _get_extension(filename: str) -> str:
    return filename.rsplit('.', 1)[-1].lower() if '.' in filename else ''


def _resolve_session(session_id: int | None) -> dict | None:
    conn = db.get()
    if session_id is not None:
        row = conn.execute('SELECT * FROM sessions WHERE id = ?', (session_id,)).fetchone()
        return dict(row) if row else None

    row = conn.execute('SELECT * FROM sessions WHERE ingest_active = 1').fetchone()
    return dict(row) if row else None


def _check_existing(session_id: int, filename: str) -> dict | None:
    conn = db.get()
    row = conn.execute(
        'SELECT * FROM ingest_log WHERE session_id = ? AND filename = ?',
        (str(session_id), filename),
    ).fetchone()
    return dict(row) if row else None


def ingest_file(
    data: bytes,
    *,
    filename: str,
    session_id: int | None = None,
    source: str = 'http',
    access_token: str | None = None,
) -> dict:
    session_row = _resolve_session(session_id)
    if not session_row:
        return {
            'status': 'failed',
            'filename': filename,
            'drive_file_id': None,
            'session_id': session_id,
            'error': 'No active ingest session found',
        }

    sid = session_row['id']
    folder_id = session_row.get('ingest_folder_id')
    if not folder_id:
        return {
            'status': 'failed',
            'filename': filename,
            'drive_file_id': None,
            'session_id': sid,
            'error': 'Session has no ingest Drive folder configured',
        }

    existing = _check_existing(sid, filename)
    if existing and existing['drive_status'] == 'uploaded':
        return {
            'status': 'exists',
            'filename': filename,
            'drive_file_id': existing['drive_file_id'],
            'session_id': sid,
            'error': None,
        }

    conn = db.get()
    try:
        conn.execute(
            'INSERT INTO ingest_log (session_id, filename, source, file_size)'
            ' VALUES (?, ?, ?, ?)',
            (str(sid), filename, source, len(data)),
        )
        conn.commit()
    except sqlite3.IntegrityError:
        # A row for this (session, filename) already exists. Only a 'failed'
        # row is safe to retry — claim it atomically so two concurrent
        # requests can't both proceed to upload_file for the same filename.
        cur = conn.execute(
            "UPDATE ingest_log SET drive_status = 'pending', error_detail = NULL"
            " WHERE session_id = ? AND filename = ? AND drive_status = 'failed'",
            (str(sid), filename),
        )
        conn.commit()
        if cur.rowcount == 0:
            existing = _check_existing(sid, filename)
            if existing and existing['drive_status'] == 'uploaded':
                return {
                    'status': 'exists',
                    'filename': filename,
                    'drive_file_id': existing['drive_file_id'],
                    'session_id': sid,
                    'error': None,
                }
            # Still 'pending' under another in-flight request — don't race
            # it to Drive; that request owns this filename's upload.
            return {
                'status': 'failed',
                'filename': filename,
                'drive_file_id': None,
                'session_id': sid,
                'error': 'Ingest already in progress for this filename',
            }

    if not access_token:
        from backend import google_auth
        mgr = google_auth._manager
        if mgr and mgr.available():
            access_token = mgr.get_access_token()

    if not access_token:
        _mark_failed(sid, filename, 'No Google OAuth token available')
        return {
            'status': 'failed',
            'filename': filename,
            'drive_file_id': None,
            'session_id': sid,
            'error': 'No Google OAuth token available',
        }

    try:
        result = google_drive.upload_file(access_token, folder_id, filename, data)
        drive_file_id = result.get('id')
        conn.execute(
            'UPDATE ingest_log SET drive_status = ?, drive_file_id = ?'
            ' WHERE session_id = ? AND filename = ?',
            ('uploaded', drive_file_id, str(sid), filename),
        )
        conn.commit()
        logger.info(f'Ingested {filename} -> Drive {drive_file_id}')
        return {
            'status': 'uploaded',
            'filename': filename,
            'drive_file_id': drive_file_id,
            'session_id': sid,
            'error': None,
        }
    except Exception as exc:
        error_msg = str(exc)
        _mark_failed(sid, filename, error_msg)
        logger.error(f'Ingest failed {filename}: {error_msg}')
        return {
            'status': 'failed',
            'filename': filename,
            'drive_file_id': None,
            'session_id': sid,
            'error': error_msg,
        }


def _mark_failed(session_id: int, filename: str, error: str) -> None:
    conn = db.get()
    conn.execute(
        'UPDATE ingest_log SET drive_status = ?, error_detail = ?'
        ' WHERE session_id = ? AND filename = ?',
        ('failed', error, str(session_id), filename),
    )
    conn.commit()


def get_ingest_stats(session_id: int) -> dict:
    conn = db.get()
    rows = conn.execute(
        'SELECT drive_status, COUNT(*) as cnt FROM ingest_log'
        ' WHERE session_id = ? GROUP BY drive_status',
        (str(session_id),),
    ).fetchall()
    stats = {'total': 0, 'uploaded': 0, 'failed': 0, 'pending': 0}
    for row in rows:
        stats[row['drive_status']] = row['cnt']
        stats['total'] += row['cnt']
    return stats


def get_recent_ingests(session_id: int, limit: int = 10) -> list[dict]:
    conn = db.get()
    rows = conn.execute(
        'SELECT filename, source, drive_status, drive_file_id, error_detail, created_at'
        ' FROM ingest_log WHERE session_id = ? ORDER BY created_at DESC LIMIT ?',
        (str(session_id), limit),
    ).fetchall()
    return [dict(r) for r in rows]


def retry_failed(session_id: int, access_token: str) -> list[dict]:
    conn = db.get()
    rows = conn.execute(
        "SELECT * FROM ingest_log WHERE session_id = ? AND drive_status = 'failed'",
        (str(session_id),),
    ).fetchall()
    results = []
    for row in rows:
        results.append({
            'filename': row['filename'],
            'status': 'retry_not_implemented',
        })
    return results
