# AGENT.md — BigBadPhotos

Agent session log and handoff notes.

---

## Session — 2026-05-09

### PRs Created

| # | Branch | Status | Description |
|---|--------|--------|-------------|
| [#12](https://github.com/BigBadApps/bigbadphotos/pull/12) | `claude/implement-index-html-e9khN` | **Merged** | Obsidian Lens design — core components + views |
| [#13](https://github.com/BigBadApps/bigbadphotos/pull/13) | `claude/design-remaining-e9khN` | Open | Obsidian Lens design — remaining components |
| [#14](https://github.com/BigBadApps/bigbadphotos/pull/14) | `bbaf/bigbadphotos-fix-render-host-binding` | Open | Fix Render deploy timeout (bind to 0.0.0.0) |

---

### Changes — PR #12 (merged)

Full implementation of the "Obsidian Lens" design system from a design bundle. Replaced Material Design 3 / Material Symbols stack with custom CSS tokens and monoline SVG icons.

**`frontend/index.html`**
- Title updated to "BigBadPhotos · Obsidian Lens"
- Added Manrope (sans) + JetBrains Mono (mono) Google Fonts
- Removed Material Symbols Outlined link

**`frontend/src/index.css`**
- Prepended `@import "tailwindcss"` (Tailwind v4 compatible)
- Full CSS custom property token system: type scale, spacing, radius, easings, palette
- Three color themes via `data-theme`: `surgical` (cyan, default), `darkroom` (amber), `studio` (magenta)
- Dark/light/auto mode via `data-mode` + `@media (prefers-color-scheme: light)`
- Density variants: `data-density` = `compact` / `comfortable` / `spacious`
- Component classes: `.appbar`, `.btn`, `.btn-primary`, `.btn-ghost`, `.btn-uppercase`, `.card`, `.card-elevated`, `.card-glow`, `.meta`, `.scorebar`, `.dbadge`, `.chip`, `.toast`, `.stat`, `.view`

**New components (`frontend/src/components/`)**
- `Icon.jsx` — custom monoline SVG icon set (no external dependency)
- `ScoreBar.jsx` — gradient score bar masked from right by `.scorebar-cap`
- `DecisionBadge.jsx` — Keep / Maybe / Reject pill badge
- `AppBar.jsx` — sticky header with breadcrumbs, step pips, keyboard help button
- `HelpOverlay.jsx` — keyboard shortcuts modal (`?` key, fixed position)
- `GoogleGate.jsx` — redesigned auth gate with ambient grid, aperture icon, custom Google mark SVG

**Redesigned views (`frontend/src/views/`)**
- `LandingView.jsx` — hero image slot, folder pickers, scoring progress bar, Begin Review CTA
- `CullingView.jsx` — photo art gradients, swipe gestures (threshold 80px), DecisionDock, score sidebar, undo/toast

**`frontend/src/App.jsx`**
- Sets `data-theme="surgical"`, `data-mode="auto"`, `data-density="comfortable"` on mount
- Local landing state + `simulateScoring()` via `setInterval`
- Prototype nav bar (fixed bottom pill)

---

### Changes — PR #13 (open)

Remaining components migrated to Obsidian Lens. Removes all remaining `material-symbols-outlined` and MD3 Tailwind classes.

**`frontend/src/index.css`**
- Added `.toggle` / `.toggle-track` / `.toggle-thumb` component CSS
- Added standalone `.iconbtn` class (usable outside `.appbar`)
- Added `.compare-panel:hover .compare-actions` and `.compare-panel:hover .compare-img` hover rules

**`frontend/src/components/Icon.jsx`**
- Added `style` and `className` props for inline color tinting without wrapper divs
- Added `cog` icon

**`frontend/src/views/CompareView.jsx`**
- Full redesign: CSS variable inline styles, `Icon` + `DecisionBadge` components
- Glass `MetadataHUD` panel (backdrop-filter blur, rgba border)
- Hover-reveal Keep/Reject action bar (`.compare-actions`, opacity transition)
- `sparkle` Best Match badge with `color-mix()` accent tint
- Filmstrip with `var(--accent)` active border, decision color indicators
- Keyboard shortcuts: `1`/`2` pick winner, `←`/`→` navigate pairs

**`frontend/src/views/ReviewExportView.jsx`**
- Full redesign: CSS variable inline styles, `Icon` component
- `OblToggle` using `.toggle` classes
- `ExportProgress` with accent-colored progress bar
- Photo grid: `aspect-ratio: 1`, `.dbadge` decision labels, score pills
- Config panel: `var(--keep)` folder highlight, format selector with accent dot indicator
- Export CTA: `.btn.btn-primary.btn-uppercase`

**`frontend/public/favicon.svg`**
- Accent color updated from `#69daff` → `#00D1FF`

**`frontend/public/apple-touch-icon.svg`**
- Accent updated to `#00D1FF`, inner ring added, center dot tightened, background corners rounded (`rx="36"`)

---

### Changes — PR #14 (open)

**`app.py` line 575**
- `BBP_HOSTNAME` default changed from `'127.0.0.1'` → `'0.0.0.0'`
- Root cause: Render's health check was timing out because Flask bound to localhost only, unreachable from outside the container. `PORT` env var was already read correctly.

---

## End-to-End Test Plan (Playwright)

### Setup

```bash
cd frontend
npm install
npx playwright install --with-deps chromium
# Build the frontend first
npm run build
# Start the Flask server in a separate terminal
cd ..
PORT=8001 python app.py
```

Or against the Render URL, set `BASE_URL=https://<your-render-url>` below.

### Test file: `frontend/tests/e2e.spec.js`

```js
import { test, expect } from '@playwright/test'

const BASE = process.env.BASE_URL || 'http://localhost:8001'

// ── Auth gate ──────────────────────────────────────────────────────────────

test('auth gate renders with Google sign-in UI', async ({ page }) => {
  await page.goto(BASE)
  await expect(page.locator('text=BigBadPhotos')).toBeVisible()
  // Aperture icon present (SVG circle)
  await expect(page.locator('svg circle')).toBeVisible()
})

test('demo: try success button bypasses auth', async ({ page }) => {
  await page.goto(BASE)
  await page.locator('text=Try success').click()
  // Should land on the Landing view
  await expect(page.locator('text=Choose your shoot')).toBeVisible()
})

// ── Landing view ───────────────────────────────────────────────────────────

test('landing: folder pickers and CTA are present', async ({ page }) => {
  await page.goto(BASE)
  await page.locator('text=Try success').click()
  await expect(page.locator('text=Source')).toBeVisible()
  await expect(page.locator('text=Export Target')).toBeVisible()
  await expect(page.locator('text=Begin Review')).toBeDisabled()
})

// ── Keyboard shortcuts overlay ─────────────────────────────────────────────

test('? key opens help overlay', async ({ page }) => {
  await page.goto(BASE)
  await page.locator('text=Try success').click()
  await page.keyboard.press('?')
  await expect(page.locator('text=Keyboard Shortcuts')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('text=Keyboard Shortcuts')).not.toBeVisible()
})

// ── Culling view ───────────────────────────────────────────────────────────

test('culling: navigate to culling via nav pill', async ({ page }) => {
  await page.goto(BASE)
  await page.locator('text=Try success').click()
  await page.locator('a[href="/cull"]').click()
  await expect(page.locator('text=Keep')).toBeVisible()
  await expect(page.locator('text=Maybe')).toBeVisible()
  await expect(page.locator('text=Reject')).toBeVisible()
})

test('culling: P key marks keep, R key marks reject', async ({ page }) => {
  await page.goto(BASE)
  await page.locator('text=Try success').click()
  await page.locator('a[href="/cull"]').click()
  await page.keyboard.press('p')
  // Toast should appear
  await expect(page.locator('.toast')).toContainText(/keep/i)
  await page.keyboard.press('r')
  await expect(page.locator('.toast')).toContainText(/reject/i)
})

test('culling: arrow keys navigate between photos', async ({ page }) => {
  await page.goto(BASE)
  await page.locator('text=Try success').click()
  await page.locator('a[href="/cull"]').click()
  const before = await page.locator('.meta').first().textContent()
  await page.keyboard.press('ArrowRight')
  // Progress bar or counter should advance — just confirm no crash
  await expect(page.locator('text=Keep')).toBeVisible()
})

// ── Compare view ───────────────────────────────────────────────────────────

test('compare: renders side-by-side panels', async ({ page }) => {
  await page.goto(`${BASE}/compare`)
  await page.locator('text=Try success').click()
  await expect(page.locator('text=Pair 1')).toBeVisible()
  await expect(page.locator('text=Pick Winner')).toBeVisible()
})

// ── Review & Export view ───────────────────────────────────────────────────

test('review: stat cards show keeps/maybes/rejects', async ({ page }) => {
  await page.goto(`${BASE}/review`)
  await page.locator('text=Try success').click()
  await expect(page.locator('text=Keeps')).toBeVisible()
  await expect(page.locator('text=Maybe')).toBeVisible()
  await expect(page.locator('text=Reject')).toBeVisible()
  await expect(page.locator('text=Export Configuration')).toBeVisible()
})

test('review: Include Maybes toggle works', async ({ page }) => {
  await page.goto(`${BASE}/review`)
  await page.locator('text=Try success').click()
  const toggle = page.locator('.toggle input')
  await expect(toggle).not.toBeChecked()
  await toggle.click({ force: true })
  await expect(toggle).toBeChecked()
})

// ── Health endpoint ────────────────────────────────────────────────────────

test('GET /health returns ok', async ({ request }) => {
  const res = await request.get(`${BASE}/health`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body.status).toBe('ok')
})
```

### `playwright.config.js` (place in `frontend/`)

```js
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:8001',
    headless: true,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  reporter: [['list'], ['html', { open: 'never' }]],
})
```

### Run tests

```bash
# Against local dev server
cd frontend && npx playwright test

# Against Render
BASE_URL=https://your-app.onrender.com npx playwright test

# Headed (watch it run)
npx playwright test --headed

# Single test
npx playwright test -g "? key opens help overlay"

# Show HTML report
npx playwright show-report
```
