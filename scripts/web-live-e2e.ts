import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright-core'
import { GatewayAdminClient } from '../src/gateway/admin/client.js'
import { createDisposableMatrixFixture } from './e2e/localMatrixFixture.js'

const ENABLE_ENV = 'CODEVER_WEB_LIVE_E2E'
const UI_FEEDBACK_TIMEOUT_MS = 1_500
const CONVERGENCE_TIMEOUT_MS = 15_000
const STARTUP_TIMEOUT_MS = 90_000
const PROVIDER_RESPONSE = 'Codever deterministic E2E response'

type ManagedProcess = {
    child: ChildProcess
    output: string
    waitFor(pattern: RegExp, timeoutMs?: number): Promise<RegExpMatchArray>
    stop(): Promise<void>
}

if (process.env[ENABLE_ENV] !== '1') {
    throw new Error(
        `Live Web E2E starts a disposable Synapse fixture and mutates Gateway state. Set ${ENABLE_ENV}=1 to run it.`,
    )
}

const repositoryRoot = process.cwd()
const runId = Date.now().toString(36).toUpperCase()
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'codever-web-e2e-'))
const artifactDirectory = join(repositoryRoot, 'artifacts', 'e2e', `web-${runId}`)
const gatewayDataDirectory = join(temporaryDirectory, 'gateway-data')
const gatewayAdminSocket = join(temporaryDirectory, 'gateway-admin.sock')
const fixturePath = join(temporaryDirectory, 'matrix-fixture.json')
const secondProjectDirectory = join(temporaryDirectory, 'second-project')
const pwaPort = await freePort()
const pwaUrl = `http://127.0.0.1:${pwaPort}`
const projectName = `Codever Web E2E ${runId}`
const secondProjectName = `Codever Web E2E second ${runId}`
const prompt = `business E2E prompt ${runId}`

let browser: Browser | undefined
let gatewayProcess: ManagedProcess | undefined
let pwaProcess: ManagedProcess | undefined
let firstPage: Page | undefined
let secondPage: Page | undefined
const browserLogs = new Map<string, string[]>()
const browserPageErrors = new WeakMap<Page, Error[]>()
let pwaBuildOutput = ''

