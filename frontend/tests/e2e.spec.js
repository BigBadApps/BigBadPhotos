import { test, expect } from '@playwright/test'

// ── Helpers ───────────────────────────────────────────────────────────────

/** Create a dev session and wait for landing view. Requires BBP_DEBUG=1. */
async function bypassAuth(page) {
  await page.goto('/')
  await expect(page.locator('h1', { hasText: 'BigBadPhotos' })).toBeVisible({ timeout: 10_000 })
  await page.evaluate(async () => {
    const res = await fetch('/auth/dev', { method: 'POST', credentials: 'include' })
    if (!res.ok) throw new Error(`dev auth failed: ${res.status}`)
  })
  await page.reload()
  await expect(page.locator('.meta', { hasText: 'Session folders' })).toBeVisible({ timeout: 10_000 })
}

/**
 * Inject synthetic photos into the Zustand store then navigate to Culling.
 * showDirectoryPicker is never called — photos go in directly via window.__bbpStore.
 */
async function loadPhotosAndGoCulling(page) {
  await bypassAuth(page)

  await page.evaluate(() => {
    const store = window.__bbpStore.getState()
    const photos = Array.from({ length: 5 }, (_, i) => ({
      id: `IMG_00${i}.jpg`,
      filename: `IMG_00${i}.jpg`,
      url: null,
      file: null,
      isRaw: false,
      decision: null,
      rank: null,
      sharpness: 0.7 + i * 0.05,
      overallScore: 0.7 + i * 0.05,
    }))
    store.addPhotos(photos)
    store.setCurrentId(photos[0].id)
    // Set sourceDir AFTER photos so usePhotoLoader skips (orderLength > 0)
    store.setSourceDir({ name: 'TestSession' })
    store.setDestDir({ name: 'TestExports' })
  })

  await page.locator('button', { hasText: 'Culling' }).click()
  await expect(page.locator('button', { hasText: 'Keep' })).toBeVisible({ timeout: 5_000 })
}

// ── Health endpoint ───────────────────────────────────────────────────────

test('GET /health returns ok', async ({ request }) => {
  const res = await request.get('/health')
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body.status).toBe('ok')
})

test('GET /auth/config returns dev:true', async ({ request }) => {
  const res = await request.get('/auth/config')
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body.dev).toBe(true)
})

// ── Auth gate ─────────────────────────────────────────────────────────────

test('auth gate renders sign-in screen', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('h1', { hasText: 'BigBadPhotos' })).toBeVisible({ timeout: 10_000 })
})

test('dev mode: Continue (Dev Mode) reaches landing', async ({ page }) => {
  await bypassAuth(page)
  await expect(page.locator('.meta', { hasText: 'Session folders' })).toBeVisible()
})

// ── Landing view ──────────────────────────────────────────────────────────

test('landing: folder rows present and Begin Review disabled', async ({ page }) => {
  await bypassAuth(page)
  await expect(page.locator('.meta', { hasText: 'Source' }).first()).toBeVisible()
  await expect(page.locator('.meta', { hasText: 'Export Target' }).first()).toBeVisible()
  await expect(page.locator('button', { hasText: 'Begin Review' })).toBeDisabled()
})

test('landing: bottom nav has all four views', async ({ page }) => {
  await bypassAuth(page)
  for (const label of ['Landing', 'Culling', 'Compare', 'Export']) {
    await expect(page.locator('button', { hasText: label }).last()).toBeVisible()
  }
})

// ── Keyboard help overlay ─────────────────────────────────────────────────

test('? key opens help overlay', async ({ page }) => {
  await bypassAuth(page)
  await page.locator('body').click()
  await page.keyboard.press('?')
  await expect(page.locator('text=Keyboard Shortcuts')).toBeVisible()
})

test('Escape closes help overlay', async ({ page }) => {
  await bypassAuth(page)
  await page.locator('body').click()
  await page.keyboard.press('?')
  await expect(page.locator('text=Keyboard Shortcuts')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('text=Keyboard Shortcuts')).not.toBeVisible()
  await expect(page.locator('.meta', { hasText: 'Session folders' })).toBeVisible()
})

test('shortcuts 2/3/4 without source show toast and stay on landing', async ({ page }) => {
  await bypassAuth(page)
  await page.locator('body').click()
  for (const key of ['2', '3', '4']) {
    await page.keyboard.press(key)
    await expect(page.getByRole('status')).toContainText('Select a source folder first', { timeout: 3_000 })
    await expect(page.locator('.meta', { hasText: 'Session folders' })).toBeVisible()
    await page.getByRole('status').waitFor({ state: 'detached', timeout: 4_000 }).catch(() => {})
  }
})

test('nav buttons disabled without source folder', async ({ page }) => {
  await bypassAuth(page)
  for (const label of ['Culling', 'Compare', 'Export']) {
    const btn = page.locator('nav button', { hasText: label })
    await expect(btn).toBeDisabled()
    await expect(btn).toHaveAttribute('title', 'Select a source folder first')
  }
})

