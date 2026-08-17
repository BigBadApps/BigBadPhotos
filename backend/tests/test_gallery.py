import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from backend import db, gallery, sessions


@pytest.fixture(autouse=True)
def _tmp_db():
    with tempfile.TemporaryDirectory() as tmp:
        db.reset_for_tests(os.path.join(tmp, 'test.db'))
        yield


def _create_session(name: str = 'Test Session') -> dict:
    return sessions.create({'name': name, 'sourceFolderId': 'src', 'exportFolderId': 'exp'})


def _create_photo(session_id: int, filename: str = 'IMG_001.jpg', score: float = 0.85) -> int:
    conn = db.get()
    cur = conn.execute(
        "INSERT INTO runs (session_id, started_at, status) VALUES (?, '2026-08-17T00:00:00Z', 'completed')",
        (session_id,),
    )
    run_id = cur.lastrowid
    p_cur = conn.execute(
        """
        INSERT INTO photos (run_id, drive_file_id, filename, state, overall_score, claimed_at, updated_at)
        VALUES (?, ?, ?, 'exported', ?, '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z')
        """,
        (run_id, f'drive-{filename}', filename, score),
    )
    conn.commit()
    return p_cur.lastrowid


def test_create_and_get_token():
    sess = _create_session()
    tok = gallery.create_token(sess['id'], label='VIP Gallery', scope='exports')
    assert tok['id'] > 0
    assert tok['session_id'] == sess['id']
    assert tok['label'] == 'VIP Gallery'
    assert tok['scope'] == 'exports'
    assert tok['revoked'] is False
    assert len(tok['token']) >= 24

    fetched = gallery.get_token_by_value(tok['token'])
    assert fetched is not None
    assert fetched['id'] == tok['id']
    assert fetched['token'] == tok['token']


def test_get_token_by_value_nonexistent():
    assert gallery.get_token_by_value('non-existent-token') is None


def test_token_revocation():
    sess = _create_session()
    tok = gallery.create_token(sess['id'])
    assert gallery.get_token_by_value(tok['token']) is not None

    gallery.revoke_token(tok['id'])
    assert gallery.get_token_by_value(tok['token']) is None


def test_revoke_tokens_for_session():
    sess = _create_session()
    tok1 = gallery.create_token(sess['id'], label='Token 1')
    tok2 = gallery.create_token(sess['id'], label='Token 2')

    assert gallery.get_token_by_value(tok1['token']) is not None
    assert gallery.get_token_by_value(tok2['token']) is not None

    gallery.revoke_tokens_for_session(sess['id'])
    assert gallery.get_token_by_value(tok1['token']) is None
    assert gallery.get_token_by_value(tok2['token']) is None


def test_token_expiration():
    sess = _create_session()
    # Expired token in the past
    past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    tok_expired = gallery.create_token(sess['id'], expires_at=past)
    assert gallery.get_token_by_value(tok_expired['token']) is None

    # Future token
    future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    tok_future = gallery.create_token(sess['id'], expires_at=future)
    assert gallery.get_token_by_value(tok_future['token']) is not None


def test_get_tokens_for_session():
    sess1 = _create_session('Session 1')
    sess2 = _create_session('Session 2')

    # Note: sessions.create automatically creates 1 token per session
    toks1 = gallery.get_tokens_for_session(sess1['id'])
    assert len(toks1) == 1

    tok1_b = gallery.create_token(sess1['id'], label='Second Token')
    toks1_updated = gallery.get_tokens_for_session(sess1['id'])
    assert len(toks1_updated) == 2
    assert [t['id'] for t in toks1_updated] == [toks1[0]['id'], tok1_b['id']]

    toks2 = gallery.get_tokens_for_session(sess2['id'])
    assert len(toks2) == 1


def test_favorites_crud_and_idempotency():
    sess = _create_session()
    tok = gallery.get_tokens_for_session(sess['id'])[0]
    p1 = _create_photo(sess['id'], 'p1.jpg')
    p2 = _create_photo(sess['id'], 'p2.jpg')

    visitor_a = 'visitor-a'
    visitor_b = 'visitor-b'

    assert gallery.get_visitor_favorites(tok['id'], visitor_a) == []

    # Add favorites
    gallery.add_favorite(tok['id'], p1, visitor_a)
    gallery.add_favorite(tok['id'], p2, visitor_a)
    assert gallery.get_visitor_favorites(tok['id'], visitor_a) == [p1, p2]

    # Idempotent insert (no duplicate row or error)
    gallery.add_favorite(tok['id'], p1, visitor_a)
    assert gallery.get_visitor_favorites(tok['id'], visitor_a) == [p1, p2]

    # Different visitor
    gallery.add_favorite(tok['id'], p1, visitor_b)
    assert gallery.get_visitor_favorites(tok['id'], visitor_b) == [p1]

    # Remove favorite
    gallery.remove_favorite(tok['id'], p1, visitor_a)
    assert gallery.get_visitor_favorites(tok['id'], visitor_a) == [p2]
    assert gallery.get_visitor_favorites(tok['id'], visitor_b) == [p1]