try {
    process.stdout.write('[1/8] Starting official Synapse and creating an isolated encrypted room…\n')
    await mkdir(secondProjectDirectory, { recursive: true })
    const fixture = await createDisposableMatrixFixture(repositoryRoot)
    await writeFile(fixturePath, JSON.stringify({
        homeserver: fixture.homeserver,
        roomId: fixture.roomId,
        gatewayId: fixture.gatewayId,
        tester: { userId: fixture.tester.userId },
        gateway: { userId: fixture.gateway.userId },
    }, null, 2), 'utf8')

    process.stdout.write('[2/8] Building and starting the current PWA and Gateway…\n')
    pwaBuildOutput = await runProcess(
        join(repositoryRoot, 'apps', 'pwa', 'node_modules', '.bin', 'vinext'),
        ['build'],
        {
            cwd: join(repositoryRoot, 'apps', 'pwa'),
            env: process.env,
        },
        STARTUP_TIMEOUT_MS,
    )
    pwaProcess = managedProcess(
        join(repositoryRoot, 'apps', 'pwa', 'node_modules', '.bin', 'wrangler'),
        [
            'dev',
            '--config',
            'dist/server/wrangler.json',
            '--port',
            String(pwaPort),
            '--ip',
            '127.0.0.1',
        ],
        {
            cwd: join(repositoryRoot, 'apps', 'pwa'),
            env: process.env,
        },
    )
    await waitForHttp(`${pwaUrl}/api/version`, STARTUP_TIMEOUT_MS)

    gatewayProcess = managedProcess(
        join(repositoryRoot, 'node_modules', '.bin', 'tsx'),
        [join(repositoryRoot, 'scripts', 'matrix-local-gateway.ts')],
        {
            cwd: repositoryRoot,
            env: {
                ...process.env,
                CODEVER_MATRIX_FIXTURE: fixturePath,
                CODEVER_MATRIX_DATA_DIR: gatewayDataDirectory,
                CODEVER_MATRIX_GATEWAY_USER: fixture.gateway.username,
                CODEVER_MATRIX_GATEWAY_PASSWORD: fixture.gateway.password,
                CODEVER_GATEWAY_NAME: `Codever E2E Gateway ${runId}`,
                CODEVER_GATEWAY_ADMIN_SOCKET: gatewayAdminSocket,
                CODEVER_MATRIX_E2E_PROVIDER: '1',
                CODEVER_CWD: repositoryRoot,
            },
        },
    )
    const pairingMatch = await gatewayProcess.waitFor(
        /Pairing link \(paste fallback\):\s*\n([^\n]+)\n/u,
        STARTUP_TIMEOUT_MS,
    )
    const firstPairingLink = pairingMatch[1]?.trim()
    assert.ok(firstPairingLink, 'Gateway did not print a pairing link')

    process.stdout.write('[3/8] Pairing the first real browser device…\n')
    browser = await chromium.launch({
        headless: true,
        executablePath: chromeExecutable(),
    })
    const firstContext = await browser.newContext()
    firstPage = await firstContext.newPage()
    captureBrowserDiagnostics(firstPage, 'browser-1')
    await pairBrowser(
        firstPage,
        pwaUrl,
        firstPairingLink,
        fixture.tester.userId,
        fixture.tester.password,
    )
    await gatewayProcess.waitFor(/Gateway ready with 1 trusted device\(s\)\./u)

    process.stdout.write('[4/8] Creating a session through the first device…\n')
    const baselineFirst = await activeSessionCount(firstPage)
    await createSession(firstPage, projectName, repositoryRoot)
    assert.equal(await activeSessionCount(firstPage), baselineFirst + 1)

    process.stdout.write('[5/8] Pairing a second device and restoring existing state…\n')
    const admin = new GatewayAdminClient({
        socketPath: gatewayAdminSocket,
        timeoutMs: 10_000,
    })
    const invitation = await admin.createInvitation({
        matrixLogin: 'disabled',
        appUrl: pwaUrl,
    })
    const secondContext = await browser.newContext()
    secondPage = await secondContext.newPage()
    captureBrowserDiagnostics(secondPage, 'browser-2')
    await pairBrowser(
        secondPage,
        pwaUrl,
        invitation.pairingLink,
        fixture.tester.userId,
        fixture.tester.password,
    )
    await waitFor(async () => (await admin.devices()).length === 2, {
        description: 'two active Gateway devices',
        timeoutMs: STARTUP_TIMEOUT_MS,
    })
    await waitForProject(secondPage, projectName)
    const baselineSecond = await activeSessionCount(secondPage)
    assert.equal(
        baselineSecond,
        baselineFirst + 1,
        'The newly paired browser did not restore the existing session inventory',
    )
    await createSession(secondPage, secondProjectName, secondProjectDirectory)
    await waitForProject(firstPage, secondProjectName)
    assert.equal(await activeSessionCount(firstPage), baselineFirst + 2)
    assert.equal(await activeSessionCount(secondPage), baselineSecond + 1)
    await openProjectSession(secondPage, projectName)

    process.stdout.write('[6/8] Sending a prompt and restoring its Matrix-native history…\n')
    await sendPrompt(firstPage, prompt)
    await waitForText(firstPage, prompt)
    await waitForText(firstPage, PROVIDER_RESPONSE)
    await waitForText(secondPage, prompt)
    await waitForText(secondPage, PROVIDER_RESPONSE)
    await reloadAndWaitForConnected(secondPage)
    await waitForProject(secondPage, projectName)
    await openProjectSession(secondPage, projectName)
    await waitForText(secondPage, prompt)
    await waitForText(secondPage, PROVIDER_RESPONSE)

    process.stdout.write('[7/8] Deleting with immediate feedback and durable multi-device absence…\n')
    await Promise.all([
        delayMatrixRoomSends(firstPage, 2_500),
        delayMatrixRoomSends(secondPage, 2_500),
    ])
    await deleteSelectedSession(firstPage, projectName)
    await waitForProjectAbsent(secondPage, projectName)
    await openProjectSession(secondPage, secondProjectName)
    await deleteSelectedSession(secondPage, secondProjectName)
    await waitForProjectAbsent(firstPage, secondProjectName)
    assert.equal(await activeSessionCount(firstPage), baselineFirst)
    assert.equal(await activeSessionCount(secondPage), baselineSecond - 1)

    await Promise.all([
        reloadAndWaitForConnected(firstPage),
        reloadAndWaitForConnected(secondPage),
    ])
    await Promise.all([
        waitForProjectAbsent(firstPage, projectName),
        waitForProjectAbsent(secondPage, projectName),
        waitForProjectAbsent(firstPage, secondProjectName),
        waitForProjectAbsent(secondPage, secondProjectName),
    ])
    assert.equal(await projectSessionExists(firstPage, projectName), false)
    assert.equal(await projectSessionExists(secondPage, projectName), false)
    assert.equal(await projectSessionExists(firstPage, secondProjectName), false)
    assert.equal(await projectSessionExists(secondPage, secondProjectName), false)

    process.stdout.write('[8/8] PASS — real browser, Synapse, Gateway, E2EE, history, and deletion converged.\n')
} catch (error) {
    await mkdir(artifactDirectory, { recursive: true })
    await Promise.all([
        capturePage(firstPage, join(artifactDirectory, 'browser-1.png')),
        capturePage(secondPage, join(artifactDirectory, 'browser-2.png')),
    ])
    await writeFile(
        join(artifactDirectory, 'gateway.log'),
        redactSecrets(gatewayProcess?.output ?? ''),
        'utf8',
    )
    await writeFile(
        join(artifactDirectory, 'pwa.log'),
        `${pwaBuildOutput}\n${pwaProcess?.output ?? ''}`,
        'utf8',
    )
    await Promise.all([...browserLogs].map(([name, lines]) =>
        writeFile(
            join(artifactDirectory, `${name}.log`),
            redactSecrets(lines.join('\n')),
            'utf8',
        ),
    ))
    process.stderr.write(`Business E2E artifacts: ${artifactDirectory}\n`)
    throw error
} finally {
    await browser?.close().catch(() => undefined)
    await gatewayProcess?.stop().catch(error => {
        process.stderr.write(`Could not stop E2E Gateway: ${formatError(error)}\n`)
    })
    await pwaProcess?.stop().catch(error => {
        process.stderr.write(`Could not stop E2E PWA: ${formatError(error)}\n`)
    })
    await rm(temporaryDirectory, { recursive: true, force: true })
}

