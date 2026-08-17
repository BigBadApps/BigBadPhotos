# BigBadPhotos — Client Photo Gallery & Pipeline Enhancement

**Date:** 2026-08-17
**Status:** Approved
**Approach:** Incremental Integration (Approach A) — gallery built inside BigBadPhotos

## Goal

End-to-end photography workflow: configure session → share gallery link with client → shoot → camera feeds images.canon → images.canon feeds Google Drive → app monitors/scores/groups/auto-culls/auto-edits/exports → photos appear live in client gallery → client favorites & comments → photographer approves favorites → favorites folder on Drive → share via gallery.

## Key Design Decisions

1. **Gallery lives inside BigBadPhotos** — same Flask+React app, single Railway deploy, shared DB and Drive tokens.
2. **Token-based share links** — gallery URL with crypto token is the only access gate. No login required. Anyone with link can view, favorite, comment.
3. **Token generated at session creation** — URL available immediately for sharing before any photos exist. Clients can watch photos arrive in real-time during shoots.
4. **Analog Digitalist theme** — client-facing gallery uses editorial aesthetic from BigBadPhotoGallery mockups (Newsreader typography, muted tones, masonry grid). Scoped via `[data-gallery]` CSS attribute to isolate from photographer UI.
5. **Anonymous visitor tracking** — browser cookie (`gallery_visitor_id`) lets multiple visitors independently manage favorites without login.
6. **Drive folders set to public-read** — export and favorites folders get "anyone with link can view" permission via Drive API.
7. **Favorites → Drive subfolder** — photographer approves client favorites, app copies to subfolder, gallery shows Favorites tab.
8. **DCT artifact scoring** — added to `scoring.py` as metadata, not in composite score initially.

## Live Gallery Use Case

Primary scenarios: (1) senior portrait sessions where parents watch photos of their kid appear live, (2) sports events where fans watch photos arrive as photographer shoots. Gallery starts empty with "Photos arriving soon..." and fills as pipeline exports complete. Polls every 5-10s.

---

## Database Schema

### New Tables

```sql
-- Gallery access tokens (created with session)
CREATE TABLE gallery_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,          -- secrets.token_urlsafe(24)
    label TEXT DEFAULT 'Main Gallery',
    scope TEXT DEFAULT 'exports',        -- 'exports' | 'favorites'
    expires_at TEXT,                      -- nullable ISO datetime
    revoked INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Client favorites (per-visitor)
CREATE TABLE gallery_favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id INTEGER NOT NULL REFERENCES gallery_tokens(id) ON DELETE CASCADE,
    photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    visitor_id TEXT NOT NULL,             -- random cookie-based ID
    created_at TEXT NOT NULL,
    UNIQUE(token_id, photo_id, visitor_id)
);

-- Client comments
CREATE TABLE gallery_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id INTEGER NOT NULL REFERENCES gallery_tokens(id) ON DELETE CASCADE,
    photo_id INTEGER REFERENCES photos(id) ON DELETE CASCADE,  -- nullable for gallery-level
    visitor_id TEXT NOT NULL,
    display_name TEXT,                    -- optional, visitor-provided
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
);
```

### Schema Changes to Existing Tables

```sql
-- Add to sessions table
ALTER TABLE sessions ADD COLUMN gallery_enabled INTEGER DEFAULT 1;
ALTER TABLE sessions ADD COLUMN favorites_folder_id TEXT;
ALTER TABLE sessions ADD COLUMN favorites_folder_name TEXT;
```

### Indexes

```sql
CREATE INDEX idx_gallery_tokens_session ON gallery_tokens(session_id);
-- Note: idx_gallery_tokens_token not needed — UNIQUE constraint on token column already creates an implicit index
CREATE INDEX idx_gallery_favorites_token_photo ON gallery_favorites(token_id, photo_id);
CREATE INDEX idx_gallery_comments_token ON gallery_comments(token_id);
CREATE INDEX idx_gallery_comments_photo ON gallery_comments(photo_id);
```

---

## Gallery API

### Public Routes (token-validated)

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/gallery/<token>` | Serve gallery React SPA |
| GET | `/gallery/api/<token>/info` | Session name, photo count, scope |
| GET | `/gallery/api/<token>/photos` | Paginated exported photos (thumbnails + metadata) |
| GET | `/gallery/api/<token>/photos/<id>/full` | Full-res image proxy via Drive |
| GET | `/gallery/api/<token>/favorites` | Favorites for current visitor (by cookie) |
| POST | `/gallery/api/<token>/favorites/<photo_id>` | Add favorite |
| DELETE | `/gallery/api/<token>/favorites/<photo_id>` | Remove favorite |
| GET | `/gallery/api/<token>/comments` | All comments (gallery + per-photo) |
| POST | `/gallery/api/<token>/comments` | Add comment (body + optional photo_id + optional display_name) |

Token validation: lookup token in `gallery_tokens`, check not revoked, check not expired. Return 404 (not 401/403) on invalid token — don't leak that the endpoint exists.

Visitor ID: read `bbp_visitor` cookie. If absent, set one with `secrets.token_urlsafe(16)`, SameSite=Lax, HttpOnly=false (JS needs read access for optimistic UI), max-age 1 year.

### Photographer Routes (authenticated, under existing session namespace)

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/sessions/<id>/gallery` | Token, URL, visitor count, favorites count, comments count |
| GET | `/sessions/<id>/gallery/favorites` | Aggregated favorites: photo details + total favorite count per photo across all visitors |
| GET | `/sessions/<id>/gallery/comments` | All comments with visitor display names |
| POST | `/sessions/<id>/gallery/approve-favorites` | Body: `{photo_ids: [...]}`. Creates Drive subfolder, copies photos, creates favorites-scope token |
| POST | `/sessions/<id>/gallery/revoke` | Revoke gallery token |
| POST | `/sessions/<id>/gallery/regenerate` | Generate new token, revoke old |

