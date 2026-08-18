# Camera Bridge Ingest Pipeline — Design Spec

**Date:** 2026-08-17
**Status:** Approved
**Branch:** TBD (will be `bbaf/bigbadphotos-camera-bridge-ingest`)

## Problem

Canon Camera Connect enters exclusive mode when USB-C tethered to an iPhone, blocking concurrent cloud uploads. Photographers need images reaching Google Drive in real-time during shoots — not after unplugging.

Additionally, Canon's image.canon always pushes to a fixed folder. Photographers need per-session Drive folder targeting (e.g., `2026-08-17_Smith-Senior`).

## Solution

Two input paths feeding one shared ingest pipeline with per-session Google Drive folder targeting.

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     INPUT PATHS                         │
│                                                         │
│  Path A (USB-C, primary):     Path B (WiFi FTP):        │
│  Camera ─USB─▶ Cascable       Camera ─WiFi─▶ iPhone     │
│       ▶ iOS Shortcut                Hotspot             │
│       ▶ POST /ingest                ▶ cellular          │
│                                     ▶ BBP FTP Server    │
│                                     ▶ file watcher      │
└────────────┬──────────────────────────┬─────────────────┘
             │                          │
             ▼                          ▼
┌─────────────────────────────────────────────────────────┐
│              SHARED INGEST PIPELINE                     │
│           (backend/ingest_pipeline.py)                  │
│                                                         │
│  1. Resolve session (explicit ID or single-active)      │
│  2. Validate image (extension, size)                    │
│  3. Dedup check (ingest_log unique constraint)          │
│  4. Upload to Google Drive (per-session folder)         │
│  5. Record in DB (ingest_log table)                     │
└─────────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────┐
│           GOOGLE DRIVE (per-session folder)             │
│                                                         │
│  My Drive/                                              │
│    └── BigBadPhotos/                                    │
│          ├── 2026-08-17_Smith-Senior/                   │
│          ├── 2026-08-20_Johnson-Family/                 │
│          └── ...                                        │
└─────────────────────────────────────────────────────────┘
```

## Target Setup

- **Camera:** Canon R6 Mark II
- **Tethering device:** iPhone (USB-C, cellular)
- **File types:** JPEG live during shoot; RAW transferred separately post-shoot
- **Drive destination:** Per-session folder, configurable in Sessions UI

## Database: `ingest_log` Table

New table in SQLite (`backend/db.py`):

```sql
CREATE TABLE IF NOT EXISTS ingest_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT    NOT NULL,
    filename      TEXT    NOT NULL,
    source        TEXT    NOT NULL,  -- 'http' | 'ftp'
    file_size     INTEGER,
    drive_file_id TEXT,
    drive_status  TEXT    NOT NULL DEFAULT 'pending',  -- pending | uploaded | failed
    error_detail  TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(session_id, filename)
);
```

`UNIQUE(session_id, filename)` provides idempotency — burst retries and Shortcut re-runs silently skip duplicates.

**`drive_status` states:** `pending` → `uploaded` (success) or `failed` (retry-eligible).

## Session Config Extensions

New fields on session object (`backend/sessions.py`):

| Field | Type | Purpose |
|---|---|---|
| `drive_folder_id` | `TEXT` | Target Drive folder for uploads |
| `drive_folder_name` | `TEXT` | Display name |
| `ingest_api_key` | `TEXT` | Per-session bearer token for `/ingest` auth |
| `ingest_active` | `BOOLEAN` | Marks session as FTP ingest target (one at a time) |

**Folder creation:** User picks via Drive folder browser or auto-creates with pattern `{date}_{session_name}` under a parent folder set in BBP Settings (`/settings` — new field `ingest_parent_folder_id`, defaults to Drive root). Uses existing `google_drive.ensure_folder()`.

**API key:** Auto-generated `secrets.token_hex(16)` on session create. Stored plaintext (short-lived, admin-visible). Revocable by regenerating.

**Single active session:** Only one session has `ingest_active=True` at a time. FTP uploads route to it. HTTP `/ingest` can target any session via explicit key.

## `/ingest` REST Endpoint

```
POST /ingest
Authorization: Bearer <ingest_api_key>
Content-Type: multipart/form-data
Fields: file (required)
```

**Responses:**
- `201 Created` — uploaded successfully, returns `{status, filename, drive_file_id, session_id}`
- `200 OK` — duplicate, already uploaded, returns `{status: "exists", ...}`
- `401` — invalid/missing API key
- `413` — file exceeds 50MB limit
- `422` — unsupported file type
- `500` — Drive upload failed, returns `{error, detail}`

**Flow:**
1. Validate `Authorization` header → resolve to session
2. Validate file extension against `IMAGE_EXTENSIONS`, enforce 50MB max
3. Dedup check via `ingest_log(session_id, filename)`
4. Insert `pending` row in `ingest_log`
5. `google_drive.upload_file(session.drive_folder_id, filename, data)`
6. Update row to `uploaded` with `drive_file_id`
7. On failure: update to `failed`, return 500

**Test endpoint:** `GET /ingest/test` with `Authorization` header — validates key, returns session name.

## Shared Ingest Pipeline

New module `backend/ingest_pipeline.py`:

```python
def ingest_file(filepath_or_bytes, *, filename=None, session_id=None, source='http'):
    """
    Convergence point for HTTP and FTP paths.
    1. Resolve session (explicit session_id or single-active for FTP)
    2. Dedup check
    3. Upload to session's Drive folder
    4. Record in ingest_log
    Returns (status, drive_file_id)
    """
