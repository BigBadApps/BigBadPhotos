Repo: BigBadPhotos (React 19 / Vite frontend, Flask backend). You're implementing Phase P07 ("SessionsView and RunView") of a larger plan adding "photo sessions" to this app.

Plan doc: docs/superpowers/plans/2026-08-10-photo-sessions.md → Task 7 (P7)
Spec doc: docs/superpowers/specs/2026-08-10-photo-sessions-design.md

FIRST: create and check out branch `bbaf/bbp-sessions-P07` from `bbaf/bigbadphotos-sessions` (this branch has Task 0 through P06 merged — the full `/sessions`, `/runs`, `/photos`, `/drive/folders`, `/settings` REST API from P06 already exists and is tested, 208 passing tests as backend baseline). **Another agent (P08, ReviewQueueView) is working on this same repo concurrently, possibly in this same working directory** — commit early and often to your own branch so your work is never sitting only as uncommitted files. If you notice the checked-out branch or working tree state doesn't match what you expect, stop and re-check `git status`/`git log` before continuing rather than assuming your last action succeeded.

No new runtime/npm dependencies. Node 20 (per Dockerfile/nixpacks.toml) — `nvm use 20` if a different version is active.

## File allowlist — ONLY create/modify these
- `frontend/src/api/sessionsClient.js` (create)
- `frontend/src/views/SessionsView.jsx` (create)
- `frontend/src/views/RunView.jsx` (create)
- `frontend/src/hooks/useSessionRun.js` (create)
- `frontend/src/App.jsx` (modify: route registration only)
- `frontend/src/components/BottomNavBar.jsx` (modify: one nav entry only)
- `frontend/src/components/GoogleDriveFolderPicker.jsx` (modify: add a Create-folder action only)
- `frontend/src/store.js` (modify: session slice only — do not touch the existing culling/scoring slice)

Do not touch anything else. In particular not `frontend/src/components/Icon.jsx` (you may only use icon names it already defines — see below), `frontend/src/views/CullingView.jsx`, `frontend/src/views/LandingView.jsx`, `frontend/src/views/ReviewExportView.jsx`, `frontend/src/utils/googleDrive.js`, any backend file, `requirements.txt`, `CLAUDE.md`, `AGENTS.md`, `Procfile`, `nixpacks.toml`, `railpack.toml`, `.env`, `.github/`. If you believe a file outside the allowlist must change, stop and say so instead of changing it.

## Background — real conventions from this codebase, read the actual files before writing

### CSRF + fetch pattern (`frontend/src/utils/csrf.js`, `frontend/src/utils/googleDrive.js`)

Every mutating fetch in this codebase follows this exact shape — match it in `sessionsClient.js`:

```js
import { getCsrfHeaders } from '../utils/csrf'

export async function someMutatingCall(payload) {
  const res = await fetch('/some/path', {
    method: 'POST', // or PUT/DELETE
    headers: { 'Content-Type': 'application/json', ...getCsrfHeaders() },
    credentials: 'include',
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.detail || body.error || 'Request failed')
  }
  return res.json()
}
```

GET requests: `fetch(path, { credentials: 'include' })`, same `res.ok` / error-extraction pattern, no CSRF header needed (Flask-WTF only checks CSRF on mutating methods).

### The exact P06 API you're calling (already live, already tested — read `app.py` if you want ground truth)