---

## Gallery Frontend

### Client-Facing Components (`frontend/src/views/Gallery/`)

- **GalleryShell.jsx** — `[data-gallery]` wrapper, loads Newsreader+Inter fonts, applies Analog Digitalist color palette, handles visitor cookie
- **GalleryLanding.jsx** — Empty state: session title, photographer branding, "Photos arriving soon..." with subtle animation. Auto-transitions to grid when first photo arrives.
- **GalleryGrid.jsx** — Masonry grid (1/2/3 col responsive). Photos fade in on arrival. Heart overlay for favorited state. Polls `/gallery/api/<token>/photos` every 5s.
- **GalleryLightbox.jsx** — Full-bleed viewer, prev/next nav, favorite toggle, comment thread per photo, comment input with optional display name
- **GalleryFavorites.jsx** — Filtered view of favorited photos only. Also used for favorites-scope tokens after photographer approval.
- **GalleryComments.jsx** — Comment list component (reused in lightbox and standalone)

### CSS Isolation

All gallery styles scoped under `[data-gallery]` attribute selector. Separate CSS file (`Gallery.css`) with CSS custom properties for the Analog Digitalist palette. No Tailwind in gallery views — hand-crafted CSS matching BigBadPhotoGallery design language.

### Photographer-Facing Additions

- **SessionAreaView** gains "Gallery" card: copyable share URL, live stats (visitors, favorites, comments), "Review Favorites" button
- **FavoritesReviewView.jsx** — New view at `/sessions/:id/favorites`. Grid of favorited photos with per-photo approve/reject and bulk approve. Shows comment thread per photo. "Create Favorites Folder" action.

---

## Pipeline Integration

### Session Creation

`sessions.create()` in `backend/sessions.py`:
1. Insert session row (existing)
2. Generate `secrets.token_urlsafe(24)`
3. Insert `gallery_tokens` row with `scope='exports'`
4. Return session dict with `gallery_token` and `gallery_url`

### Export Folder Permissions

`google_drive.py` gains `set_public_read(folder_id, token)`:
```python
def set_public_read(folder_id, token):
    requests.post(
        f"https://www.googleapis.com/drive/v3/files/{folder_id}/permissions",
        headers={"Authorization": f"Bearer {token}"},
        json={"role": "reader", "type": "anyone"}
    )
```

Called in pipeline `_export` step on first export (when creating the export folder), and in `approve-favorites` when creating the favorites subfolder.

### Gallery Photo Availability

No pipeline changes needed for photo visibility. Gallery API queries `photos` table for `state = 'exported'` (or later states). Photos appear in gallery as soon as `_export` completes and commits the state transition.

### Favorites Approval Workflow

`POST /sessions/<id>/gallery/approve-favorites`:
1. Validate photographer auth
2. Get photo records for submitted `photo_ids`
3. Create subfolder `{session_name} - Favorites` under export folder via `google_drive.create_folder()`
4. Set public-read permission on subfolder
5. Copy each approved photo to subfolder via Drive API copy
6. Store `favorites_folder_id` on session
7. Create new `gallery_tokens` row with `scope='favorites'` for the subfolder
8. Return favorites folder ID and new gallery URL

---

## Scoring Enhancement: DCT Artifact Detection

### Implementation in `backend/scoring.py`

New function `score_artifacts(gray)`:
1. Iterate 8x8 DCT blocks across image
2. Compute cross-boundary pixel discontinuity at each block edge
3. Compare to within-block discontinuity as baseline
4. Ratio of boundary vs interior discontinuity indicates compression artifacts
5. Score: 1.0 (no artifacts) to 0.0 (heavy artifacts)

### Integration

- Added to `rank_images()` per-image scoring pipeline
- Stored in `metrics_json` as `artifact_score`
- **Not** included in `composite_score()` initially — available as metadata for display in CullingView sidebar and gallery
- Can be promoted to composite with weight adjustment after validation on real shoots

---

## Routing

### New React Routes

```jsx
// Client gallery (no auth)
/gallery/:token                    → GalleryShell → GalleryGrid (or GalleryLanding if empty)
/gallery/:token/favorites          → GalleryShell → GalleryFavorites
/gallery/:token/photo/:photoId     → GalleryShell → GalleryLightbox

// Photographer (authenticated)
/sessions/:sessionId/favorites     → FavoritesReviewView
```

### Flask Route Serving

`/gallery/<token>` and all sub-paths serve the React SPA build (same as existing `/*` catch-all but gallery-specific entry). The React router handles client-side routing from there.

---

## Phased Implementation

### Dependency Graph

```
Phase 1 (DB + Backend Models)
    ├── Phase 2A (Gallery API Routes)      ──→ Phase 3 (Gallery Frontend) ──→ Phase 5 (E2E Polish)
    ├── Phase 2B (DCT Artifact Scoring)  ─────────────────────────────────────→ Phase 5
    └── Phase 4 (Pipeline + Session Integration + Photographer UI) ─────────→ Phase 5
```

**Parallel pairs:**
- Phase 2A + 2B (independent)
- Phase 3 + Phase 4 (different file sets, can run concurrently with care)

### Phase 1: Database Schema & Gallery Backend Module

**Must complete before:** 2A, 2B, 3, 4
**Files touched:** `backend/db.py`, new `backend/gallery.py`

### Phase 2A: Gallery REST API

**Depends on:** Phase 1
**Can parallel with:** Phase 2B
**Files touched:** `app.py`

### Phase 2B: DCT Artifact Scoring

**Depends on:** nothing (independent)
**Can parallel with:** Phase 2A
**Files touched:** `backend/scoring.py`

### Phase 3: Gallery Frontend (Client Views)

