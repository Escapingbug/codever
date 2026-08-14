import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import {
    createServer as createHttpServer,
    request as requestHttp,
    type Server as HttpServer,
} from 'node:http'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright-core'
import {
    createDisposableMatrixFixture,
    type DisposableMatrixFixture,
} from './e2e/localMatrixFixture.js'

const ENABLE_ENV = 'CODEVER_SYNC_STALL_E2E'
const SHARED_ENABLE_ENVS = ['CODEVER_WEB_LIVE_E2E', 'CODEVER_ALPHA_LIVE_E2E'] as const
const STARTUP_TIMEOUT_MS = 90_000
const UI_TIMEOUT_MS = 2_000
const COMMAND_ACK_TIMEOUT_MS = 45_000
const SYNC_STALL_TIMEOUT_MS = 120_000
const WATCHDOG_TIMEOUT_MS = SYNC_STALL_TIMEOUT_MS + 45_000
const POST_RESTART_CONVERGENCE_TIMEOUT_MS = 30_000
const QUEUED_WARNING =
    'Your computer did not confirm this command. It remains queued for a safe retry.'

if (
    process.env[ENABLE_ENV] !== '1'
    && !SHARED_ENABLE_ENVS.some(name => process.env[name] === '1')
) {
    throw new Error(
        'This E2E starts a disposable Synapse fixture and intentionally stalls Gateway /sync. '
        + `Set ${ENABLE_ENV}=1, CODEVER_WEB_LIVE_E2E=1, or CODEVER_ALPHA_LIVE_E2E=1 to run it.`,
    )
}

type ManagedProcess = {
    child: ChildProcess
    output: string
    waitFor(pattern: RegExp, timeoutMs?: number): Promise<RegExpMatchArray>
    stop(): Promise<void>
}

type GatewaySyncGate = {
    homeserver: string
    hold(accessToken: string): number
    waitForInterception(after: number): Promise<void>
    release(): void
    close(): Promise<void>
}

const repositoryRoot = process.cwd()
const runId = Date.now().toString(36).toUpperCase()
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'codever-sync-stall-e2e-'))
const artifactDirectory = join(repositoryRoot, 'artifacts', 'e2e', `sync-stall-${runId}`)
const gatewayDataDirectory = join(temporaryDirectory, 'gateway-data')
const gatewayAdminSocket = join(temporaryDirectory, 'gateway-admin.sock')
const fixturePath = join(temporaryDirectory, 'matrix-fixture.json')
const workProjectName = `Sync stall active work ${runId}`
const deleteProjectName = `Sync stall delete target ${runId}`
const activePrompt = `keep this Agent active while Matrix sync is stalled ${runId}`
const pwaPort = await freePort()
let matrixPort = await freePort()
while (matrixPort === pwaPort) matrixPort = await freePort()
const pwaUrl = `http://127.0.0.1:${pwaPort}`

let browser: Browser | undefined
let page: Page | undefined
let pwaProcess: ManagedProcess | undefined
let gatewayProcess: ManagedProcess | undefined
let matrixFixture: DisposableMatrixFixture | undefined
let syncGate: GatewaySyncGate | undefined
let pwaBuildOutput = ''
const browserLog: string[] = []