```

Both `/ingest` route and `burst_watcher.on_frame_arrived` call this function.

## FTP Server Wiring

Conditional startup in `app.py` when `BBP_FTP_PORT` is set:

```python
if os.environ.get('BBP_FTP_PORT'):
    start_ftp_thread(root, port, user, password)
    start_burst_watcher(
        ...,
        on_frame_arrived=lambda path: ingest_file(path, source='ftp'),
    )
```

FTP path uses stored OAuth refresh token from session creator for Drive access (existing `google_auth.py` pattern).

## iOS Shortcut + Cascable Integration

No BBP code — setup guide only.

**Cascable config:**
1. Install Cascable Studio, connect R6 II via USB-C
2. Camera: `USB connection app` → `Photo Import/Remote Control`
3. Enable Storage Links to route images to local folder/album

**iOS Shortcut "BBP Ingest":**
- Trigger: Automation → file saved to Cascable album
- Action: POST file to `/ingest` with Bearer token
- Error: notification on non-2xx response

**Per-shoot setup:**
1. Create session in BBP, pick Drive folder
2. Copy `ingest_api_key` from session detail
3. Paste into Shortcut Authorization header

## Sessions UI Changes

**Session form — new fields:**
- Drive Folder picker (reuses `/drive/browse`)
- Ingest API Key (read-only, copy button, shown when `drive_folder_id` set)
- Ingest Active toggle (confirmation when switching from another session)

**Session detail — new "Ingest" section:**
- Status badge (Active/Inactive)
- File counter from `ingest_log` aggregation
- Recent files list (last 10)
- Retry failed button
- API key + copy
- Test URL link

## Security

**Ingest API key:** 32-char hex, per-session scoped, upload-only, revocable. Always via `Authorization: Bearer` header, never query string.

**File validation:** Extension whitelist (`IMAGE_EXTENSIONS`), 50MB `MAX_CONTENT_LENGTH`, `secure_filename()` sanitization. Bytes go to Drive API — never executed, minimal/no server filesystem persistence.

**FTP exposure:** If on Railway, FTPS enforced (`BBP_CERT`/`BBP_KEY`), strong password, `max_cons=5`. Recommended: run FTP locally at venue only, avoid public exposure. Railway TCP port mapping required for passive range.

**Drive OAuth:** Refresh tokens stored in DB (existing pattern). Used server-side for FTP background uploads.

**Threat surface:** HTTP `/ingest` is low risk (bearer auth, HTTPS, file validation). FTP is medium risk if public (recommend local-only). Drive tokens unchanged from current risk profile.

## File Types

JPEG only during live ingest. Supported extensions per existing `IMAGE_EXTENSIONS` set. RAW files transferred post-shoot via separate workflow (already supported by autonomous mode).

## Gallery Integration

Ingested images land in the session's Drive folder. Existing gallery system can browse that folder — no extra wiring if gallery watches the same `drive_folder_id`. Live gallery viewers see new images as they arrive in Drive.
