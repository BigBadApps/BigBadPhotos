# CLAUDE.md — BigBadPhotos
# Part of BigBadAgentForce (BBAF)

## Project

- **Name:** BigBadPhotos
- **Description:** Photography portfolio/gallery app with image ranking (OpenCV), password-protected access, and export/review workflow
- **Status:** deployed
- **Priority:** P3
- **Tech Stack:** Python, Flask, OpenCV, React, Vite
- **GitHub:** github.com/BigBadApps/bigbadphotos (branch protection: no direct push to `main`; PR + CI `build` required)
- **Deployed URL:** deployed (Railway — see Procfile/nixpacks.toml)

## BBAF Integration

This project is managed by BigBadAgentForce.
- **Primary agent:** Cursor (code implementation)
- **Review agent:** Claude (code review, architecture)
- **Research agent:** Gemini (when needed)
- **Workspace:** ~/BigBadAgentForce/

## Git Rules

- Branch naming: `bbaf/bigbadphotos-[description]`
- Never push to main
- Conventional commits: feat:, fix:, docs:, refactor:, test:
- PRs require Robert's approval before merge

## Structure

- `app.py` — Flask entry point, serves API + React static build
- `backend/` — Python modules (ranking, image processing)
- `frontend/` — React/Vite SPA
  - `src/App.jsx` — shell: routing, photo loader, ranker, hidden file inputs (iOS), bottom nav
  - `src/components/GoogleGate.jsx` — auth gate (`/auth/config`, `/auth/me`, password / dev / open)
  - `src/hooks/usePhotoRanker.js` — manual `beginScoring` to `/rank`, progress + ETA in store, 401 → session-expired UX
  - `src/hooks/useExporter.js` — export (FSAPI + iOS share/downloads), `exportDone` only on success
  - `src/views/LandingView.jsx` — source folder, hero preview, explicit scoring CTA, review gate after scoring
  - `src/views/CullingView.jsx` — AI filters, bulk Keep/Maybe/Reject, metric sidebar (`*_score` from `/rank`)
  - `src/views/ReviewExportView.jsx` — Review + export UI
  - `frontend/tests/e2e.spec.js` — Playwright smoke
- `requirements.txt` — Python deps
- `Procfile` / `nixpacks.toml` / `railpack.toml` — Railway deployment

## Key APIs

- `POST /analyze` — image ranking
- `POST /rank` — ranking endpoint (requires authenticated session for API routes)
- `GET /auth/config`, `GET /auth/me`, `POST /auth/password`, `POST /auth/google`, `POST /auth/logout`

## Environment Variables

- `BBP_PASSWORD` — enables password gate when set (see `/auth/config`)
- `BBP_DEBUG=1` / `FLASK_DEBUG=1` — dev bypass paths (see auth config)
- `FLASK_SECRET_KEY` — **set in production (e.g. Railway)**; if unset, Flask generates a new key each process start and invalidates sessions on every deploy/restart
- `BBP_ALLOWED_EMAILS` — comma-separated allowlist for Google OAuth (empty = all Google logins rejected)
- `GOOGLE_CLIENT_ID` — server-side Google token verify (when using Google auth)

## Recently completed (2026-05)

- **PR #32** merged (`bbaf/bigbadphotos-ui-fixes-tweaks`, 2026-05-11): Landing separates folder load from AI scoring (`beginScoring`, ETA, **Begin Review** only after scoring completes or RAW-only with no scoreable images); hero shows a random preview from the loaded set. Culling maps `exposure_score` / `noise_score` / `composition_score`, adds burst-best and top-20% filters, bulk Keep/Maybe/Reject from thumbnail selection, and stacks the sidebar below the viewer on narrow viewports (no mobile hide). `.venv/` gitignored for local Python 3.12 venv.
- **PR #31** merged (`bbaf/bigbadphotos-merge-session-export-fixes`): session/export/scoring fixes on redesign `main` (same scope as #30 below).
- **PR #30** merged (`bbaf/bigbadphotos-merge-session-export-fixes`): `/rank` errors expose `error`/`detail` + `.status`, 401 does not mark backend offline, `isScoring` cleared in `finally`, `authSessionExpired` synced to store + cleared on sign-in, Landing scoring bar no longer shows false 100% when there are no scoreable images, export completion only after success, iOS `hasDestDir` treated as ready without FSAPI.

## Current Priorities

1. **Railway:** set stable `FLASK_SECRET_KEY` (one `secrets.token_hex(32)` value) so sessions survive deploys
2. **Verify export** end-to-end on desktop (directory picker) and iOS (share sheet / downloads) after deploy
3. **`frontend/package.json`** — periodic dependency audit / updates when convenient

## Known Issues

- Sessions are Flask server-side cookies; without a fixed `FLASK_SECRET_KEY`, users see “session expired” after restarts (UI now surfaces reload; infra fix is the env var)
- Google OAuth path needs `BBP_ALLOWED_EMAILS` + client wiring when enabled

## Restrictions

- No deployment without Robert's explicit approval
- Keep .env and secrets out of commits
- Do not modify Railway config (Procfile/nixpacks.toml) without review
