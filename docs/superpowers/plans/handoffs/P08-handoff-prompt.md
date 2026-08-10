Repo: BigBadPhotos (React 19 / Vite frontend, Flask backend). You're implementing Phase P08 ("ReviewQueueView") of a larger plan adding "photo sessions" to this app.

Plan doc: docs/superpowers/plans/2026-08-10-photo-sessions.md → Task 8 (P8)
Spec doc: docs/superpowers/specs/2026-08-10-photo-sessions-design.md

FIRST: create and check out branch `bbaf/bbp-sessions-P08` from `bbaf/bigbadphotos-sessions` (this branch has Task 0 through P06 merged — the full `/sessions`, `/runs`, `/photos`, `/drive/folders`, `/settings` REST API from P06 already exists and is tested, 208 passing tests as backend baseline). **Another agent (P07, SessionsView/RunView) is working on this same repo concurrently, possibly in this same working directory** — commit early and often to your own branch so your work is never sitting only as uncommitted files. If you notice the checked-out branch or working tree state doesn't match what you expect, stop and re-check `git status`/`git log` before continuing rather than assuming your last action succeeded.

No new runtime/npm dependencies. Node 20 (per Dockerfile/nixpacks.toml) — `nvm use 20` if a different version is active.

## File allowlist — ONLY create/modify these
- `frontend/src/views/ReviewQueueView.jsx` (create)
- `frontend/src/App.jsx` (modify: route registration only)

Do not touch anything else. In particular not `frontend/src/components/Icon.jsx` (you may only use icon names it already defines — see below), `frontend/src/views/CullingView.jsx` (read-only reference for patterns), `frontend/src/api/sessionsClient.js` (owned by the parallel P07 phase — see the fallback rule below), any backend file, `requirements.txt`, `CLAUDE.md`, `AGENTS.md`, `Procfile`, `nixpacks.toml`, `railpack.toml`, `.env`, `.github/`. If you believe a file outside the allowlist must change, stop and say so instead of changing it.

## Important: P07 may not have merged yet

