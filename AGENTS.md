# AGENTS.md — BigBadPhotos

## Cursor Cloud specific instructions

### Services

| Service | Command | Port | Notes |
|---------|---------|------|-------|
| Flask backend | `BBP_PORT=8002 BBP_DEBUG=1 python3 app.py` | 8002 | Serves API + production frontend from `frontend/dist/` |
| Vite dev server | `cd frontend && npm run dev` | 5173 | Proxies `/health`, `/analyze`, `/rank`, `/auth` to Flask on 8002 |

### Running in development

1. Start Flask backend: `BBP_PORT=8002 BBP_DEBUG=1 python3 app.py`
2. Start Vite dev server: `cd frontend && npm run dev`
3. Access app at `http://localhost:5173/` (dev with HMR) or `http://localhost:8002/` (production build served by Flask)

To use the production build path, first run `cd frontend && npm run build` to generate `frontend/dist/`.

### Authentication bypass

In the browser, click "Try success" on the auth gate to bypass Google Sign-In for local development. The API endpoints `/analyze` and `/rank` still require a valid session — only the frontend UI is bypassed.

### Known dev-mode caveat

The combination of zustand 4.4.0 + React 19 + Vite 8 dev server may produce an ESM import error at runtime (`use-sync-external-store` CJS/ESM mismatch). The production build (`npm run build`) works correctly. If you encounter a white screen in Vite dev mode, use the Flask production serve on port 8002 after running `cd frontend && npm run build`.

### Testing

- **Smoke test:** `bash test_rank.sh http://localhost:8002` — tests health endpoint (API tests require an authenticated session)
- **Build check:** `cd frontend && npm run build`
- **No ESLint or Python linter** is configured in this repo
- **No automated test framework** (pytest, vitest, etc.) is set up

### Environment variables (dev)

- `BBP_PORT` — backend port (use 8002 to match Vite proxy config)
- `BBP_DEBUG=1` — enables Flask debug mode with hot-reload
- `GOOGLE_CLIENT_ID` / `BBP_ALLOWED_EMAILS` — optional, for real Google auth
- `FLASK_SECRET_KEY` — optional, auto-generated if unset

### Node version

This project requires Node.js 20 (per Dockerfile/nixpacks.toml). Use `nvm use 20` if a different version is active.

### Design system

The frontend uses the "Obsidian Lens" design system (PR #12, merged). Key details:
- Custom CSS token system in `frontend/src/index.css` (no Material Design)
- Three color themes via `data-theme`: `surgical` (cyan, default), `darkroom` (amber), `studio` (magenta)
- Dark/light/auto mode via `data-mode`
- Density variants: `data-density` = `compact` / `comfortable` / `spacious`
- Custom monoline SVG icons in `frontend/src/components/Icon.jsx` (no icon font)
- Google Fonts: Manrope (sans) + JetBrains Mono (mono)

### PR history (as of 2026-05-09)

| # | Branch | Status | Description |
|---|--------|--------|-------------|
| #12 | `claude/implement-index-html-e9khN` | Merged | Obsidian Lens design — core components + views |
| #13 | `claude/design-remaining-e9khN` | Open | Obsidian Lens — remaining components (CompareView, ReviewExportView) |
| #14 | `bbaf/bigbadphotos-fix-render-host-binding` | Open | Fix deploy timeout (bind `0.0.0.0`) |

### E2E testing (Playwright — proposed, not yet implemented)

A Playwright test plan exists for future implementation. Setup:

```bash
cd frontend
npm install
npx playwright install --with-deps chromium
npm run build
# Start Flask in a separate terminal:
cd .. && PORT=8001 python app.py
# Run tests:
cd frontend && npx playwright test
```

Tests cover: auth gate rendering, demo bypass, landing view, keyboard shortcuts (`?` for help), culling view navigation + decisions (`P`=keep, `R`=reject), compare view, review/export view, and `GET /health`.

Config should go in `frontend/playwright.config.js` with `testDir: './tests'` and test file at `frontend/tests/e2e.spec.js`.