try {
    process.stdout.write('[1/6] Starting disposable Synapse and the selective Gateway sync gate…\n')
    matrixFixture = await createDisposableMatrixFixture({
        runtimeDirectory: join(temporaryDirectory, 'matrix'),
        hostPort: matrixPort,
    })
    syncGate = await createGatewaySyncGate(matrixPort)
    await writeFile(fixturePath, JSON.stringify({
        homeserver: syncGate.homeserver,
        roomId: matrixFixture.roomId,
        gatewayId: matrixFixture.gatewayId,
        tester: { userId: matrixFixture.tester.userId },
        gateway: { userId: matrixFixture.gateway.userId },
    }, null, 2), 'utf8')

    process.stdout.write('[2/6] Building the real PWA and starting the deterministic Gateway…\n')
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
        { cwd: join(repositoryRoot, 'apps', 'pwa'), env: process.env },
    )
    await waitForHttp(`${pwaUrl}/api/version`, STARTUP_TIMEOUT_MS)
    gatewayProcess = startGateway({
        fixture: matrixFixture,
        providerDelayMs: 300_000,
    })
    const pairingMatch = await gatewayProcess.waitFor(
        /Pairing link \(paste fallback\):\s*\n([^\n]+)\n/u,
        STARTUP_TIMEOUT_MS,
    )
    const pairingLink = pairingMatch[1]?.trim()
    assert.ok(pairingLink, 'Gateway did not print a pairing link')

    process.stdout.write('[3/6] Pairing a real browser and creating active/target sessions…\n')
    browser = await chromium.launch({
        headless: true,
        executablePath: chromeExecutable(),
    })
    page = await browser.newPage()
    captureBrowserDiagnostics(page, browserLog)
    await pairBrowser(
        page,
        pwaUrl,
        pairingLink,
        matrixFixture.tester.userId,
        matrixFixture.tester.password,
    )
    await gatewayProcess.waitFor(/Gateway ready with 1 trusted device\(s\)\./u)
    await createSession(page, workProjectName, repositoryRoot)
    await createSession(page, deleteProjectName, repositoryRoot)
    await openProjectSession(page, workProjectName)
    await sendPrompt(page, activePrompt)
    await waitForProjectWorking(page, workProjectName)

    process.stdout.write('[4/6] Holding only Gateway /sync, then deleting from the still-online browser…\n')
    const gatewayAccessToken = await readGatewayAccessToken(gatewayDataDirectory)
    const interceptionBaseline = syncGate.hold(gatewayAccessToken)
    await syncGate.waitForInterception(interceptionBaseline)
    await openProjectSession(page, deleteProjectName)
    const deleteStartedAt = Date.now()
    await beginDeleteSelectedSession(page, deleteProjectName)
    await page.getByText(QUEUED_WARNING, { exact: true }).first().waitFor({
        state: 'visible',
        timeout: COMMAND_ACK_TIMEOUT_MS,
    })
    process.stdout.write(
        `[REPRODUCED] Browser showed the durable-queue warning after ${Date.now() - deleteStartedAt}ms.\n`,
    )

    process.stdout.write('[5/6] Waiting for the watchdog to restart only Matrix sync…\n')
    await gatewayProcess.waitFor(
        /Matrix sync made no progress for \d+ms; restarting Matrix sync in place\./u,
        WATCHDOG_TIMEOUT_MS,
    )
    syncGate.release()
    await gatewayProcess.waitFor(/Matrix sync restarted in place\./u, 20_000)
    assert.equal(
        gatewayProcess.child.exitCode,
        null,
        'The Gateway process exited instead of preserving the active Agent runtime',
    )

    process.stdout.write('[6/6] Requiring the queued delete to execute exactly once after sync recovery…\n')
    try {
        await waitFor(
            async () => !await projectSessionExists(page!, deleteProjectName),
            {
                description: `recovered deletion of ${deleteProjectName}`,
                timeoutMs: POST_RESTART_CONVERGENCE_TIMEOUT_MS,
            },
        )
    } catch (error) {
        const terminal = await latestDeleteTerminal(gatewayDataDirectory)
        throw new Error(
            'SYNC-STALL DELETE REGRESSION REPRODUCED: the browser command stayed queued '
            + 'through the Gateway watchdog restart and the target session still exists. '
            + `Gateway terminal=${JSON.stringify(terminal)}. ${formatError(error)}`,
        )
    }
    assert.equal(
        await page.getByText(QUEUED_WARNING, { exact: true }).count(),
        0,
        'The recovered delete completed but its queued warning remained visible',
    )
    assert.equal(
        await acceptedCommandCount(gatewayDataDirectory, 'session.delete'),
        1,
        'The durable delete was accepted more than once',
    )
    process.stdout.write('PASS — a delete submitted during a long Gateway sync stall recovered exactly once.\n')
} catch (error) {
    await mkdir(artifactDirectory, { recursive: true })
    await Promise.all([
        page?.screenshot({ path: join(artifactDirectory, 'browser.png'), fullPage: true })
            .catch(() => undefined),
        writeFile(
            join(artifactDirectory, 'gateway.log'),
            redactSecrets(gatewayProcess?.output ?? ''),
            'utf8',
        ),
        writeFile(
            join(artifactDirectory, 'browser.log'),
            redactSecrets(browserLog.join('\n')),
            'utf8',
        ),
        writeFile(
            join(artifactDirectory, 'pwa.log'),
            redactSecrets(`${pwaBuildOutput}\n${pwaProcess?.output ?? ''}`),
            'utf8',
        ),
    ])
    process.stderr.write(`Sync-stall E2E artifacts: ${artifactDirectory}\n`)
    throw error
} finally {
    syncGate?.release()
    await browser?.close().catch(() => undefined)
    await gatewayProcess?.stop().catch(() => undefined)
    await pwaProcess?.stop().catch(() => undefined)
    await syncGate?.close().catch(() => undefined)
    await matrixFixture?.close().catch(() => undefined)
    await rm(temporaryDirectory, { recursive: true, force: true })
}