// Matrix SDK and Wrangler dependencies may retain unreferenced helper handles
// after their processes and stores are closed. This executable has completed
// all cleanup at this point, so do not let those implementation handles stall
// an otherwise successful CI job.
process.exit(0)

async function pairBrowser(
    page: Page,
    pwaUrl: string,
    pairingLink: string,
    userId: string,
    password: string,
): Promise<void> {
    await page.goto(`${pwaUrl}/#pair=${encodeURIComponent(pairingLink)}`)
    const dialog = page.getByRole('dialog', { name: 'Connect a computer' })
    await dialog.waitFor({ state: 'visible', timeout: STARTUP_TIMEOUT_MS })
    await dialog.getByText('Computer found').waitFor({ state: 'visible' })
    await dialog.getByPlaceholder('@you:example.org').fill(userId)
    await dialog.getByPlaceholder('Your account password').fill(password)
    await dialog.getByRole('button', { name: 'Sign in', exact: true }).click()
    const connect = dialog.getByRole('button', { name: /^Connect to /u })
    await waitFor(async () => await connect.isEnabled(), {
        description: 'enabled secure pairing confirmation',
        timeoutMs: STARTUP_TIMEOUT_MS,
    })
    await connect.click()
    await waitForConnected(page)
    const close = page.getByRole('button', { name: 'Close connection settings' })
    if (await close.isVisible().catch(() => false)) await close.click()
}