**Depends on:** Phase 2A
**Can parallel with:** Phase 4
**Files touched:** new `frontend/src/views/Gallery/*`, `frontend/src/App.jsx` (routes)

### Phase 4: Pipeline + Session Integration + Photographer UI

**Depends on:** Phase 1
**Can parallel with:** Phase 3
**Files touched:** `backend/sessions.py`, `backend/pipeline.py`, `backend/google_drive.py`, `frontend/src/views/SessionAreaView.jsx`, new `frontend/src/views/FavoritesReviewView.jsx`

### Phase 5: End-to-End Testing & Polish

**Depends on:** All phases complete
**Files touched:** potentially any, plus `frontend/tests/`

---

## Agent Prompts

Detailed prompts for each phase follow. Each is self-contained for handoff to an implementation agent.

---

### PHASE 1 PROMPT: Database Schema & Gallery Backend Module

```
You are implementing Phase 1 of the BigBadPhotos Client Photo Gallery feature.

PROJECT: /Volumes/BigBadDrive_1/BigBadPhotos
TECH STACK: Python 3, Flask, SQLite (WAL mode), React/Vite frontend

CONTEXT:
BigBadPhotos is a photography workflow app. We are adding a client-facing photo gallery so photographers can share a link with clients who watch photos appear in real-time during shoots, favorite photos, and leave comments. This phase creates the database foundation and backend data-access module.

EXISTING CODE TO UNDERSTAND FIRST:
- backend/db.py — SQLite connection manager with incremental schema migration. Currently at schema version 2. Uses threading.local() for connections, WAL mode. Tables: sessions, runs, photos, run_errors, app_settings.
- backend/sessions.py — CRUD for sessions table. Follow its patterns (row-to-dict conversion, timestamp handling, validation).

TASK 1: Update backend/db.py

Increment schema version to 3. Add migration logic in the existing migration pattern.

New tables:

gallery_tokens:
- id INTEGER PRIMARY KEY AUTOINCREMENT
- session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
- token TEXT UNIQUE NOT NULL
- label TEXT DEFAULT 'Main Gallery'
- scope TEXT DEFAULT 'exports' (values: 'exports', 'favorites')
- expires_at TEXT (nullable ISO datetime)
- revoked INTEGER DEFAULT 0
- created_at TEXT NOT NULL
- updated_at TEXT NOT NULL
- INDEX on session_id
- INDEX on token

gallery_favorites:
- id INTEGER PRIMARY KEY AUTOINCREMENT
- token_id INTEGER NOT NULL REFERENCES gallery_tokens(id) ON DELETE CASCADE
- photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE
- visitor_id TEXT NOT NULL (random cookie-based browser ID)
- created_at TEXT NOT NULL
- UNIQUE(token_id, photo_id, visitor_id)
- INDEX on (token_id, photo_id)

gallery_comments:
- id INTEGER PRIMARY KEY AUTOINCREMENT
- token_id INTEGER NOT NULL REFERENCES gallery_tokens(id) ON DELETE CASCADE
- photo_id INTEGER REFERENCES photos(id) ON DELETE CASCADE (nullable — null means gallery-level comment)
- visitor_id TEXT NOT NULL
- display_name TEXT (nullable, visitor-provided)
- body TEXT NOT NULL
- created_at TEXT NOT NULL
- INDEX on token_id
- INDEX on photo_id

ALTER sessions table — add three columns:
- gallery_enabled INTEGER DEFAULT 1
- favorites_folder_id TEXT
- favorites_folder_name TEXT

TASK 2: Create backend/gallery.py

New module for gallery data access. Follow the patterns in backend/sessions.py (use db.get() for connections, return dicts, ISO timestamps via datetime.utcnow().isoformat()).

Functions to implement:

Token management:
- create_token(session_id, label='Main Gallery', scope='exports', expires_at=None) — generates token via secrets.token_urlsafe(24), inserts row, returns dict
- get_token_by_value(token_value) — lookup by token string, return dict or None. Check not revoked, check not expired (compare expires_at to now if set).
- get_tokens_for_session(session_id) — list all tokens for a session
- revoke_token(token_id) — set revoked=1, update updated_at
- revoke_tokens_for_session(session_id) — revoke all tokens for a session

Favorites:
- add_favorite(token_id, photo_id, visitor_id) — INSERT OR IGNORE (idempotent)
- remove_favorite(token_id, photo_id, visitor_id) — DELETE
- get_visitor_favorites(token_id, visitor_id) — list of photo_ids for this visitor
- get_aggregated_favorites(session_id) — for photographer view: list of {photo_id, filename, drive_file_id, overall_score, favorite_count} across all visitors, ordered by favorite_count desc. Join through gallery_tokens on session_id.

Comments:
- add_comment(token_id, photo_id, visitor_id, body, display_name=None) — insert, return dict with id
- get_comments_for_gallery(token_id) — all comments for this token, ordered by created_at
- get_comments_for_photo(token_id, photo_id) — comments on a specific photo
- get_all_comments_for_session(session_id) — for photographer view: all comments across all tokens for a session, with photo filename. Join through gallery_tokens.

Stats:
- get_gallery_stats(session_id) — returns {favorites_count, comments_count, unique_visitors} by counting distinct visitor_ids across favorites and comments for this session's tokens

TASK 3: Update backend/sessions.py

Modify create() to also create a gallery token:
- After inserting the session row and getting the new session ID
- Import and call gallery.create_token(session_id)
- Include gallery_token and gallery_url in the returned session dict

Modify _row_to_dict() to include the new columns: gallery_enabled, favorites_folder_id, favorites_folder_name.

Modify update() to allow updating gallery_enabled.

IMPORTANT:
- Do NOT modify app.py in this phase (that's Phase 2A)
- Do NOT modify any frontend files
- Do NOT modify scoring.py
- Follow existing code style exactly (no type hints unless already used, same import patterns, same error handling)
- Use secrets.token_urlsafe(24) for token generation (import secrets)
- All timestamps as datetime.utcnow().isoformat() + 'Z'
- Test the migration works by checking db.get() doesn't error after schema change
```

