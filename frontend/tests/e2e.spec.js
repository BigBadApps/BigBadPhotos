import { test, expect } from '@playwright/test'

// ── Helpers ───────────────────────────────────────────────────────────────

/** Create a dev session and wait for session hub view. Requires BBP_DEBUG=1. */
async function bypassAuth(page) {
  await page.goto('/')
  const devBtn = page.locator('button', { hasText: 'Continue (Dev Mode)' })
  try {
    await devBtn.waitFor({ state: 'visible', timeout: 4000 })
    await devBtn.click()
  } catch {}
  await expect(page.locator('h1', { hasText: 'Session Configuration' })).toBeVisible({ timeout: 10_000 })
}

/**
 * Inject synthetic photos into the Zustand store on /one-off then navigate to Culling.
 */
async function loadPhotosAndGoCulling(page) {
  await bypassAuth(page)
  await page.locator('nav button', { hasText: 'One-off' }).click()
  await expect(page.locator('.meta', { hasText: 'Session folders' })).toBeVisible({ timeout: 5_000 })

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
    store.setSourceDir({ name: 'TestSession' })
    store.setDestDir({ name: 'TestExports' })
  })

  await page.locator('nav button', { hasText: 'Cull' }).click()
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

// ── Session Hub (/ view) ──────────────────────────────────────────────────

test('after login, / shows SessionHubView with New and Open buttons', async ({ page }) => {
  await bypassAuth(page)
  await expect(page.locator('h1', { hasText: 'Session Configuration' })).toBeVisible()
  await expect(page.locator('button', { hasText: 'New' })).toBeVisible()
  await expect(page.locator('button', { hasText: 'Open' })).toBeVisible()
})

test('SessionHub: New opens create form overlay', async ({ page }) => {
  await bypassAuth(page)
  await page.locator('button', { hasText: 'New' }).click()
  await expect(page.locator('h2', { hasText: 'Create a Session' })).toBeVisible()
  await expect(page.locator('button', { hasText: 'Create session' })).toBeVisible()
  await page.locator('button[aria-label="Close form"]').click()
  await expect(page.locator('h2', { hasText: 'Create a Session' })).not.toBeVisible()
})

test('SessionHub: Open toggles session list', async ({ page }) => {
  await bypassAuth(page)
  await page.locator('button', { hasText: 'Open' }).click()
  await expect(
    page.locator('text=No sessions yet').or(page.locator('.card').first())
  ).toBeVisible({ timeout: 5_000 })
})

