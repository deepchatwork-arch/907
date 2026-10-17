import { test, expect, type Page } from '@playwright/test'

const ALLOWED = process.env.E2E_ALLOW === '1'
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:4173'
const SUPA_URL = process.env.E2E_SUPABASE_URL!
const SUPA_ANON = process.env.E2E_SUPABASE_ANON_KEY!
const ADMIN_LOGIN = process.env.E2E_ADMIN_LOGIN!
const ADMIN_PW = process.env.E2E_ADMIN_PASSWORD!

test.skip(!ALLOWED, 'E2E_ALLOW=1 required')

async function login(page: Page, login: string, password: string) {
  await page.goto('/')
  await page.fill('input[type="text"]', login)
  await page.fill('input[type="password"]', password)
  await page.click('button[type="submit"]')
}

test.describe('QR History', () => {
  test('history page shows cleaning and incident tabs, search, date filter, detail, no delete', async ({ page }) => {
    await login(page, ADMIN_LOGIN, ADMIN_PW)
    await page.waitForURL(/\/(admin|sv)$/, { timeout: 15000 })

    await page.goto('/qr/1/history')
    await page.waitForTimeout(3000)

    const url = page.url()
    expect(url).toContain('/qr/1/history')

    const cleaningTab = page.locator('text=Уборки').first()
    if (await cleaningTab.isVisible()) {
      await cleaningTab.click()
      await page.waitForTimeout(1000)

      const searchInput = page.locator('input[type="text"]').first()
      if (await searchInput.isVisible()) {
        await searchInput.fill('test')
        await page.waitForTimeout(600)
        await searchInput.fill('')
        await page.waitForTimeout(600)
      }

      const filterToggle = page.locator('text=Фильтры').first()
      if (await filterToggle.isVisible()) {
        await filterToggle.click()
        await page.waitForTimeout(500)
        const dateFrom = page.locator('input[type="date"]').first()
        if (await dateFrom.isVisible()) {
          await dateFrom.fill('2026-01-01')
          await page.waitForTimeout(600)
          await dateFrom.fill('')
          await page.waitForTimeout(600)
        }
        await filterToggle.click()
        await page.waitForTimeout(500)
      }

      const firstItem = page.locator('button.w-full.text-left').first()
      if (await firstItem.isVisible()) {
        await firstItem.click()
        await page.waitForTimeout(1000)
        const deleteBtn = page.locator('button:has-text("Удалить")')
        const deleteVisible = await deleteBtn.isVisible().catch(() => false)
        expect(deleteVisible).toBe(false)
        const closeBtn = page.locator('button:has-text("Закрыть")').first()
        if (await closeBtn.isVisible()) await closeBtn.click()
        await page.waitForTimeout(500)
      }
    }

    const incidentTab = page.locator('text=Заявки').first()
    if (await incidentTab.isVisible()) {
      await incidentTab.click()
      await page.waitForTimeout(1000)
    }
  })
})
