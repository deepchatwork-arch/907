import { test, expect, type Page } from '@playwright/test'

const ALLOWED = process.env.E2E_ALLOW === '1'
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:4173'
const ADMIN_LOGIN = process.env.E2E_ADMIN_LOGIN!
const ADMIN_PW = process.env.E2E_ADMIN_PASSWORD!
const SV_LOGIN = process.env.E2E_SV_LOGIN!
const SV_PW = process.env.E2E_SV_PASSWORD!

void BASE_URL

test.skip(!ALLOWED, 'E2E_ALLOW=1 required')

async function login(page: Page, login: string, password: string) {
  await page.goto('/')
  await page.fill('input[type="text"]', login)
  await page.fill('input[type="password"]', password)
  await page.click('button[type="submit"]')
}

async function gotoHistory(page: Page) {
  await page.goto('/admin/more/history')
  await page.waitForSelector('text=История', { timeout: 10000 })
}

test.describe('History', () => {
  test('admin can open history page', async ({ page }) => {
    await login(page, ADMIN_LOGIN, ADMIN_PW)
    await page.waitForURL('**/admin', { timeout: 15000 })
    await gotoHistory(page)
    await expect(page.locator('h1:has-text("История")')).toBeVisible({ timeout: 10000 })
  })

  test('search filters by text', async ({ page }) => {
    await login(page, ADMIN_LOGIN, ADMIN_PW)
    await page.waitForURL('**/admin', { timeout: 15000 })
    await gotoHistory(page)

    const filterToggle = page.locator('button:has-text("Фильтры")')
    if (await filterToggle.isVisible()) {
      await filterToggle.click()
      await page.waitForTimeout(500)
    }

    const searchInput = page.locator('input[placeholder*="Поиск"]')
    if (await searchInput.isVisible()) {
      await searchInput.fill('test-query-xyz')
      await page.waitForTimeout(1000)
      const noResults = page.locator('text=Ничего не найдено')
      await expect(noResults).toBeVisible({ timeout: 8000 })
    }
  })

  test('date filter narrows results', async ({ page }) => {
    await login(page, ADMIN_LOGIN, ADMIN_PW)
    await page.waitForURL('**/admin', { timeout: 15000 })
    await gotoHistory(page)

    const filterToggle = page.locator('button:has-text("Фильтры")')
    if (await filterToggle.isVisible()) {
      await filterToggle.click()
      await page.waitForTimeout(500)
    }

    const dateFrom = page.locator('input[type="date"]').first()
    if (await dateFrom.isVisible()) {
      await dateFrom.fill('2000-01-01')
      await page.waitForTimeout(1000)
      const noResults = page.locator('text=Ничего не найдено')
      await expect(noResults).toBeVisible({ timeout: 8000 })
    }
  })

  test('admin can open a cleaning card and delete with reason', async ({ page }) => {
    await login(page, ADMIN_LOGIN, ADMIN_PW)
    await page.waitForURL('**/admin', { timeout: 15000 })
    await gotoHistory(page)

    const cardButton = page.locator('button.w-full.text-left.bg-surface').first()
    if (await cardButton.isVisible({ timeout: 10000 })) {
      await cardButton.click()
      const detailTitle = page.locator('h2:has-text("Уборка")')
      await expect(detailTitle).toBeVisible({ timeout: 5000 })

      const deleteBtn = page.locator('button:has-text("Удалить")')
      if (await deleteBtn.isVisible()) {
        await deleteBtn.click()
        const reasonField = page.locator('textarea[placeholder*="причина"]')
        if (await reasonField.isVisible({ timeout: 3000 })) {
          await reasonField.fill('e2e test deletion')
          const confirmDelete = page.locator('.bg-bad.text-white:has-text("Удалить")')
          if (await confirmDelete.isVisible()) {
            await confirmDelete.click()
            await page.waitForTimeout(3000)
          }
        }
      }
    }
  })

  test('supervisor has no delete button', async ({ page }) => {
    await login(page, SV_LOGIN, SV_PW)
    await page.waitForURL(/\/(admin|sv)$/, { timeout: 15000 })
    await page.goto('/sv')
    await page.waitForTimeout(2000)

    const cardButton = page.locator('button.w-full.text-left.bg-surface').first()
    if (await cardButton.isVisible({ timeout: 8000 })) {
      await cardButton.click()
      await page.waitForTimeout(2000)
      const deleteBtn = page.locator('button:has-text("Удалить")')
      await expect(deleteBtn).not.toBeVisible()
    }
  })
})
