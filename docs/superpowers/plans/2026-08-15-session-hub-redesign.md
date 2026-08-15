# Session Hub Redesign — Implementation Plan

**Spec:** `docs/superpowers/specs/2026-08-15-session-hub-redesign.md`
**Phases:** 4
**Branch:** `bbaf/bigbadphotos-session-hub-redesign`

---

## Phase 1: Backend endpoint + sessionsClient

**Goal:** Add `GET /sessions/:id/runs` endpoint returning run history with per-state photo counts. Add `listRuns()` to the frontend API client.

### Files to modify
- `app.py` — add route
- `frontend/src/api/sessionsClient.js` — add `listRuns(sessionId)` function

### Acceptance criteria
- `GET /sessions/1/runs` returns `{ runs: [...] }` with each run having `id`, `sessionId`, `status`, `phase`, `startedAt`, `endedAt`, `lastPollAt`, `error`, and `counts` (per-state photo counts)
- Runs ordered by `started_at` DESC
- Returns empty array for sessions with no runs
- Returns 404 for non-existent session
- `sessionsClient.listRuns(sessionId)` calls the endpoint

### Handoff prompt

```
You are implementing Phase 1 of the Session Hub Redesign for BigBadPhotos.

Read the spec at docs/superpowers/specs/2026-08-15-session-hub-redesign.md (Section 1: "New Backend Endpoint").

Task: Add a GET /sessions/<int:session_id>/runs endpoint to app.py that returns run history for a session.

Implementation details:
1. In app.py, add the route near the other session routes (around line 485). Pattern to follow: the existing session routes use @app.get/@app.post decorators, enforce_auth(), and db.get() for queries.

2. The endpoint should:
   - Call enforce_auth()
   - Verify the session exists (404 if not)
   - Query the runs table: SELECT * FROM runs WHERE session_id = ? ORDER BY started_at DESC
   - For each run, query photo counts: SELECT state, COUNT(*) as count FROM photos WHERE run_id = ? GROUP BY state
   - Return JSON: { "runs": [ { "id", "sessionId", "status", "phase", "startedAt", "endedAt", "lastPollAt", "error", "counts": { "claimed": N, "scored": N, ... } } ] }
   - Use camelCase keys in the response (match existing patterns like sourceFolderId)
   - Include all pipeline states in counts even if 0: claimed, downloaded, scored, awaiting_review, approved, rejected, editing, exporting, exported, archived, failed

3. In frontend/src/api/sessionsClient.js, add:
   export function listRuns(sessionId) {
     return jsonFetch(`/sessions/${sessionId}/runs`)
   }

4. Test manually: start the Flask dev server, create a session, start/stop a run, then call GET /sessions/<id>/runs to verify the response shape.

Do NOT modify any other files. Do NOT change routing or frontend views.
```

---

## Phase 2: SessionHubView + route reorganization

**Goal:** Create SessionHubView as the default `/` route. Move LandingView to `/one-off`. Update bottom nav and keyboard shortcuts.

### Files to create
- `frontend/src/views/SessionHubView.jsx`

### Files to modify
- `frontend/src/App.jsx` — route changes, nav update, keyboard shortcuts
- `frontend/src/views/SessionsView.jsx` — extract shared components (form, list rendering) if needed, or import directly in SessionHubView

### Acceptance criteria
- `/` shows SessionHubView with "New" and "Open" buttons
- "New" opens the session create form (reuse existing form UI from SessionsView)
- "Open" reveals the session list; clicking a session navigates to `/sessions/:id`
- After creating a session, navigates to `/sessions/:id`
- `/one-off` shows LandingView (unchanged behavior)
- Bottom nav shows: Sessions | One-off | Cull | Compare | Export
- Keyboard shortcuts updated: 1=Sessions, 2=One-off, etc.
- All existing culling/compare/edit/export routes work unchanged

### Handoff prompt

