from flask import Flask, request, jsonify, send_from_directory, session, Response, g
from flask_wtf.csrf import CSRFProtect, generate_csrf
import cv2
import numpy as np
import json
import os
import time
import gc
import secrets
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from typing import List
from backend import google_drive
from backend import google_photos
from backend import topaz
from backend import google_auth
from backend import db
from backend import pipeline
from backend import preflight
from backend import sessions
from backend import gallery
from backend.scoring import (
    decode_image, score_sharpness, score_exposure, score_noise,
    score_contrast, score_faces, compute_phash, hamming_distance,
    score_composition, composite_score,
)
from backend import scoring

try:
    from dotenv import load_dotenv
    load_dotenv()
    load_dotenv('.env.local', override=True)
    load_dotenv(os.path.join('frontend', '.env.local'), override=True)
    load_dotenv(os.path.join('frontend', 'env.local'), override=True)
except ImportError:
    pass

app = Flask(__name__)
csrf = CSRFProtect(app)

FRONTEND_DIST = os.path.join(os.path.dirname(__file__), 'frontend', 'dist')

IS_DEBUG = (os.environ.get('FLASK_DEBUG') == '1') or (os.environ.get('BBP_DEBUG') == '1')

# In production, set FLASK_SECRET_KEY (e.g. on Railway) so sessions survive deploys/restarts.
app.secret_key = os.environ.get('FLASK_SECRET_KEY')
if not IS_DEBUG and not app.secret_key:
    raise ValueError("FLASK_SECRET_KEY environment variable is required in production.")
if not app.secret_key:
    app.secret_key = secrets.token_hex(32)
app.config.update(
    SESSION_COOKIE_SECURE=not IS_DEBUG,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',
    PERMANENT_SESSION_LIFETIME=timedelta(days=7),
)

if not IS_DEBUG:
    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1)

GOOGLE_CLIENT_ID = os.environ.get('GOOGLE_CLIENT_ID', '') or os.environ.get('VITE_GOOGLE_CLIENT_ID', '')
HAS_AUTH = bool(os.environ.get('BBP_PASSWORD')) or bool(GOOGLE_CLIENT_ID) or IS_DEBUG

# Lazy-import google-auth only when GOOGLE_CLIENT_ID is configured.
# The native extension may not be available in all environments.
if GOOGLE_CLIENT_ID:
    try:
        from google.oauth2 import id_token as google_id_token
        from google.auth.transport import requests as google_requests
    except Exception as _ge:
        print(f"⚠️  google-auth import failed: {_ge} — Google OAuth will be unavailable")
        google_id_token = None
        google_requests = None
else:
    google_id_token = None
    google_requests = None

ALLOWED_EMAILS = {
    e.strip().lower()
    for e in os.environ.get('BBP_ALLOWED_EMAILS', '').split(',')
    if e.strip()
}

if not ALLOWED_EMAILS:
    print("⚠️  BBP_ALLOWED_EMAILS is empty — all logins will be rejected")


API_ROUTES = {'/analyze', '/rank', '/edit', '/edit/file'}

# Photo editing (Topaz) — LOCAL ONLY. Topaz runs on this machine; these routes
# operate on absolute paths on the local filesystem, not uploaded bytes.
EDITED_SUBDIR = 'edited'


def _safe_in_dir(source_dir: str, filename: str) -> str:
    """Resolve `filename` inside `source_dir`, rejecting traversal. Returns abs path.

    Raises ValueError if filename escapes the directory or isn't a plain name.
    """
    if not filename or filename != os.path.basename(filename):
        raise ValueError('filename must be a bare name, not a path')
    base = os.path.realpath(source_dir)
    full = os.path.realpath(os.path.join(base, filename))
    if full != os.path.join(base, filename) and not full.startswith(base + os.sep):
        raise ValueError('resolved path escapes source directory')
    return full


@app.after_request
def set_response_cookies(response):
    response.set_cookie(
        'csrf_token',
        generate_csrf(),
        secure=not IS_DEBUG,
        samesite='Lax',
        httponly=False
    )
    if getattr(g, 'new_visitor', False) and getattr(g, 'visitor_id', None):
        response.set_cookie(
            'bbp_visitor',
            g.visitor_id,
            secure=not IS_DEBUG,
            samesite='Lax',
            httponly=False,
            max_age=365 * 24 * 3600,
            path='/gallery/',
        )
    return response

@app.before_request
def enforce_auth():
    if request.path == '/drive/status':
        return
    if (request.path not in API_ROUTES
            and not request.path.startswith('/drive')
            and not request.path.startswith('/photos')
            and not request.path.startswith('/sessions')
            and not request.path.startswith('/runs')
            and not request.path.startswith('/settings')):
        return  # static files, /health, /auth/* all pass through
    if not HAS_AUTH:
        return  # No auth configured = open access
    if IS_DEBUG and not session.get('user'):
        # Auto-create a dev session so the UI works without credentials
        session['user'] = {'email': 'dev@local', 'name': 'Dev User', 'picture': '', 'sub': 'dev'}
        session.permanent = True
        return
    if not session.get('user'):
        return jsonify({'error': 'not_authenticated'}), 401


@app.post('/auth/google')
def auth_google():
    """Verify Google ID token, create session if email is allowed."""
    if not google_id_token or not GOOGLE_CLIENT_ID:
        return jsonify({'error': 'google_oauth_not_configured'}), 400

    data = request.get_json(silent=True) or {}
    credential = data.get('credential')
    if not credential:
        return jsonify({'error': 'missing_credential'}), 400

    try:
        idinfo = google_id_token.verify_oauth2_token(
            credential,
            google_requests.Request(),
            GOOGLE_CLIENT_ID,
        )
    except ValueError as e:
        return jsonify({'error': 'invalid_token', 'detail': str(e)}), 401

    email = (idinfo.get('email') or '').lower()
    if email not in ALLOWED_EMAILS:
        return jsonify({'error': 'unauthorized_email', 'email': email}), 403

    session['user'] = {
        'email': email,
        'name': idinfo.get('name', ''),
        'picture': idinfo.get('picture', ''),
        'sub': idinfo.get('sub', ''),
    }
    session.permanent = True

    return jsonify({'ok': True, 'user': session['user']})


@app.post('/auth/logout')
def auth_logout():
    session.clear()
    return jsonify({'ok': True})


@app.get('/auth/me')
def auth_me():
    """Check current session. Frontend calls this on load."""
    user = session.get('user')
    if not user:
        return jsonify({'authenticated': False})
    return jsonify({'authenticated': True, 'user': user})


