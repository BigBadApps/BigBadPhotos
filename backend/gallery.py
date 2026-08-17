"""Gallery tokens, client favorites, comments, and stats data access."""
from __future__ import annotations

import secrets
import sqlite3
from datetime import datetime, timezone

from backend import db


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def _is_expired(expires_at: str | None) -> bool:
    if not expires_at:
        return False
    try:
        clean = expires_at.replace('Z', '+00:00')
        exp_dt = datetime.fromisoformat(clean)
        if exp_dt.tzinfo is None:
            exp_dt = exp_dt.replace(tzinfo=timezone.utc)
        return datetime.now(timezone.utc) > exp_dt
    except Exception:
        return True


def _token_to_dict(row: sqlite3.Row) -> dict:
    return {
        'id': row['id'],
        'session_id': row['session_id'],
        'sessionId': row['session_id'],
        'token': row['token'],
        'label': row['label'],
        'scope': row['scope'],
        'expires_at': row['expires_at'],
        'expiresAt': row['expires_at'],
        'revoked': bool(row['revoked']),
        'created_at': row['created_at'],
        'createdAt': row['created_at'],
        'updated_at': row['updated_at'],
        'updatedAt': row['updated_at'],
    }


def _comment_to_dict(row: sqlite3.Row) -> dict:
    d = {
        'id': row['id'],
        'token_id': row['token_id'],
        'tokenId': row['token_id'],
        'photo_id': row['photo_id'],
        'photoId': row['photo_id'],
        'visitor_id': row['visitor_id'],
        'visitorId': row['visitor_id'],
        'display_name': row['display_name'],
        'displayName': row['display_name'],
        'body': row['body'],
        'created_at': row['created_at'],
        'createdAt': row['created_at'],
    }
    if 'filename' in row.keys():
        d['filename'] = row['filename']
    return d


# ---------------------------------------------------------------------------
# Token management
# ---------------------------------------------------------------------------