---

### PHASE 2A PROMPT: Gallery REST API Routes

```
You are implementing Phase 2A of the BigBadPhotos Client Photo Gallery feature.

PROJECT: /Volumes/BigBadDrive_1/BigBadPhotos
TECH STACK: Python 3, Flask, SQLite, React/Vite frontend
DEPENDS ON: Phase 1 (already complete — backend/db.py has gallery tables, backend/gallery.py has data access)

CONTEXT:
BigBadPhotos is adding a client-facing photo gallery. Phase 1 created the DB schema and gallery.py module. This phase adds Flask routes for both the public gallery API (accessed by clients via token URL) and photographer-facing gallery management routes.

EXISTING CODE TO UNDERSTAND FIRST:
- app.py — Flask app with existing route patterns. Auth is Flask session-based. Study how /sessions/* routes work for the authenticated pattern. Study how the React SPA is served (catch-all route serves index.html).
- backend/gallery.py — Data access module created in Phase 1. Has functions for tokens, favorites, comments, stats.
- backend/google_drive.py — Drive API wrapper. Study upload_file(), create_folder(), ensure_folder() for the favorites approval flow.

TASK 1: Add public gallery routes to app.py

These routes are NOT authenticated — the token in the URL is the access gate.

Helper function validate_gallery_token(token_value):
- Call gallery.get_token_by_value(token_value)
- Return None if not found, revoked, or expired
- Return the token dict if valid

Visitor ID cookie handling — helper function get_or_create_visitor_id():
- Read cookie 'bbp_visitor' from request
- If present, return it
- If absent, generate secrets.token_urlsafe(16), set it on the response later
- Use flask.g to stash the visitor_id and a flag for whether to set cookie

After-request handler to set cookie:
- If g has new_visitor flag, set 'bbp_visitor' cookie: SameSite=Lax, HttpOnly=False, max_age=365*24*3600, path=/gallery/

Routes:

GET /gallery/<token>
- Validate token, 404 if invalid
- Serve the React SPA index.html (same as existing catch-all but gallery gets it too)
- React router handles client-side routing from here

GET /gallery/api/<token>/info
- Validate token, 404 if invalid
- Look up session via token's session_id (use sessions.get())
- Return JSON: {session_name, photo_count, scope: token.scope, gallery_label: token.label}
- photo_count: SELECT COUNT(*) FROM photos JOIN runs ON photos.run_id = runs.id WHERE runs.session_id = ? AND photos.state IN ('exported', 'archived')

GET /gallery/api/<token>/photos
- Validate token, 404 if invalid
- Query params: limit (default 50, max 200), offset (default 0), after_id (for polling — return photos with id > after_id)
- Query photos table: JOIN runs on run_id, WHERE runs.session_id = token.session_id AND photos.state IN ('exported', 'archived')
- Order by photos.id ASC (chronological appearance)
- Return JSON array: [{id, filename, thumbnail_url: f"/gallery/api/{token}/photos/{id}/thumb", overall_score, metrics (parsed from metrics_json), created_at: claimed_at}]
- Include X-Total-Count header with total photo count (for client to know if more exist)

GET /gallery/api/<token>/photos/<int:photo_id>/thumb
- Validate token, 404 if invalid
- Verify photo belongs to this session (JOIN through runs)
- Stream thumbnail from Drive via google_drive.stream_file() using the session's Drive token
- Follow the same pattern as the existing /photos/<id>/thumb endpoint in app.py for how the Drive OAuth token is obtained and how the image is proxied
- Set Cache-Control: public, max-age=86400
- Content-Type from filename extension

GET /gallery/api/<token>/photos/<int:photo_id>/full
- Same as thumb but full resolution
- Use google_drive.download_file() or stream_file()
- Cache-Control: public, max-age=3600

GET /gallery/api/<token>/favorites
- Validate token, get visitor_id
- Return gallery.get_visitor_favorites(token.id, visitor_id) as JSON array of photo_ids

POST /gallery/api/<token>/favorites/<int:photo_id>
- Validate token, get visitor_id
- Verify photo belongs to session
- Call gallery.add_favorite(token.id, photo_id, visitor_id)
- Return 201 {status: 'added'}

DELETE /gallery/api/<token>/favorites/<int:photo_id>
- Validate token, get visitor_id
- Call gallery.remove_favorite(token.id, photo_id, visitor_id)
- Return 200 {status: 'removed'}

GET /gallery/api/<token>/comments
- Validate token
- Optional query param: photo_id (filter to specific photo)
- Return gallery.get_comments_for_gallery(token.id) or get_comments_for_photo() as JSON

POST /gallery/api/<token>/comments
- Validate token, get visitor_id
- JSON body: {body: required, photo_id: optional, display_name: optional}
- Validate body is non-empty string, max 2000 chars
- Call gallery.add_comment(...)
- Return 201 with comment dict

TASK 2: Add photographer gallery management routes to app.py

These routes ARE authenticated (use existing @require_auth pattern or session check).

GET /sessions/<int:session_id>/gallery
- Existing auth required
- Return: {token, gallery_url: f"/gallery/{token}", stats: gallery.get_gallery_stats(session_id), tokens: gallery.get_tokens_for_session(session_id)}

GET /sessions/<int:session_id>/gallery/favorites
- Return gallery.get_aggregated_favorites(session_id) as JSON

GET /sessions/<int:session_id>/gallery/comments
- Return gallery.get_all_comments_for_session(session_id) as JSON

POST /sessions/<int:session_id>/gallery/approve-favorites
- JSON body: {photo_ids: [int, ...]}
- Look up session, get export_folder_id
- Create subfolder '{session_name} - Favorites' via google_drive.create_folder() under export folder
- Set public-read on subfolder: POST to Drive permissions API — add a new function set_public_read(folder_id, token) to google_drive.py:
    requests.post(
        f"https://www.googleapis.com/drive/v3/files/{folder_id}/permissions",
        headers={"Authorization": f"Bearer {token}"},
        json={"role": "reader", "type": "anyone"}
    )
- For each photo_id: get the photo's exported_file_id, copy to favorites folder via Drive API copy endpoint
- Update session: favorites_folder_id, favorites_folder_name
- Create new gallery_tokens row with scope='favorites' for this session
- Return {favorites_folder_id, favorites_token, favorites_url}

POST /sessions/<int:session_id>/gallery/revoke
- Revoke all tokens for session
- Return 200

POST /sessions/<int:session_id>/gallery/regenerate
- Revoke all existing tokens
- Create new token
- Return new token info

TASK 3: Add set_public_read() to backend/google_drive.py

Add function:
def set_public_read(folder_id, token):
    """Set Google Drive folder/file to 'anyone with link can view'."""
    resp = requests.post(
        f"https://www.googleapis.com/drive/v3/files/{folder_id}/permissions",
        headers={"Authorization": f"Bearer {token}"},
        json={"role": "reader", "type": "anyone"}
    )
    resp.raise_for_status()
    return resp.json()

Also add copy_file(file_id, dest_folder_id, token) for copying photos to favorites folder:
def copy_file(file_id, dest_folder_id, token, new_name=None):
    """Copy a file to a destination folder."""
    body = {"parents": [dest_folder_id]}
    if new_name:
        body["name"] = new_name
    resp = requests.post(
        f"https://www.googleapis.com/drive/v3/files/{file_id}/copy",
        headers={"Authorization": f"Bearer {token}"},
        json=body
    )
    resp.raise_for_status()
    return resp.json()

IMPORTANT:
- Do NOT modify frontend files in this phase
- Do NOT modify scoring.py
- Do NOT modify db.py or gallery.py (those are done in Phase 1)
- Follow existing app.py patterns exactly: error handling, JSON responses, status codes
- Use flask.jsonify for all JSON responses
- Public routes return 404 (not 401/403) on invalid tokens — don't leak endpoint existence
- Check how existing routes get the Drive OAuth token and follow the same pattern for gallery image proxying
```