```
GET    /sessions                    -> { sessions: [...] }
POST   /sessions                    body: session fields -> { ok, session }      400 bad_config
GET    /sessions/<id>                -> { session }                              404 not_found
PUT    /sessions/<id>                body: partial fields -> { ok, session }     400 bad_config, 404, 409 run_in_progress
DELETE /sessions/<id>                -> { ok }                                    404, 409 run_in_progress
POST   /sessions/<id>/preflight      -> { checks: [{check, ok, detail, fix}] }   404, 401 server_google_not_connected
POST   /sessions/<id>/start          -> { ok, runId, sessionId, sessionName }    404, 401, 409 already_running
POST   /runs/active/stop             -> { ok, stopped: bool }
GET    /runs/active                  -> { running, runId, sessionId, sessionName, phase, counts: {state: n}, lastPollAt, errors: [{at,code,detail,fix}] }
GET    /runs/<id>/photos?state=&limit=&offset=  -> { photos: [...] }             404
POST   /photos/<id>/decision         body: {decision: 'keep'|'reject'} -> { ok, photo }  400, 404
POST   /runs/<id>/approve-all        -> { ok, count }                             404
GET    /photos/<id>/thumb            -> raw image bytes (never a redirect)       404, 502 drive_error
GET    /drive/folders?parent=        -> { parent, items: [{id, name}] }          502 drive_error
POST   /drive/folders                body: {parentId, name} -> { ok, folder: {id, name} }  400, 502
GET    /settings                     -> { inboxFolderId, inboxFolderName, sessionsRoot }
PUT    /settings                     body: any of the above keys -> same shape back
```

Session dicts (both request and response bodies) are camelCase: `id, name, sourceFolderId, sourceFolderName, exportFolderId, exportFolderName, archiveFolderId, autonomous (bool), preset ('strict'|'balanced'|'loose'|'custom'), threshold (float 0-1), burstBestOnly (bool), editMode ('off'|'auto'|'topaz'), editStrength ('light'|'medium'), pollSeconds, createdAt, updatedAt`.

### Icon.jsx — closed allowlist, work within it

`frontend/src/components/Icon.jsx` is NOT in your allowlist. It currently defines these names only: `folder, folderOpen, arrowR, arrowL, check, qmark, x, undo, info, image, sparkle, swipe, keyboard, aperture, lock, cog`. Usage: `<Icon name="folder" size={18} />` (also accepts `stroke`, `style`, `className`). If you need a glyph that isn't in this list, pick the closest existing one, or draw an inline `<svg>` directly inside your own view file — do not modify `Icon.jsx`.

### BottomNavBar — a real inconsistency in the codebase, follow the file as it is, not the docs

`CLAUDE.md`/`AGENTS.md` claim "custom monoline SVG icons in `Icon.jsx` (no icon font)" everywhere, but `frontend/src/components/BottomNavBar.jsx` itself was never migrated — it still uses Google's `material-symbols-outlined` icon **font** (a string icon name like `'grid_view'`, rendered via `<span className="material-symbols-outlined">`), not `Icon.jsx`. When you add your one nav entry, match what's actually in this file (the `material-symbols-outlined` string-name convention), not the newer `Icon.jsx` pattern used elsewhere — consistency within this specific component matters more than matching newer views. Current entries: `LIBRARY` (`/`, `grid_view`), `DEVELOP` (`/cull`, `tune`), `REVIEW` (`/compare`, `visibility`), `EXPORT` (`/review`, `ios_share`). Add a `SESSIONS` entry pointing at whatever route you register for `SessionsView` (e.g. `/sessions`), picking a sensible Material Symbols name (e.g. `photo_camera` or `event`).

### GoogleDriveFolderPicker.jsx — extend, don't replace

This component already browses folders via `browseDrive(parentId, 'folders')` from `frontend/src/utils/googleDrive.js`, which hits the **existing** `GET /drive/browse` route (left untouched by P06, still works). Leave that browsing behavior alone. Your job is to add a **＋ Create folder** action to this picker's UI (e.g. a button near the folder list or in the header) that prompts for a name and calls the **new** `POST /drive/folders` route (via your `sessionsClient.createDriveFolder`, not `googleDrive.js` — that file is outside your allowlist) using the currently-browsed folder (`currentFolder.id` in the component) as `parentId`. On success, treat the new folder as if the user had selected it (or refresh the current listing and let them pick it — your call).

### Zustand store — flat slice, no nesting surprises