process.exit(0)

function startGateway(input: {
    fixture: DisposableMatrixFixture
    providerDelayMs: number
}): ManagedProcess {
    return managedProcess(
        join(repositoryRoot, 'node_modules', '.bin', 'tsx'),
        [join(repositoryRoot, 'scripts', 'matrix-local-gateway.ts')],
        {
            cwd: repositoryRoot,
            env: {
                ...process.env,
                CODEVER_MATRIX_FIXTURE: fixturePath,
                CODEVER_MATRIX_DATA_DIR: gatewayDataDirectory,
                CODEVER_MATRIX_GATEWAY_USER: input.fixture.gateway.username,
                CODEVER_MATRIX_GATEWAY_PASSWORD: input.fixture.gateway.password,
                CODEVER_GATEWAY_NAME: `Codever sync-stall E2E ${runId}`,
                CODEVER_GATEWAY_ADMIN_SOCKET: gatewayAdminSocket,
                CODEVER_MATRIX_E2E_PROVIDER: '1',
                CODEVER_MATRIX_E2E_PROVIDER_DELAY_MS: String(input.providerDelayMs),
                CODEVER_MATRIX_SYNC_STALL_TIMEOUT_MS: String(SYNC_STALL_TIMEOUT_MS),
                CODEVER_CWD: repositoryRoot,
            },
        },
    )
}

async function createGatewaySyncGate(targetPort: number): Promise<GatewaySyncGate> {
    let intercepted = 0
    let gatewayAccessToken: string | null = null
    let cycle = releasedCycle()
    const server = createHttpServer((incoming, outgoing) => {
        const requestPath = incoming.url ?? '/'
        const authorization = incoming.headers.authorization
        const upstream = requestHttp({
            hostname: '127.0.0.1',
            port: targetPort,
            method: incoming.method,
            path: requestPath,
            headers: {
                ...incoming.headers,
                host: `127.0.0.1:${targetPort}`,
            },
        }, response => {
            void (async () => {
                const blockedCycle = cycle
                if (
                    blockedCycle.held
                    && isMatrixSyncRequest(requestPath)
                    && authorization === `Bearer ${gatewayAccessToken}`
                ) {
                    response.pause()
                    intercepted += 1
                    await blockedCycle.wait
                }
                if (outgoing.destroyed) {
                    response.destroy()
                    return
                }
                outgoing.writeHead(
                    response.statusCode ?? 502,
                    response.statusMessage,
                    response.headers,
                )
                response.pipe(outgoing)
                response.resume()
            })().catch(error => {
                response.destroy()
                if (!outgoing.headersSent) {
                    outgoing.writeHead(502, { 'content-type': 'text/plain' })
                }
                outgoing.end(`Matrix sync gate failed: ${formatError(error)}`)
            })
        })
        upstream.on('error', error => {
            if (!outgoing.headersSent) {
                outgoing.writeHead(502, { 'content-type': 'text/plain' })
            }
            outgoing.end(`Matrix sync gate failed: ${formatError(error)}`)
        })
        incoming.pipe(upstream)
    })
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject)
            resolve()
        })
    })
    const address = server.address() as AddressInfo
    return {
        homeserver: `http://127.0.0.1:${address.port}`,
        hold(accessToken: string) {
            gatewayAccessToken = accessToken
            cycle = heldCycle()
            return intercepted
        },
        waitForInterception: after => waitFor(
            () => intercepted > after,
            {
                description: 'a Gateway /sync response to reach the selective hold',
                timeoutMs: 45_000,
            },
        ),
        release() {
            if (!cycle.held) return
            cycle.held = false
            cycle.release()
        },
        close: () => closeHttpServer(server),
    }
}

function heldCycle(): { held: boolean; wait: Promise<void>; release(): void } {
    let release = () => undefined
    const wait = new Promise<void>(resolve => { release = resolve })
    return { held: true, wait, release }
}

function releasedCycle(): { held: boolean; wait: Promise<void>; release(): void } {
    return { held: false, wait: Promise.resolve(), release: () => undefined }
}

function isMatrixSyncRequest(path: string): boolean {
    return /^\/_matrix\/client\/(?:v3|unstable\/[^/]+)\/sync(?:\?|$)/u.test(path)
}