---

### PHASE 2B PROMPT: DCT Artifact Scoring

```
You are implementing Phase 2B of the BigBadPhotos scoring enhancement.

PROJECT: /Volumes/BigBadDrive_1/BigBadPhotos
TECH STACK: Python 3, OpenCV, NumPy
DEPENDS ON: nothing (independent of other phases)

CONTEXT:
BigBadPhotos uses OpenCV-based heuristic scoring to rank photos for automated culling. The scoring engine computes sharpness (Laplacian variance), exposure (histogram analysis), noise (Donoho estimator), contrast (RMS), and composition (rule-of-thirds + horizon detection). We are adding JPEG compression artifact detection inspired by digiKam's Image Quality Parser.

EXISTING CODE TO UNDERSTAND:
- backend/scoring.py — Read the entire file. Understand:
  - decode_image() at line ~163: how images are decoded to grayscale, max 1000px
  - Individual scoring functions: score_sharpness(), score_exposure(), score_noise(), score_contrast(), score_composition()
  - composite_score() at line ~447: current weights (0.40 sharpness, 0.30 exposure, 0.20 noise, 0.10 contrast)
  - rank_images() at line ~464: how per-image scoring is called and results assembled
  - The metrics dict structure that gets stored as metrics_json

TASK: Add score_artifacts() function to backend/scoring.py

Implement DCT 8x8 block boundary artifact detection:

def score_artifacts(gray):
    """
    Detect JPEG compression artifacts by measuring discontinuity at 8x8 DCT block boundaries
    vs interior regions. Heavy compression creates visible grid patterns at block edges.
    
    Returns float 0.0 (heavy artifacts) to 1.0 (clean/no artifacts).
    """

Algorithm:
1. Ensure image dimensions are at least 64x64. If smaller, return 1.0 (can't reliably assess).
2. Crop image to multiple of 8 in both dimensions (discard partial blocks at edges).
3. Compute horizontal and vertical gradient magnitude using cv2.Sobel (ksize=1 for sensitivity to sharp transitions).
4. Extract boundary pixels: columns at positions 0, 8, 16, 24... (vertical block boundaries) and rows at positions 0, 8, 16, 24... (horizontal block boundaries). These are the DCT block edges.
5. Extract interior pixels: all other columns/rows (within-block regions).
6. Compute mean absolute gradient at boundary positions (boundary_energy).
7. Compute mean absolute gradient at interior positions (interior_energy).
8. Compute blockiness ratio: boundary_energy / (interior_energy + 1e-6).
9. A clean image has ratio near 1.0 (boundaries look like interior). A compressed image has ratio > 1.0 (boundaries have more discontinuity).
10. Convert to score: score = 1.0 / (1.0 + max(0, ratio - 1.0) * 2.0). This gives 1.0 when ratio <= 1.0, and drops toward 0 as ratio increases.
11. Clip to [0.0, 1.0].

Integration into rank_images():
- Call score_artifacts(gray) alongside the other scoring functions in the per-image scoring block
- Add 'artifact_score' to the metrics dict (same level as sharpness_score, exposure_score, etc.)
- Do NOT add artifact_score to composite_score() — it is metadata only for now
- Do NOT change the composite_score weights or formula

IMPORTANT:
- Do NOT modify any other files
- Do NOT modify composite_score() weights
- Place the function near the other score_* functions (after score_contrast, before score_faces)
- Follow the same code style: numpy/cv2 operations, docstring format, return type
- Use only cv2 and numpy (already imported)
- The function receives grayscale uint8 ndarray (same as other score_* functions)
```

