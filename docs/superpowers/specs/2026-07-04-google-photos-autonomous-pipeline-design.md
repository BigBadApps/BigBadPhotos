# Google Photos Integration + Server-Side Autonomous Pipeline — Design

**Date:** 2026-07-04
**Branch:** `bbaf/bigbadphotos-bobs-photo-services`
**Status:** Approved by Robert (design review 2026-07-04)

## Problem

BigBadPhotos covers camera → Google Drive → scoring → culling → compare → Topaz edit → export, but:

1. No Google Photos destination. Robert wants to create or re-select an album at session setup and publish selected photos into it.
2. Autonomous mode runs in a browser tab: the phone locking or the tab closing kills the pipeline, and the implicit-flow Google token expires after ~1 hour.
3. The Topaz edit step (`POST /edit`) only runs on the Mac against absolute local paths, so the browser-driven Drive pipeline can never reach it — files stay in browser memory.
4. Scoring and Topaz behavior have not been measured; accuracy/speed complaints are anecdotal.

Target experience: at a shoot, camera uploads JPEGs via images.canon to a Drive folder; Robert configures a session in BigBadPhotos on his phone; selected + Topaz-edited photos appear in a Google Photos album minutes later, hands-free.

## Decisions locked (with Robert, 2026-07-04)

- **App-created albums only.** Confirmed against current Google Photos API docs: since 2025-03-31 the Library API can only list and add media to albums the app created (`photoslibrary.appendonly`, `photoslibrary.readonly.appcreateddata`). Publishing into hand-made albums is impossible; BigBadPhotos creates and owns its albums, which remain fully visible/shareable in Google Photos.
- **Pipeline runs as a Mac server worker** inside Flask — not browser-driven, not n8n-orchestrated. The existing `n8n/topaz-edit.workflow.json` remains a standalone reusable asset.
- **Camera deposits JPEG only** into the Drive source folder. No RAW decode path needed in the autonomous pipeline.
- **Audit before tuning.** Benchmark scoring agreement and per-stage latency on a real session folder before changing any weights or profiles.

## Non-goals

- No RAW (CR3) scoring or editing in the autonomous pipeline.
- No changes to the existing browser autonomous mode (kept as fallback; may be deprecated later).
- No multi-user token management — single-owner app behind the existing auth gate.
- No Railway deployment of worker/Topaz features (Mac-only, feature-flagged).

## Architecture

```
Canon camera ── images.canon ──▶ Google Drive source folder
                                        │  (poll)
                    Flask on Mac ◀──────┘
                    session_worker thread:
                      download new JPEGs → staging dir
                      → score (backend/scoring.py, in-process)
                      → threshold + burst-best gate
                      → Topaz edit (backend/topaz.py, route_by_iso)
                      → upload edited JPEG → Google Photos album
                      → write .bbp.json sidecar back to Drive
                                        ▲
Phone (React SPA) ── configure/start/stop/status ──┘
```

The phone is a remote control; the Mac owns execution. Google credentials live server-side with a refresh token, so runs survive phone disconnects and token expiry.

## Components

### A. Google auth upgrade (foundation)

Authorization-code flow alongside the existing GIS implicit flow:

- `GET /google/oauth/start` — redirects to Google consent. Scopes: existing Drive scope + `photoslibrary.appendonly` + `photoslibrary.readonly.appcreateddata`.
- `GET /google/oauth/callback` — exchanges the code using `GOOGLE_CLIENT_SECRET`; persists tokens to `~/.bigbadphotos/google_token.json` (mode 600).
- `backend/google_auth.py` token manager: loads the token file, refreshes access tokens on demand (thread-safe, small expiry margin), exposes `get_access_token()`.
- Drive routes and new Photos routes prefer the token manager when a refresh token exists, else fall back to the session token (`session['google_drive_token']`) — hosted/Railway behavior unchanged.
- New envs: `GOOGLE_CLIENT_SECRET`, optional `BBP_TOKEN_PATH` override. `/auth/config` reports whether server-side Google auth is available so the frontend can offer "Connect Google (full)".

One-time Google Cloud console setup (documented in README section): add the Photos Library API, add the two Photos scopes to the consent screen, create/extend the OAuth client with the callback URL, set the secret in `.env`.

### B. Google Photos module

`backend/google_photos.py`, mirroring `google_drive.py` (plain `requests`, bearer headers):

- `list_albums(token)` — GET `https://photoslibrary.googleapis.com/v1/albums` (paginated; API returns app-created albums only).
- `create_album(token, title)` — POST `/v1/albums`.
- `upload_bytes(token, filename, data)` — POST `/v1/uploads` (raw bytes, `X-Goog-Upload-*` headers) → upload token.
- `batch_create(token, album_id, items)` — POST `/v1/mediaItems:batchCreate`, ≤50 newMediaItems per call, returns per-item status.

Flask routes (auth-gated like `/drive/*`):

- `GET /photos/albums`
- `POST /photos/albums` `{title}`
- `POST /photos/upload` — multipart file(s) + `albumId`; uploads bytes then batchCreates; returns per-file results including `mediaItemId`.

### C. Manual export to Google Photos