async function closeHttpServer(server: HttpServer): Promise<void> {
    server.closeIdleConnections()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
    })
}

async function readGatewayAccessToken(dataDirectory: string): Promise<string> {
    const session = JSON.parse(await readFile(
        join(dataDirectory, 'matrix-session.json'),
        'utf8',
    )) as { access_token?: unknown }
    assert.equal(typeof session.access_token, 'string', 'Gateway Matrix login has no access token')
    return session.access_token
}

async function latestDeleteTerminal(dataDirectory: string): Promise<unknown> {
    const content = await readFile(join(dataDirectory, 'gateway-replay.jsonl'), 'utf8')
    const entries = content.split(/\r?\n/u)
        .filter(Boolean)
        .map(line => JSON.parse(line) as {
            revision?: { commandOperation?: string }
            terminal?: { terminal?: { outcome?: string; error?: string } }
        })
    const entry = entries.reverse().find(candidate =>
        candidate.revision?.commandOperation === 'session.delete',
    )
    return entry
        ? {
            operation: entry.revision?.commandOperation,
            outcome: entry.terminal?.terminal?.outcome,
            error: entry.terminal?.terminal?.error,
        }
        : null
}

async function acceptedCommandCount(
    dataDirectory: string,
    operation: string,
): Promise<number> {
    const content = await readFile(join(dataDirectory, 'gateway-replay.jsonl'), 'utf8')
    return content.split(/\r?\n/u)
        .filter(Boolean)
        .map(line => JSON.parse(line) as {
            revision?: { commandOperation?: string }
        })
        .filter(entry => entry.revision?.commandOperation === operation)
        .length
}

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
    await waitFor(async () => {
        const label = await page
            .locator('button[aria-label^="Open connection settings,"]')
            .getAttribute('aria-label')
        return label?.endsWith('Connected') === true
            || await connect.isEnabled({ timeout: 500 }).catch(() => false)
    }, { description: 'signed-in pairing confirmation', timeoutMs: STARTUP_TIMEOUT_MS })
    const label = await page
        .locator('button[aria-label^="Open connection settings,"]')
        .getAttribute('aria-label')
    if (!label?.endsWith('Connected')) await connect.click()
    await waitForConnected(page)
    const close = page.getByRole('button', { name: 'Close connection settings' })
    if (await close.isVisible().catch(() => false)) await close.click()
}

async function createSession(page: Page, projectName: string, cwd: string): Promise<void> {
    await page.getByRole('button', { name: 'New conversation' }).click()
    const dialog = page.locator('.new-session-dialog')
    await dialog.waitFor({ state: 'visible' })
    await dialog.locator('select').first().selectOption('__new_project__')
    await dialog.getByPlaceholder('My project').fill(projectName)
    await dialog.getByPlaceholder('/Users/me/Documents/project').fill(cwd)
    await dialog.getByRole('button', { name: 'Create session', exact: true }).click()
    await waitFor(
        () => projectSessionExists(page, projectName),
        { description: `project ${projectName}`, timeoutMs: 20_000 },
    )
}

async function openProjectSession(page: Page, projectName: string): Promise<void> {
    const row = page.locator(
        `button.session-row[data-project-name=${JSON.stringify(projectName)}]`,
    ).first()
    await row.waitFor({ state: 'attached', timeout: 20_000 })
    const group = page.locator('.project-session-group').filter({ has: row })
    const toggle = group.locator('button.project-session-toggle')
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
    if (await row.getAttribute('aria-pressed') !== 'true') await row.click()
    await waitFor(
        async () => await row.getAttribute('aria-pressed') === 'true',
        { description: `selected session in ${projectName}`, timeoutMs: UI_TIMEOUT_MS },
    )
}

async function sendPrompt(page: Page, prompt: string): Promise<void> {
    await page.locator('textarea[aria-label^="Message "]').fill(prompt)
    await page.getByRole('button', { name: 'Send message' }).click()
}

async function waitForProjectWorking(page: Page, projectName: string): Promise<void> {
    await waitFor(async () => {
        const row = page.locator(
            `button.session-row[data-project-name=${JSON.stringify(projectName)}]`,
        ).first()
        return (await row.getAttribute('class'))?.includes('session-signal-working') ?? false
    }, { description: `working session in ${projectName}`, timeoutMs: 20_000 })
}

