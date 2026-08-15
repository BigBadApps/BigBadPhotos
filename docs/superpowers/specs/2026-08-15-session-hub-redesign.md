# Session Hub Redesign — Spec

**Date:** 2026-08-15
**Status:** Draft
**Scope:** Frontend route reorganization + backend run-history endpoint + session area UI

## Goal

Make sessions the primary workflow. After auth, the app opens to a Session Hub with New/Open. One-off scoring (current LandingView) stays accessible via nav. The session area shows config, autonomous toggle, run controls, and run history.

## What Exists Today

### Backend (no changes needed except one new endpoint)
- `sessions.py` — full CRUD: name, sourceFolderId/Name, exportFolderId/Name, autonomous, preset, threshold, burstBestOnly, editMode, editStrength, pollSeconds
- `pipeline.py` — `Pipeline` class: claim → download → score → gate → edit → export → archive. Background thread, polls Drive source folder. `_gate()` switches manual review (→ `awaiting_review`) vs autonomous (→ auto-approve against threshold)
- `scoring.py` — OpenCV + MediaPipe scoring
- `auto_edit.py` — bounded auto-filter
- `topaz.py` — Topaz Photo AI CLI wrapper
- `sessionsClient.js` — frontend API client for all session/run/photo endpoints

### Frontend
- `SessionsView.jsx` — session list + create/edit form (full-screen overlay). Currently at `/sessions`
- `RunView.jsx` — live run dashboard with preflight checks, start/stop, photo state table. Currently at `/sessions/:sessionId`
- `LandingView.jsx` — one-off folder picker + scoring + autonomous toggle. Currently at `/`
- `App.jsx` — routing, Drive auth, inline bottom nav pill bar
- `BottomNavBar.jsx` — exists but unused (Tailwind-based, doesn't match current design system)

## Changes

### 1. New Backend Endpoint: `GET /sessions/:id/runs`

Returns run history for a session, ordered by `started_at` descending.

```
GET /sessions/5/runs

Response:
{
  "runs": [
    {
      "id": 12,
      "sessionId": 5,
      "status": "stopped",       // running | stopping | stopped
      "phase": "watching",       // starting | watching | scoring | editing | exporting | archiving | auth_error
      "startedAt": "2026-08-15T10:00:00Z",
      "endedAt": "2026-08-15T12:30:00Z",
      "lastPollAt": "2026-08-15T12:29:30Z",
      "error": null,
      "counts": {
        "claimed": 0,
        "downloaded": 0,
        "scored": 5,
        "awaiting_review": 3,
        "approved": 10,
        "rejected": 2,
        "editing": 0,
        "exporting": 0,
        "exported": 8,
        "archived": 8,
        "failed": 0
      }
    }
  ]
}
```

Implementation: query `runs` table by `session_id`, join with `photos` for per-state counts via `GROUP BY state`. Add to `app.py` session routes.

### 2. Route Reorganization

| Old Route | New Route | Component | Purpose |
|-----------|-----------|-----------|---------|
| `/` (LandingView) | `/one-off` | LandingView | Ad-hoc folder scoring |
| `/sessions` (SessionsView) | `/` | SessionHubView (new) | Session hub: New + Open |
| `/sessions/:id` (RunView) | `/sessions/:id` | SessionAreaView (new) | Session workspace: config summary, autonomous toggle, threshold, edit mode, start/stop, run history |
| — | `/sessions/:id/run/:runId` | RunView (existing) | Live run dashboard |
| `/cull` | `/cull` | CullingView | No change |
| `/compare` | `/compare` | CompareView | No change |
| `/edit` | `/edit` | EditView | No change |
| `/review` | `/review` | ReviewExportView | No change |
| `/review-queue` | `/review-queue` | ReviewQueueView | No change |

### 3. New Component: SessionHubView

The default view after auth. Two-button layout:

```
┌─────────────────────────────┐
│  · Photo Sessions           │
│  Session Configuration      │
│                             │
│  ┌─────────┐  ┌──────────┐ │
│  │   New   │  │   Open   │ │
│  └─────────┘  └──────────┘ │
│                             │
└─────────────────────────────┘
```

- **New** — opens the session create form (reuse existing form from SessionsView, presented as full-screen overlay or inline expansion)
- **Open** — shows the session list (reuse existing session list rendering from SessionsView). Clicking a session navigates to `/sessions/:id`

After saving a new session via the create form, navigate to `/sessions/:id` (the session area).

This view is extracted from SessionsView — the existing component already has both the list and the create form. SessionHubView restructures the layout to lead with New/Open instead of listing first with a sticky create button.

### 4. New Component: SessionAreaView (refactored from RunView)

The current `RunView.jsx` at `/sessions/:sessionId` already combines session config display, preflight, start/stop, and live run monitoring in one component. This redesign **splits** that into:

- **SessionAreaView** (new) — session workspace at `/sessions/:id`. Config summary, run controls, run history.
- **RunView** (trimmed) — live run dashboard at `/sessions/:id/run/:runId`. Only the active run monitoring: photo state counts, stop button, review queue link.

SessionAreaView fetches session config and run history on mount.

Layout:

```
┌─────────────────────────────────┐
│  ← Back to Sessions            │
│                                 │
│  Session: "Soccer Saturday"     │
│  Source: Drive · IMG_INBOX      │
│  Export: Drive · Keepers        │
│  Edit settings · Pencil icon    │
│                                 │
│  ┌─── Run Controls ──────────┐ │
│  │ Autonomous  [===OFF===]   │ │
│  │ Threshold   Balanced · 60%│ │
│  │ Edit mode   Topaz         │ │
│  │ Edit strength  Medium     │ │
│  │                           │ │
│  │  [ Start ]                │ │
│  └───────────────────────────┘ │
│                                 │
│  ┌─── Run History ───────────┐ │
│  │ Run #12 · Stopped         │ │
│  │ Aug 15, 10:00–12:30       │ │
│  │ 8 exported · 2 rejected   │ │
│  │ 3 awaiting review         │ │
│  │                    [View] │ │
│  │                           │ │
│  │ Run #11 · Stopped         │ │
│  │ Aug 14, 09:00–11:00       │ │
│  │ 15 exported · 5 rejected  │ │
│  │                    [View] │ │
│  └───────────────────────────┘ │
└─────────────────────────────────┘
```

**Config summary section:**
- Session name (large heading)
- Source and export folder names
- Edit (pencil) icon to open the edit form overlay (reuse existing form from SessionsView)

**Run controls section:**
- Autonomous toggle (reads/writes session `autonomous` field via `PUT /sessions/:id`)
- Threshold display (reads session `threshold`/`preset`; editing opens the form overlay)
- Edit mode display (reads session `editMode`/`editStrength`)
- Start button — calls `POST /sessions/:id/preflight` then `POST /sessions/:id/start`, navigates to `/sessions/:id/run/:runId` (RunView)
- When a run is already active for this session: show "Run in progress" with a link to RunView and a Stop button

**Run history section:**
- Fetched from `GET /sessions/:id/runs`
- Each row: run ID, status, date range, photo counts (exported, rejected, awaiting review)
- "View" button navigates to `/sessions/:id/run/:runId`

**Relationship to existing RunView:**
- RunView keeps: `useSessionRun()` polling, photo state counts table, stop button, approve-all, review queue link
- RunView loses: session fetch, preflight, start button (moved to SessionAreaView)
- RunView gains: `runId` from URL params (currently derives from `useSessionRun()` active run). Back button navigates to `/sessions/:id` instead of `/sessions`
- The preflight + start flow lives in SessionAreaView; once a run starts, user is navigated to RunView for live monitoring

### 5. Bottom Nav Update

Replace the current inline pill bar in App.jsx with updated items:

| Label | Route | Needs photos? |
|-------|-------|---------------|
| Sessions | `/` | No |
| One-off | `/one-off` | No |
| Cull | `/cull` | Yes |
| Compare | `/compare` | Yes |
| Export | `/review` | Yes |

Keep the inline pill bar style (not BottomNavBar.jsx which uses Tailwind). Update keyboard shortcuts: `1` = Sessions, `2` = One-off, etc.

### 6. Store Changes

No new store fields needed. Existing `sessions`, `activeSession`, `runStatus` fields are sufficient. Session area uses local component state for run history (fetched per-mount, not global).

### 7. App.jsx Routing Changes

- Move LandingView route from `/` to `/one-off`
- Add SessionHubView at `/`
- Add SessionAreaView at `/sessions/:id`
- Keep RunView at `/sessions/:id/run/:runId` (update from current `/sessions/:sessionId`)
- Update currentView derivation and stepMap
- Move Drive auth setup to remain accessible from both SessionHubView and LandingView (it stays in AppContent)

## What Does NOT Change

- **Backend pipeline** — no changes to Pipeline, scoring, auto_edit, topaz, sessions CRUD
- **sessionsClient.js** — add one function (`listRuns(sessionId)`) for the new endpoint; everything else stays
- **RunView.jsx** — stays as-is, just mounted at a deeper route
- **ReviewQueueView.jsx** — no changes
- **CullingView, CompareView, EditView, ReviewExportView** — no changes
- **GoogleGate auth flow** — no changes
- **Drive folder picker** — reused as-is in session form

## Phased Implementation

### Phase 1: Backend endpoint + sessionsClient
Add `GET /sessions/:id/runs` endpoint. Add `listRuns()` to sessionsClient.js. Unit test the endpoint.

### Phase 2: SessionHubView + route reorganization
Create SessionHubView (extract from SessionsView). Move LandingView to `/one-off`. Wire new routes in App.jsx. Update bottom nav.

### Phase 3: SessionAreaView
Create SessionAreaView with config summary, run controls, run history. Wire session edit form (reuse from SessionsView). Start button with preflight → start → navigate to RunView.

### Phase 4: Polish + cleanup
Keyboard shortcuts. Remove dead code from old SessionsView if fully replaced. Test all navigation paths.