`frontend/src/store.js` is one flat `create((set, get) => ({...}))` object (Zustand v4). Add three new top-level keys — `sessions` (array), `activeSession` (object or null), `runStatus` (object or null, the `GET /runs/active` shape) — plus setters following the existing naming convention (`setSessions`, `setActiveSession`, `setRunStatus`, or similar — match the terse `set({ key: value })` style already used throughout the file). Do not touch any existing key (`photos`, `order`, `history`, `editSettings`, etc.) — those belong to the culling flow and are unrelated to sessions.

### Test command

There is no automated frontend test suite (per `AGENTS.md`: "No automated test framework"). Your verification gate is a clean build:

```bash
cd frontend && npm run build
```

## Task

### Produce

- `sessionsClient.js`: `{ listSessions, createSession, getSession, updateSession, deleteSession, preflight, startRun, stopRun, activeRun, listPhotos, decide, approveAll, getSettings, putSettings, createDriveFolder }` — one function per API call above, following the fetch pattern shown.
- `useSessionRun()` hook → `{ status, loading, error, refresh, stop }`. Polls `GET /runs/active` every 3s while a run is active (`status.running === true`), backs off to 15s when idle. `refresh()` forces an immediate poll; `stop()` calls `sessionsClient.stopRun()` then refreshes.
- `SessionsView.jsx`: list of saved sessions (from `listSessions`), a create/edit form (name, source folder via `GoogleDriveFolderPicker`, export folder via the same picker with the new Create-folder action, autonomous toggle, preset chips + threshold slider + burst-best toggle, edit mode + strength, poll interval), delete with a confirm step.
- `RunView.jsx`: preflight results (each check's `ok`/`detail`, and its `fix` text rendered prominently when `ok` is false — this is explicitly load-bearing per the plan, don't just show `ok: false`), current `phase`, live `counts` by state, recent `errors` (each with its `fix`), a Stop button wired to `useSessionRun().stop`.
- Register a route (e.g. `/sessions`) in `App.jsx` (route registration only — do not touch the existing `hasPhotos`-gated culling routes) and the one `BottomNavBar` entry described above.

### Design constraints (from the plan and the existing design system)

- Obsidian Lens tokens only: CSS custom properties from `frontend/src/index.css` (`var(--sp-4)`, `var(--fg)`, `var(--bg-2)`, `var(--line)`, `var(--keep)`, `var(--reject)`, `var(--accent)`, etc. — grep the file for the full token list), the existing `.card`, `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-uppercase`, `.flex`, `.aic`, `.jcsb`, `fs-xs`/`fs-sm`/`fs-md` utility classes already used throughout `GoogleDriveFolderPicker.jsx`/`ReviewExportView.jsx`. No new CSS framework, no new icon set.
- Every control reachable one-handed on a 390px-wide viewport (iPhone is the primary device) — bottom-anchored primary actions, no reliance on hover states, tap targets ≥44px.

### Verify

Run `cd frontend && npm run build` — expect exit 0, no warnings about missing imports.

### Commit

```
git add frontend/src
git commit -m "feat(ui): sessions list, session form, and live run view"
```
(conventional commit; keep subject line under 50 chars, add a short body if your repo's commit hook requires one)

## Definition of done
- `npm run build` exits 0.
- Obsidian Lens tokens are used — no new CSS framework, no new icon set; icons come from `Icon.jsx` (or, for `BottomNavBar` specifically, that file's existing `material-symbols-outlined` convention).
- Every control is reachable one-handed on a 390px-wide viewport.
- Preflight failures render their `fix` text, not just `ok: false`.

## Your final report MUST include
1. The full pasted output of `cd frontend && npm run build`. A summary is not evidence — paste the actual terminal output.
2. Confirmation you touched only the allowlisted files (paste `git diff --name-only bbaf/bigbadphotos-sessions...HEAD`), and confirm `App.jsx`'s diff is route-registration only and `store.js`'s diff is additive (session slice only, nothing existing changed).
3. How `useSessionRun`'s polling backoff actually works (3s active / 15s idle) — walk through the transition logic, since this is easy to get subtly wrong (e.g. a stale closure over `status`).
4. Any deviation from the spec above, and why — in particular how you handled folder creation UX in `GoogleDriveFolderPicker` (this was left to your judgment).