async function beginDeleteSelectedSession(page: Page, projectName: string): Promise<void> {
    const details = page.getByRole('button', { name: 'Conversation details' })
    if (await details.getAttribute('aria-expanded') !== 'true') await details.click()
    await page.getByRole('button').filter({
        has: page.locator('strong', { hasText: /^Delete session$/u }),
    }).click()
    const dialog = page.getByRole('alertdialog')
    await dialog.waitFor({ state: 'visible' })
    await dialog.getByRole('button', { name: 'Delete session', exact: true }).click()
    await waitFor(async () => {
        const row = page.locator(
            `button.session-row[data-project-name=${JSON.stringify(projectName)}]`,
        )
        return !await dialog.isVisible().catch(() => false)
            && await row.count() === 1
            && (await row.first().getAttribute('class'))?.includes('is-busy') === true
    }, { description: 'immediate deleting state', timeoutMs: UI_TIMEOUT_MS })
}

async function projectSessionExists(page: Page, projectName: string): Promise<boolean> {
    return await page.locator(
        `button.session-row[data-project-name=${JSON.stringify(projectName)}]`,
    ).count() > 0
}

async function waitForConnected(page: Page): Promise<void> {
    await waitFor(async () => {
        const label = await page
            .locator('button[aria-label^="Open connection settings,"]')
            .getAttribute('aria-label')
        return label?.endsWith('Connected') ?? false
    }, { description: 'connected Matrix browser', timeoutMs: STARTUP_TIMEOUT_MS })
}

function captureBrowserDiagnostics(page: Page, output: string[]): void {
    page.on('console', message => output.push(`[console.${message.type()}] ${message.text()}`))
    page.on('pageerror', error => output.push(`[pageerror] ${error.stack ?? error.message}`))
    page.on('requestfailed', request => {
        output.push(
            `[requestfailed] ${request.method()} ${request.url()} `
            + `${request.failure()?.errorText ?? 'unknown failure'}`,
        )
    })
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
    return {
        child,
        get output() { return output },
        waitFor(pattern, timeoutMs = STARTUP_TIMEOUT_MS) {
            return waitForOutput(child, () => output, pattern, timeoutMs)
        },
        async stop() {
            if (child.exitCode !== null || child.signalCode !== null) return
            const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
            signalProcessTree(child, 'SIGTERM')
            if (!await completeWithin(exited, 10_000)) {
                signalProcessTree(child, 'SIGKILL')
                await completeWithin(exited, 2_000)
            }
            child.stdout?.destroy()
            child.stderr?.destroy()
        },
    }
}

async function runProcess(
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
    timeoutMs: number,
): Promise<string> {
    const process = managedProcess(command, args, options)
    const exited = await Promise.race([
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
            process.child.once('exit', (code, signal) => resolve({ code, signal }))
        }),
        delay(timeoutMs).then(() => null),
    ])
    if (!exited) {
        await process.stop()
        throw new Error(`Process timed out: ${command} ${args.join(' ')}`)
    }
    if (exited.code !== 0) {
        throw new Error(
            `Process failed: ${command} ${args.join(' ')} code=${exited.code} signal=${exited.signal}\n`
            + process.output.slice(-8_000),
        )
    }
    return process.output
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
            reject(new Error(
                `Timed out waiting for ${pattern}. Last output:\n${output().slice(-4_000)}`,
            ))
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
                `Process exited before ${pattern}: code=${code} signal=${signal}\n`
                + output().slice(-4_000),
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
    options: { description: string; timeoutMs: number },
): Promise<void> {
    const deadline = Date.now() + options.timeoutMs
    let lastError: unknown
    while (Date.now() < deadline) {
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

async function completeWithin(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            operation.then(() => true, () => true),
            new Promise<boolean>(resolve => {
                timeout = setTimeout(() => resolve(false), timeoutMs)
            }),
        ])
    } finally {
        if (timeout) clearTimeout(timeout)
    }
}

async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createNetServer()
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            const port = typeof address === 'object' && address ? address.port : 0
            server.close(error => error ? reject(error) : resolve(port))
        })
    })
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
    if (process.platform !== 'win32' && child.pid) {
        try {
            process.kill(-child.pid, signal)
            return
        } catch {
            // Process group already exited.
        }
    }
    child.kill(signal)
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

function redactSecrets(value: string): string {
    return value
        .replace(/codever:\/\/[^\s]+/gu, '[REDACTED_PAIRING_LINK]')
        .replace(/("access_token"\s*:\s*")[^"]+/gu, '$1[REDACTED]')
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds))
}