function captureBrowserDiagnostics(page: Page, name: string): void {
    const lines: string[] = []
    browserLogs.set(name, lines)
    browserPageErrors.set(page, [])
    page.on('console', message => {
        lines.push(`[console.${message.type()}] ${message.text()}`)
    })
    page.on('pageerror', error => {
        lines.push(`[pageerror] ${error.stack ?? error.message}`)
        browserPageErrors.get(page)?.push(error)
    })
    page.on('requestfailed', request => {
        lines.push(
            `[requestfailed] ${request.method()} ${request.url()} `
            + `${request.failure()?.errorText ?? 'unknown failure'}`,
        )
    })
    page.on('response', response => {
        if (!response.url().includes('/_matrix/client/v3/sync')) return
        void response.json().then((body: unknown) => {
            const record = asRecord(body)
            const joined = asRecord(asRecord(record?.rooms)?.join)
            for (const [roomId, roomValue] of Object.entries(joined ?? {})) {
                const timeline = asRecord(asRecord(roomValue)?.timeline)
                const events = Array.isArray(timeline?.events) ? timeline.events : []
                const metadata = events.flatMap(event => {
                    const value = asRecord(event)
                    if (!value) return []
                    return [{
                        eventId: value.event_id,
                        sender: value.sender,
                        type: value.type,
                    }]
                })
                if (metadata.length > 0) {
                    lines.push(`[matrix-sync] ${roomId} ${JSON.stringify(metadata)}`)
                }
            }
        }).catch(error => {
            lines.push(`[matrix-sync-error] ${formatError(error)}`)
        })
    })
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

async function createSession(page: Page, projectName: string, cwd: string): Promise<void> {
    const baseline = await activeSessionCount(page)
    await page.getByRole('button', { name: 'New conversation' }).click()
    const dialog = page.locator('.new-session-dialog')
    await dialog.waitFor({ state: 'visible' })
    await dialog.locator('select').first().selectOption('__new_project__')
    await dialog.getByPlaceholder('My project').fill(projectName)
    await dialog.getByPlaceholder('/Users/me/Documents/project').fill(cwd)
    const startedAt = Date.now()
    await dialog.getByRole('button', { name: 'Create session', exact: true }).click()
    await page.locator('.session-create-pending').waitFor({
        state: 'visible',
        timeout: UI_FEEDBACK_TIMEOUT_MS,
    })
    await waitForProject(page, projectName)
    assert.equal(await activeSessionCount(page), baseline + 1)
    assert.ok(
        Date.now() - startedAt <= CONVERGENCE_TIMEOUT_MS,
        `Session creation exceeded ${CONVERGENCE_TIMEOUT_MS} ms`,
    )
}

async function sendPrompt(page: Page, prompt: string): Promise<void> {
    const composer = page.locator('textarea[aria-label^="Message "]')
    await composer.fill(prompt)
    await page.getByRole('button', { name: 'Send message' }).click()
}

async function delayMatrixRoomSends(page: Page, milliseconds: number): Promise<void> {
    await page.route('**/_matrix/client/v3/rooms/**/send/**', async route => {
        await delay(milliseconds)
        await route.continue()
    })
}

async function deleteSelectedSession(page: Page, projectName: string): Promise<void> {
    const details = page.getByRole('button', { name: 'Conversation details' })
    if (await details.getAttribute('aria-expanded') !== 'true') await details.click()
    await page.getByRole('button').filter({
        has: page.locator('strong', { hasText: /^Delete session$/u }),
    }).click()
    const dialog = page.getByRole('alertdialog')
    await dialog.waitFor({ state: 'visible' })
    const startedAt = Date.now()
    await dialog.getByRole('button', { name: 'Delete session', exact: true }).click()
    await waitFor(async () => {
        const feedback = await projectSessionFeedback(page, projectName)
        return !await dialog.isVisible().catch(() => false)
            && await page.locator('button.session-row.selected').count() === 0
            && (feedback.deleting || !feedback.exists)
    }, {
        description: `immediate deletion feedback for ${projectName}`,
        timeoutMs: UI_FEEDBACK_TIMEOUT_MS,
    })
    await waitForProjectAbsent(page, projectName)
    assert.ok(
        Date.now() - startedAt <= CONVERGENCE_TIMEOUT_MS,
        `Session deletion exceeded ${CONVERGENCE_TIMEOUT_MS} ms`,
    )
}

async function waitForConnected(page: Page): Promise<void> {
    await waitFor(async () => {
        const label = await page.locator('button[aria-label^="Open connection settings,"]').getAttribute('aria-label')
        return label?.endsWith('Connected') ?? false
    }, {
        description: 'fresh Gateway connection',
        timeoutMs: STARTUP_TIMEOUT_MS,
        failFast: () => assertNoPageErrors(page),
    })
    await assertNoBlockingAlert(page)
}

async function reloadAndWaitForConnected(page: Page): Promise<void> {
    await page.reload()
    await waitForConnected(page)
}

async function waitForProject(page: Page, projectName: string): Promise<void> {
    await waitFor(
        () => projectSessionExists(page, projectName),
        {
            description: `project ${projectName}`,
            timeoutMs: CONVERGENCE_TIMEOUT_MS,
            failFast: () => assertNoPageErrors(page),
        },
    )
    await assertNoBlockingAlert(page)
}

async function waitForProjectAbsent(page: Page, projectName: string): Promise<void> {
    await waitFor(
        async () => !await projectSessionExists(page, projectName),
        {
            description: `absence of ${projectName}`,
            timeoutMs: CONVERGENCE_TIMEOUT_MS,
            failFast: () => assertNoPageErrors(page),
        },
    )
    await assertNoBlockingAlert(page)
}

async function projectSessionExists(page: Page, projectName: string): Promise<boolean> {
    return (await projectSessionFeedback(page, projectName)).exists
}

async function projectSessionFeedback(
    page: Page,
    projectName: string,
): Promise<{ exists: boolean; deleting: boolean }> {
    return page.locator('button.session-row').evaluateAll((rows, expectedProject) => {
        const matching = rows.filter(row =>
            (row as HTMLElement).dataset.projectName === expectedProject,
        )
        return {
            exists: matching.length > 0,
            deleting: matching.some(row => row.classList.contains('is-busy')),
        }
    }, projectName)
}

async function openProjectSession(page: Page, projectName: string): Promise<void> {
    const group = page.locator('.project-session-group').filter({
        has: page.locator('.project-copy strong', { hasText: new RegExp(`^${escapeRegex(projectName)}$`, 'u') }),
    })
    const toggle = group.locator('button.project-session-toggle')
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
    const row = group.locator('button.session-row').first()
    await row.click()
    await waitFor(async () => (await row.getAttribute('class'))?.includes('selected') ?? false, {
        description: `selected session in ${projectName}`,
        timeoutMs: UI_FEEDBACK_TIMEOUT_MS,
        failFast: () => assertNoPageErrors(page),
    })
    await page.locator('.conversation-heading span', { hasText: projectName }).waitFor({
        state: 'visible',
        timeout: UI_FEEDBACK_TIMEOUT_MS,
    })
}

async function waitForText(page: Page, text: string): Promise<void> {
    await waitFor(async () => {
        return await page.locator('.chat-feed').getByText(text, { exact: true }).last().isVisible()
    }, {
        description: `visible text ${JSON.stringify(text)}`,
        timeoutMs: CONVERGENCE_TIMEOUT_MS,
        failFast: () => assertNoPageErrors(page),
    })
    await assertNoBlockingAlert(page)
}

async function activeSessionCount(page: Page): Promise<number> {
    return page.locator('button.session-row').count()
}

async function assertNoBlockingAlert(page: Page): Promise<void> {
    assertNoPageErrors(page)
    const alerts = await page.locator('[role="alert"]').allTextContents()
    const blocking = alerts.filter(alert =>
        /history could not be restored|native bridge did not answer|matrix runtime failed|needs review|must be acknowledged|previous action|connected device did not respond|too many requests/iu.test(alert),
    )
    assert.deepEqual(blocking, [], `Blocking Codever alert appeared: ${blocking.join(' | ')}`)
}

function assertNoPageErrors(page: Page): void {
    const errors = browserPageErrors.get(page) ?? []
    assert.equal(
        errors.length,
        0,
        `Browser runtime error: ${errors.map(error => error.stack ?? error.message).join('\n')}`,
    )
}

async function runProcess(
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
    timeoutMs: number,
): Promise<string> {
    const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
    })
    let output = ''
    child.stdout?.on('data', chunk => { output += String(chunk) })
    child.stderr?.on('data', chunk => { output += String(chunk) })
    const result = await Promise.race([
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
            child.once('exit', (code, signal) => resolve({ code, signal }))
        }),
        delay(timeoutMs).then(() => null),
    ])
    if (!result) {
        signalProcessTree(child, 'SIGKILL')
        throw new Error(`Process timed out: ${command} ${args.join(' ')}\n${output.slice(-8_000)}`)
    }
    if (result.code !== 0) {
        throw new Error(
            `Process failed: ${command} ${args.join(' ')} code=${result.code} signal=${result.signal}\n`
            + output.slice(-8_000),
        )
    }
    return output
}

