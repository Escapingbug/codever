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

  test('C02 authorizes a second computer without confusing it with the Relay connection', async ({ page }) => {
    await page.goto('./e2e.html#/machines')
    const secondComputer = page.locator('.machine-card').filter({ hasText: 'Second computer' })
    await expect(secondComputer).toContainText('Authorization required')
    await secondComputer.click()

    await expect(page.getByRole('heading', { name: 'Authorize this client' })).toBeVisible()
    await page.getByLabel('Device pairing code').fill('PAIR-GATEWAY-123')
    await page.getByRole('button', { name: 'Authorize computer' }).click()
    await expect(page.getByRole('heading', { name: 'No projects on this computer' })).toBeVisible()
  })

  test('C03 creates a Windows Project using a Gateway-native path', async ({ page }) => {
    await page.goto('./e2e.html#/projects')
    await page.getByRole('button', { name: 'New project' }).click()
    await page.getByLabel('Computer').selectOption('gateway-e2e')
    await page.getByLabel('Project name').fill('New Windows project')
    await page.getByLabel('Project folder').fill('D:\\workspace\\new-project')
    await page.getByLabel('Default provider (optional)').fill('codex')
    await page.getByRole('button', { name: 'Create project' }).click()

    await expect(page.getByRole('heading', { name: 'New Windows project' })).toBeVisible()
    await expect(page.getByRole('button', { name: /New task/ })).toBeVisible()
  })

  test('C04/C14 starts fresh work or continues an inactive Provider task from one list', async ({ page }) => {
    await page.goto('./e2e.html#/projects/gateway-e2e/project-e2e')
    await expect(page.locator('.session-row').filter({ hasText: 'Build Android client' })).toBeVisible()
    const inactive = page.locator('.session-row').filter({ hasText: 'Local Codex investigation' })
    await expect(inactive).toContainText('Investigate the local build failure')
    await inactive.click()
    await expect(page.getByRole('heading', { name: 'Local Codex investigation' })).toBeVisible()

    await page.goto('./e2e.html#/projects/gateway-e2e/project-e2e')
    await page.getByRole('button', { name: /New task/ }).click()
    await page.getByPlaceholder(/describe the task/).fill('Fresh remote task')
    await page.getByRole('button', { name: 'Create task' }).click()
    await expect(page.getByRole('heading', { name: 'Fresh remote task' })).toBeVisible()
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

  test('C08 stops an accepted running tool and returns the composer to idle', async ({ page }) => {
    const composer = page.locator('.composer textarea')
    await composer.fill('Run a long verification')
    await page.getByRole('button', { name: 'Send message' }).click()
    await page.evaluate(() => window.__CODEVER_E2E__.startLongTurn())

    await expect(page.locator('.message--user').filter({ hasText: 'Run a long verification' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible()
    await page.getByRole('button', { name: 'Stop' }).click()

    await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0)
    await expect(page.getByText('idle', { exact: true })).toBeVisible()
    await expect(composer).toBeEnabled()
  })

  test('C11 uploads, attaches, sends, and deletes a Session file', async ({ page }) => {
    await page.locator('input[type=file]').setInputFiles({
      name: 'requirements.txt', mimeType: 'text/plain', buffer: Buffer.from('vitest\nplaywright\n'),
    })
    await expect(page.locator('.composer-attachment--ready')).toContainText('requirements.txt')

    await page.locator('.composer textarea').fill('Use the attached requirements')
    await page.getByRole('button', { name: 'Send message' }).click()
    expect(await page.evaluate(() => window.__CODEVER_E2E__.lastSentInput()?.attachmentIds)).toHaveLength(1)
    await page.evaluate(() => window.__CODEVER_E2E__.completeTurn())
    await expect(page.locator('.message--user').filter({ hasText: 'requirements.txt' })).toBeVisible()

    await page.getByRole('button', { name: /Files 1/ }).click()
    const files = page.getByRole('region', { name: 'Files stored for this session' })
    await expect(files).toContainText('requirements.txt')
    await files.getByRole('checkbox', { name: 'Select file for deletion' }).check()
    page.once('dialog', dialog => dialog.accept())
    await files.getByRole('button', { name: 'Delete (1)' }).click()
    await expect(files).toContainText('No files are stored for this session.')
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

  test('C15 incrementally loads earlier history without moving the visible anchor', async ({ page }) => {
    await page.goto('./e2e.html?history=long#/projects/gateway-e2e/project-e2e/sessions/session-long-history-e2e')
    await expect(page.getByText('Historical reply 5.')).toBeVisible()
    await expect(page.getByText('Historical reply 4.')).toHaveCount(0)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))

    const pane = page.getByRole('region', { name: 'Conversation timeline' })
    const anchor = page.getByText('Historical reply 5.')
    const before = await anchor.evaluate(element => element.getBoundingClientRect().top)
    await pane.evaluate(element => {
      element.scrollTop = 0
      element.dispatchEvent(new Event('scroll'))
    })

    await expect(page.getByText('Historical reply 4.')).toBeVisible()
    const after = await anchor.evaluate(element => element.getBoundingClientRect().top)
    expect(Math.abs(after - before)).toBeLessThanOrEqual(2)
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