---

### PHASE 3 PROMPT: Gallery Frontend (Client Views)

```
You are implementing Phase 3 of the BigBadPhotos Client Photo Gallery feature.

PROJECT: /Volumes/BigBadDrive_1/BigBadPhotos
TECH STACK: React 18, Vite, CSS (no Tailwind for gallery views)
DEPENDS ON: Phase 2A (gallery API routes exist in Flask backend)

CONTEXT:
BigBadPhotos is adding a client-facing photo gallery. The gallery is accessed via /gallery/<token> URLs. Clients (photography customers) watch photos appear in real-time during shoots, can favorite photos, and leave comments. No login required — the URL token is the only access gate. A browser cookie (bbp_visitor) tracks the visitor for favorites.

DESIGN DIRECTION — "ANALOG DIGITALIST":
The gallery uses a distinct editorial aesthetic, separate from the photographer-facing BigBadPhotos UI. Reference design exists at /Volumes/BigBadDrive_1/BigBadPhotoGallery/ — study the mockup HTML files in BigBadPhotoGallery_UXDesign/ for visual direction, especially the sepia_editorial_* variants and aurelian_archive/DESIGN.md.

Key design elements:
- Typography: Newsreader (serif) for headings/body, Inter (sans-serif) for labels/metadata
- Color palette: warm muted tones, sepia undertones, cream/ivory backgrounds
- Grid: masonry layout, intentional asymmetry
- Lightbox: full-bleed, minimal chrome, centered focus on the image
- Overall feel: premium, editorial, analog warmth
- Fonts loaded via @import from Google Fonts (self-host later if needed)

IMPORTANT: All gallery styles MUST be scoped under [data-gallery] CSS attribute selector. This prevents any bleed into the photographer-facing BigBadPhotos UI. Create a dedicated Gallery.css file.

EXISTING CODE TO UNDERSTAND:
- frontend/src/App.jsx — React router setup. Study how existing routes are defined. Add gallery routes here.
- frontend/src/components/GoogleGate.jsx — Auth gate. Gallery routes must BYPASS this gate (no auth needed).
- frontend/src/api/sessionsClient.js — Example of API client pattern. Create a similar galleryClient.js.

TASK 1: Create frontend/src/api/galleryClient.js

API client for gallery endpoints. The token comes from the URL.

Functions:
- fetchGalleryInfo(token) — GET /gallery/api/{token}/info
- fetchPhotos(token, {limit, offset, afterId}) — GET /gallery/api/{token}/photos with query params
- fetchFavorites(token) — GET /gallery/api/{token}/favorites
- addFavorite(token, photoId) — POST /gallery/api/{token}/favorites/{photoId}
- removeFavorite(token, photoId) — DELETE /gallery/api/{token}/favorites/{photoId}
- fetchComments(token, photoId) — GET /gallery/api/{token}/comments, optional ?photo_id=
- addComment(token, {body, photoId, displayName}) — POST /gallery/api/{token}/comments

All functions use fetch(). On 404, throw an error with message "Gallery not found". Include credentials: 'same-origin' for cookie handling.

TASK 2: Create frontend/src/views/Gallery/Gallery.css

Scoped styles under [data-gallery]. Define CSS custom properties for the Analog Digitalist palette:

[data-gallery] {
  --gallery-bg: #FAF7F2;           /* warm cream */
  --gallery-bg-alt: #F2EDE6;       /* slightly darker cream */
  --gallery-text: #2C2824;         /* warm near-black */
  --gallery-text-muted: #8C8279;   /* warm gray */
  --gallery-accent: #B8860B;       /* dark goldenrod */
  --gallery-border: #E5DFD6;       /* warm light border */
  --gallery-overlay: rgba(44, 40, 36, 0.85);  /* dark overlay */
  --gallery-heart: #C75050;        /* muted red for favorites */
  --gallery-font-serif: 'Newsreader', Georgia, serif;
  --gallery-font-sans: 'Inter', system-ui, sans-serif;
}

Dark mode support:
@media (prefers-color-scheme: dark) {
  [data-gallery] { adjust palette to dark warm tones }
}

Include Google Fonts @import for Newsreader (400,400i,600) and Inter (400,500).

Style the masonry grid, lightbox, cards, buttons, favorite hearts, comment forms — all scoped under [data-gallery].

TASK 3: Create frontend/src/views/Gallery/GalleryShell.jsx

Top-level wrapper component for all gallery views.

- Sets data-gallery attribute on root div
- Imports Gallery.css
- Reads token from URL params (useParams)
- Fetches gallery info on mount via galleryClient.fetchGalleryInfo(token)
- If 404, shows "Gallery not found" page
- If loading, shows minimal branded loading state
- Renders header: photographer branding / session name
- Renders children via Outlet (react-router nested routes)
- Provides token and gallery info via React context (GalleryContext)

TASK 4: Create frontend/src/views/Gallery/GalleryGrid.jsx

Main gallery view — masonry photo grid with live polling.

- Fetches photos via galleryClient.fetchPhotos(token) on mount
- Polls every 5 seconds using afterId of last received photo (efficient — only fetches new photos)
- Masonry layout: CSS columns (1 col mobile, 2 col tablet, 3 col desktop)
- Photos fade in with CSS animation when they first appear
- Each photo card shows:
  - Thumbnail image (lazy loaded)
  - Favorite heart icon overlay (filled if favorited, outline if not)
  - Click opens lightbox
- If no photos yet, render GalleryLanding (empty state)

Favorites state:
- Fetch visitor's favorites on mount
- Optimistic UI: toggle favorite immediately, revert on API error
- Heart icon click stops event propagation (doesn't open lightbox)

TASK 5: Create frontend/src/views/Gallery/GalleryLanding.jsx

Empty state shown when gallery has zero photos.

- Session name as heading (Newsreader, large)
- Subtle message: "Photos arriving soon..."
- Minimal animation (pulsing dot or gentle opacity cycle)
- Auto-disappears when GalleryGrid detects first photo arrival

TASK 6: Create frontend/src/views/Gallery/GalleryLightbox.jsx

Full-screen photo viewer overlay.

- Full-bleed image display, dark overlay background
- Previous/next navigation (arrow keys + click areas + swipe on mobile)
- Close button (X) and Escape key
- Favorite toggle (heart icon)
- Comment section:
  - Show existing comments for this photo
  - Comment input with optional display name field
  - Submit button (or Enter key)
  - Comments appear immediately (optimistic)
- Photo counter: "12 / 48"
- Preloads adjacent images for smooth navigation

TASK 7: Create frontend/src/views/Gallery/GalleryFavorites.jsx

Filtered view showing only favorited photos.

- Same masonry grid layout as GalleryGrid
- Toggle between "All Photos" and "My Favorites" in the gallery header/nav
- If no favorites, show message: "Tap the heart on any photo to save your favorites"
- Link/button to go back to full gallery

TASK 8: Update frontend/src/App.jsx

Add gallery routes that bypass the auth gate:

- /gallery/:token → GalleryShell (layout) with nested:
  - index → GalleryGrid
  - favorites → GalleryFavorites
  - photo/:photoId → GalleryLightbox (as overlay? or standalone)

These routes must be OUTSIDE the GoogleGate wrapper. Study how App.jsx currently structures routes and add gallery routes before the auth-gated routes.

IMPORTANT:
- Do NOT modify any backend files
- Do NOT modify existing BigBadPhotos views (SessionAreaView, CullingView, etc.) — that's Phase 4
- All styles scoped under [data-gallery] — zero CSS leakage to photographer UI
- Mobile-first responsive design (gallery will be viewed on phones by clients at events)
- No Tailwind in gallery components — use Gallery.css with custom properties
- Lazy load images (loading="lazy" attribute or IntersectionObserver)
- Handle errors gracefully — network issues shouldn't crash the gallery
- Comment display names are optional — show "Guest" if not provided
- Study the BigBadPhotoGallery UX mockups at /Volumes/BigBadDrive_1/BigBadPhotoGallery/BigBadPhotoGallery_UXDesign/ for visual reference, especially sepia_editorial_* files
```

