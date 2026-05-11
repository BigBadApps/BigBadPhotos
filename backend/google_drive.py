"""Google Drive helpers for folder browse, download, and upload."""

from __future__ import annotations

import io
import mimetypes
from typing import Any

import requests

DRIVE_API = 'https://www.googleapis.com/drive/v3'
DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3'

IMAGE_EXTENSIONS = {
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'raw', 'arw', 'cr2', 'cr3',
    'nef', 'dng', 'orf', 'rw2', 'raf', 'tif', 'tiff',
}

FOLDER_MIME = 'application/vnd.google-apps.folder'


def _headers(access_token: str) -> dict[str, str]:
    return {'Authorization': f'Bearer {access_token}'}


def verify_access_token(access_token: str) -> dict[str, Any]:
    resp = requests.get(
        'https://oauth2.googleapis.com/tokeninfo',
        params={'access_token': access_token},
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def list_folders(access_token: str, parent_id: str) -> list[dict[str, Any]]:
    parent = parent_id or 'root'
    q = (
        f"'{parent}' in parents and trashed = false "
        f"and mimeType = '{FOLDER_MIME}'"
    )
    return _list_files(access_token, q, fields='files(id,name,modifiedTime)')


def list_images(access_token: str, folder_id: str) -> list[dict[str, Any]]:
    q = (
        f"'{folder_id}' in parents and trashed = false "
        f"and mimeType != '{FOLDER_MIME}'"
    )
    files = _list_files(
        access_token,
        q,
        fields='files(id,name,mimeType,size,modifiedTime)',
    )
    return [
        f for f in files
        if _is_supported_image(f.get('name', ''), f.get('mimeType', ''))
    ]


def _resolve_file_meta(
    access_token: str,
    file_id: str,
    *,
    filename: str | None = None,
    mime_type: str | None = None,
) -> tuple[str, str]:
    name = filename or file_id
    mime = mime_type or mimetypes.guess_type(name)[0] or 'application/octet-stream'
    if filename and mime_type:
        return name, mime

    meta = requests.get(
        f'{DRIVE_API}/files/{file_id}',
        headers=_headers(access_token),
        params={'fields': 'id,name,mimeType'},
        timeout=30,
    )
    meta.raise_for_status()
    info = meta.json()
    return info.get('name', name), info.get('mimeType', mime)


def download_file(
    access_token: str,
    file_id: str,
    *,
    filename: str | None = None,
    mime_type: str | None = None,
) -> tuple[bytes, str, str]:
    name, mime = _resolve_file_meta(
        access_token,
        file_id,
        filename=filename,
        mime_type=mime_type,
    )
    content = requests.get(
        f'{DRIVE_API}/files/{file_id}',
        headers=_headers(access_token),
        params={'alt': 'media'},
        timeout=120,
    )
    content.raise_for_status()
    return content.content, name, mime


def stream_file(
    access_token: str,
    file_id: str,
    *,
    filename: str | None = None,
    mime_type: str | None = None,
):
    name, mime = _resolve_file_meta(
        access_token,
        file_id,
        filename=filename,
        mime_type=mime_type,
    )
    content = requests.get(
        f'{DRIVE_API}/files/{file_id}',
        headers=_headers(access_token),
        params={'alt': 'media'},
        timeout=120,
        stream=True,
    )
    content.raise_for_status()

    def generate():
        try:
            for chunk in content.iter_content(chunk_size=262144):
                if chunk:
                    yield chunk
        finally:
            content.close()

    return generate(), name, mime


def upload_file(
    access_token: str,
    parent_id: str,
    filename: str,
    data: bytes,
    mime_type: str | None = None,
) -> dict[str, Any]:
    import json

    mime = mime_type or mimetypes.guess_type(filename)[0] or 'application/octet-stream'
    metadata = {'name': filename, 'parents': [parent_id]}
    boundary = 'bbp_drive_upload_boundary'
    meta_json = json.dumps(metadata).encode('utf-8')
    body = b''.join([
        f'--{boundary}\r\n'.encode(),
        b'Content-Type: application/json; charset=UTF-8\r\n\r\n',
        meta_json,
        b'\r\n',
        f'--{boundary}\r\n'.encode(),
        f'Content-Type: {mime}\r\n\r\n'.encode(),
        data,
        b'\r\n',
        f'--{boundary}--\r\n'.encode(),
    ])
    headers = {
        **_headers(access_token),
        'Content-Type': f'multipart/related; boundary={boundary}',
    }
    resp = requests.post(
        f'{DRIVE_UPLOAD}/files',
        headers=headers,
        params={'uploadType': 'multipart', 'supportsAllDrives': 'true'},
        data=body,
        timeout=180,
    )
    if not resp.ok:
        detail = resp.text
        try:
            detail = resp.json().get('error', {}).get('message', detail)
        except ValueError:
            pass
        raise RuntimeError(detail or f'Google Drive upload failed ({resp.status_code})')
    return resp.json()


def _list_files(access_token: str, q: str, fields: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    page_token = None
    while True:
        params = {
            'q': q,
            'fields': f'nextPageToken,{fields}',
            'pageSize': 200,
            'orderBy': 'folder,name',
            'supportsAllDrives': 'true',
            'includeItemsFromAllDrives': 'true',
        }
        if page_token:
            params['pageToken'] = page_token
        resp = requests.get(
            f'{DRIVE_API}/files',
            headers=_headers(access_token),
            params=params,
            timeout=30,
        )
        resp.raise_for_status()
        payload = resp.json()
        items.extend(payload.get('files', []))
        page_token = payload.get('nextPageToken')
        if not page_token:
            break
    return items


def _is_supported_image(name: str, mime: str) -> bool:
    ext = name.rsplit('.', 1)[-1].lower() if '.' in name else ''
    if ext in IMAGE_EXTENSIONS:
        return True
    return mime.startswith('image/')
