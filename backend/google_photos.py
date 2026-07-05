"""Google Photos Library API helpers (post-2025 API: app-created content only).

Mirrors backend/google_drive.py: plain requests + bearer token. The API can
only list albums this app created and only add media to app-created albums —
that is a Google policy, not a bug.
"""
from __future__ import annotations

from typing import Any

import requests

PHOTOS_API = 'https://photoslibrary.googleapis.com/v1'
BATCH_LIMIT = 50  # mediaItems:batchCreate hard cap


class PhotosApiError(RuntimeError):
    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


def _headers(access_token: str) -> dict[str, str]:
    return {'Authorization': f'Bearer {access_token}'}


def _error_detail(resp) -> str:
    try:
        return resp.json().get('error', {}).get('message', resp.text)
    except ValueError:
        return resp.text


def list_albums(access_token: str) -> list[dict[str, Any]]:
    """All albums created by this app (the API returns no others)."""
    albums: list[dict[str, Any]] = []
    params: dict[str, Any] = {'pageSize': 50}
    while True:
        resp = requests.get(f'{PHOTOS_API}/albums', headers=_headers(access_token),
                            params=params, timeout=30)
        if not resp.ok:
            raise PhotosApiError(_error_detail(resp), resp.status_code)
        payload = resp.json()
        albums.extend(payload.get('albums', []))
        token = payload.get('nextPageToken')
        if not token:
            break
        params['pageToken'] = token
    return albums


def create_album(access_token: str, title: str) -> dict[str, Any]:
    resp = requests.post(f'{PHOTOS_API}/albums', headers=_headers(access_token),
                         json={'album': {'title': title}}, timeout=30)
    if not resp.ok:
        raise PhotosApiError(_error_detail(resp), resp.status_code)
    return resp.json()


def upload_bytes(access_token: str, filename: str, data: bytes,
                 mime_type: str = 'image/jpeg') -> str:
    """Upload raw bytes; returns an upload token for batch_create."""
    headers = {
        **_headers(access_token),
        'Content-Type': 'application/octet-stream',
        'X-Goog-Upload-Content-Type': mime_type,
        'X-Goog-Upload-Protocol': 'raw',
    }
    resp = requests.post(f'{PHOTOS_API}/uploads', headers=headers, data=data, timeout=180)
    if not resp.ok:
        raise PhotosApiError(_error_detail(resp), resp.status_code)
    token = resp.text.strip()
    if not token:
        raise PhotosApiError('empty upload token from Photos API')
    return token


def batch_create(access_token: str, album_id: str | None,
                 items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Create media items from upload tokens, optionally into an app-created album.

    items: [{'uploadToken': str, 'filename': str, 'description': str?}, ...]
    Returns one result per item, order preserved:
      {'filename': str, 'ok': bool, 'mediaItemId': str?, 'error': str?}
    """
    results: list[dict[str, Any]] = []
    for i in range(0, len(items), BATCH_LIMIT):
        chunk = items[i:i + BATCH_LIMIT]
        body: dict[str, Any] = {
            'newMediaItems': [
                {
                    'description': it.get('description', ''),
                    'simpleMediaItem': {
                        'fileName': it['filename'],
                        'uploadToken': it['uploadToken'],
                    },
                }
                for it in chunk
            ],
        }
        if album_id:
            body['albumId'] = album_id
        resp = requests.post(f'{PHOTOS_API}/mediaItems:batchCreate',
                             headers=_headers(access_token), json=body, timeout=120)
        if not resp.ok:
            raise PhotosApiError(_error_detail(resp), resp.status_code)
        item_results = resp.json().get('newMediaItemResults', [])
        for it, res in zip(chunk, item_results):
            status = res.get('status', {})
            ok = status.get('message', '').lower() == 'success' or 'code' not in status
            entry: dict[str, Any] = {'filename': it['filename'], 'ok': ok}
            if ok and res.get('mediaItem', {}).get('id'):
                entry['mediaItemId'] = res['mediaItem']['id']
            if not ok:
                entry['error'] = status.get('message', 'unknown error')
            results.append(entry)
    return results
