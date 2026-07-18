import { expect, test } from '@playwright/test'

const sessionUrl = './e2e.html#/projects/gateway-e2e/project-e2e/sessions/session-e2e'

test.describe('mobile Session business journey', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(sessionUrl)
    await expect(page.getByRole('heading', { name: 'Build Android client' })).toBeVisible()
  })

  test('C04 shows the user message immediately, then reconciles the authoritative turn', async ({ page }) => {
    const composer = page.locator('.composer textarea')
    await composer.fill('Run the complete business flow')
    await page.getByRole('button', { name: 'Send message' }).click()

    await expect(composer).toHaveValue('')
    await expect(page.locator('.message--pending')).toContainText('Run the complete business flow')
    await expect(page.locator('.message--pending')).toContainText('Sending')
    await expect(page.locator('.message--user').filter({ hasText: 'Run the complete business flow' })).toHaveCount(1)

    await page.evaluate(() => window.__CODEVER_E2E__.completeTurn())

    await expect(page.locator('.message--pending')).toHaveCount(0)
    await expect(page.locator('.message--user').filter({ hasText: 'Run the complete business flow' })).toHaveCount(1)
    await expect(page.locator('.message--assistant').filter({ hasText: 'First reply.' })).toBeVisible()
    await expect(page.locator('.message--assistant').filter({ hasText: 'First reply.' }).locator('.agent-reply-state')).toContainText('success')
  })

  test('C06 reopens completed history as a stable snapshot', async ({ page }) => {
    const historic = page.locator('.message--assistant').filter({ hasText: 'Build ready.' })
    await expect(historic).toBeVisible()
    await expect(historic.locator('.agent-reply-state')).toContainText('success')
    const before = await historic.textContent()

    await page.goto('./e2e.html#/projects/gateway-e2e/project-e2e')
    await page.locator('.session-row').filter({ hasText: 'Build Android client' }).click()

    await expect(historic).toBeVisible()
    await expect(historic.locator('.agent-reply-state')).not.toContainText('Working')
    await page.waitForTimeout(200)
    expect(await historic.textContent()).toBe(before)
  })

  test('C12 downloads a Project file without entering app navigation', async ({ page }) => {
    const before = page.url()
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('link', { name: 'Download APK' }).click()
    const download = await downloadPromise

    expect(download.suggestedFilename()).toBe('codever-client.apk')
    expect(page.url()).toBe(before)
    expect(await page.evaluate(() => window.__CODEVER_E2E__.exportedPath())).toBe('D:/workspace/codever-client.apk')
    await expect(page.getByTestId('machines-page')).toHaveCount(0)
  })

  test('C07 keeps cached history readable while disconnected and restores input on reconnect', async ({ page }) => {
    await page.evaluate(() => window.__CODEVER_E2E__.setConnection('disconnected'))

    await expect(page.locator('.message--assistant').filter({ hasText: 'Build ready.' })).toBeVisible()
    await expect(page.locator('.connection-banner')).toContainText('Server offline')
    await expect(page.locator('.composer textarea')).toBeDisabled()

    await page.evaluate(() => window.__CODEVER_E2E__.setConnection('connected'))
    await expect(page.locator('.connection-banner')).toHaveCount(0)
    await expect(page.locator('.composer textarea')).toBeEnabled()
  })

  test('C09 changes model behavior from compact UI controls', async ({ page }) => {
    await page.locator('.session-control--model select').selectOption('scripted-model')
    await page.locator('.session-control--reasoning select').selectOption('high')
    await page.locator('.session-control--mode select').selectOption('plan')
    await page.locator('.session-control--permissions select').selectOption('bypassPermissions')

    await expect.poll(() => page.evaluate(() => window.__CODEVER_E2E__.lastConfig())).toMatchObject({
      model: 'scripted-model', mode: 'plan',
      config: { reasoningEffort: 'high', permissionMode: 'bypassPermissions' },
    })
  })

  test('C10 resolves a decision without opening the event inspector', async ({ page }) => {
    await page.evaluate(() => window.__CODEVER_E2E__.requestDecision())
    await expect(page.getByText('Install the APK?')).toBeVisible()
    await page.getByRole('button', { name: 'Install' }).click()

    await expect(page.locator('.decision-resolved')).toContainText('Resolved')
    await expect(page.locator('.inspector')).not.toHaveClass(/inspector--open/)
  })

  test('C13 archives and restores a task without treating page visits as activity', async ({ page }) => {
    await page.getByRole('button', { name: 'Archive' }).click()
    await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible()
    await expect(page.locator('.session-row').filter({ hasText: 'Build Android client' })).toHaveCount(0)
    expect(await page.evaluate(() => window.__CODEVER_E2E__.archiveUpdates())).toBe(1)

    await page.getByRole('button', { name: 'Filter' }).click()
    await page.locator('.session-filters select').first().selectOption('archived')
    const archivedTask = page.locator('.session-row').filter({ hasText: 'Build Android client' })
    await expect(archivedTask).toBeVisible()
    await archivedTask.getByRole('button', { name: 'Restore' }).click()
    expect(await page.evaluate(() => window.__CODEVER_E2E__.archiveUpdates())).toBe(2)
    await expect(archivedTask).toHaveCount(0)

    await page.locator('.session-filters select').first().selectOption('recent')
    await expect(page.locator('.session-row').filter({ hasText: 'Build Android client' })).toBeVisible()
  })

  test('mobile layout stays within the viewport', async ({ page }) => {
    const dimensions = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      sessionRight: document.querySelector('.session-page')?.getBoundingClientRect().right ?? 0,
    }))
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport)
    expect(dimensions.sessionRight).toBeLessThanOrEqual(dimensions.viewport + 0.5)
    await expect(page).toHaveScreenshot('session-mobile.png', { animations: 'disabled', fullPage: true })
  })
})
