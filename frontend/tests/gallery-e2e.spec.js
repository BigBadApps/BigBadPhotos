import { test, expect } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DIST_INDEX = path.resolve(__dirname, '../dist/index.html')

const MOCK_TOKEN = 'test-token-gallery-123'

test.describe('Client Photo Gallery E2E', () => {
  test('gallery endpoint returns 404 for invalid token and renders error state', async ({ page }) => {
    // 1. Direct server GET returns 404
    const res = await page.goto('/gallery/invalid-token-xyz')
    expect(res.status()).toBe(404)
    const json = await res.json()
    expect(json.error).toBe('not_found')

    // 2. Client-side SPA error view when token not found
    await page.route(`**/gallery/${MOCK_TOKEN}`, async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/html', path: DIST_INDEX })
    })
    await page.route(`**/gallery/api/${MOCK_TOKEN}/info`, async (route) => {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'not_found', detail: 'gallery not found' }),
      })
    })

    await page.goto(`/gallery/${MOCK_TOKEN}`)
    await expect(page.locator('h1', { hasText: 'Gallery Not Found' })).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('text=This gallery link may be invalid')).toBeVisible()
  })

  test('empty gallery displays arriving soon state', async ({ page }) => {
    await page.route(`**/gallery/${MOCK_TOKEN}*`, async (route) => {
      if (route.request().url().includes('/gallery/api/')) {
        await route.fallback()
      } else {
        await route.fulfill({ status: 200, contentType: 'text/html', path: DIST_INDEX })
      }
    })
    await page.route(`**/gallery/api/${MOCK_TOKEN}/info`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessionName: 'Senior Portrait 2026',
          photoCount: 0,
          galleryLabel: 'Main Gallery',
          scope: 'exports',
        }),
      })
    })
    await page.route(`**/gallery/api/${MOCK_TOKEN}/favorites`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      })
    })
    await page.route(`**/gallery/api/${MOCK_TOKEN}/photos*`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      })
    })

    await page.goto(`/gallery/${MOCK_TOKEN}`)

    // Header session name and label
    await expect(page.locator('.gallery-title', { hasText: 'Senior Portrait 2026' })).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.gallery-brand-sub', { hasText: 'Main Gallery' })).toBeVisible()

    // Empty landing state
    await expect(page.locator('text=Photos arriving soon')).toBeVisible()
    await expect(page.locator('text=Your photography team is currently shooting')).toBeVisible()
  })

  test('photo grid renders and favorite toggle works', async ({ page }) => {
    const mockPhotos = [
      {
        id: 101,
        filename: 'IMG_0001.JPG',
        thumbnailUrl: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="100%" height="100%" fill="%2391462E"/></svg>',
      },
      {
        id: 102,
        filename: 'IMG_0002.JPG',
        thumbnailUrl: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="100%" height="100%" fill="%232C2824"/></svg>',
      },
    ]

    let serverFavorites = []

    await page.route(`**/gallery/${MOCK_TOKEN}*`, async (route) => {
      if (route.request().url().includes('/gallery/api/')) {
        await route.fallback()
      } else {
        await route.fulfill({ status: 200, contentType: 'text/html', path: DIST_INDEX })
      }
    })

    await page.route(`**/gallery/api/${MOCK_TOKEN}/info`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessionName: 'Wedding Highlights',
          photoCount: 2,
          galleryLabel: 'Main Gallery',
          scope: 'exports',
        }),
      })
    })

    await page.route(`**/gallery/api/${MOCK_TOKEN}/favorites`, async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(serverFavorites),
        })
      }
    })

    await page.route(`**/gallery/api/${MOCK_TOKEN}/favorites/101`, async (route) => {
      if (route.request().method() === 'POST') {
        serverFavorites.push(101)
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'added' }),
        })
      } else if (route.request().method() === 'DELETE') {
        serverFavorites = serverFavorites.filter((id) => id !== 101)
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'removed' }),
        })
      }
    })

    await page.route(`**/gallery/api/${MOCK_TOKEN}/photos*`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'X-Total-Count': '2' },
        body: JSON.stringify(mockPhotos),
      })
    })

    await page.goto(`/gallery/${MOCK_TOKEN}`)

    // Verify grid cards render
    const cards = page.locator('.gallery-card')
    await expect(cards).toHaveCount(2, { timeout: 10_000 })
    await expect(page.locator('text=IMG_0001.JPG')).toBeVisible()
    await expect(page.locator('text=IMG_0002.JPG')).toBeVisible()

    // Click favorite heart on first card
    const favBtn = cards.first().locator('.gallery-card-favorite-btn')
    await expect(favBtn).toBeVisible()
    await favBtn.click()

    // Check tab badge updates
    await expect(page.locator('.tab-badge', { hasText: '1' })).toBeVisible()

    // Navigate to My Favorites tab
    await page.locator('.gallery-nav-tab', { hasText: 'My Favorites' }).click()
    await expect(page).toHaveURL(`/gallery/${MOCK_TOKEN}/favorites`)
    await expect(page.locator('.gallery-card')).toHaveCount(1)
    await expect(page.locator('text=IMG_0001.JPG')).toBeVisible()
  })

  test('lightbox opens, navigates photos, and allows comment submission', async ({ page }) => {
    const mockPhotos = [
      {
        id: 201,
        filename: 'PHOTO_A.JPG',
        thumbnailUrl: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="100%" height="100%" fill="%234A5568"/></svg>',
      },
      {
        id: 202,
        filename: 'PHOTO_B.JPG',
        thumbnailUrl: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="100%" height="100%" fill="%232D3748"/></svg>',
      },
    ]

    let commentsList = [
      {
        id: 1,
        photo_id: 201,
        body: 'Beautiful shot!',
        display_name: 'Guest User',
        created_at: '2026-08-17T12:00:00Z',
      },
    ]

    await page.route(`**/gallery/${MOCK_TOKEN}*`, async (route) => {
      if (route.request().url().includes('/gallery/api/')) {
        await route.fallback()
      } else {
        await route.fulfill({ status: 200, contentType: 'text/html', path: DIST_INDEX })
      }
    })

    await page.route(`**/gallery/api/${MOCK_TOKEN}/info`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessionName: 'Family Portrait',
          photoCount: 2,
          galleryLabel: 'Main Gallery',
          scope: 'exports',
        }),
      })
    })

    await page.route(`**/gallery/api/${MOCK_TOKEN}/favorites*`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      })
    })

    await page.route(`**/gallery/api/${MOCK_TOKEN}/photos*`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'X-Total-Count': '2' },
        body: JSON.stringify(mockPhotos),
      })
    })

    await page.route(`**/gallery/api/${MOCK_TOKEN}/comments*`, async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(commentsList),
        })
      } else if (route.request().method() === 'POST') {
        const payload = route.request().postDataJSON() || {}
        const newComm = {
          id: commentsList.length + 1,
          photo_id: payload.photoId || 201,
          body: payload.body,
          display_name: payload.displayName || null,
          created_at: new Date().toISOString(),
        }
        commentsList.push(newComm)
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(newComm),
        })
      }
    })

    await page.goto(`/gallery/${MOCK_TOKEN}`)

    // Click photo card image to open lightbox
    await page.locator('.gallery-card').first().click()

    // Lightbox modal is visible
    const lightbox = page.locator('.gallery-lightbox-overlay')
    await expect(lightbox).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('.gallery-lightbox-counter', { hasText: 'PHOTO_A.JPG' })).toBeVisible()

    // Open comments drawer
    const commentToggleBtn = page.locator('button[aria-label="Toggle comments"]')
    await commentToggleBtn.click()

    await expect(page.locator('text=Beautiful shot!')).toBeVisible()

    // Add a new comment
    await page.locator('input[placeholder="Your name (optional)"]').fill('Aunt Sarah')
    await page.locator('input[placeholder="Add a comment or note..."]').fill('Love the smile in this one!')
    await page.locator('button', { hasText: 'Post' }).click()

    await expect(page.locator('text=Love the smile in this one!')).toBeVisible()

    // Navigate to next photo in lightbox
    await page.locator('button[aria-label="Next photo"]').click()
    await expect(page.locator('.gallery-lightbox-counter', { hasText: 'PHOTO_B.JPG' })).toBeVisible()

    // Close lightbox via Close button
    await page.locator('button[aria-label="Close viewer"]').click()
    await expect(lightbox).not.toBeVisible()
  })
})