---

### PHASE 4 PROMPT: Pipeline Integration & Photographer UI

```
You are implementing Phase 4 of the BigBadPhotos Client Photo Gallery feature.

PROJECT: /Volumes/BigBadDrive_1/BigBadPhotos
TECH STACK: Python 3, Flask, SQLite, React 18, Vite
DEPENDS ON: Phase 1 (DB schema + gallery.py)
CAN RUN PARALLEL WITH: Phase 3 (different file sets)

CONTEXT:
BigBadPhotos now has gallery DB tables and a gallery.py data-access module (Phase 1). This phase wires the gallery into the existing session/pipeline workflow and adds photographer-facing UI for managing gallery links, viewing client favorites/comments, and approving favorites into a Drive subfolder.

EXISTING CODE TO UNDERSTAND:
- backend/sessions.py — Session CRUD. Phase 1 already modified create() to auto-generate a gallery token and updated _row_to_dict() with gallery columns.
- backend/pipeline.py — Pipeline state machine. Study the _export() method (~line 419) to understand how photos reach 'exported' state. The gallery reads exported photos directly — no pipeline changes needed for photo visibility.
- backend/google_drive.py — Drive API wrapper. Phase 2A added set_public_read() and copy_file(). Study create_folder() and ensure_folder() patterns.
- backend/gallery.py — Data access for tokens, favorites, comments, stats.
- frontend/src/views/SessionAreaView.jsx — Session workspace view (923 lines). Study its structure to add a Gallery card.
- frontend/src/views/SessionHubView.jsx — Session list + create form. Study the create form to show gallery URL after creation.
- frontend/src/api/sessionsClient.js — API client for sessions.

TASK 1: Update pipeline export folder permissions

In backend/pipeline.py, in the _export() method: when the export folder is first created (or on the first export of a run), call google_drive.set_public_read() on the export folder so gallery image proxying works and the Drive folder itself is viewable by anyone with the link.

Look for where the export folder is created or first used in _export(). Add the set_public_read() call there, guarded so it only runs once per run (use a flag or check).

TASK 2: Update frontend/src/api/sessionsClient.js

Add API functions for photographer gallery management:

- fetchGalleryInfo(sessionId) — GET /sessions/{sessionId}/gallery
- fetchGalleryFavorites(sessionId) — GET /sessions/{sessionId}/gallery/favorites
- fetchGalleryComments(sessionId) — GET /sessions/{sessionId}/gallery/comments
- approveFavorites(sessionId, photoIds) — POST /sessions/{sessionId}/gallery/approve-favorites, body: {photo_ids: photoIds}
- revokeGallery(sessionId) — POST /sessions/{sessionId}/gallery/revoke
- regenerateGallery(sessionId) — POST /sessions/{sessionId}/gallery/regenerate

TASK 3: Add Gallery card to SessionAreaView.jsx

In the session workspace view, add a "Gallery" card section (similar to existing cards for session config, run status, etc.):

- Show gallery share URL with a "Copy Link" button (navigator.clipboard.writeText)
- Show live stats: favorites count, comments count, unique visitors
- "Review Favorites" button — navigates to /sessions/:sessionId/favorites
- "View Gallery" link — opens /gallery/<token> in new tab
- "Revoke Link" button with confirmation
- "Regenerate Link" button with confirmation (warns that old link stops working)
- Poll stats every 15 seconds when the view is active
- If gallery_enabled is false on the session, show a toggle to enable it

Fetch gallery info via sessionsClient.fetchGalleryInfo(sessionId) on mount and on poll.

TASK 4: Show gallery URL after session creation in SessionHubView.jsx

After a session is successfully created, the response includes gallery_token and gallery_url. Show this prominently:
- Display the full gallery URL
- "Copy Link" button
- Brief instruction: "Share this link with your client"
- Dismiss to go to the session workspace

TASK 5: Create frontend/src/views/FavoritesReviewView.jsx

New view at route /sessions/:sessionId/favorites. Photographer reviews client favorites.

- Fetch aggregated favorites via sessionsClient.fetchGalleryFavorites(sessionId)
- Grid display of favorited photos:
  - Thumbnail image (use existing photo thumb proxy endpoint)
  - Favorite count badge (how many visitors favorited this photo)
  - Checkbox for selection
- Fetch and display comments via sessionsClient.fetchGalleryComments(sessionId)
  - Show comments inline with relevant photos, and gallery-level comments separately
  - Display: visitor display_name (or "Guest"), comment body, timestamp
- Select/deselect all toggle
- "Create Favorites Folder" button:
  - Calls sessionsClient.approveFavorites(sessionId, selectedPhotoIds)
  - Shows progress/loading state
  - On success: shows the favorites folder URL and new favorites gallery link
- Back navigation to session area

Add route to App.jsx: /sessions/:sessionId/favorites → FavoritesReviewView (inside auth gate).

IMPORTANT:
- Do NOT modify backend/db.py or backend/gallery.py (Phase 1)
- Do NOT modify app.py gallery routes (Phase 2A)
- Do NOT modify scoring.py (Phase 2B)
- Do NOT modify Gallery/ frontend views (Phase 3)
- Pipeline change in Task 1 is minimal — just adding set_public_read() call, not restructuring the export flow
- Follow existing code patterns in SessionAreaView.jsx for the Gallery card
- Follow existing sessionsClient.js patterns for new API functions
```

