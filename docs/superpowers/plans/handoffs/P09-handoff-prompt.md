Repo: BigBadPhotos (Flask backend, React/Vite frontend). You're implementing Phase P09 ("Remove the superseded singleton worker") of a larger plan that added "photo sessions" to this app. P01–P08 are all merged: SQLite-backed session configs, a Drive-backed pipeline state machine, preflight checks, the full `/sessions`/`/runs`/`/photos`/`/settings` REST API, and three frontend views (SessionsView, RunView, ReviewQueueView) that fully replace the old singleton autonomous-worker flow. This phase deletes what they replaced.

Plan doc: docs/superpowers/plans/2026-08-10-photo-sessions.md → Task 9 (P9)
Phase brief: docs/superpowers/plans/phases/P09.md
Spec doc: docs/superpowers/specs/2026-08-10-photo-sessions-design.md

FIRST: create and check out branch `bbaf/bbp-sessions-P09` from `bbaf/bigbadphotos-sessions` (this branch has Task 0 through P08 merged — 208 backend tests passing, frontend builds clean). Use an isolated git worktree if your tooling supports it (`git worktree add ../agent-p09 bbaf/bbp-sessions-P09` or equivalent) rather than working directly in a shared checkout — two prior phases in this project landed commits on each other's branches when agents shared one working directory without worktrees. If you can't use a worktree, at minimum run `git status`/`git log` before your first commit to confirm you're on the branch and commit you expect.

Interpreter is `.venv/bin/python` (3.14.6) at repo root — use it for every command, not `python3`/`python`. Node 20 for the frontend (`nvm use 20` if needed). No new runtime dependencies.

## File allowlist — as written in the phase brief, PLUS one necessary addition (read the note below before you start)

- `backend/session_worker.py` (delete)
- `backend/tests/test_session_worker.py` (delete)
- `backend/tests/test_autonomous_routes.py` (delete)
- `frontend/src/components/ServerAutonomousPanel.jsx` (delete)
- `frontend/src/hooks/useServerAutonomous.js` (delete)
- `app.py` (modify: drop `/autonomous/*` and the `session_worker` import)
- `frontend/src/App.jsx` (modify: drop the unused `AutonomousPanel` import — see note)
- `frontend/src/components/AutonomousPanel.jsx` (modify — **not in the original phase brief, added here, see note below**)
- `CLAUDE.md` (modify)
- `AGENTS.md` (modify)

Do not touch anything else. In particular not `backend/scoring.py`, `backend/topaz.py`, `backend/google_auth.py`, `backend/db.py`, `backend/sessions.py`, `backend/pipeline.py`, `backend/preflight.py`, `backend/auto_edit.py`, `backend/google_drive.py`, `frontend/src/views/LandingView.jsx` (see note — it needs no change), `frontend/src/views/SessionsView.jsx`, `frontend/src/views/RunView.jsx`, `frontend/src/views/ReviewQueueView.jsx`, `frontend/src/api/sessionsClient.js`, `frontend/src/hooks/useSessionRun.js`, `frontend/src/store.js`, `requirements.txt`, `Procfile`, `nixpacks.toml`, `railpack.toml`, `.env`, `.github/`. If you believe some other file must change beyond what's described here, stop and say so instead of changing it.

## Important — a real gap the plan doesn't mention, verified by reading the actual source

Deleting `frontend/src/components/ServerAutonomousPanel.jsx` as instructed **will break the build** unless one more file changes, because the plan's file list doesn't account for it:

