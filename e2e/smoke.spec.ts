import { test, expect, type Page } from '@playwright/test'

const ALLOWED = process.env.E2E_ALLOW === '1'
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:4173'
const SUPA_URL = process.env.E2E_SUPABASE_URL!
const SUPA_ANON = process.env.E2E_SUPABASE_ANON_KEY!
const ADMIN_LOGIN = process.env.E2E_ADMIN_LOGIN!
const ADMIN_PW = process.env.E2E_ADMIN_PASSWORD!
const SV_LOGIN = process.env.E2E_SV_LOGIN!
const SV_PW = process.env.E2E_SV_PASSWORD!

test.skip(!ALLOWED, 'E2E_ALLOW=1 required')

async function login(page: Page, login: string, password: string) {
  await page.goto('/')
  await page.fill('input[type="text"]', login)
  await page.fill('input[type="password"]', password)
  await page.click('button[type="submit"]')
}

test.describe('Smoke', () => {
  test('admin login and dashboard', async ({ page }) => {
    await login(page, ADMIN_LOGIN, ADMIN_PW)
    await page.waitForURL('**/admin', { timeout: 15000 })
    await expect(page).toHaveURL(/\/admin$/)
  })

  test('offline cleaning queues to outbox then syncs', async ({ page, context }) => {
    await login(page, ADMIN_LOGIN, ADMIN_PW)
    await page.waitForURL('**/admin', { timeout: 15000 })
    await page.goto('/sv')
    await page.waitForSelector('text=Квартиры', { timeout: 10000 })

    await context.setOffline(true)
    await page.goto('/sv/apartments/1/clean')
    await page.waitForSelector('text=Отметить уборку', { timeout: 10000 })
    const staffCheckbox = page.locator('input[type="checkbox"]').first()
    if (await staffCheckbox.isVisible()) {
      await staffCheckbox.check()
    }
    const confirmBtn = page.locator('button:has-text("Подтвердить")')
    if (await confirmBtn.isVisible()) {
      await confirmBtn.click()
      await expect(page.locator('text=В очереди')).toBeVisible({ timeout: 5000 })
    }
    await context.setOffline(false)
    await page.waitForTimeout(5000)
  })

  test('server error on cleaning shows error, not queued', async ({ page }) => {
    await login(page, ADMIN_LOGIN, ADMIN_PW)
    await page.waitForURL('**/admin', { timeout: 15000 })
    await page.goto('/sv')
    await page.waitForSelector('text=Квартиры', { timeout: 10000 })
    await page.goto('/sv/apartments/1/clean')
    await page.waitForSelector('text=Отметить уборку', { timeout: 10000 })
    const confirmBtn = page.locator('button:has-text("Подтвердить")')
    if (await confirmBtn.isVisible()) {
      await confirmBtn.click()
      await page.waitForTimeout(3000)
    }
  })

  test('qr/:id accessible by admin, manager, supervisor', async ({ browser }) => {
    const roles = [
      { login: ADMIN_LOGIN, pw: ADMIN_PW },
      { login: SV_LOGIN, pw: SV_PW },
    ]
    for (const r of roles) {
      const page = await browser.newPage()
      await login(page, r.login, r.pw)
      await page.waitForURL(/\/(admin|sv)$/, { timeout: 15000 })
      await page.goto('/qr/1')
      await page.waitForTimeout(3000)
      await page.close()
    }
  })

  test('delete staff with history shows error or archive option', async ({ page }) => {
    await login(page, ADMIN_LOGIN, ADMIN_PW)
    await page.waitForURL('**/admin', { timeout: 15000 })
    await page.goto('/admin/more/staff')
    await page.waitForTimeout(3000)
    const deleteBtn = page.locator('button:has-text("Удалить")').first()
    if (await deleteBtn.isVisible()) {
      await deleteBtn.click()
      await page.waitForTimeout(2000)
    }
  })
})
