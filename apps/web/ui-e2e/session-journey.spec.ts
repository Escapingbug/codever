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
    await expect(page.getByLabel('Agent response (success): First reply.')).toBeVisible()
    await expect(page.locator('.message--assistant').filter({ hasText: 'First reply.' }).locator('.agent-reply-state')).toContainText('success')
  })

  test('C04 catches up omitted Provider deltas when Matrix delivers only a state wake-up', async ({ page }) => {
    const composer = page.locator('.composer textarea')
    await composer.fill('Exercise durable wake-up delivery')
    await page.getByRole('button', { name: 'Send message' }).click()
    await expect(page.locator('.message--pending')).toContainText('Exercise durable wake-up delivery')

    await page.evaluate(() => window.__CODEVER_E2E__.completeTurnWithWakeup())

    await expect(page.locator('.message--pending')).toHaveCount(0)
    await expect(page.locator('.message--user').filter({ hasText: 'Exercise durable wake-up delivery' })).toHaveCount(1)
    const reply = page.locator('.message--assistant').filter({ hasText: 'Recovered from the durable journal.' })
    await expect(reply).toHaveCount(1)
    await expect(reply.locator('.agent-reply-state')).toContainText('success')
    await expect(page.getByText('idle', { exact: true })).toBeVisible()
  })

  test('C01 keeps the running UI available after a late native listener error', async ({ page }) => {
    await page.evaluate(() => window.__CODEVER_E2E__.reportRuntimeError())

    await expect(page.getByRole('heading', { name: 'Build Android client' })).toBeVisible()
    await expect(page.getByText('Codever could not start.')).toHaveCount(0)
    await expect(page.locator('.composer textarea')).toBeEnabled()
  })

  test('C02 separates Matrix device trust from Gateway execution authorization', async ({ page }) => {
    await page.goto('./e2e.html#/machines')
    const secondComputer = page.locator('.machine-card').filter({ hasText: 'Windows Computer' })
    await expect(secondComputer).toContainText('Verify this computer')
    await secondComputer.click()

    await expect(page.getByRole('heading', { name: 'Verify this computer' })).toBeVisible()
    await page.getByRole('button', { name: 'Start secure verification' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByLabel('Verification emoji')).toBeVisible()
    const accessCallsBeforeClientConfirmation = await page.evaluate(() => window.__CODEVER_E2E__.projectAccessCalls())
    await page.getByRole('button', { name: 'They match' }).click()
    await expect(page.getByText('Waiting for confirmation on the computer')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Authorize this client' })).toHaveCount(0)
    expect(await page.evaluate(() => window.__CODEVER_E2E__.clientVerificationConfirmed())).toBe(true)
    expect(await page.evaluate(() => window.__CODEVER_E2E__.projectAccessCalls())).toBe(accessCallsBeforeClientConfirmation)

    await page.evaluate(() => window.__CODEVER_E2E__.confirmGatewayVerification())
    await expect(page.getByRole('heading', { name: 'Authorize this client' })).toBeVisible()
    await page.getByText('Technical details').click()
    await expect(page.getByText('SECONDGATEWAY')).toBeVisible()
    await page.getByRole('button', { name: 'Request authorization' }).click()
    await expect(page.getByRole('heading', { name: 'No projects on this computer' })).toBeVisible()
  })

  test('C02 keeps cached Computer data visibly refreshing while a Gateway command is delayed', async ({ page }) => {
    await page.goto('./e2e.html#/projects')
    await expect(page.getByRole('link', { name: 'Codever My computer' })).toBeVisible()
    await page.evaluate(() => window.__CODEVER_E2E__.setProjectAccessMode('pending'))

    await page.goto('./e2e.html#/machines')
    const computer = page.locator('.machine-card').filter({ hasText: 'My computer' })
    await expect(computer).toContainText('Loading projects')
    await expect(computer).not.toContainText('0 projects')

    await computer.click()
    await expect(page.getByRole('heading', { name: 'My computer' })).toBeVisible()
    await page.evaluate(() => window.__CODEVER_E2E__.releaseProjectAccess())
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible()
  })

  test('C02 keeps commands blocked when the Gateway cancels SAS', async ({ page }) => {
    await page.goto('./e2e.html#/machines')
    await page.locator('.machine-card').filter({ hasText: 'Windows Computer' }).click()
    await page.getByRole('button', { name: 'Start secure verification' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    const accessCalls = await page.evaluate(() => window.__CODEVER_E2E__.projectAccessCalls())
    await page.getByRole('button', { name: 'They match' }).click()
    await expect(page.getByText('Waiting for confirmation on the computer')).toBeVisible()
    await page.evaluate(() => window.__CODEVER_E2E__.cancelGatewayVerification('Gateway operator rejected the emoji'))
    await expect(page.getByRole('button', { name: 'Try verification again' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Authorize this client' })).toHaveCount(0)
    expect(await page.evaluate(() => window.__CODEVER_E2E__.projectAccessCalls())).toBe(accessCalls)

    await page.getByRole('button', { name: 'Try verification again' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'They match' }).click()
    await page.evaluate(() => window.__CODEVER_E2E__.confirmGatewayVerification())
    await expect(page.getByRole('heading', { name: 'Authorize this client' })).toBeVisible()
  })

  test('C02 times out bilateral verification without leaking a Gateway command', async ({ page }) => {
    await page.clock.install()
    await page.goto('./e2e.html#/machines')
    await page.locator('.machine-card').filter({ hasText: 'Windows Computer' }).click()
    await page.getByRole('button', { name: 'Start secure verification' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    const accessCalls = await page.evaluate(() => window.__CODEVER_E2E__.projectAccessCalls())
    await page.getByRole('button', { name: 'They match' }).click()
    await expect(page.getByText('Waiting for confirmation on the computer')).toBeVisible()

    await page.clock.fastForward(181_000)
    await expect(page.getByRole('alert')).toContainText('did not confirm verification within three minutes')
    await expect(page.getByRole('button', { name: 'Start secure verification' })).toBeVisible()
    expect(await page.evaluate(() => window.__CODEVER_E2E__.projectAccessCalls())).toBe(accessCalls)
  })

  test('C01 manages client approvals without mixing them with Computer verification', async ({ page }) => {
    await page.goto('./e2e.html#/settings')
    await expect(page.getByText('Computer setup now belongs in')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Verify' })).toHaveCount(0)
    const approval = page.locator('.authorization-card').filter({ hasText: 'New phone' })
    await expect(approval).toContainText('execution-new')
    await approval.getByRole('button', { name: 'Approve client' }).click()
    await expect(approval).toHaveCount(0)
  })

  test('C01 keeps the mobile Settings page independently scrollable', async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 600 })
    await page.goto('./e2e.html#/settings')

    const settings = page.locator('.settings-page')
    await expect(settings).toBeVisible()
    await expect.poll(() => settings.evaluate(element => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }))).toEqual(expect.objectContaining({ clientHeight: expect.any(Number), scrollHeight: expect.any(Number) }))

    const dimensions = await settings.evaluate(element => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }))
    expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight)
    await settings.evaluate(element => { element.scrollTop = element.scrollHeight })
    await expect.poll(() => settings.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
  })

  test('C17 exposes a failed Matrix restore and lets the user reconnect', async ({ page }) => {
    await page.goto('./e2e.html#/projects')
    await page.evaluate(() => window.__CODEVER_E2E__.setConnectionError('Temporary Matrix restore failure'))

    await expect(page.getByText('Temporary Matrix restore failure', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retry secure sync' })).toBeVisible()
    await page.goto('./e2e.html#/settings')
    await expect(page.getByRole('button', { name: 'Retry connection' })).toBeVisible()
    await expect(page.getByRole('alert')).toContainText('Temporary Matrix restore failure')
    await page.getByRole('button', { name: 'Retry connection' }).click()

    await expect(page.getByText('Encrypted sync connected')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retry connection' })).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('C17 renews an expired refresh token without signing out the device', async ({ page }) => {
    await page.goto('./e2e.html#/settings')
    await page.evaluate(() => window.__CODEVER_E2E__.setConnectionError("[403 / M_FORBIDDEN] refresh token isn't valid anymore"))

    await expect(page.getByRole('button', { name: 'Retry connection' })).toHaveCount(0)
    await expect(page.getByText(/renew this same device/)).toBeVisible()
    await page.getByLabel('Matrix password').fill('renew-secret')
    await page.getByRole('button', { name: 'Renew session' }).click()

    await expect(page.getByText('Encrypted sync connected')).toBeVisible()
    await expect(page.getByLabel('Matrix password')).toHaveCount(0)
  })

  test('C17 recovers an expired retained session in place and resumes Computer setup', async ({ page }) => {
    await page.goto('./e2e.html#/gateways/gateway-unpaired-e2e')
    await expect(page.getByRole('heading', { name: 'Verify this computer' })).toBeVisible()
    await page.evaluate(() => window.__CODEVER_E2E__.setConnectionError('Matrix session is no longer valid: UnknownToken'))

    const recovery = page.getByRole('dialog', { name: 'Reconnect Codever' })
    await expect(recovery).toBeVisible()
    await recovery.getByLabel('Matrix password').fill('renew-secret')
    await recovery.getByRole('button', { name: 'Renew session' }).click()

    await expect(page).toHaveURL(/#\/gateways\/gateway-unpaired-e2e$/)
    await expect(page.getByText('Connected')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Verify this computer' })).toBeVisible()
  })

  test('C17 explains a partial Android backup restore instead of retrying forever', async ({ page }) => {
    await page.goto('./e2e.html#/machines')
    await page.evaluate(() => window.__CODEVER_E2E__.setConnectionError('No entry found in secure storage for Matrix credential'))

    const recovery = page.getByRole('dialog', { name: 'Sign in again' })
    await expect(recovery).toBeVisible()
    await expect(recovery).toContainText('restored app data without the matching secure credential')
    await expect(recovery.getByRole('button', { name: 'Continue to sign in' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retry connection' })).toHaveCount(0)
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

  test('C03 discards a cancelled Project form instead of reviving stale input', async ({ page }) => {
    await page.goto('./e2e.html#/projects')
    await page.getByRole('button', { name: 'New project' }).click()
    await page.getByLabel('Project name').fill('Stale project')
    await page.getByLabel('Project folder').fill('D:\\stale')
    await page.getByRole('button', { name: 'Cancel' }).click()
    await page.getByRole('button', { name: 'New project' }).click()

    await expect(page.getByLabel('Project name')).toHaveValue('')
    await expect(page.getByLabel('Project folder')).toHaveValue('')
    await expect(page.getByLabel('Default provider (optional)')).toHaveValue('')
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

  test('C17 keeps cached work usable across Matrix sync restart and deduplicates backlog redelivery', async ({ page }) => {
    await page.locator('.composer textarea').fill('Finish while Matrix sync restarts')
    await page.getByRole('button', { name: 'Send message' }).click()
    await page.evaluate(() => window.__CODEVER_E2E__.startLongTurn())
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible()

    await page.evaluate(() => window.__CODEVER_E2E__.setConnection('disconnected'))
    await page.evaluate(() => window.__CODEVER_E2E__.finishTurnOffline('Completed during Matrix sync restart.'))
    await expect(page.getByText('Completed during Matrix sync restart.')).toHaveCount(0)
    await expect(page.locator('.message--user').filter({ hasText: 'Finish while Matrix sync restarts' })).toBeVisible()
    await expect(page.locator('.connection-banner')).toContainText('Server offline')

    await page.evaluate(() => window.__CODEVER_E2E__.setConnection('connected'))
    const recovered = page.locator('.message--assistant').filter({ hasText: 'Completed during Matrix sync restart.' })
    await expect(recovered).toHaveCount(1)
    await expect(recovered.locator('.agent-reply-state')).toContainText('success')
    await expect(page.getByText('idle', { exact: true })).toBeVisible()
  })

  test('C18 leaves an errored Session retryable and reconciles the successful retry', async ({ page }) => {
    const composer = page.locator('.composer textarea')
    await composer.fill('Trigger a Provider failure')
    await page.getByRole('button', { name: 'Send message' }).click()
    await page.evaluate(() => window.__CODEVER_E2E__.failTurn('Provider process exited unexpectedly'))

    await expect(page.locator('.session-header').getByText('error', { exact: true })).toBeVisible()
    await expect(page.locator('.agent-reply-state--error')).toContainText('error')
    await expect(composer).toBeEnabled()
    await composer.fill('Retry after Provider recovery')
    await page.getByRole('button', { name: 'Send message' }).click()
    await page.evaluate(() => window.__CODEVER_E2E__.completeTurn())

    await expect(page.locator('.message--assistant').filter({ hasText: 'First reply.' })).toBeVisible()
    await expect(page.getByText('idle', { exact: true })).toBeVisible()
    await expect(page.locator('.message--user').filter({ hasText: 'Retry after Provider recovery' })).toHaveCount(1)
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

test.describe('first-run complete business journey', () => {
  test('J01 goes from a fresh install to a durable first agent reply without bypassing trust', async ({ page }) => {
    await page.goto('./e2e.html?journey=onboarding#/')

    await expect(page.getByRole('heading', { name: 'Connect to Codever' })).toBeVisible()
    await page.getByLabel('Server domain').fill('matrix.example.test')
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByRole('heading', { name: 'Sign in to Codever' })).toBeVisible()
    await page.getByLabel('Username').fill('codever')
    await page.getByLabel('Password').fill('correct-password')
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Connect your first computer' })).toBeVisible()
    await page.getByRole('link', { name: 'Open Computers' }).click()
    const computer = page.locator('.machine-card').filter({ hasText: 'Windows Computer' })
    await expect(computer).toContainText('Verify this computer')
    expect(await page.evaluate(() => window.__CODEVER_E2E__.projectAccessCalls())).toBe(0)
    await computer.click()

    await page.getByRole('button', { name: 'Start secure verification' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByLabel('Verification emoji')).toContainText('🐶')
    await page.getByRole('button', { name: 'They match' }).click()
    await expect(page.getByText('Waiting for confirmation on the computer')).toBeVisible()
    expect(await page.evaluate(() => window.__CODEVER_E2E__.projectAccessCalls())).toBe(0)

    await page.evaluate(() => window.__CODEVER_E2E__.confirmGatewayVerification())
    await expect(page.getByRole('heading', { name: 'Authorize this client' })).toBeVisible()
    await page.getByRole('button', { name: 'Request authorization' }).click()
    await expect(page.getByRole('heading', { name: 'No projects on this computer' })).toBeVisible()

    await page.getByRole('link', { name: /Projects/ }).last().click()
    await expect(page.getByRole('heading', { name: 'No projects yet' })).toBeVisible()
    await page.getByRole('button', { name: 'Add project' }).click()
    await page.getByLabel('Project name').fill('First remote project')
    await page.getByLabel('Project folder').fill('D:\\workspace\\first-project')
    await page.getByLabel('Default provider (optional)').fill('codex')
    await page.getByRole('button', { name: 'Create project' }).click()

    await expect(page.getByRole('heading', { name: 'First remote project' })).toBeVisible()
    await page.getByRole('button', { name: /New task/ }).click()
    await page.getByPlaceholder(/describe the task/).fill('Create a hello file')
    await page.getByRole('button', { name: 'Create task' }).click()
    await expect(page.getByRole('heading', { name: 'Create a hello file' })).toBeVisible()

    const composer = page.locator('.composer textarea')
    await composer.fill('Create hello.txt with a greeting')
    await page.getByRole('button', { name: 'Send message' }).click()
    await expect(page.locator('.message--pending')).toContainText('Create hello.txt with a greeting')
    await page.evaluate(() => window.__CODEVER_E2E__.completeTurn())
    await expect(page.locator('.message--assistant').filter({ hasText: 'First reply.' })).toBeVisible()

    await page.getByRole('button', { name: 'Go back' }).click()
    await page.getByRole('button', { name: 'Open task Create a hello file' }).click()
    const cachedReply = page.locator('.message--assistant').filter({ hasText: 'First reply.' })
    await expect(cachedReply).toBeVisible()
    await expect(cachedReply.locator('.agent-reply-state')).toContainText('success')
  })
})