- New component `GooglePhotosAlbumPicker.jsx`: lists app-created albums, creates new (default name `BBP <YYYY-MM-DD>`), stores selection in the store as `photosAlbum {id, title}`.
- `ReviewExportView` gains destination choice **Google Photos album** next to the existing folder destination.
- `useExporter` gains a Photos path: sequential per-file POST `/photos/upload` with progress and failure list, mirroring the Drive path's error handling (`isDriveExportAbortError` analogue for Photos auth failures). Manual export sends the in-browser file as-is; preferring server-side `/edited` variants is the pre-existing "exporter prefers edited outputs" Topaz work item and stays out of scope here.

### D. Scoring extraction + audit

- Extract the scoring core from `app.py` (`decode_image`, `score_*`, `compute_phash`, `composite_score`, burst grouping) into `backend/scoring.py`. `app.py` imports it; `/rank` and `/analyze` responses stay byte-identical (regression-tested against fixture images).
- `backend/audit.py` + CLI (`python -m backend.audit <folder>`): runs scoring + optional Topaz over a real session folder; reports per-stage latency (download excluded, rank per image, Topaz per image) and score distribution; if the folder has Robert's verdicts (existing `.bbp.json` sidecars or `bigbad_decisions.json`), reports agreement between `overall_score >= threshold` and his keep/reject calls at several thresholds.
- Output: markdown report checked into `docs/audits/`. Tuning of weights/profiles happens only after this report, as its own change.

### E. Autonomous session worker

`backend/session_worker.py` — a singleton worker thread owned by the Flask process, plus `python -m backend.session_worker --config …` for headless use.

Session config (JSON, posted from the phone):

```json
{
  "sourceFolderId": "…",      // Drive folder
  "albumId": "…",             // app-created Photos album
  "threshold": 60,             // overall_score gate
  "edit": true,                // Topaz step on/off
  "pollSeconds": 30
}
```

Loop per poll:

1. List Drive folder (`list_all`) → JPEGs lacking a `.bbp.json` sidecar and not in the in-memory processed set.
2. Download each to a per-session staging dir (`~/.bigbadphotos/sessions/<id>/raw/`).
3. Score the batch in-process via `backend/scoring.py` (same burst grouping as `/rank`).
4. Gate: `overall_score >= threshold` AND `is_burst_best !== false`.
5. For qualifiers, if `edit`: `topaz.process()` with `route_by_iso(iso)` profiles into `<staging>/edited/` (serial — Topaz constraint).
6. Upload edited (or original if `edit` off / Topaz failed) JPEG to the album via `google_photos`; Topaz failure falls back to publishing the original and records the error.
7. Write the sidecar to the Drive source folder: existing `buildSidecarPayload` schema plus `published: {albumId, mediaItemId, publishedAt}`, `edited: {settings, status}`. Shared schema keeps browser mode and worker mode mutually dedupe-safe.
8. Update in-memory status; sleep `pollSeconds`.

Endpoints:

- `POST /autonomous/start` — body = session config; 409 if already running; requires server-side Google auth (refresh token present).
- `POST /autonomous/stop`
- `GET /autonomous/status` — `{running, phase, sessionConfig, counts: {seen, scored, published, skipped, failed}, lastPollAt, errors: […last 20]}`

Error policy: per-file failures are recorded and skipped (sidecar written with `status: failed` so they are not retried forever); Google 401/403 pauses the worker with a visible `auth_error` phase; Drive/API network errors retry next poll. Worker never crashes the Flask process — everything wrapped, status carries the truth.

### F. AutonomousPanel v2 (phone-first)

Replaces the panel's internals when the backend reports worker capability (`/auth/config` flag):

- Setup: Drive folder picker (existing `GoogleDriveFolderPicker`), album picker (component from C), threshold slider, edit toggle → **Start session**.
- Running: status card polling `/autonomous/status` every ~5 s — new/scored/published counts, current phase, last-poll clock, error list, **Stop**.
- Falls back to the current browser-driven hook when the backend lacks worker capability (Railway).

## Testing

- `backend/tests/test_google_photos.py` — mocked HTTP: album list/create, upload token flow, batchCreate chunking (>50 items), error surfaces.
- `backend/tests/test_scoring.py` — fixture images through `backend/scoring.py`; assert identical scores to pre-extraction `/rank` goldens.
- `backend/tests/test_session_worker.py` — worker loop with mocked Drive/Photos/Topaz: gating logic, sidecar content, failure paths, start/stop idempotence.
- Playwright smoke extension: album picker renders, export destination selectable (mock backend).
- Manual E2E (phase G): real camera session — images.canon → Drive → worker → album on a real Google account, phone as controller.

## Risks / mitigations

- **Unverified-app consent warnings** for Photos scopes on a personal GCP project — acceptable (owner is the only user; add self as test user).
- **Topaz serial throughput** (~seconds/image) bounds pipeline rate; acceptable for session volumes, measured in the audit.
- **Sidecar as dedupe ledger**: if a sidecar write fails after publish, a re-poll could re-publish. Mitigation: in-memory processed set + write sidecar before counting success; duplicate in an album is cosmetic, not destructive.
- **Flask restart kills the worker**: status is in-memory; sidecars make restart-resume safe (already-processed files skipped). CLI entry point exists for long headless runs.

## Build order

- **A.** OAuth code flow + token manager (foundation)
- **B.** `google_photos.py` + routes + tests
- **C.** Manual export to Photos (picker + exporter path)
- **D.** Scoring extraction + audit report
- **E.** Session worker + endpoints + tests
- **F.** AutonomousPanel v2
- **G.** Real-session end-to-end verification

Each phase is a separate conventional commit on this branch; no push to `main`; PR requires Robert's approval per project rules.