test('password error clears field, shows hint, and shakes card', async ({ page }) => {
  await page.route('**/auth/config', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ password: true, dev: false, google: false, drive: false }),
    })
  })
  await page.route('**/auth/me', async (route) => {
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{}' })
  })
  await page.route('**/auth/password', async (route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'invalid_password' }),
    })
  })

  await page.goto('/')
  await expect(page.locator('h1', { hasText: 'BigBadPhotos' })).toBeVisible({ timeout: 10_000 })
  const passwordInput = page.locator('input[type="password"]')
  await passwordInput.fill('wrong-password')
  await page.locator('button', { hasText: 'Sign In' }).click()

  await expect(page.locator('text=Incorrect password. Try again.')).toBeVisible({ timeout: 5_000 })
  await expect(passwordInput).toHaveValue('')
  await expect(page.locator('.auth-card')).toHaveClass(/bbp-shake/, { timeout: 2_000 })
})

test('appbar help button opens overlay', async ({ page }) => {
  await bypassAuth(page)
  await page.locator('[aria-label="Keyboard shortcuts"]').click()
  await expect(page.locator('text=Keyboard Shortcuts')).toBeVisible()
})

// ── Culling view ──────────────────────────────────────────────────────────

test('culling: decision dock has Keep, Maybe, Reject', async ({ page }) => {
  await loadPhotosAndGoCulling(page)
  await expect(page.locator('button', { hasText: 'Maybe' })).toBeVisible()
  await expect(page.locator('button', { hasText: 'Reject' })).toBeVisible()
})

test('culling: P key marks Keep and shows toast', async ({ page }) => {
  await loadPhotosAndGoCulling(page)
  await page.locator('body').click()
  await page.keyboard.press('p')
  await expect(page.locator('.toast')).toContainText('Kept', { timeout: 3_000 })
})

test('culling: M key marks Maybe and shows toast', async ({ page }) => {
  await loadPhotosAndGoCulling(page)
  await page.locator('body').click()
  await page.keyboard.press('m')
  await expect(page.locator('.toast')).toContainText('Maybe', { timeout: 3_000 })
})

test('culling: R key marks Reject and shows toast', async ({ page }) => {
  await loadPhotosAndGoCulling(page)
  await page.locator('body').click()
  await page.keyboard.press('r')
  await expect(page.locator('.toast')).toContainText('Rejected', { timeout: 3_000 })
})

test('culling: Ctrl+Z undoes last decision', async ({ page }) => {
  await loadPhotosAndGoCulling(page)
  await page.locator('body').click()
  await page.keyboard.press('p')
  await expect(page.locator('.toast')).toContainText('Kept', { timeout: 3_000 })
  await page.keyboard.press('Control+z')
  await expect(page.locator('.toast')).toContainText('Undone', { timeout: 3_000 })
})

test('culling: Keep button click marks photo', async ({ page }) => {
  await loadPhotosAndGoCulling(page)
  await page.locator('button', { hasText: 'Keep' }).click()
  await expect(page.locator('.toast')).toContainText('Kept', { timeout: 3_000 })
})

test('culling: decision updates keep counter to 01', async ({ page }) => {
  await loadPhotosAndGoCulling(page)
  await page.locator('button', { hasText: 'Keep' }).click()
  await page.locator('.toast').waitFor({ state: 'detached', timeout: 3_000 }).catch(() => {})
  await expect(page.locator('.mono.fs-md', { hasText: '01' }).first()).toBeVisible({ timeout: 3_000 })
})

test('culling: right arrow advances to photo 02', async ({ page }) => {
  await loadPhotosAndGoCulling(page)
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('text=02').first()).toBeVisible({ timeout: 2_000 })
})

// ── Compare view ──────────────────────────────────────────────────────────

test('compare: shows pair navigator with injected photos', async ({ page }) => {
  await loadPhotosAndGoCulling(page)
  await page.locator('button', { hasText: 'Compare' }).click()
  await expect(page.locator('text=Pair 1')).toBeVisible({ timeout: 5_000 })
})

// ── Review / Export view ──────────────────────────────────────────────────

test('review: header and stats row visible', async ({ page }) => {
  await loadPhotosAndGoCulling(page)
  await page.locator('button', { hasText: 'Export' }).click()
  await expect(page.locator('h1', { hasText: 'Review' })).toBeVisible({ timeout: 5_000 })
  await expect(page.locator('.meta', { hasText: 'Total' }).first()).toBeVisible()
})

test('review: Initiate Export button present', async ({ page }) => {
  await loadPhotosAndGoCulling(page)
  await page.locator('button', { hasText: 'Export' }).click()
  await expect(page.locator('button', { hasText: 'Initiate Export' })).toBeVisible({ timeout: 5_000 })
})

test('review: Total stat shows 5 photos', async ({ page }) => {
  await loadPhotosAndGoCulling(page)
  await page.locator('button', { hasText: 'Export' }).click()
  await expect(page.locator('.stat-num', { hasText: '5' }).first()).toBeVisible({ timeout: 3_000 })
})