```
You are implementing Phase 2 of the Session Hub Redesign for BigBadPhotos.

Read the spec at docs/superpowers/specs/2026-08-15-session-hub-redesign.md (Sections 2, 3, and 5).

Task: Create SessionHubView as the new default route, move LandingView to /one-off, update nav.

Implementation details:

1. Create frontend/src/views/SessionHubView.jsx:
   - This is the new default view after auth
   - Shows a heading "Session Configuration" with two buttons: "New" and "Open"
   - "New" opens the session create form. Reuse the form UI from SessionsView.jsx — extract the form into a shared component or copy the relevant JSX (name field, folder pickers, autonomous toggle, preset chips, threshold slider, burst best only, edit mode, edit strength, poll interval, save button). The form needs GoogleDriveFolderPicker for folder selection.
   - "Open" reveals the session list below the buttons. Fetch sessions via sessionsClient.listSessions(). Show each session as a card with name, mode summary, source/export folders. Clicking a session card navigates to /sessions/${session.id}.
   - After successfully creating a session, navigate to /sessions/${newSession.id}.
   - Follow the existing design system: use var(--bg), var(--bg-2), var(--bg-3), var(--fg), var(--accent), var(--line), etc. Look at SessionsView.jsx and LandingView.jsx for styling patterns. Use the card class, btn/btn-primary/btn-ghost classes, meta/dim/mono/upper utility classes, fs-xs/fs-sm/fs-md size classes.
   - Import Icon from '../components/Icon' for folder icons etc.
   - Import GoogleDriveFolderPicker from '../components/GoogleDriveFolderPicker' for the form.
   - Import * as sessionsClient from '../api/sessionsClient' for data fetching.

2. Modify frontend/src/App.jsx:
   - Import SessionHubView
   - Change Route path="/" to render SessionHubView instead of LandingView
   - Add Route path="/one-off" to render LandingView (with all existing props — state, callbacks, etc.)
   - Keep all other routes unchanged
   - Update the inline bottom nav pill bar (around line 512): change the array to:
     ['/', 'Sessions', false],
     ['/one-off', 'One-off', false],
     ['/cull', 'Cull', true],
     ['/compare', 'Compare', true],
     ['/review', 'Export', true],
   - Update keyboard shortcuts (around line 126): 1=/, 2=/one-off, 3=/cull, 4=/compare, 5=/review
   - Update the currentView derivation (around line 93) to handle '/one-off' as 'landing' and '/' as 'sessions'

3. Do NOT modify the backend. Do NOT create SessionAreaView yet (that's Phase 3). Do NOT delete SessionsView.jsx — it may still be referenced.
```

---

## Phase 3: SessionAreaView

**Goal:** Create SessionAreaView at `/sessions/:id` — the session workspace with config summary, run controls (autonomous toggle, start/stop), and run history.

### Files to create
- `frontend/src/views/SessionAreaView.jsx`

### Files to modify
- `frontend/src/App.jsx` — add route for SessionAreaView, update RunView route
- `frontend/src/views/RunView.jsx` — trim to live-run-only (remove preflight/start, update back navigation)

### Acceptance criteria
- `/sessions/:id` shows SessionAreaView with session config, autonomous toggle, threshold, edit mode, start button, run history
- Autonomous toggle updates session via `PUT /sessions/:id` immediately
- "Edit" icon opens the edit form overlay (reuse form from SessionHubView/SessionsView)
- Start button runs preflight then starts run, navigates to `/sessions/:id/run/:runId`
- When a run is active for this session, show "Run in progress" with link + stop button
- Run history section shows past runs from `GET /sessions/:id/runs` with counts
- "View" on a historical run navigates to `/sessions/:id/run/:runId`
- RunView at `/sessions/:id/run/:runId` works with runId from URL params
- RunView back button goes to `/sessions/:id`

### Handoff prompt