test('Full Session flow: create session -> SessionArea -> start run -> RunView -> back to SessionArea -> back to Hub', async ({ page }) => {
  const consoleErrors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  await bypassAuth(page)

  const sessionName = `E2E Test Session ${Date.now()}`
  const fakeSessionId = 777

  // Mock sessions API for listing and session details
  await page.route('**/sessions', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessions: [
            {
              id: fakeSessionId,
              name: sessionName,
              sourceFolderName: 'Inbox Folder',
              exportFolderName: 'Keepers Folder',
              autonomous: false,
              preset: 'balanced',
              threshold: 0.6,
            },
          ],
        }),
      })
    } else {
      await route.continue()
    }
  })

  await page.route(`**/sessions/${fakeSessionId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        session: {
          id: fakeSessionId,
          name: sessionName,
          sourceFolderId: 'src_1',
          sourceFolderName: 'Inbox Folder',
          exportFolderId: 'exp_1',
          exportFolderName: 'Keepers Folder',
          autonomous: false,
          preset: 'balanced',
          threshold: 0.6,
          burstBestOnly: true,
          editMode: 'off',
          editStrength: 'medium',
          pollSeconds: 30,
        },
      }),
    })
  })

  await page.route(`**/sessions/${fakeSessionId}/runs`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        runs: [
          {
            id: 101,
            sessionId: fakeSessionId,
            status: 'stopped',
            phase: 'watching',
            startedAt: '2026-08-15T10:00:00Z',
            endedAt: '2026-08-15T10:30:00Z',
            counts: { exported: 8, rejected: 2, awaiting_review: 0 },
          },
        ],
      }),
    })
  })

  await page.route(`**/sessions/${fakeSessionId}/gallery`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        token: 'mock-session-gallery-tok',
        gallery_url: '/gallery/mock-session-gallery-tok',
        galleryUrl: '/gallery/mock-session-gallery-tok',
        stats: { favorites_count: 3, comments_count: 1, unique_visitors: 2 },
        tokens: [
          {
            id: 1,
            session_id: fakeSessionId,
            token: 'mock-session-gallery-tok',
            label: 'Main Gallery',
            scope: 'exports',
            revoked: false,
          },
        ],
      }),
    })
  })

  // 1. Open list and click the session card to navigate to SessionAreaView
  await page.locator('button', { hasText: 'Open' }).click()
  await expect(page.locator('.card', { hasText: sessionName })).toBeVisible()
  await page.locator('.card', { hasText: sessionName }).click()

  // 2. Verify SessionAreaView is displayed
  await expect(page.locator('h1', { hasText: sessionName })).toBeVisible({ timeout: 5_000 })
  await expect(page.locator('.meta', { hasText: 'Run Controls' })).toBeVisible()
  await expect(page.locator('h2', { hasText: 'Run History' })).toBeVisible()
  await expect(page.locator('text=Run #101')).toBeVisible()
  await expect(page.locator('button', { hasText: 'Start run' })).toBeVisible()

  // 3. Mock preflight and start run
  await page.route(`**/sessions/${fakeSessionId}/preflight`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        checks: [
          { check: 'auth', name: 'Google authorization', ok: true, detail: 'Valid token' },
          { check: 'source', name: 'Source folder exists', ok: true, detail: 'Inbox accessible' },
          { check: 'export', name: 'Export folder exists', ok: true, detail: 'Keepers accessible' },
        ],
      }),
    })
  })

  await page.route(`**/sessions/${fakeSessionId}/start`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ runId: 999 }),
    })
  })

  await page.route('**/runs/active', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        running: true,
        runId: 999,
        sessionId: fakeSessionId,
        sessionName,
        phase: 'watching',
        startedAt: new Date().toISOString(),
        counts: { scored: 2, awaiting_review: 1, exported: 1 },
      }),
    })
  })

  // Click Start run
  await page.locator('button', { hasText: 'Start run' }).click()

  // 4. Verify navigated to /sessions/:id/run/999 (RunView)
  await expect(page.locator('h1', { hasText: 'Run #999' })).toBeVisible({ timeout: 5_000 })
  await expect(page.locator('button', { hasText: 'Stop run' })).toBeVisible()

  // 5. Stop run & click Back to session
  await page.route('**/runs/active/stop', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    })
  })

  await page.locator('button', { hasText: 'Back to session' }).first().click()

  // 6. Verify navigated back to SessionAreaView (/sessions/:id)
  await expect(page.locator('h1', { hasText: sessionName })).toBeVisible()

  // 7. Click Back button to go to / (Sessions Hub)
  await page.locator('button', { hasText: 'Sessions' }).first().click()
  await expect(page.locator('h1', { hasText: 'Session Configuration' })).toBeVisible()

  const criticalErrors = consoleErrors.filter((e) => !e.includes('favicon'))
  expect(criticalErrors).toEqual([])
})

// ── One-off Landing View & Bottom Nav ──────────────────────────────────────

test('bottom nav: One-off button goes to /one-off with LandingView', async ({ page }) => {
  await bypassAuth(page)
  await page.locator('nav button', { hasText: 'One-off' }).click()
  await expect(page).toHaveURL('/one-off')
  await expect(page.locator('.meta', { hasText: 'Session folders' })).toBeVisible()
  await expect(page.locator('button', { hasText: 'Begin Review' })).toBeDisabled()
})

test('bottom nav buttons Cull / Compare / Export disabled without photos', async ({ page }) => {
  await bypassAuth(page)
  for (const label of ['Cull', 'Compare', 'Export']) {
    const btn = page.locator('nav button', { hasText: label })
    await expect(btn).toBeDisabled()
    await expect(btn).toHaveAttribute('title', 'Select a source folder first')
  }
})

// ── Keyboard shortcuts ────────────────────────────────────────────────────

test('? key opens help overlay and Escape closes it', async ({ page }) => {
  await bypassAuth(page)
  await page.locator('body').click()
  await page.keyboard.press('?')
  await expect(page.locator('text=Keyboard Shortcuts')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('text=Keyboard Shortcuts')).not.toBeVisible()
})

test('keyboard navigation: 1=/, 2=/one-off, 3/4/5 require photos', async ({ page }) => {
  await bypassAuth(page)
  await page.locator('body').click()

  // Press '2' -> navigates to /one-off
  await page.keyboard.press('2')
  await expect(page).toHaveURL('/one-off')
  await expect(page.locator('.meta', { hasText: 'Session folders' })).toBeVisible()

  // Press '1' -> navigates back to /
  await page.keyboard.press('1')
  await expect(page).toHaveURL('/')
  await expect(page.locator('h1', { hasText: 'Session Configuration' })).toBeVisible()

  // Press '3', '4', '5' without photos -> shows toast and stays on /
  for (const key of ['3', '4', '5']) {
    await page.keyboard.press(key)
    await expect(page.getByRole('status')).toContainText('Select a source folder first', { timeout: 3_000 })
    await expect(page).toHaveURL('/')
    await page.getByRole('status').waitFor({ state: 'detached', timeout: 4_000 }).catch(() => {})
  }
})

// ── Culling, Compare, Review/Export flow ───────────────────────────────────

test('culling: decision dock and keyboard decisions work', async ({ page }) => {
  await loadPhotosAndGoCulling(page)
  await expect(page.locator('button', { hasText: 'Keep' })).toBeVisible()
  await expect(page.locator('button', { hasText: 'Maybe' })).toBeVisible()
  await expect(page.locator('button', { hasText: 'Reject' })).toBeVisible()

  // P key
  await page.locator('body').click()
  await page.keyboard.press('p')
  await expect(page.locator('.toast')).toContainText('Kept', { timeout: 3_000 })
})

test('compare: shows pair navigator with loaded photos', async ({ page }) => {
  await loadPhotosAndGoCulling(page)
  await page.locator('nav button', { hasText: 'Compare' }).click()
  await expect(page.locator('text=Overview Stacks')).toBeVisible({ timeout: 5_000 })
})

test('review / export: header and stats row visible', async ({ page }) => {
  await loadPhotosAndGoCulling(page)
  await page.locator('nav button', { hasText: 'Export' }).click()
  await expect(page.locator('h1', { hasText: 'Review' })).toBeVisible({ timeout: 5_000 })
  await expect(page.locator('.meta', { hasText: 'Total' }).first()).toBeVisible()
  await expect(page.locator('.stat-num', { hasText: '5' }).first()).toBeVisible()
  await expect(page.locator('button', { hasText: 'Initiate Export' })).toBeVisible()
})

