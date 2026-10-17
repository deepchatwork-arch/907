import { test, expect, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'

const ALLOWED = process.env.E2E_ALLOW === '1'
const SUPA_URL = process.env.E2E_SUPABASE_URL!
const SUPA_ANON = process.env.E2E_SUPABASE_ANON_KEY!
const ADMIN_LOGIN = process.env.E2E_ADMIN_LOGIN!
const ADMIN_PW = process.env.E2E_ADMIN_PASSWORD!

test.skip(!ALLOWED, 'E2E_ALLOW=1 required')

const SELF_REG_LOGIN = `e2e_self_${Date.now()}`
const SELF_REG_PW = 'TestPass123!'

async function login(page: Page, login: string, password: string) {
  await page.goto('/')
  await page.fill('input[type="text"]', login)
  await page.fill('input[type="password"]', password)
  await page.click('button[type="submit"]')
}

test.describe('Access control', () => {
  test('self-registered account with no data sees empty state', async ({ page }) => {
    const c = createClient(SUPA_URL, SUPA_ANON)
    const email = `${SELF_REG_LOGIN.toLowerCase().trim()}@sklad.internal`
    const { data, error } = await c.auth.signUp({ email, password: SELF_REG_PW })
    expect(error).toBeNull()
    expect(data.session).toBeTruthy()

    await login(page, SELF_REG_LOGIN, SELF_REG_PW)
    await page.waitForURL(/\/(admin|sv)$/, { timeout: 15000 })

    await page.goto('/sv')
    await page.waitForTimeout(3000)
    const body = page.locator('body')
    await expect(body).not.toContainText('Error')
  })

  test('disabled account cannot sign in', async ({ page }) => {
    const c = createClient(SUPA_URL, SUPA_ANON)
    const email = `${SELF_REG_LOGIN.toLowerCase().trim()}@sklad.internal`
    const { data: signInData } = await c.auth.signInWithPassword({ email, password: SELF_REG_PW })
    const userId = signInData.user?.id
    if (userId) {
      const admin = createClient(SUPA_URL, SUPA_ANON)
      const adminEmail = `${ADMIN_LOGIN.toLowerCase().trim()}@sklad.internal`
      await admin.auth.signInWithPassword({ email: adminEmail, password: ADMIN_PW })
      await admin.from('profiles').update({ active: false }).eq('id', userId)
    }

    await login(page, SELF_REG_LOGIN, SELF_REG_PW)
    await page.waitForTimeout(3000)
    const errorText = page.locator('text=/отключён|disabled|deactivated/i')
    await expect(errorText).toBeVisible({ timeout: 10000 })
  })
})