Another phase (P07) is building `frontend/src/api/sessionsClient.js` — the shared fetch client for the sessions API — concurrently with you, possibly right now in the same working directory. **Do not wait for it and do not create/edit that file yourself** (it's outside your allowlist). Instead:

- If `frontend/src/api/sessionsClient.js` already exists in your working tree when you start, import and use `listPhotos`, `decide`, `approveAll` from it.
- If it does not exist yet, write the minimal fetch wrappers you need **inline in your own `ReviewQueueView.jsx`**, and leave a `// TODO(P7): replace with sessionsClient` marker above them. The reviewer collapses these once P07 lands — this is expected and fine, don't treat it as a blocker.

Either way, the calls you need are:
- `GET /runs/active` → `{ running, runId, ... }` — to know if there's an active run at all, and its `runId`.
- `GET /runs/<runId>/photos?state=awaiting_review` → `{ photos: [...] }`.
- `POST /photos/<id>/decision` body `{decision: 'keep'|'reject'}` → `{ ok, photo }`.
- `POST /runs/<runId>/approve-all` → `{ ok, count }`.

All follow the standard fetch pattern used throughout this codebase (see `frontend/src/utils/googleDrive.js` for the canonical shape): `credentials: 'include'`, CSRF header from `getCsrfHeaders()` (`frontend/src/utils/csrf.js`) on the two POSTs, `if (!res.ok) throw new Error((await res.json().catch(()=>({}))).detail || ...)`.

Photo objects from `GET /runs/<id>/photos` are camelCase: `{ id, runId, driveFileId, filename, state, overallScore, metrics, edit, exportedFileId, errorCode, errorDetail, attempts, claimedAt, updatedAt }`. Thumbnail URL for a photo is simply `/photos/<id>/thumb` (a plain `<img src>` works — it's a real image response behind the auth session cookie, not JSON).

## Background — real conventions from this codebase, reference `CullingView.jsx` directly (read-only, don't modify it)

### Keyboard shortcuts — exact pattern to replicate

`frontend/src/views/CullingView.jsx` (around line 225):
```js
useEffect(() => {
  function onKey(e) {
    if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return
    const k = e.key.toLowerCase()
    if (k === 'p') { e.preventDefault(); decide('keep') }
    else if (k === 'r') { e.preventDefault(); decide('reject') }
    // CullingView also has 'm' for maybe and arrow-key navigation — you don't need those,
    // there is no "maybe" state in the sessions pipeline (states are keep/reject only)
  }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}, [decide])
```
Match this exactly: `P` decides keep on the currently-focused/selected photo, `R` decides reject. Guard against firing while an input/textarea has focus, same as `CullingView`.

### Thumbnail grid markup — reference, not copy-paste (CullingView's is a horizontal strip with multi-select; yours is a plain grid)

`CullingView.jsx` around line 417-476 shows the established look for a thumbnail tile: a button wrapping an `<img>` (or an `Icon name="image"` placeholder while unloaded), rounded corners (`borderRadius: 8`), `border: '1px solid var(--line)'`, a highlight ring on the active/selected item via `boxShadow: '0 0 0 2px var(--accent)'` (or `var(--keep)`/`var(--reject)` where relevant). There is a `.culling-grid` CSS class already defined in `frontend/src/index.css` for a responsive photo grid — check it and reuse it (or a close variant) rather than inventing new grid CSS from scratch.

### Optimistic update + rollback — exact shape

This codebase doesn't have a pre-built "optimistic mutation" helper — build it inline in your component:
```js
async function handleDecision(photo, decision) {
  const prevPhotos = photos // snapshot before mutating local state
  setPhotos(ps => ps.filter(p => p.id !== photo.id)) // optimistic: remove from the awaiting_review list immediately
  try {
    await decide(photo.id, decision) // or the inline TODO(P7) wrapper
  } catch (err) {
    setPhotos(prevPhotos) // rollback
    setError(err.message)
  }
}
```
The important property: the UI reacts instantly on tap/keypress, and a failed request restores exactly the prior list (not just re-adds the one photo at the end — restore the snapshot).

### Icon.jsx — closed allowlist, work within it

`frontend/src/components/Icon.jsx` is NOT in your allowlist. It currently defines these names only: `folder, folderOpen, arrowR, arrowL, check, qmark, x, undo, info, image, sparkle, swipe, keyboard, aperture, lock, cog`. `check` and `x` are the natural fits for keep/reject buttons. Usage: `<Icon name="check" size={20} style={{ color: 'var(--keep)' }} />`. If you need a glyph not in this list, pick the closest existing one or draw an inline `<svg>` in your own file — do not modify `Icon.jsx`.

### Design tokens

Obsidian Lens CSS custom properties from `frontend/src/index.css` — `var(--keep)`, `var(--reject)`, `var(--accent)`, `var(--bg-2)`/`var(--bg-3)`, `var(--fg)`/`var(--fg-3)`/`var(--fg-4)`, `var(--line)`, `var(--sp-*)` spacing scale — plus the existing `.card`, `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-uppercase`, `.flex`, `.aic`, `.jcsb`, `fs-xs`/`fs-sm`/`fs-md` utility classes already used throughout `ReviewExportView.jsx`/`CullingView.jsx`. No new CSS framework, no new icon set.

## Task

### Behavior to implement

- Grid of `awaiting_review` photos for the active run (fetch `GET /runs/active` first to get `runId`, then `GET /runs/<runId>/photos?state=awaiting_review`). Thumbnails via `<img src={`/photos/${id}/thumb`}>`.
- Tap a thumbnail to open it large (a simple lightbox/detail state is fine — doesn't need to be fancy, just show the full-size image via the same `/photos/<id>/thumb` URL).
- Keep/reject buttons (large, thumb-reachable) plus the `P`/`R` keyboard shortcuts described above.
- Optimistic update on decision, rolled back on a failed request (exact shape above).
- "Approve all" action with a confirm step showing the count (e.g. "Approve all 12 photos?") before calling `POST /runs/<runId>/approve-all`.
- Empty state must distinguish two different situations, with different copy for each:
  - **"nothing awaiting review"** — there IS an active run, but its `awaiting_review` count is currently zero (e.g. everything's been decided, or nothing has scored high enough yet).
  - **"no active run"** — `GET /runs/active` came back with `running: false` — there's nothing to review at all right now, point the user at starting a session.

### Register the route

Add a route (e.g. `/review-queue` — pick something that doesn't collide with the existing `/review` route used by `ReviewExportView`, they are different things) in `App.jsx`, route registration only. Do not gate it behind the existing `hasPhotos` check used by the culling routes — that flag is about locally-loaded photos for the old ranking flow and is unrelated to server-side session runs.

### Verify

Run `cd frontend && npm run build` — expect exit 0.

### Commit

```
git add frontend/src/views/ReviewQueueView.jsx frontend/src/App.jsx
git commit -m "feat(ui): Drive-backed review queue with keep, reject, approve-all"
```
(conventional commit; keep subject line under 50 chars, add a short body if your repo's commit hook requires one)

## Definition of done
- `npm run build` exits 0.
- Keep/reject are optimistic and roll back on a failed request.
- Keyboard shortcuts match `CullingView.jsx` (`P` keep, `R` reject).
- The empty state distinguishes "nothing awaiting review" from "no active run".

## Your final report MUST include
1. The full pasted output of `cd frontend && npm run build`. A summary is not evidence — paste the actual terminal output.
2. Confirmation you touched only the 2 allowlisted files (paste `git diff --name-only bbaf/bigbadphotos-sessions...HEAD`), and confirm `App.jsx`'s diff is route-registration only.
3. Whether `frontend/src/api/sessionsClient.js` existed in your working tree when you built this (i.e. did P07 land before or after you started), and if it didn't, exactly which calls you left as `// TODO(P7)` inline wrappers.
4. Walk through your optimistic-update rollback: what exact state gets restored on a failed decision request, and why that's correct even if the user made another decision in between (or explain why that race isn't possible given how you built it).
5. Any other deviation from the spec above, and why.