---

### PHASE 5 PROMPT: End-to-End Testing & Polish

```
You are implementing Phase 5 of the BigBadPhotos Client Photo Gallery feature.

PROJECT: /Volumes/BigBadDrive_1/BigBadPhotos
TECH STACK: Python 3, Flask, SQLite, React 18, Vite, Playwright
DEPENDS ON: All previous phases (1, 2A, 2B, 3, 4) must be complete

CONTEXT:
The Client Photo Gallery feature is functionally complete across all phases. This phase verifies end-to-end integration, fixes issues, and adds test coverage.

TASK 1: Verify database migration

- Start the Flask app and confirm schema version 3 migration runs cleanly
- Verify all new tables exist: gallery_tokens, gallery_favorites, gallery_comments
- Verify sessions table has new columns: gallery_enabled, favorites_folder_id, favorites_folder_name
- Test creating a session and confirm gallery token is auto-generated
- Test the migration path from version 2 → 3 (if possible, test with existing data)

TASK 2: Verify gallery API routes

Test each public route with curl or similar:
- GET /gallery/<valid_token> — serves React SPA
- GET /gallery/<invalid_token> — returns 404
- GET /gallery/api/<token>/info — returns session info
- GET /gallery/api/<token>/photos — returns photo list (empty is fine)
- POST /gallery/api/<token>/favorites/<photo_id> — adds favorite, sets cookie
- DELETE /gallery/api/<token>/favorites/<photo_id> — removes favorite
- POST /gallery/api/<token>/comments — adds comment
- GET /gallery/api/<token>/comments — returns comments

Test photographer routes (with auth):
- GET /sessions/<id>/gallery — returns gallery info with token
- GET /sessions/<id>/gallery/favorites — returns aggregated favorites
- POST /sessions/<id>/gallery/approve-favorites — test with mock photo_ids

TASK 3: Verify gallery frontend

Start the dev server and test in browser:
- Navigate to /gallery/<token>
- Verify Analog Digitalist theme renders (fonts, colors, layout)
- Verify CSS isolation — gallery styles don't leak to photographer views
- Verify masonry grid layout at mobile/tablet/desktop widths
- Verify empty state (GalleryLanding) when no photos
- Verify lightbox opens/closes, navigation works
- Verify favorite toggle (heart icon) works
- Verify comment submission and display
- Verify 5-second polling (check network tab)
- Test on mobile viewport

TASK 4: Verify photographer UI

- Create a session, confirm gallery URL appears
- Copy gallery link, verify it works in incognito
- Check Gallery card in SessionAreaView shows stats
- Navigate to FavoritesReviewView
- Verify revoke/regenerate gallery link

TASK 5: Verify DCT artifact scoring

- Score a known JPEG with heavy compression artifacts
- Score a clean/high-quality JPEG
- Verify artifact_score appears in metrics_json
- Verify composite_score is unchanged (artifact_score not in weights)
- Verify CullingView sidebar shows artifact_score if present

TASK 6: Add Playwright smoke tests

Add to frontend/tests/e2e.spec.js (or create gallery-e2e.spec.js):
- Gallery loads with valid token
- Gallery returns 404 with invalid token
- Empty gallery shows "arriving soon" state
- Photo grid renders when photos exist
- Favorite toggle works
- Comment submission works
- Lightbox opens and navigates

TASK 7: Fix any integration issues found

- CSS conflicts between gallery and main app
- API response format mismatches between backend and frontend
- Cookie handling issues
- Drive permission errors
- Missing error handling or loading states
- Mobile responsiveness issues

Document all fixes made.
```

---
