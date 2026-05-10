import { test, expect } from '@playwright/test'

// Navigate within the SPA without triggering a full page reload.
// Preserves React state (e.g. landing.source) across route changes.
async function spaNavigate(page, url) {
  await page.evaluate((u) => {
    window.history.pushState({}, '', u)
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }))
  }, url)
}

// ── Health endpoint ────────────────────────────────────────────────────────

test('GET /health returns ok', async ({ request }) => {
  const res = await request.get('/health')
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body.status).toBe('ok')
})

// ── Auth gate ──────────────────────────────────────────────────────────────

test('auth gate renders', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('h1', { hasText: 'BigBadPhotos' })).toBeVisible()
  await expect(page.locator('svg').first()).toBeVisible()
})

test('demo: try success bypasses auth to landing', async ({ page }) => {
  await page.goto('/')
  await page.locator('text=Try success').click()
  await expect(page.locator('text=Choose your shoot')).toBeVisible()
})

test('demo: try unauthorized shows allowlist error', async ({ page }) => {
  await page.goto('/')
  await page.locator('text=Try unauthorized').click()
  await expect(page.locator("text=allowlist")).toBeVisible({ timeout: 5000 })
})

// ── Landing view ───────────────────────────────────────────────────────────

test('landing: source and export pickers present, CTA disabled', async ({ page }) => {
  await page.goto('/')
  await page.locator('text=Try success').click()
  await expect(page.locator('text=Choose your shoot')).toBeVisible()
  await expect(page.locator('.meta', { hasText: 'Source' }).first()).toBeVisible()
  await expect(page.locator('.meta', { hasText: 'Export Target' }).first()).toBeVisible()
  await expect(page.locator('button', { hasText: 'Begin Review' })).toBeDisabled()
})

test('landing: clicking Source sets demo path', async ({ page }) => {
  await page.goto('/')
  await page.locator('text=Try success').click()
  await expect(page.locator('text=Choose your shoot')).toBeVisible()
  await page.locator('.meta', { hasText: 'Source' }).first().click()
  await expect(page.locator('text=Pictures')).toBeVisible()
})

// ── Keyboard shortcuts overlay ─────────────────────────────────────────────

test('? key opens help overlay, Escape closes it', async ({ page }) => {
  await page.goto('/')
  await page.locator('text=Try success').click()
  await expect(page.locator('text=Choose your shoot')).toBeVisible()
  await page.locator('body').click()
  await page.keyboard.press('?')
  await expect(page.locator('text=Keyboard Shortcuts')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('text=Keyboard Shortcuts')).not.toBeVisible()
})

test('keyboard help button in appbar opens overlay', async ({ page }) => {
  await page.goto('/')
  await page.locator('text=Try success').click()
  await expect(page.locator('text=Choose your shoot')).toBeVisible()
  await page.locator('[aria-label="Keyboard shortcuts"]').click()
  await expect(page.locator('text=Keyboard Shortcuts')).toBeVisible()
})

// ── Culling view ───────────────────────────────────────────────────────────

async function goToCulling(page) {
  await page.goto('/')
  await page.locator('text=Try success').click()
  await expect(page.locator('text=Choose your shoot')).toBeVisible()
  await page.locator('.meta', { hasText: 'Source' }).first().click()
  await page.locator('button', { hasText: 'Culling' }).click()
  await expect(page.locator('button', { hasText: 'Keep' })).toBeVisible()
}

test('culling: decision dock has Keep, Maybe, Reject buttons', async ({ page }) => {
  await goToCulling(page)
  await expect(page.locator('button', { hasText: 'Maybe' })).toBeVisible()
  await expect(page.locator('button', { hasText: 'Reject' })).toBeVisible()
})

test('culling: P key marks keep and shows toast', async ({ page }) => {
  await goToCulling(page)
  await page.locator('body').click()
  await page.keyboard.press('p')
  await expect(page.locator('.toast')).toContainText(/kept/i)
})

test('culling: R key marks reject and shows toast', async ({ page }) => {
  await goToCulling(page)
  await page.locator('body').click()
  await page.keyboard.press('r')
  await expect(page.locator('.toast')).toContainText(/rejected/i)
})

test('culling: M key marks maybe and shows toast', async ({ page }) => {
  await goToCulling(page)
  await page.locator('body').click()
  await page.keyboard.press('m')
  await expect(page.locator('.toast')).toContainText(/maybe/i)
})

test('culling: arrow right advances without crash', async ({ page }) => {
  await goToCulling(page)
  await page.locator('body').click()
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('button', { hasText: 'Keep' })).toBeVisible()
})

// ── Compare view ───────────────────────────────────────────────────────────

test('compare: renders compare view (empty state without photos)', async ({ page }) => {
  await page.goto('/')
  await page.locator('text=Try success').click()
  await expect(page.locator('text=Choose your shoot')).toBeVisible()
  await page.locator('.meta', { hasText: 'Source' }).first().click()
  await spaNavigate(page, '/compare')
  // No photos in store → empty state is expected
  await expect(page.locator('text=No photos loaded')).toBeVisible()
  await expect(page.locator('text=Load photos in Cull first')).toBeVisible()
})

// ── Review & Export view ───────────────────────────────────────────────────

test('review: stat cards render with correct labels', async ({ page }) => {
  await page.goto('/')
  await page.locator('text=Try success').click()
  await expect(page.locator('text=Choose your shoot')).toBeVisible()
  await page.locator('.meta', { hasText: 'Source' }).first().click()
  await spaNavigate(page, '/review')
  await expect(page.locator('.stat', { hasText: 'Keeps' })).toBeVisible()
  await expect(page.locator('.stat', { hasText: 'Maybe' })).toBeVisible()
  await expect(page.locator('text=Export Configuration')).toBeVisible()
})

test('review: Include Maybes toggle is interactive', async ({ page }) => {
  await page.goto('/')
  await page.locator('text=Try success').click()
  await expect(page.locator('text=Choose your shoot')).toBeVisible()
  await page.locator('.meta', { hasText: 'Source' }).first().click()
  await spaNavigate(page, '/review')
  const toggleLabel = page.locator('.toggle').first()
  const toggleInput = page.locator('.toggle input')
  await expect(toggleInput).not.toBeChecked()
  await toggleLabel.scrollIntoViewIfNeeded()
  await toggleLabel.click()
  await expect(toggleInput).toBeChecked()
})
