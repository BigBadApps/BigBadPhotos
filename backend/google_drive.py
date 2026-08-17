"""Google Drive helpers for folder browse, download, and upload."""

from __future__ import annotations

import mimetypes
from typing import Any
from urllib.parse import quote

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


def _files_url(file_id: str) -> str:
    """Build a `.../files/{id}` URL with the id properly path-encoded.

    file_id ultimately traces back to request/route input in some callers
    (e.g. `/drive/files/<file_id>`) — quote() prevents a crafted id from
    injecting extra path segments into the Drive API request."""
    return f'{DRIVE_API}/files/{quote(file_id, safe="")}'


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


SIDECAR_SUFFIX = '.bbp.json'

def list_all(access_token: str, folder_id: str) -> list[dict[str, Any]]:
    """
    List all non-folder files in a Drive folder: images and .bbp.json sidecars.
    Used by autonomous mode to detect both unprocessed images and existing sidecars.
    """
    q = (
        f"'{folder_id}' in parents and trashed = false "
        f"and mimeType != '{FOLDER_MIME}'"
    )
    files = _list_files(
        access_token,
        q,
        fields='files(id,name,mimeType,size,modifiedTime)',
    )
    # Return images + bbp sidecars; exclude other file types
    return [
        f for f in files
        if _is_supported_image(f.get('name', ''), f.get('mimeType', ''))
        or f.get('name', '').endswith(SIDECAR_SUFFIX)
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
        _files_url(file_id),
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
        _files_url(file_id),
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
        _files_url(file_id),
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
    app_properties: dict[str, str] | None = None,
) -> dict[str, Any]:
    import json

    mime = mime_type or mimetypes.guess_type(filename)[0] or 'application/octet-stream'
    metadata = {'name': filename, 'parents': [parent_id]}
    if app_properties:
        metadata['appProperties'] = app_properties
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


def create_folder(access_token: str, parent_id: str, name: str) -> dict[str, Any]:
    resp = requests.post(
        f'{DRIVE_API}/files',
        headers=_headers(access_token),
        params={'fields': 'id,name', 'supportsAllDrives': 'true'},
        json={
            'name': name,
            'mimeType': FOLDER_MIME,
            'parents': [parent_id],
        },
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    return {'id': data.get('id'), 'name': data.get('name')}


def find_child_by_name(
    access_token: str,
    parent_id: str,
    name: str,
    folders_only: bool = False,
) -> dict[str, Any] | None:
    escaped_name = name.replace("'", "\\'")
    q = (
        f"'{parent_id}' in parents and trashed = false "
        f"and name = '{escaped_name}'"
    )
    if folders_only:
        q += f" and mimeType = '{FOLDER_MIME}'"
    resp = requests.get(
        f'{DRIVE_API}/files',
        headers=_headers(access_token),
        params={
            'q': q,
            'fields': 'files(id,name,mimeType)',
            'pageSize': 1,
            'supportsAllDrives': 'true',
            'includeItemsFromAllDrives': 'true',
        },
        timeout=30,
    )
    resp.raise_for_status()
    files = resp.json().get('files', [])
    return files[0] if files else None


def find_by_app_property(
    access_token: str,
    parent_id: str,
    key: str,
    value: str,
) -> dict[str, Any] | None:
    """Find a child of `parent_id` tagged with a given appProperties key/value.

    Unlike find_child_by_name, this is safe as a per-item idempotency check
    even when multiple items share a filename: appProperties are set once at
    upload time (see upload_file's app_properties param) with a value that's
    unique to the caller's own record (e.g. a database row id), not derived
    from the filename. A retry after a lost response can look up "did *my*
    upload for *this specific row* already land" without any risk of a
    same-named-but-different item satisfying the check.
    """
    escaped_key = key.replace("'", "\\'")
    escaped_value = value.replace("'", "\\'")
    q = (
        f"'{parent_id}' in parents and trashed = false "
        f"and appProperties has {{ key='{escaped_key}' and value='{escaped_value}' }}"
    )
    resp = requests.get(
        f'{DRIVE_API}/files',
        headers=_headers(access_token),
        params={
            'q': q,
            'fields': 'files(id,name,mimeType)',
            'pageSize': 1,
            'supportsAllDrives': 'true',
            'includeItemsFromAllDrives': 'true',
        },
        timeout=30,
    )
    resp.raise_for_status()
    files = resp.json().get('files', [])
    return files[0] if files else None


def ensure_folder(access_token: str, parent_id: str, name: str) -> dict[str, Any]:
    found = find_child_by_name(access_token, parent_id, name, folders_only=True)
    if found:
        return found
    return create_folder(access_token, parent_id, name)


def move_file(
    access_token: str,
    file_id: str,
    new_parent_id: str,
    old_parent_id: str | None = None,
) -> dict[str, Any]:
    if old_parent_id is None:
        meta = requests.get(
            _files_url(file_id),
            headers=_headers(access_token),
            params={'fields': 'parents', 'supportsAllDrives': 'true'},
            timeout=30,
        )
        meta.raise_for_status()
        old_parent_id = ','.join(meta.json().get('parents', []))

    resp = requests.patch(
        _files_url(file_id),
        headers=_headers(access_token),
        params={
            'addParents': new_parent_id,
            'removeParents': old_parent_id,
            'fields': 'id,name,parents',
            'supportsAllDrives': 'true',
        },
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def folder_meta(access_token: str, folder_id: str) -> dict[str, Any]:
    resp = requests.get(
        _files_url(folder_id),
        headers=_headers(access_token),
        params={
            'fields': 'id,name,trashed,capabilities(canAddChildren)',
            'supportsAllDrives': 'true',
        },
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    capabilities = data.get('capabilities') or {}
    return {
        'id': data.get('id'),
        'name': data.get('name'),
        'canAddChildren': bool(capabilities.get('canAddChildren')),
        'trashed': bool(data.get('trashed', False)),
    }


def set_public_read(folder_id: str, token: str) -> dict[str, Any]:
    """Set Google Drive folder/file to 'anyone with link can view'."""
    resp = requests.post(
        f"{DRIVE_API}/files/{quote(folder_id, safe='')}/permissions",
        headers=_headers(token),
        json={"role": "reader", "type": "anyone"},
        params={"supportsAllDrives": "true"},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def copy_file(
    file_id: str,
    dest_folder_id: str,
    token: str,
    new_name: str | None = None,
) -> dict[str, Any]:
    """Copy a file to a destination folder."""
    body: dict[str, Any] = {"parents": [dest_folder_id]}
    if new_name:
        body["name"] = new_name
    resp = requests.post(
        f"{DRIVE_API}/files/{quote(file_id, safe='')}/copy",
        headers=_headers(token),
        json=body,
        params={"supportsAllDrives": "true"},
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()