```
You are implementing Phase 3 of the Session Hub Redesign for BigBadPhotos.

Read the spec at docs/superpowers/specs/2026-08-15-session-hub-redesign.md (Section 4).

Task: Create SessionAreaView at /sessions/:id — the session workspace with config, controls, and run history.

Implementation details:

1. Create frontend/src/views/SessionAreaView.jsx:
   - Uses useParams() to get sessionId
   - On mount, fetch session via sessionsClient.getSession(sessionId) and run history via sessionsClient.listRuns(sessionId)
   - Layout sections (top to bottom):
     a. Back button: "← Sessions" navigating to /
     b. Config summary: session name as h1, source folder name, export folder name, edit pencil icon button
     c. Run controls card:
        - Autonomous toggle (on/off). When toggled, immediately call sessionsClient.updateSession(sessionId, { autonomous: newValue }). This just updates the session config for the NEXT run.
        - Threshold display: show preset name and percentage (e.g. "Balanced · 60%")
        - Edit mode display: show editMode and editStrength
        - Start button (btn-primary): calls sessionsClient.preflight(sessionId), shows preflight results (reuse CheckRow component from RunView.jsx — extract it or import it). If all checks pass, call sessionsClient.startRun(sessionId), then navigate to /sessions/${sessionId}/run/${result.runId}
        - If useSessionRun() shows an active run for this session: show "Run in progress" status with phase, a "View Run" link to /sessions/${sessionId}/run/${status.runId}, and a Stop button
     d. Run history section:
        - Heading "Run History"
        - List of past runs from listRuns response
        - Each run card shows: "Run #N · Status", date range (format startedAt/endedAt nicely), key counts (exported, rejected, awaiting_review, failed)
        - "View" button navigates to /sessions/${sessionId}/run/${run.id}
        - Empty state: "No runs yet"
   - Edit pencil icon opens the session edit form as a full-screen overlay. Reuse the form pattern from SessionHubView or SessionsView — the same fields (name, folders, autonomous, preset, threshold, burst, edit mode, strength, poll interval). On save, refresh the session data.
   - Styling: follow existing patterns. Use var(--bg), var(--bg-2), var(--accent), card class, etc. Look at RunView.jsx and SessionsView.jsx for reference.

2. Modify frontend/src/App.jsx:
   - Import SessionAreaView
   - Change the /sessions/:sessionId route to render SessionAreaView (was RunView)
   - Add route /sessions/:sessionId/run/:runId to render RunView
   - (SessionsView route at /sessions can be removed if SessionHubView fully replaces it — check that SessionHubView handles the list)

3. Modify frontend/src/views/RunView.jsx:
   - Change useParams() to extract both sessionId and runId (was just sessionId)
   - Remove the preflight and start logic (moved to SessionAreaView). RunView should assume a run is already started.
   - Keep: useSessionRun() polling, photo state counts, stop button, approve-all functionality
   - Update back button: navigate to /sessions/${sessionId} instead of /sessions
   - If the run is not found or not active, show a message and link back to the session area

4. Extract CheckRow component: if RunView.jsx has a CheckRow component used for preflight results, either export it from RunView or move it to a shared location so SessionAreaView can import it.

5. Do NOT modify the backend. Do NOT modify LandingView, CullingView, or other views.
```

---

## Phase 4: Polish + cleanup

**Goal:** Clean up dead code, verify all navigation paths, ensure keyboard shortcuts work.

### Files to modify
- `frontend/src/views/SessionsView.jsx` — delete if fully replaced by SessionHubView
- `frontend/src/App.jsx` — remove any dead imports/routes
- `frontend/src/components/BottomNavBar.jsx` — delete (unused Tailwind component)

### Acceptance criteria
- No dead imports or unreachable routes
- All navigation paths tested: Sessions hub → New → form → save → session area → start → run view → back → session area → back → hub
- Sessions hub → Open → list → pick → session area
- One-off nav → LandingView works
- Keyboard shortcuts 1-5 work
- No console errors or warnings

### Handoff prompt

```
You are implementing Phase 4 (final polish) of the Session Hub Redesign for BigBadPhotos.

Read the spec at docs/superpowers/specs/2026-08-15-session-hub-redesign.md.

Task: Clean up dead code and verify all navigation paths work.

1. Check if SessionsView.jsx is still imported anywhere. If SessionHubView fully replaces it (handles both the session list and create form), delete SessionsView.jsx and remove any imports.

2. Check frontend/src/components/BottomNavBar.jsx — this is an old Tailwind-based nav component that's not used by the current App.jsx (which has its own inline pill bar). If nothing imports it, delete it.

3. In App.jsx:
   - Remove any unused imports
   - Verify the /sessions route (if it existed separately from /) is removed or redirects to /
   - Verify currentView derivation handles all current routes
   - Verify keyboard shortcuts map: 1=/, 2=/one-off, 3=/cull, 4=/compare, 5=/review

4. Test all navigation flows by starting the dev server and verifying in the browser:
   - After login, / shows SessionHubView with New and Open
   - New opens form, fill in name + folders, save creates session and navigates to /sessions/:id
   - /sessions/:id shows SessionAreaView with config, controls, history
   - Start runs preflight then starts run, navigates to /sessions/:id/run/:runId
   - RunView shows live status, stop works, back goes to /sessions/:id
   - Session area back goes to /
   - Bottom nav "One-off" goes to /one-off with LandingView
   - Bottom nav "Cull" / "Compare" / "Export" require photos loaded (from one-off flow)
   - No console errors

5. Do NOT add new features. Do NOT modify the backend. Only clean up and verify.
```