`frontend/src/components/AutonomousPanel.jsx` (a *different* file — read it before touching anything) is a switcher component rendered from `LandingView.jsx`. Its default export does:
```js
export default function AutonomousPanel(props) {
  const [available, setAvailable] = useState(false)
  // ...fetches /auth/config, sets `available` from cfg.worker...
  if (available && sourceDir?._drive) {
    return <ServerAutonomousPanel />
  }
  return <LegacyAutonomousPanel {...props} />
}
```
`LegacyAutonomousPanel` (defined earlier in the same file) is the older **client-local** autonomous mode (`useAutonomousMode.js` territory — browser-driven, unrelated to `session_worker.py`/the server pipeline you're deleting here). It is NOT part of this phase and must keep working exactly as it does today.

**Required fix:** in `frontend/src/components/AutonomousPanel.jsx`, remove the `import ServerAutonomousPanel from './ServerAutonomousPanel'` line and the `if (available && sourceDir?._drive) { return <ServerAutonomousPanel /> }` branch (and the now-unused `available`/`useEffect`/`/auth/config` fetch that only existed to decide that branch, if nothing else in the file needs them — check before removing). The component should simply always render `LegacyAutonomousPanel`. Do not touch `LandingView.jsx` — it renders `<AutonomousPanel>` and needs no change; `AutonomousPanel` continuing to exist and default-export something renderable is all it needs.

Separately, `frontend/src/App.jsx` has a stale, **unused** import — `import AutonomousPanel from './components/AutonomousPanel';` (grep confirms it's never referenced as `<AutonomousPanel` anywhere in `App.jsx`, only imported). This is what the plan's "drop the panel" instruction for `App.jsx` refers to — just remove the dead import line. Do not touch anything else in `App.jsx`.

## Step 1: Confirm the blast radius before deleting anything

Run exactly:
```bash
grep -rn "session_worker\|ServerAutonomousPanel\|useServerAutonomous\|/autonomous/" --include=*.py --include=*.jsx --include=*.js . | grep -v node_modules
```
Expected: hits only in the files you're about to delete or modify (plus this repo's `docs/` planning files, which are text references, not code — ignore those; the plan's "expected: only the files being deleted" means only *code* files). If you find a code reference outside your allowlist that this list didn't anticipate, stop and report it rather than deleting/editing it yourself.

## Step 2: Delete and unwire

- Delete the five files listed for deletion.
- In `app.py`: remove the `/autonomous/start`, `/autonomous/stop`, `/autonomous/status` route handlers and the `from backend import session_worker` import. Also remove `/autonomous` from the `enforce_auth()` prefix-check list added in P06 (it currently has `and not request.path.startswith('/autonomous')` — that check becomes dead code once the routes are gone, remove it along with the others if nothing else needs it, but don't touch the `/sessions`/`/runs`/`/settings` checks P06 added).
- In `frontend/src/App.jsx`: remove the unused `AutonomousPanel` import line only.
- In `frontend/src/components/AutonomousPanel.jsx`: apply the required fix described above.
- In `CLAUDE.md` and `AGENTS.md`: update the structure/module descriptions to reflect the current session flow (`backend/db.py`, `backend/sessions.py`, `backend/pipeline.py`, `backend/preflight.py`, `backend/auto_edit.py`, the Drive folder helpers in `backend/google_drive.py`, `frontend/src/views/SessionsView.jsx`/`RunView.jsx`/`ReviewQueueView.jsx`, `frontend/src/api/sessionsClient.js`) and remove/correct any remaining mention of the singleton `session_worker`/server-side `ServerAutonomousPanel` flow. Exact wording is your judgment — the definition of done just requires these docs to no longer describe the deleted flow as if it still exists.

## Step 3: Full suite plus frontend build

```bash
.venv/bin/python -m pytest backend/tests tests -q
cd frontend && npm run build
```
Expected: all pass, exit 0. Baseline before your changes is 208 backend tests passing and a clean frontend build — deleting `test_session_worker.py` and `test_autonomous_routes.py` will drop the backend count (that's expected and correct, not a regression — those tests covered the code you're deleting). Report the exact before/after counts.

## Step 4: Commit

The plan's own suggested commit step says `git add -A`. **Don't do that literally** — this repo has accumulated stray untracked directories in past phases (things like `.omc/`, `.claude/worktrees/`) that must not get swept into your commit. Stage only the specific files you touched:

```bash
git add -u  # stages modifications and deletions to already-tracked files only
git status  # confirm nothing unexpected is staged before committing
git commit -m "refactor: remove singleton autonomous worker"
```
(conventional commit; keep subject line under 50 chars, add a short body if your repo's commit hook requires one — mention the `AutonomousPanel.jsx` fix since it wasn't in the original file list)

## Definition of done
- The Step 1 grep returns nothing outside the deleted/modified files (docs/planning files aside).
- Full suite passes and the frontend build exits 0.
- `CLAUDE.md` and `AGENTS.md` describe the session flow and no longer mention the singleton worker.
- `LegacyAutonomousPanel` (client-local autonomous mode) still renders and works exactly as before — you only removed the server-backed branch.

## Your final report MUST include
1. The full pasted output of `.venv/bin/python -m pytest backend/tests tests -q` and `cd frontend && npm run build`. A summary is not evidence — paste the actual terminal output. State the exact before/after test counts.
2. The output of the Step 1 grep, both before you started (to show the actual blast radius you found) and after your changes (to prove it's clean).
3. Confirmation you touched only the allowlisted files above, including the `AutonomousPanel.jsx` addition (paste `git diff --name-only bbaf/bigbadphotos-sessions...HEAD`).
4. Confirm `frontend/src/views/LandingView.jsx` has zero diff — it should need no change.
5. Any other file you found that referenced the deleted code but wasn't anticipated here, and how you handled it.