def test_get_aggregated_favorites():
    sess = _create_session()
    tok = gallery.get_tokens_for_session(sess['id'])[0]
    p1 = _create_photo(sess['id'], 'photo1.jpg', score=0.92)
    p2 = _create_photo(sess['id'], 'photo2.jpg', score=0.88)
    p3 = _create_photo(sess['id'], 'photo3.jpg', score=0.75)

    # p2 favorited by 3 visitors, p1 favorited by 1 visitor, p3 favorited by 0
    gallery.add_favorite(tok['id'], p2, 'v1')
    gallery.add_favorite(tok['id'], p2, 'v2')
    gallery.add_favorite(tok['id'], p2, 'v3')
    gallery.add_favorite(tok['id'], p1, 'v1')

    agg = gallery.get_aggregated_favorites(sess['id'])
    assert len(agg) == 2
    assert agg[0]['photo_id'] == p2
    assert agg[0]['filename'] == 'photo2.jpg'
    assert agg[0]['favorite_count'] == 3
    assert agg[1]['photo_id'] == p1
    assert agg[1]['filename'] == 'photo1.jpg'
    assert agg[1]['favorite_count'] == 1


def test_comments_and_queries():
    sess = _create_session()
    tok = gallery.get_tokens_for_session(sess['id'])[0]
    p1 = _create_photo(sess['id'], 'photo1.jpg')
    p2 = _create_photo(sess['id'], 'photo2.jpg')

    # Gallery-level comment (photo_id=None)
    c_gal = gallery.add_comment(tok['id'], None, 'visitor-1', 'Great shoot!', 'Mom')
    assert c_gal['id'] > 0
    assert c_gal['photo_id'] is None
    assert c_gal['body'] == 'Great shoot!'
    assert c_gal['display_name'] == 'Mom'

    # Photo-level comments
    c_p1 = gallery.add_comment(tok['id'], p1, 'visitor-2', 'Love this angle', 'Dad')
    c_p2 = gallery.add_comment(tok['id'], p2, 'visitor-1', 'Lighting is perfect')

    # Query for gallery
    gal_comments = gallery.get_comments_for_gallery(tok['id'])
    assert len(gal_comments) == 3
    assert [c['id'] for c in gal_comments] == [c_gal['id'], c_p1['id'], c_p2['id']]

    # Query for specific photo
    p1_comments = gallery.get_comments_for_photo(tok['id'], p1)
    assert len(p1_comments) == 1
    assert p1_comments[0]['id'] == c_p1['id']
    assert p1_comments[0]['body'] == 'Love this angle'

    # Photographer all comments for session
    all_sess_comments = gallery.get_all_comments_for_session(sess['id'])
    assert len(all_sess_comments) == 3
    assert all_sess_comments[0]['filename'] is None  # gallery-level comment
    assert all_sess_comments[1]['filename'] == 'photo1.jpg'
    assert all_sess_comments[2]['filename'] == 'photo2.jpg'


def test_get_gallery_stats():
    sess = _create_session()
    tok = gallery.get_tokens_for_session(sess['id'])[0]
    p1 = _create_photo(sess['id'], 'photo1.jpg')
    p2 = _create_photo(sess['id'], 'photo2.jpg')

    stats_empty = gallery.get_gallery_stats(sess['id'])
    assert stats_empty['favorites_count'] == 0
    assert stats_empty['comments_count'] == 0
    assert stats_empty['unique_visitors'] == 0

    # Visitor 1: favorites p1 and p2, leaves a comment
    gallery.add_favorite(tok['id'], p1, 'v1')
    gallery.add_favorite(tok['id'], p2, 'v1')
    gallery.add_comment(tok['id'], p1, 'v1', 'Love it')

    # Visitor 2: favorites p1
    gallery.add_favorite(tok['id'], p1, 'v2')

    # Visitor 3: only leaves a comment (no favorites)
    gallery.add_comment(tok['id'], None, 'v3', 'Awesome gallery')

    stats = gallery.get_gallery_stats(sess['id'])
    assert stats['favorites_count'] == 3  # (v1, p1), (v1, p2), (v2, p1)
    assert stats['comments_count'] == 2   # v1, v3
    assert stats['unique_visitors'] == 3  # v1, v2, v3