@app.post('/auth/dev')
def auth_dev():
    """Create a dev session when BBP_DEBUG/FLASK_DEBUG is enabled."""
    if not IS_DEBUG:
        return jsonify({'error': 'forbidden'}), 403
    session['user'] = {
        'email': 'dev@local',
        'name': 'Dev User',
        'picture': '',
        'sub': 'dev',
    }
    session.permanent = True
    return jsonify({'ok': True, 'user': session['user']})


@app.get('/auth/config')
def auth_config():
    """Return available auth methods so the frontend renders the right sign-in UI."""
    return jsonify({
        'google': bool(GOOGLE_CLIENT_ID),
        'googleClientId': GOOGLE_CLIENT_ID or None,
        'password': bool(os.environ.get('BBP_PASSWORD')),
        'dev': IS_DEBUG,
        'open': not HAS_AUTH,
        'drive': bool(GOOGLE_CLIENT_ID),
        'serverGoogle': google_auth.get_manager().available(),
        'worker': google_auth.get_manager().available(),
    })


@app.post('/auth/password')
def auth_password():
    """Password-based auth using BBP_PASSWORD env var."""
    pwd = os.environ.get('BBP_PASSWORD', '')
    if not pwd:
        return jsonify({'error': 'password_auth_not_configured'}), 400
    data = request.get_json(silent=True) or {}
    if not secrets.compare_digest(str(data.get('password', '')), pwd):
        return jsonify({'error': 'invalid_password'}), 401
    session['user'] = {
        'email': 'local@bigbadphotos',
        'name': 'Local User',
        'picture': '',
        'sub': 'local',
    }
    session.permanent = True
    return jsonify({'ok': True, 'user': session['user']})