function managedProcess(
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
): ManagedProcess {
    const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
    })
    let output = ''
    child.stdout?.on('data', chunk => { output += String(chunk) })
    child.stderr?.on('data', chunk => { output += String(chunk) })
    const result: ManagedProcess = {
        child,
        get output() { return output },
        waitFor(pattern, timeoutMs = STARTUP_TIMEOUT_MS) {
            return waitForOutput(child, () => output, pattern, timeoutMs)
        },
        async stop() {
            if (child.exitCode !== null || child.signalCode !== null) return
            const exitPromise = new Promise<boolean>(resolve =>
                child.once('exit', () => resolve(true)),
            )
            signalProcessTree(child, 'SIGTERM')
            const exited = await Promise.race([
                exitPromise,
                delay(10_000).then(() => false),
            ])
            if (!exited) {
                signalProcessTree(child, 'SIGKILL')
                await Promise.race([
                    exitPromise,
                    delay(2_000).then(() => false),
                ])
            }
            child.stdout?.destroy()
            child.stderr?.destroy()
        },
    }
    return result
}

function signalProcessTree(
    child: ChildProcess,
    signal: NodeJS.Signals,
): void {
    if (process.platform !== 'win32' && child.pid) {
        try {
            process.kill(-child.pid, signal)
            return
        } catch {
            // The process group may already be gone while the wrapper remains.
        }
    }
    child.kill(signal)
}