def create_token(
    session_id: int,
    label: str = 'Main Gallery',
    scope: str = 'exports',
    expires_at: str | None = None,
) -> dict:
    token_value = secrets.token_urlsafe(24)
    now = _now()
    conn = db.get()
    cur = conn.execute(
        "INSERT INTO gallery_tokens (session_id, token, label, scope, expires_at, revoked, created_at, updated_at)"
        " VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
        (session_id, token_value, label, scope, expires_at, now, now),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM gallery_tokens WHERE id = ?", (cur.lastrowid,)).fetchone()
    return _token_to_dict(row)


def get_token_by_value(token_value: str) -> dict | None:
    conn = db.get()
    row = conn.execute("SELECT * FROM gallery_tokens WHERE token = ?", (token_value,)).fetchone()
    if not row:
        return None
    if bool(row['revoked']):
        return None
    if _is_expired(row['expires_at']):
        return None
    return _token_to_dict(row)


def get_tokens_for_session(session_id: int) -> list[dict]:
    conn = db.get()
    rows = conn.execute(
        "SELECT * FROM gallery_tokens WHERE session_id = ? ORDER BY id ASC",
        (session_id,),
    ).fetchall()
    return [_token_to_dict(r) for r in rows]


def revoke_token(token_id: int) -> None:
    now = _now()
    conn = db.get()
    conn.execute(
        "UPDATE gallery_tokens SET revoked = 1, updated_at = ? WHERE id = ?",
        (now, token_id),
    )
    conn.commit()


def revoke_tokens_for_session(session_id: int) -> None:
    now = _now()
    conn = db.get()
    conn.execute(
        "UPDATE gallery_tokens SET revoked = 1, updated_at = ? WHERE session_id = ?",
        (now, session_id),
    )
    conn.commit()


# ---------------------------------------------------------------------------
# Favorites
# ---------------------------------------------------------------------------


def add_favorite(token_id: int, photo_id: int, visitor_id: str) -> None:
    now = _now()
    conn = db.get()
    conn.execute(
        "INSERT OR IGNORE INTO gallery_favorites (token_id, photo_id, visitor_id, created_at)"
        " VALUES (?, ?, ?, ?)",
        (token_id, photo_id, visitor_id, now),
    )
    conn.commit()


def remove_favorite(token_id: int, photo_id: int, visitor_id: str) -> None:
    conn = db.get()
    conn.execute(
        "DELETE FROM gallery_favorites WHERE token_id = ? AND photo_id = ? AND visitor_id = ?",
        (token_id, photo_id, visitor_id),
    )
    conn.commit()


def get_visitor_favorites(token_id: int, visitor_id: str) -> list[int]:
    conn = db.get()
    rows = conn.execute(
        "SELECT photo_id FROM gallery_favorites WHERE token_id = ? AND visitor_id = ? ORDER BY id ASC",
        (token_id, visitor_id),
    ).fetchall()
    return [r['photo_id'] for r in rows]


def get_aggregated_favorites(session_id: int) -> list[dict]:
    conn = db.get()
    rows = conn.execute(
        """
        SELECT 
            p.id AS photo_id,
            p.filename,
            p.drive_file_id,
            p.overall_score,
            COUNT(f.id) AS favorite_count
        FROM gallery_favorites f
        JOIN gallery_tokens t ON f.token_id = t.id
        JOIN photos p ON f.photo_id = p.id
        WHERE t.session_id = ?
        GROUP BY p.id, p.filename, p.drive_file_id, p.overall_score
        ORDER BY favorite_count DESC, p.id ASC
        """,
        (session_id,),
    ).fetchall()
    return [
        {
            'photo_id': r['photo_id'],
            'photoId': r['photo_id'],
            'filename': r['filename'],
            'drive_file_id': r['drive_file_id'],
            'driveFileId': r['drive_file_id'],
            'overall_score': r['overall_score'],
            'overallScore': r['overall_score'],
            'favorite_count': r['favorite_count'],
            'favoriteCount': r['favorite_count'],
        }
        for r in rows
    ]


# ---------------------------------------------------------------------------
# Comments
# ---------------------------------------------------------------------------


def add_comment(
    token_id: int,
    photo_id: int | None,
    visitor_id: str,
    body: str,
    display_name: str | None = None,
) -> dict:
    now = _now()
    conn = db.get()
    cur = conn.execute(
        "INSERT INTO gallery_comments (token_id, photo_id, visitor_id, display_name, body, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (token_id, photo_id, visitor_id, display_name, body, now),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM gallery_comments WHERE id = ?", (cur.lastrowid,)).fetchone()
    return _comment_to_dict(row)


def get_comments_for_gallery(token_id: int) -> list[dict]:
    conn = db.get()
    rows = conn.execute(
        "SELECT * FROM gallery_comments WHERE token_id = ? ORDER BY created_at ASC, id ASC",
        (token_id,),
    ).fetchall()
    return [_comment_to_dict(r) for r in rows]


def get_comments_for_photo(token_id: int, photo_id: int) -> list[dict]:
    conn = db.get()
    rows = conn.execute(
        "SELECT * FROM gallery_comments WHERE token_id = ? AND photo_id = ? ORDER BY created_at ASC, id ASC",
        (token_id, photo_id),
    ).fetchall()
    return [_comment_to_dict(r) for r in rows]


def get_all_comments_for_session(session_id: int) -> list[dict]:
    conn = db.get()
    rows = conn.execute(
        """
        SELECT 
            c.id,
            c.token_id,
            c.photo_id,
            c.visitor_id,
            c.display_name,
            c.body,
            c.created_at,
            p.filename
        FROM gallery_comments c
        JOIN gallery_tokens t ON c.token_id = t.id
        LEFT JOIN photos p ON c.photo_id = p.id
        WHERE t.session_id = ?
        ORDER BY c.created_at ASC, c.id ASC
        """,
        (session_id,),
    ).fetchall()
    return [_comment_to_dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------


def get_gallery_stats(session_id: int) -> dict:
    conn = db.get()
    fav_row = conn.execute(
        """
        SELECT COUNT(f.id) FROM gallery_favorites f
        JOIN gallery_tokens t ON f.token_id = t.id
        WHERE t.session_id = ?
        """,
        (session_id,),
    ).fetchone()
    favorites_count = fav_row[0] if fav_row else 0

    com_row = conn.execute(
        """
        SELECT COUNT(c.id) FROM gallery_comments c
        JOIN gallery_tokens t ON c.token_id = t.id
        WHERE t.session_id = ?
        """,
        (session_id,),
    ).fetchone()
    comments_count = com_row[0] if com_row else 0

    vis_row = conn.execute(
        """
        SELECT COUNT(DISTINCT visitor_id) FROM (
            SELECT f.visitor_id FROM gallery_favorites f
            JOIN gallery_tokens t ON f.token_id = t.id
            WHERE t.session_id = ?
            UNION
            SELECT c.visitor_id FROM gallery_comments c
            JOIN gallery_tokens t ON c.token_id = t.id
            WHERE t.session_id = ?
        )
        """,
        (session_id, session_id),
    ).fetchone()
    unique_visitors = vis_row[0] if vis_row else 0

    return {
        'favorites_count': favorites_count,
        'favoritesCount': favorites_count,
        'comments_count': comments_count,
        'commentsCount': comments_count,
        'unique_visitors': unique_visitors,
        'uniqueVisitors': unique_visitors,
    }
