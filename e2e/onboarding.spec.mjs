import { test, expect } from '@playwright/test'

test('first-run onboarding, settings and library work on a clean data dir', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#onboarding')).toBeVisible()
  await expect(page.locator('#onboardStep1')).toBeVisible()

  await page.locator('#onboardNext1').click()
  await expect(page.locator('#onboardStep2')).toBeVisible()
  await page.locator('#onboardProvider').selectOption('local')
  await page.locator('#onboardSkipLlm').click()
  await expect(page.locator('#onboardStep3')).toBeVisible()

  await page.locator('#onboardFinish').click()
  await expect(page.locator('#onboarding')).toBeHidden()
  await expect(page.locator('.brand-name')).toHaveText('course notes')
  await expect(page.locator('#statusText')).toContainText('运行')

  await page.locator('#btnSettings').click()
  await expect(page.locator('#settingsDrawer')).toHaveClass(/open/)
  await expect(page.locator('#browserHint')).toBeVisible()
  await expect(page.locator('#setDataDir')).toHaveValue(/e2e-data/)
  await page.locator('#settingsClose').click()

  await page.locator('.nav-item[data-view="library"]').click()
  await expect(page.locator('#viewLibrary')).toBeVisible()
  await expect(page.locator('#libraryStats')).toContainText('0 个视频')
  await expect(page.locator('.brand-name')).toHaveText('course notes')

  await page.reload()
  await expect(page.locator('#onboarding')).toBeHidden()
  await expect(page.locator('#viewHome')).toBeVisible()
})