async function waitForOutput(
    child: ChildProcess,
    output: () => string,
    pattern: RegExp,
    timeoutMs: number,
): Promise<RegExpMatchArray> {
    return new Promise((resolve, reject) => {
        const deadline = setTimeout(() => {
            cleanup()
            reject(new Error(`Timed out waiting for process output ${pattern}. Last output:\n${output().slice(-4_000)}`))
        }, timeoutMs)
        const inspect = () => {
            const match = output().match(pattern)
            if (!match) return
            cleanup()
            resolve(match)
        }
        const exited = (code: number | null, signal: NodeJS.Signals | null) => {
            cleanup()
            reject(new Error(
                `Process exited before ${pattern}: code=${code} signal=${signal}\n${output().slice(-4_000)}`,
            ))
        }
        const cleanup = () => {
            clearTimeout(deadline)
            child.stdout?.off('data', inspect)
            child.stderr?.off('data', inspect)
            child.off('exit', exited)
        }
        child.stdout?.on('data', inspect)
        child.stderr?.on('data', inspect)
        child.once('exit', exited)
        inspect()
    })
}

async function waitFor(
    predicate: () => boolean | Promise<boolean>,
    options: {
        description: string
        timeoutMs: number
        failFast?: () => void
    },
): Promise<void> {
    const deadline = Date.now() + options.timeoutMs
    let lastError: unknown
    while (Date.now() < deadline) {
        options.failFast?.()
        try {
            if (await predicate()) return
        } catch (error) {
            lastError = error
        }
        await delay(100)
    }
    throw new Error(
        `Timed out waiting for ${options.description}`
        + (lastError ? `: ${formatError(lastError)}` : ''),
    )
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
    await waitFor(async () => {
        const response = await fetch(url).catch(() => null)
        return response?.ok ?? false
    }, { description: url, timeoutMs })
}

async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer()
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            const port = typeof address === 'object' && address ? address.port : 0
            server.close(error => error ? reject(error) : resolve(port))
        })
    })
}

function chromeExecutable(): string {
    if (process.env.CODEVER_CHROME_EXECUTABLE) return process.env.CODEVER_CHROME_EXECUTABLE
    if (process.platform === 'darwin') {
        return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    }
    return process.platform === 'win32'
        ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
        : '/usr/bin/google-chrome'
}

async function capturePage(page: Page | undefined, path: string): Promise<void> {
    if (!page || page.isClosed()) return
    await page.screenshot({ path, fullPage: true }).catch(() => undefined)
}

function redactSecrets(value: string): string {
    return value.replace(/codever:\/\/[^\s]+/gu, '[REDACTED_PAIRING_LINK]')
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds))
}