@app.get('/google/oauth/start')
def google_oauth_start():
    """Begin the server-side authorization-code flow (owner connects once)."""
    if not session.get('user'):
        return jsonify({'error': 'not_authenticated'}), 401
    client_secret = os.environ.get('GOOGLE_CLIENT_SECRET', '')
    if not GOOGLE_CLIENT_ID or not client_secret:
        return jsonify({'error': 'server_google_not_configured',
                        'detail': 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET'}), 400
    state = secrets.token_urlsafe(24)
    session['google_oauth_state'] = state
    redirect_uri = request.host_url.rstrip('/') + '/google/oauth/callback'
    from flask import redirect
    return redirect(google_auth.build_auth_url(GOOGLE_CLIENT_ID, redirect_uri, state))


@app.get('/google/oauth/callback')
def google_oauth_callback():
    from flask import redirect
    if not session.get('user'):
        return redirect('/?googleAuth=error&detail=not_authenticated')
    state = request.args.get('state', '')
    if not state or state != session.pop('google_oauth_state', None):
        return redirect('/?googleAuth=error&detail=bad_state')
    if request.args.get('error'):
        return redirect(f"/?googleAuth=error&detail={request.args['error']}")
    code = request.args.get('code', '')
    if not code:
        return redirect('/?googleAuth=error&detail=missing_code')
    redirect_uri = request.host_url.rstrip('/') + '/google/oauth/callback'
    try:
        tokens = google_auth.exchange_code(
            GOOGLE_CLIENT_ID, os.environ.get('GOOGLE_CLIENT_SECRET', ''), code, redirect_uri)
    except google_auth.GoogleAuthError as e:
        return redirect(f'/?googleAuth=error&detail={str(e)[:120]}')
    google_auth.get_manager().store_tokens(tokens)
    return redirect('/?googleAuth=connected')


def _drive_token() -> str | None:
    return session.get('google_drive_token')


def _google_token() -> str | None:
    """Server-stored refresh-token credentials first, then the session token."""
    mgr = google_auth.get_manager()
    if mgr.available():
        try:
            return mgr.get_access_token()
        except google_auth.GoogleAuthError:
            pass  # fall back to the browser-granted session token
    return _drive_token()


def _drive_auth_error():
    if not session.get('user'):
        return jsonify({'error': 'not_authenticated'}), 401
    if not _google_token():
        return jsonify({'error': 'drive_not_authorized'}), 401
    return None


@app.get('/drive/status')
def drive_status():
    """Lightweight Drive auth probe without treating missing access as an error."""
    user = session.get('user')
    if not user and IS_DEBUG and HAS_AUTH:
        session['user'] = {
            'email': 'dev@local',
            'name': 'Dev User',
            'picture': '',
            'sub': 'dev',
        }
        session.permanent = True
        user = session['user']
    return jsonify({
        'authenticated': bool(user),
        'driveAuthorized': bool(user and _google_token()),
        'serverGoogleAuth': google_auth.get_manager().available(),
    })


@app.post('/drive/authorize')
def drive_authorize():
    if not GOOGLE_CLIENT_ID:
        return jsonify({'error': 'google_oauth_not_configured'}), 400
    data = request.get_json(silent=True) or {}
    access_token = (data.get('accessToken') or '').strip()
    if not access_token:
        return jsonify({'error': 'missing_access_token'}), 400
    try:
        info = google_drive.verify_access_token(access_token)
    except Exception as exc:
        return jsonify({'error': 'invalid_access_token', 'detail': str(exc)}), 401
    if info.get('aud') != GOOGLE_CLIENT_ID:
        return jsonify({'error': 'invalid_token_audience'}), 401
    session['google_drive_token'] = access_token
    session.permanent = True
    return jsonify({'ok': True, 'expiresIn': info.get('expires_in')})


@app.get('/drive/browse')
def drive_browse():
    err = _drive_auth_error()
    if err:
        return err
    parent_id = request.args.get('parentId', 'root')
    mode = request.args.get('mode', 'folders')
    try:
        if mode == 'images':
            files = google_drive.list_images(_google_token(), parent_id)
        elif mode == 'all':
            files = google_drive.list_all(_google_token(), parent_id)
        else:
            files = google_drive.list_folders(_google_token(), parent_id)
    except Exception as exc:
        return jsonify({'error': 'drive_list_failed', 'detail': str(exc)}), 502
    return jsonify({'parentId': parent_id, 'mode': mode, 'items': files})


@app.get('/drive/files/<file_id>')
def drive_download(file_id):
    err = _drive_auth_error()
    if err:
        return err
    filename = request.args.get('name')
    mime_type = request.args.get('mimeType')
    try:
        body, resolved_name, resolved_mime = google_drive.stream_file(
            _google_token(),
            file_id,
            filename=filename,
            mime_type=mime_type,
        )
    except Exception as exc:
        return jsonify({'error': 'drive_download_failed', 'detail': str(exc)}), 502
    from flask import Response
    return Response(body, mimetype=resolved_mime, headers={
        'Content-Disposition': f'inline; filename="{resolved_name}"',
    })


@app.post('/drive/files')
def drive_upload():
    err = _drive_auth_error()
    if err:
        return err
    parent_id = request.form.get('parentId') or request.args.get('parentId')
    if not parent_id:
        return jsonify({'error': 'missing_parent_id'}), 400
    if 'file' not in request.files:
        return jsonify({'error': 'missing_file'}), 400
    upload = request.files['file']
    payload = upload.read()
    if not payload:
        return jsonify({'error': 'empty_file'}), 400
    try:
        created = google_drive.upload_file(
            _google_token(),
            parent_id,
            upload.filename or 'upload.bin',
            payload,
            upload.mimetype,
        )
    except Exception as exc:
        return jsonify({'error': 'drive_upload_failed', 'detail': str(exc)}), 502
    return jsonify({'ok': True, 'file': created})


def _photos_auth_error():
    if not session.get('user'):
        return jsonify({'error': 'not_authenticated'}), 401
    if not _google_token():
        return jsonify({'error': 'photos_not_authorized',
                        'detail': 'Connect Google via /google/oauth/start'}), 401
    return None


@app.get('/photos/albums')
def photos_albums():
    err = _photos_auth_error()
    if err:
        return err
    try:
        albums = google_photos.list_albums(_google_token())
    except Exception as exc:
        return jsonify({'error': 'photos_list_failed', 'detail': str(exc)}), 502
    return jsonify({'albums': albums})


@app.post('/photos/albums')
def photos_create_album():
    err = _photos_auth_error()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    title = (data.get('title') or '').strip()
    if not title:
        return jsonify({'error': 'bad_request', 'detail': 'title is required'}), 400
    try:
        album = google_photos.create_album(_google_token(), title)
    except Exception as exc:
        return jsonify({'error': 'photos_create_failed', 'detail': str(exc)}), 502
    return jsonify({'ok': True, 'album': album})


@app.post('/photos/upload')
def photos_upload():
    err = _photos_auth_error()
    if err:
        return err
    album_id = request.form.get('albumId') or ''
    if not album_id:
        return jsonify({'error': 'missing_album_id'}), 400
    if 'file' not in request.files:
        return jsonify({'error': 'missing_file'}), 400
    upload = request.files['file']
    payload = upload.read()
    if not payload:
        return jsonify({'error': 'empty_file'}), 400
    filename = upload.filename or 'upload.jpg'
    try:
        token = _google_token()
        upload_token = google_photos.upload_bytes(
            token, filename, payload, upload.mimetype or 'image/jpeg')
        results = google_photos.batch_create(token, album_id, [
            {'uploadToken': upload_token, 'filename': filename},
        ])
    except Exception as exc:
        return jsonify({'error': 'photos_upload_failed', 'detail': str(exc)}), 502
    result = results[0] if results else {'ok': False, 'error': 'no result returned'}
    if not result.get('ok'):
        return jsonify({'error': 'photos_upload_failed',
                        'detail': result.get('error', 'unknown')}), 502
    return jsonify({'ok': True, 'filename': filename,
                    'mediaItemId': result.get('mediaItemId')})


# ---------------------------------------------------------------------------
# Photo sessions (P6): session, run, photo, and settings routes
# ---------------------------------------------------------------------------

def _session_run_active(session_id) -> bool:
    row = db.get().execute(
        'SELECT id FROM runs WHERE session_id = ? AND status = ?',
        (session_id, 'running')).fetchone()
    return row is not None


def _photo_row_to_dict(row: dict) -> dict:
    """Map a raw `photos` row (snake_case) to a camelCase API photo."""
    def _parse_json(value):
        if not value:
            return None
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else None
        except ValueError:
            return None
    return {
        'id': row['id'],
        'runId': row['run_id'],
        'driveFileId': row['drive_file_id'],
        'filename': row['filename'],
        'state': row['state'],
        'overallScore': row['overall_score'],
        'metrics': _parse_json(row['metrics_json']),
        'edit': _parse_json(row['edit_json']),
        'exportedFileId': row['exported_file_id'],
        'errorCode': row['error_code'],
        'errorDetail': row['error_detail'],
        'attempts': row['attempts'],
        'claimedAt': row['claimed_at'],
        'updatedAt': row['updated_at'],
    }


@app.get('/sessions')
def sessions_list():
    return jsonify({'sessions': sessions.list_all()})


@app.post('/sessions')
def sessions_create():
    data = request.get_json(silent=True) or {}
    try:
        created = sessions.create(data)
    except sessions.SessionError as e:
        return jsonify({'error': 'bad_config', 'detail': str(e)}), 400
    return jsonify({'ok': True, 'session': created})


@app.get('/sessions/<int:session_id>')
def sessions_get(session_id):
    s = sessions.get(session_id)
    if s is None:
        return jsonify({'error': 'not_found',
                        'detail': f'session not found: {session_id}'}), 404
    return jsonify({'session': s})


@app.put('/sessions/<int:session_id>')
def sessions_update(session_id):
    s = sessions.get(session_id)
    if s is None:
        return jsonify({'error': 'not_found',
                        'detail': f'session not found: {session_id}'}), 404
    data = request.get_json(silent=True) or {}
    if _session_run_active(session_id):
        # Re-pointing folders mid-run would strand the running worker.
        if any(k in data for k in ('sourceFolderId', 'exportFolderId')):
            return jsonify({'error': 'run_in_progress',
                            'detail': 'stop the active run before changing '
                                      'this session\'s folders'}), 409
    try:
        updated = sessions.update(session_id, data)
    except sessions.SessionError as e:
        return jsonify({'error': 'bad_config', 'detail': str(e)}), 400
    return jsonify({'ok': True, 'session': updated})


@app.delete('/sessions/<int:session_id>')
def sessions_delete(session_id):
    if sessions.get(session_id) is None:
        return jsonify({'error': 'not_found',
                        'detail': f'session not found: {session_id}'}), 404
    if _session_run_active(session_id):
        return jsonify({'error': 'run_in_progress',
                        'detail': 'stop the active run before deleting this session'}), 409
    sessions.delete(session_id)
    return jsonify({'ok': True})


@app.get('/sessions/<int:session_id>/runs')
def sessions_runs(session_id):
    auth_err = enforce_auth()
    if auth_err:
        return auth_err
    s = sessions.get(session_id)
    if s is None:
        return jsonify({'error': 'not_found',
                        'detail': f'session not found: {session_id}'}), 404
    conn = db.get()
    run_rows = conn.execute(
        'SELECT * FROM runs WHERE session_id = ? ORDER BY started_at DESC',
        (session_id,)
    ).fetchall()

    runs_list = []
    for r in run_rows:
        run_id = r['id']
        counts = {state: 0 for state in pipeline.STATES}
        for count_row in conn.execute(
            'SELECT state, COUNT(*) as count FROM photos WHERE run_id = ? GROUP BY state',
            (run_id,)
        ):
            counts[count_row['state']] = count_row['count']

        err_row = conn.execute(
            'SELECT detail FROM run_errors WHERE run_id = ? ORDER BY id DESC LIMIT 1',
            (run_id,)
        ).fetchone()
        error_msg = err_row['detail'] if err_row else None

        runs_list.append({
            'id': run_id,
            'sessionId': r['session_id'],
            'status': r['status'],
            'phase': r['phase'],
            'startedAt': r['started_at'],
            'endedAt': r['ended_at'],
            'lastPollAt': r['last_poll_at'],
            'error': error_msg,
            'counts': counts,
        })

    return jsonify({'runs': runs_list})


@app.post('/sessions/<int:session_id>/preflight')
def sessions_preflight(session_id):
    s = sessions.get(session_id)
    if s is None:
        return jsonify({'error': 'not_found',
                        'detail': f'session not found: {session_id}'}), 404
    if not google_auth.get_manager().available():
        return jsonify({'error': 'server_google_not_connected',
                        'detail': 'Connect via /google/oauth/start first'}), 401
    checks = preflight.run(s, _google_token)
    return jsonify({'checks': checks})


@app.post('/sessions/<int:session_id>/start')
def sessions_start(session_id):
    s = sessions.get(session_id)
    if s is None:
        return jsonify({'error': 'not_found',
                        'detail': f'session not found: {session_id}'}), 404
    if not google_auth.get_manager().available():
        return jsonify({'error': 'server_google_not_connected',
                        'detail': 'Connect via /google/oauth/start first'}), 401
    try:
        result = pipeline.start_run(session_id, _google_token)
    except pipeline.RunConflict as e:
        return jsonify({'error': 'already_running', 'detail': str(e)}), 409
    return jsonify({'ok': True, **result})


@app.get('/runs/active')
def runs_active():
    return jsonify(pipeline.active_status())


@app.post('/runs/active/stop')
def runs_active_stop():
    stopped = pipeline.stop_run()
    return jsonify({'ok': True, 'stopped': stopped})


@app.get('/runs/<int:run_id>/photos')
def runs_photos(run_id):
    conn = db.get()
    run = conn.execute('SELECT id FROM runs WHERE id = ?', (run_id,)).fetchone()
    if run is None:
        return jsonify({'error': 'not_found',
                        'detail': f'run not found: {run_id}'}), 404
    state = request.args.get('state')
    limit = request.args.get('limit')
    offset = request.args.get('offset')
    query = 'SELECT * FROM photos WHERE run_id = ?'
    params = [run_id]
    if state:
        query += ' AND state = ?'
        params.append(state)
    query += ' ORDER BY id'
    try:
        if limit:
            query += ' LIMIT ?'
            params.append(int(limit))
            if offset:
                query += ' OFFSET ?'
                params.append(int(offset))
    except ValueError:
        return jsonify({'error': 'bad_config',
                        'detail': 'limit and offset must be integers'}), 400
    rows = conn.execute(query, params).fetchall()
    return jsonify({'photos': [_photo_row_to_dict(r) for r in rows]})


@app.post('/runs/<int:run_id>/approve-all')
def runs_approve_all(run_id):
    conn = db.get()
    run = conn.execute('SELECT id FROM runs WHERE id = ?', (run_id,)).fetchone()
    if run is None:
        return jsonify({'error': 'not_found',
                        'detail': f'run not found: {run_id}'}), 404
    try:
        count = pipeline.approve_all(run_id)
    except pipeline.RunNotActive as e:
        return jsonify({'error': 'run_not_active', 'detail': str(e)}), 409
    return jsonify({'ok': True, 'count': count})


@app.post('/photos/<int:photo_id>/decision')
def photos_decision(photo_id):
    data = request.get_json(silent=True) or {}
    decision = data.get('decision')
    try:
        row = pipeline.apply_decision(photo_id, decision)
    except KeyError:
        return jsonify({'error': 'not_found',
                        'detail': f'photo not found: {photo_id}'}), 404
    except ValueError as e:
        return jsonify({'error': 'bad_config', 'detail': str(e)}), 400
    except pipeline.RunNotActive as e:
        return jsonify({'error': 'run_not_active', 'detail': str(e)}), 409
    return jsonify({'ok': True, 'photo': _photo_row_to_dict(row)})


@app.get('/photos/<int:photo_id>/thumb')
def photos_thumb(photo_id):
    """Proxy the Drive file through the server token; never redirect to Google."""
    if not google_auth.get_manager().available():
        return jsonify({'error': 'server_google_not_connected',
                        'detail': 'Connect via /google/oauth/start first'}), 401
    row = db.get().execute(
        'SELECT drive_file_id, filename FROM photos WHERE id = ?',
        (photo_id,)).fetchone()
    if row is None:
        return jsonify({'error': 'not_found',
                        'detail': f'photo not found: {photo_id}'}), 404
    try:
        body, resolved_name, resolved_mime = google_drive.stream_file(
            _google_token(), row['drive_file_id'], filename=row['filename'])
    except Exception as exc:
        return jsonify({'error': 'drive_error', 'detail': str(exc)}), 502
    return Response(body, mimetype=resolved_mime, headers={
        'Content-Disposition': f'inline; filename="{resolved_name}"',
        'Cache-Control': 'private, max-age=3600',
    })


@app.get('/drive/folders')
def drive_folders_browse():
    """Browse subfolders of a parent. Distinct from /drive/browse (P6 spec)."""
    err = _drive_auth_error()
    if err:
        return err
    parent = request.args.get('parent') or 'root'
    try:
        folders = google_drive.list_folders(_google_token(), parent)
    except Exception as exc:
        return jsonify({'error': 'drive_error', 'detail': str(exc)}), 502
    return jsonify({'parent': parent, 'items': folders})


@app.post('/drive/folders')
def drive_folders_create():
    err = _drive_auth_error()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    parent_id = (data.get('parentId') or '').strip()
    name = (data.get('name') or '').strip()
    if not parent_id or not name:
        return jsonify({'error': 'bad_config',
                        'detail': 'parentId and name are required'}), 400
    try:
        folder = google_drive.create_folder(_google_token(), parent_id, name)
    except Exception as exc:
        return jsonify({'error': 'drive_error', 'detail': str(exc)}), 502
    return jsonify({'ok': True, 'folder': folder})


# Known app-wide wiring keys: {public API name: app_settings key}.
_SETTINGS_KEYS = (
    ('inboxFolderId', 'inbox_folder_id'),
    ('inboxFolderName', 'inbox_folder_name'),
    ('sessionsRoot', 'sessions_root_folder_id'),
)


def _settings_payload() -> dict:
    return {public: sessions.get_setting(key) for public, key in _SETTINGS_KEYS}


@app.get('/settings')
def settings_get():
    return jsonify(_settings_payload())


@app.put('/settings')
def settings_put():
    data = request.get_json(silent=True) or {}
    for public, key in _SETTINGS_KEYS:
        if public in data:
            value = data[public]
            sessions.set_setting(key, '' if value is None else str(value))
    return jsonify(_settings_payload())


# ---------------------------------------------------------------------------
# Gallery helper functions and routes
# ---------------------------------------------------------------------------


def validate_gallery_token(token_value: str) -> dict | None:
    if not token_value:
        return None
    token_dict = gallery.get_token_by_value(token_value)
    if not token_dict or token_dict.get('revoked'):
        return None
    return token_dict


def get_or_create_visitor_id() -> str:
    visitor_id = request.cookies.get('bbp_visitor')
    if visitor_id:
        g.visitor_id = visitor_id
        return visitor_id
    if not getattr(g, 'visitor_id', None):
        g.visitor_id = secrets.token_urlsafe(16)
        g.new_visitor = True
    return g.visitor_id


# Photographer-facing gallery management routes (authenticated via enforce_auth)

@app.get('/sessions/<int:session_id>/gallery')
def session_gallery_get(session_id):
    s = sessions.get(session_id)
    if s is None:
        return jsonify({'error': 'not_found',
                        'detail': f'session not found: {session_id}'}), 404
    tokens = gallery.get_tokens_for_session(session_id)
    active_tokens = [t for t in tokens if not t.get('revoked')]
    token_str = active_tokens[0]['token'] if active_tokens else (tokens[0]['token'] if tokens else '')
    stats = gallery.get_gallery_stats(session_id)
    return jsonify({
        'token': token_str,
        'gallery_url': f"/gallery/{token_str}" if token_str else '',
        'galleryUrl': f"/gallery/{token_str}" if token_str else '',
        'stats': stats,
        'tokens': tokens,
    })


@app.get('/sessions/<int:session_id>/gallery/favorites')
def session_gallery_favorites_get(session_id):
    s = sessions.get(session_id)
    if s is None:
        return jsonify({'error': 'not_found',
                        'detail': f'session not found: {session_id}'}), 404
    return jsonify(gallery.get_aggregated_favorites(session_id))


@app.get('/sessions/<int:session_id>/gallery/comments')
def session_gallery_comments_get(session_id):
    s = sessions.get(session_id)
    if s is None:
        return jsonify({'error': 'not_found',
                        'detail': f'session not found: {session_id}'}), 404
    return jsonify(gallery.get_all_comments_for_session(session_id))


@app.post('/sessions/<int:session_id>/gallery/approve-favorites')
def session_gallery_approve_favorites(session_id):
    s = sessions.get(session_id)
    if s is None:
        return jsonify({'error': 'not_found',
                        'detail': f'session not found: {session_id}'}), 404

    data = request.get_json(silent=True) or {}
    photo_ids = data.get('photo_ids') if 'photo_ids' in data else data.get('photoIds')
    if not isinstance(photo_ids, list):
        return jsonify({'error': 'bad_request',
                        'detail': 'photo_ids must be a list of photo IDs'}), 400

    export_folder_id = s.get('exportFolderId') or s.get('export_folder_id')
    if not export_folder_id:
        return jsonify({'error': 'bad_config',
                        'detail': 'Session has no export folder configured'}), 400

    drive_token = _google_token()
    if not drive_token:
        return jsonify({'error': 'drive_not_authorized',
                        'detail': 'Google Drive is not connected'}), 401

    session_name = s.get('name') or f'Session {session_id}'
    fav_folder_name = f"{session_name} - Favorites"

    try:
        fav_folder = google_drive.ensure_folder(drive_token, export_folder_id, fav_folder_name)
        google_drive.set_public_read(fav_folder['id'], drive_token)
    except Exception as exc:
        return jsonify({'error': 'drive_error',
                        'detail': f'Failed to create favorites folder: {exc}'}), 502

    conn = db.get()
    for pid in photo_ids:
        row = conn.execute(
            "SELECT photos.id, photos.exported_file_id, photos.drive_file_id, photos.filename "
            "FROM photos JOIN runs ON photos.run_id = runs.id "
            "WHERE photos.id = ? AND runs.session_id = ?",
            (pid, session_id),
        ).fetchone()
        if not row:
            continue
        file_to_copy = row['exported_file_id'] or row['drive_file_id']
        if not file_to_copy:
            continue
        try:
            google_drive.copy_file(file_to_copy, fav_folder['id'], drive_token)
        except Exception as exc:
            return jsonify({'error': 'drive_error',
                            'detail': f'Failed to copy file {row["filename"]}: {exc}'}), 502

    sessions.update(session_id, {
        'favoritesFolderId': fav_folder['id'],
        'favoritesFolderName': fav_folder.get('name', fav_folder_name),
    })

    fav_token = gallery.create_token(
        session_id,
        label=f"{session_name} - Favorites",
        scope='favorites',
    )

    return jsonify({
        'favorites_folder_id': fav_folder['id'],
        'favoritesFolderId': fav_folder['id'],
        'favorites_token': fav_token['token'],
        'favoritesToken': fav_token['token'],
        'favorites_url': f"/gallery/{fav_token['token']}",
        'favoritesUrl': f"/gallery/{fav_token['token']}",
    })


@app.post('/sessions/<int:session_id>/gallery/revoke')
def session_gallery_revoke(session_id):
    s = sessions.get(session_id)
    if s is None:
        return jsonify({'error': 'not_found',
                        'detail': f'session not found: {session_id}'}), 404
    gallery.revoke_tokens_for_session(session_id)
    return jsonify({'ok': True})


@app.post('/sessions/<int:session_id>/gallery/regenerate')
def session_gallery_regenerate(session_id):
    s = sessions.get(session_id)
    if s is None:
        return jsonify({'error': 'not_found',
                        'detail': f'session not found: {session_id}'}), 404
    gallery.revoke_tokens_for_session(session_id)
    new_token = gallery.create_token(session_id, label='Main Gallery', scope='exports')
    return jsonify({
        'ok': True,
        'token': new_token['token'],
        'gallery_url': f"/gallery/{new_token['token']}",
        'galleryUrl': f"/gallery/{new_token['token']}",
        'token_info': new_token,
        'tokenInfo': new_token,
    })


# Public gallery routes (token-gated)

@app.get('/gallery/<token>')
def gallery_view(token):
    token_dict = validate_gallery_token(token)
    if token_dict is None:
        return jsonify({'error': 'not_found', 'detail': 'gallery not found'}), 404
    get_or_create_visitor_id()
    if not os.path.isdir(FRONTEND_DIST):
        return jsonify({'error': 'Frontend not built. Run: cd frontend && npm run build'}), 503
    return send_from_directory(FRONTEND_DIST, 'index.html')


@app.get('/gallery/api/<token>/info')
def gallery_api_info(token):
    token_dict = validate_gallery_token(token)
    if token_dict is None:
        return jsonify({'error': 'not_found', 'detail': 'gallery not found'}), 404
    s = sessions.get(token_dict['session_id'])
    if s is None:
        return jsonify({'error': 'not_found', 'detail': 'session not found'}), 404
    conn = db.get()
    count_row = conn.execute(
        "SELECT COUNT(*) FROM photos JOIN runs ON photos.run_id = runs.id "
        "WHERE runs.session_id = ? AND photos.state IN ('exported', 'archived')",
        (token_dict['session_id'],),
    ).fetchone()
    photo_count = count_row[0] if count_row else 0
    return jsonify({
        'session_name': s['name'],
        'sessionName': s['name'],
        'photo_count': photo_count,
        'photoCount': photo_count,
        'scope': token_dict['scope'],
        'gallery_label': token_dict['label'],
        'galleryLabel': token_dict['label'],
    })


@app.get('/gallery/api/<token>/photos')
def gallery_api_photos(token):
    token_dict = validate_gallery_token(token)
    if token_dict is None:
        return jsonify({'error': 'not_found', 'detail': 'gallery not found'}), 404

    try:
        limit = min(max(int(request.args.get('limit', 50)), 1), 200)
    except (TypeError, ValueError):
        limit = 50

    try:
        offset = max(int(request.args.get('offset', 0)), 0)
    except (TypeError, ValueError):
        offset = 0

    after_id_raw = request.args.get('after_id')
    after_id = None
    if after_id_raw is not None:
        try:
            after_id = int(after_id_raw)
        except (TypeError, ValueError):
            after_id = None

    conn = db.get()
    count_row = conn.execute(
        "SELECT COUNT(*) FROM photos JOIN runs ON photos.run_id = runs.id "
        "WHERE runs.session_id = ? AND photos.state IN ('exported', 'archived')",
        (token_dict['session_id'],),
    ).fetchone()
    total_count = count_row[0] if count_row else 0

    if after_id is not None:
        rows = conn.execute(
            "SELECT photos.* FROM photos JOIN runs ON photos.run_id = runs.id "
            "WHERE runs.session_id = ? AND photos.state IN ('exported', 'archived') AND photos.id > ? "
            "ORDER BY photos.id ASC LIMIT ? OFFSET ?",
            (token_dict['session_id'], after_id, limit, offset),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT photos.* FROM photos JOIN runs ON photos.run_id = runs.id "
            "WHERE runs.session_id = ? AND photos.state IN ('exported', 'archived') "
            "ORDER BY photos.id ASC LIMIT ? OFFSET ?",
            (token_dict['session_id'], limit, offset),
        ).fetchall()

    photos_list = []
    for p in rows:
        metrics = None
        if p['metrics_json']:
            try:
                metrics = json.loads(p['metrics_json'])
            except Exception:
                metrics = None
        photos_list.append({
            'id': p['id'],
            'filename': p['filename'],
            'thumbnail_url': f"/gallery/api/{token}/photos/{p['id']}/thumb",
            'thumbnailUrl': f"/gallery/api/{token}/photos/{p['id']}/thumb",
            'overall_score': p['overall_score'],
            'overallScore': p['overall_score'],
            'metrics': metrics,
            'created_at': p['claimed_at'],
            'createdAt': p['claimed_at'],
        })

    resp = jsonify(photos_list)
    resp.headers['X-Total-Count'] = str(total_count)
    return resp


@app.get('/gallery/api/<token>/photos/<int:photo_id>/thumb')
def gallery_api_photo_thumb(token, photo_id):
    token_dict = validate_gallery_token(token)
    if token_dict is None:
        return jsonify({'error': 'not_found', 'detail': 'gallery not found'}), 404

    row = db.get().execute(
        "SELECT photos.drive_file_id, photos.filename FROM photos "
        "JOIN runs ON photos.run_id = runs.id "
        "WHERE photos.id = ? AND runs.session_id = ? AND photos.state IN ('exported', 'archived')",
        (photo_id, token_dict['session_id']),
    ).fetchone()
    if row is None:
        return jsonify({'error': 'not_found', 'detail': f'photo not found: {photo_id}'}), 404

    drive_token = _google_token()
    if not drive_token:
        return jsonify({'error': 'drive_error', 'detail': 'Drive not authorized on server'}), 502

    try:
        body, resolved_name, resolved_mime = google_drive.stream_file(
            drive_token, row['drive_file_id'], filename=row['filename'])
    except Exception as exc:
        return jsonify({'error': 'drive_error', 'detail': str(exc)}), 502

    return Response(body, mimetype=resolved_mime, headers={
        'Content-Disposition': f'inline; filename="{resolved_name}"',
        'Cache-Control': 'public, max-age=86400',
    })


@app.get('/gallery/api/<token>/photos/<int:photo_id>/full')
def gallery_api_photo_full(token, photo_id):
    token_dict = validate_gallery_token(token)
    if token_dict is None:
        return jsonify({'error': 'not_found', 'detail': 'gallery not found'}), 404

    row = db.get().execute(
        "SELECT photos.drive_file_id, photos.filename FROM photos "
        "JOIN runs ON photos.run_id = runs.id "
        "WHERE photos.id = ? AND runs.session_id = ? AND photos.state IN ('exported', 'archived')",
        (photo_id, token_dict['session_id']),
    ).fetchone()
    if row is None:
        return jsonify({'error': 'not_found', 'detail': f'photo not found: {photo_id}'}), 404

    drive_token = _google_token()
    if not drive_token:
        return jsonify({'error': 'drive_error', 'detail': 'Drive not authorized on server'}), 502

    try:
        body, resolved_name, resolved_mime = google_drive.stream_file(
            drive_token, row['drive_file_id'], filename=row['filename'])
    except Exception as exc:
        return jsonify({'error': 'drive_error', 'detail': str(exc)}), 502

    return Response(body, mimetype=resolved_mime, headers={
        'Content-Disposition': f'inline; filename="{resolved_name}"',
        'Cache-Control': 'public, max-age=3600',
    })


@app.get('/gallery/api/<token>/favorites')
def gallery_api_favorites_get(token):
    token_dict = validate_gallery_token(token)
    if token_dict is None:
        return jsonify({'error': 'not_found', 'detail': 'gallery not found'}), 404
    visitor_id = get_or_create_visitor_id()
    favs = gallery.get_visitor_favorites(token_dict['id'], visitor_id)
    return jsonify(favs)


@app.post('/gallery/api/<token>/favorites/<int:photo_id>')
def gallery_api_favorites_add(token, photo_id):
    token_dict = validate_gallery_token(token)
    if token_dict is None:
        return jsonify({'error': 'not_found', 'detail': 'gallery not found'}), 404
    row = db.get().execute(
        "SELECT photos.id FROM photos JOIN runs ON photos.run_id = runs.id "
        "WHERE photos.id = ? AND runs.session_id = ? AND photos.state IN ('exported', 'archived')",
        (photo_id, token_dict['session_id']),
    ).fetchone()
    if row is None:
        return jsonify({'error': 'not_found', 'detail': f'photo not found: {photo_id}'}), 404
    visitor_id = get_or_create_visitor_id()
    gallery.add_favorite(token_dict['id'], photo_id, visitor_id)
    return jsonify({'status': 'added'}), 201


@app.delete('/gallery/api/<token>/favorites/<int:photo_id>')
def gallery_api_favorites_remove(token, photo_id):
    token_dict = validate_gallery_token(token)
    if token_dict is None:
        return jsonify({'error': 'not_found', 'detail': 'gallery not found'}), 404
    visitor_id = get_or_create_visitor_id()
    gallery.remove_favorite(token_dict['id'], photo_id, visitor_id)
    return jsonify({'status': 'removed'}), 200


@app.get('/gallery/api/<token>/comments')
def gallery_api_comments_get(token):
    token_dict = validate_gallery_token(token)
    if token_dict is None:
        return jsonify({'error': 'not_found', 'detail': 'gallery not found'}), 404
    photo_id_arg = request.args.get('photo_id') or request.args.get('photoId')
    if photo_id_arg is not None:
        try:
            photo_id = int(photo_id_arg)
        except (TypeError, ValueError):
            return jsonify({'error': 'bad_request', 'detail': 'invalid photo_id'}), 400
        comments = gallery.get_comments_for_photo(token_dict['id'], photo_id)
    else:
        comments = gallery.get_comments_for_gallery(token_dict['id'])
    return jsonify(comments)


@app.post('/gallery/api/<token>/comments')
def gallery_api_comments_post(token):
    token_dict = validate_gallery_token(token)
    if token_dict is None:
        return jsonify({'error': 'not_found', 'detail': 'gallery not found'}), 404
    data = request.get_json(silent=True) or {}
    body = data.get('body')
    if not body or not isinstance(body, str) or not body.strip() or len(body.strip()) > 2000:
        return jsonify({'error': 'bad_request', 'detail': 'body is required and must be 1-2000 characters'}), 400
    body = body.strip()

    photo_id = data.get('photo_id') if 'photo_id' in data else data.get('photoId')
    if photo_id is not None:
        try:
            photo_id = int(photo_id)
        except (TypeError, ValueError):
            return jsonify({'error': 'bad_request', 'detail': 'invalid photo_id'}), 400
        row = db.get().execute(
            "SELECT photos.id FROM photos JOIN runs ON photos.run_id = runs.id "
            "WHERE photos.id = ? AND runs.session_id = ? AND photos.state IN ('exported', 'archived')",
            (photo_id, token_dict['session_id']),
        ).fetchone()
        if row is None:
            return jsonify({'error': 'not_found', 'detail': f'photo not found: {photo_id}'}), 404

    display_name = data.get('display_name') if 'display_name' in data else data.get('displayName')
    if display_name is not None:
        display_name = str(display_name).strip()[:100] or None

    visitor_id = get_or_create_visitor_id()
    comment = gallery.add_comment(token_dict['id'], photo_id, visitor_id, body, display_name)
    return jsonify(comment), 201


@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def serve_frontend(path):
    """Serve the built Vite frontend. Falls back to index.html for client-side routing."""
    if not os.path.isdir(FRONTEND_DIST):
        return jsonify({'error': 'Frontend not built. Run: cd frontend && npm run build'}), 503
    full = os.path.join(FRONTEND_DIST, path)
    if path and os.path.isfile(full):
        return send_from_directory(FRONTEND_DIST, path)
    return send_from_directory(FRONTEND_DIST, 'index.html')


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return jsonify({
        "status":        "ok",
        "model":         "multi-metric-v1",
        "metrics":       ["sharpness", "exposure", "noise", "contrast"],
        "driveEnabled": bool(GOOGLE_CLIENT_ID),
    })


@app.post("/analyze")
def analyze():
    """Single-image diagnostic. Returns all metrics."""
    try:
        if "file" not in request.files:
            return jsonify({"error": "bad_manifest", "detail": "no file part"}), 400

        file_obj = request.files["file"]
        filename = file_obj.filename or "unknown"

        img_bytes = file_obj.read()
        gray = decode_image(img_bytes)

        sharp_raw  = score_sharpness(gray)
        exposure   = score_exposure(gray)
        noise      = score_noise(gray)
        contrast   = score_contrast(gray)

        return jsonify({
            "filename":        filename,
            "sharpness_raw":   round(sharp_raw, 4),
            "exposure":        exposure,
            "noise":           noise,
            "contrast":        contrast,
            "model":           "multi-metric-v1",
        })

    except Exception as e:
        return jsonify({"error": "internal_error", "detail": str(e)}), 500


@app.post("/rank")
def rank():
    """
    Batch ranking endpoint.

    Content-Type: multipart/form-data
      manifest  — JSON string [{"id": "...", "filename": "..."}, ...]
      <id>      — one file part per manifest entry, keyed by id

    Returns per-image scores for sharpness (p99-normalised), exposure,
    noise, contrast, and a weighted composite overall_score.
    Sorted by overall_score descending; rank 1 = best image.
    """
    start = time.perf_counter()

    try:
        if "manifest" not in request.form:
            return jsonify({"error": "bad_manifest", "detail": "manifest field missing"}), 400

        try:
            manifest = json.loads(request.form["manifest"])
        except json.JSONDecodeError as e:
            return jsonify({"error": "bad_manifest", "detail": f"JSON parse error: {e}"}), 400

        if not isinstance(manifest, list):
            return jsonify({"error": "bad_manifest", "detail": "manifest must be an array"}), 400

        if len(manifest) > 200:
            return jsonify({"error": "payload_too_large",
                            "detail": f"batch size {len(manifest)} exceeds 200"}), 413

        # ---- Read all files into memory first ----
        tasks = []
        for entry in manifest:
            entry_id = entry.get("id")
            filename = entry.get("filename", "unknown")

            if not entry_id:
                return jsonify({"error": "bad_manifest",
                                "detail": "entry missing 'id' field"}), 400

            file_obj = request.files.get(entry_id)
            if file_obj is None:
                return jsonify({"error": "bad_manifest",
                                "detail": f"missing file part for id '{entry_id}'",
                                "missing_id": entry_id}), 400

            file_obj.seek(0)
            img_bytes = file_obj.read()
            tasks.append((entry_id, filename, img_bytes))

        # ---- Score all images via extracted core ----
        results, ranking_errors = scoring.rank_images(tasks)

        if not results:
            if ranking_errors:
                first = ranking_errors[0]
                return jsonify({
                    "error":          "all_scoring_failed",
                    "detail":         first["detail"],
                    "id":             first["id"],
                    "filename":       first["filename"],
                    "ranking_errors": ranking_errors,
                    "model":          "multi-metric-v1",
                    "duration_ms":    int((time.perf_counter() - start) * 1000),
                }), 422
            return jsonify({
                "results":          [],
                "ranking_errors":   [],
                "model":            "multi-metric-v1",
                "duration_ms":      int((time.perf_counter() - start) * 1000),
            })

        return jsonify({
            "results":          results,
            "ranking_errors":   ranking_errors,
            "model":            "multi-metric-v1",
            "duration_ms":      int((time.perf_counter() - start) * 1000),
        })

    except Exception as e:
        return jsonify({"error": "internal_error", "detail": str(e)}), 500


@app.post("/edit")
def edit():
    """Run Topaz on one local image (LOCAL ONLY). Non-destructive.

    Body (JSON):
      source_dir    — absolute path to the folder holding the image (required)
      filename      — bare filename within source_dir (required)
      enhancements  — {"sharpen": true, "noise": true, ...}; if omitted and
                      `iso` is given, defaults come from route_by_iso(iso)
      iso           — EXIF ISO, used only when enhancements omitted
      format/quality/overwrite — passed through to the wrapper
    Writes to <source_dir>/edited/ and returns the edited filename + fetch URL.

    Path model (why the NOSONAR markers on the isdir checks below, here and
    in edit_file(), are justified): source_dir is realpath-canonicalized
    immediately on receipt, and _safe_in_dir() still guards every filename
    joined under it against traversal. But source_dir itself is
    intentionally allowed to be any local folder — this route exists so the
    desktop UI can edit whatever folder the user picked via their browser's
    own File System Access API, which is unpredictable from the server's
    side by design. This app's real security boundary is enforce_auth()
    (BBP_PASSWORD or the Google email allowlist), not per-route path
    sandboxing: every other authenticated route already has equivalent
    reach (arbitrary Drive folder configuration, the server's own Drive
    OAuth tokens, etc.) — restricting only this route to a fixed root would
    both break the picker-driven workflow and not meaningfully change the
    app's actual trust boundary. See backend/audit.py's module docstring
    for the same reasoning applied to this app's local-only CLI tools.
    """
    data = request.get_json(silent=True) or {}
    source_dir = data.get("source_dir")
    filename = data.get("filename")
    if not source_dir or not filename:
        return jsonify({"error": "bad_request", "detail": "source_dir and filename are required"}), 400
    # Canonicalize once, immediately, before it's used in any filesystem
    # check below — matches _safe_in_dir's own realpath-based guard.
    source_dir = os.path.realpath(source_dir)
    if not os.path.isdir(source_dir):  # NOSONAR see docstring above
        return jsonify({"error": "not_found", "detail": f"source_dir does not exist: {source_dir}"}), 404

    try:
        input_path = _safe_in_dir(source_dir, filename)
    except ValueError as e:
        return jsonify({"error": "bad_request", "detail": str(e)}), 400
    if not os.path.isfile(input_path):
        return jsonify({"error": "not_found", "detail": f"file not found: {filename}"}), 404

    enhancements = data.get("enhancements")
    if enhancements is None:
        enhancements = topaz.route_by_iso(data.get("iso"))

    output_dir = os.path.join(source_dir, EDITED_SUBDIR)
    try:
        result = topaz.process(
            inputs=[input_path],
            output_dir=output_dir,
            enhancements=enhancements,
            fmt=data.get("format"),
            quality=data.get("quality"),
            overwrite=bool(data.get("overwrite", False)),
            timeout_s=float(data.get("timeout_s", 600.0)),
        )
    except topaz.TopazError as e:
        return jsonify({"error": "edit_config_error", "detail": str(e)}), 400
    except Exception as e:
        return jsonify({"error": "internal_error", "detail": str(e)}), 500

    payload = result.to_dict()
    payload["enhancements"] = enhancements
    if result.ok and result.outputs:
        edited_name = os.path.basename(result.outputs[0])
        payload["edited_filename"] = edited_name
        payload["edited_url"] = f"/edit/file?dir={source_dir}&name={edited_name}&variant=edited"
        payload["original_url"] = f"/edit/file?dir={source_dir}&name={filename}&variant=original"
    status_code = 200 if result.ok else 422
    return jsonify(payload), status_code


@app.get("/edit/file")
def edit_file():
    """Serve an original or edited image for the before/after viewer (LOCAL ONLY).

    Same path model as edit() above — see that route's docstring.
    """
    source_dir = request.args.get("dir")
    name = request.args.get("name")
    variant = request.args.get("variant", "original")
    if not source_dir or not name:
        return jsonify({"error": "bad_request", "detail": "dir and name are required"}), 400
    serve_dir = os.path.realpath(source_dir)
    if variant == "edited":
        serve_dir = os.path.join(serve_dir, EDITED_SUBDIR)
    if not os.path.isdir(serve_dir):  # NOSONAR see edit()'s docstring above
        return jsonify({"error": "not_found", "detail": "directory not found"}), 404
    try:
        full_path = _safe_in_dir(serve_dir, name)  # traversal guard; use its return, not a fresh join
    except ValueError as e:
        return jsonify({"error": "bad_request", "detail": str(e)}), 400
    if not os.path.isfile(full_path):
        return jsonify({"error": "not_found", "detail": "file not found"}), 404
    return send_from_directory(serve_dir, name)


if __name__ == "__main__":
    cert = os.environ.get('BBP_CERT')
    key  = os.environ.get('BBP_KEY')
    ssl_context = (cert, key) if cert and key else None
    # Railway injects PORT; local fallback is BBP_PORT or 8001
    port = 8443 if ssl_context else int(os.environ.get('PORT') or os.environ.get('BBP_PORT', '8001'))
    scheme = 'https' if ssl_context else 'http'

    hostname = os.environ.get('BBP_HOSTNAME', '0.0.0.0')
    print(f"Starting BigBadPhotos on {scheme}://{hostname}:{port}")
    app.run(
        debug=IS_DEBUG,
        host=hostname,
        port=port,
        ssl_context=ssl_context,
    )
