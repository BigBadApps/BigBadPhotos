# backend/google_auth.py
"""Server-side Google OAuth (authorization-code flow) with a persisted refresh token.

Single-owner app: one token file holds the owner's Google credentials so the
Drive/Photos proxies and the autonomous worker can run unattended. The file
lives outside the repo (default ~/.bigbadphotos/google_token.json, mode 600).
"""
from __future__ import annotations

import json
import os
import threading
import time
from typing import Any
from urllib.parse import urlencode

import requests

GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

# Drive scope matches frontend DRIVE_SCOPES.write; Photos scopes are the only
# ones that still allow uploads + listing app-created albums (post-2025-03-31 API).
OAUTH_SCOPES = [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/photoslibrary.appendonly',
    'https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata',
]

DEFAULT_TOKEN_PATH = os.path.join(os.path.expanduser('~'), '.bigbadphotos', 'google_token.json')

# Refresh when fewer than this many seconds of validity remain.
EXPIRY_MARGIN_S = 120


class GoogleAuthError(Exception):
    pass


def build_auth_url(client_id: str, redirect_uri: str, state: str) -> str:
    params = {
        'client_id': client_id,
        'redirect_uri': redirect_uri,
        'response_type': 'code',
        'scope': ' '.join(OAUTH_SCOPES),
        'access_type': 'offline',
        'prompt': 'consent',
        'include_granted_scopes': 'true',
        'state': state,
    }
    return f'{GOOGLE_AUTH_URL}?{urlencode(params)}'


def exchange_code(client_id: str, client_secret: str, code: str, redirect_uri: str) -> dict:
    resp = requests.post(GOOGLE_TOKEN_URL, data={
        'client_id': client_id,
        'client_secret': client_secret,
        'code': code,
        'grant_type': 'authorization_code',
        'redirect_uri': redirect_uri,
    }, timeout=30)
    if not resp.ok:
        detail = resp.text
        try:
            detail = resp.json().get('error_description', detail)
        except ValueError:
            pass
        raise GoogleAuthError(f'code exchange failed: {detail}')
    return resp.json()


class GoogleAuthManager:
    def __init__(self, token_path: str | None = None,
                 client_id: str | None = None, client_secret: str | None = None):
        self.token_path = token_path or os.environ.get('BBP_TOKEN_PATH') or DEFAULT_TOKEN_PATH
        self.client_id = client_id if client_id is not None else (
            os.environ.get('GOOGLE_CLIENT_ID', '') or os.environ.get('VITE_GOOGLE_CLIENT_ID', ''))
        self.client_secret = client_secret if client_secret is not None else (
            os.environ.get('GOOGLE_CLIENT_SECRET', ''))
        self._lock = threading.Lock()

    # -- persistence ---------------------------------------------------------

    def _load(self) -> dict[str, Any] | None:
        try:
            with open(self.token_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def _write(self, data: dict[str, Any]) -> None:
        os.makedirs(os.path.dirname(self.token_path), exist_ok=True)
        tmp = f'{self.token_path}.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.token_path)

    def store_tokens(self, token_response: dict) -> None:
        with self._lock:
            existing = self._load() or {}
            refresh = token_response.get('refresh_token') or existing.get('refresh_token')
            data = {
                'refresh_token': refresh,
                'access_token': token_response.get('access_token'),
                'expires_at': time.time() + float(token_response.get('expires_in', 0)),
                'scope': token_response.get('scope', existing.get('scope', '')),
                'stored_at': time.time(),
            }
            self._write(data)

    def clear(self) -> None:
        with self._lock:
            try:
                os.remove(self.token_path)
            except OSError:
                pass

    # -- token access --------------------------------------------------------

    def available(self) -> bool:
        data = self._load()
        return bool(data and data.get('refresh_token') and self.client_id and self.client_secret)

    def get_access_token(self) -> str:
        if not self.client_id or not self.client_secret:
            raise GoogleAuthError('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured')
        with self._lock:
            data = self._load()
            if not data or not data.get('refresh_token'):
                raise GoogleAuthError('no stored Google credentials — connect via /google/oauth/start')
            if data.get('access_token') and data.get('expires_at', 0) - time.time() > EXPIRY_MARGIN_S:
                return data['access_token']
            return self._refresh_locked(data)

    def _refresh_locked(self, data: dict[str, Any]) -> str:
        resp = requests.post(GOOGLE_TOKEN_URL, data={
            'client_id': self.client_id,
            'client_secret': self.client_secret,
            'refresh_token': data['refresh_token'],
            'grant_type': 'refresh_token',
        }, timeout=30)
        if not resp.ok:
            detail = resp.text
            try:
                detail = resp.json().get('error_description', detail)
            except ValueError:
                pass
            raise GoogleAuthError(f'token refresh failed: {detail}')
        payload = resp.json()
        data['access_token'] = payload['access_token']
        data['expires_at'] = time.time() + float(payload.get('expires_in', 3600))
        self._write(data)
        return data['access_token']


_manager: GoogleAuthManager | None = None
_manager_lock = threading.Lock()


def get_manager() -> GoogleAuthManager:
    global _manager
    with _manager_lock:
        if _manager is None:
            _manager = GoogleAuthManager()
        return _manager
