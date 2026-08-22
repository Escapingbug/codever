import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    CVP3_MATRIX_PROJECT_KEY_GRANT_EVENT_TYPE,
    CVP3_MATRIX_PROJECT_POINTER_EVENT_TYPE,
    CVP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE,
} from '@codever/protocol'
import { chromium, type Browser, type Page, type Route } from 'playwright-core'
import { GatewayAdminClient } from '../src/gateway/admin/client.js'
import { runAndroidMatrixCvp3Journey } from './e2e/androidMatrixCvp3Journey.js'
import { MATRIX_CVP3_PROJECTION_STATE_VERSION } from '../apps/pwa/app/matrixCvp3Projection.js'
import {
    createDisposableMatrixFixture,
    type DisposableMatrixFixture,
} from './e2e/localMatrixFixture.js'

const ENABLE_ENV = 'CODEVER_MATRIX_CVP3_LIVE_E2E'
const REQUIRE_ANDROID_ENV = 'CODEVER_MATRIX_CVP3_REQUIRE_ANDROID'
const STARTUP_TIMEOUT_MS = 90_000
const CONVERGENCE_TIMEOUT_MS = 20_000
const PROVIDER_RESPONSE = 'Codever deterministic E2E response'
const COLD_START_NOISE_EVENTS = 40
const LEGACY_CVP3_OUTBOX_SENTINEL = '__codever_e2e_preserved_outbox__'
const LEGACY_CVP3_INBOX_SENTINEL = '__codever_e2e_stale_inbox__'
const LEGACY_CVP3_PROJECTION_SENTINEL = '__codever_e2e_stale_projection__'

if (process.env[ENABLE_ENV] !== '1') {
    throw new Error(
        'This test starts disposable Synapse, browser, PWA, and Gateway processes. '
        + `Set ${ENABLE_ENV}=1 to run it.`,
    )
}
if (process.env[REQUIRE_ANDROID_ENV] === '1' && !process.env.CODEVER_ANDROID_SERIAL) {
    throw new Error(
        'The Alpha acceptance gate requires a real Android target. Set CODEVER_ANDROID_SERIAL.',
    )
}

type ManagedProcess = {
    child: ChildProcess
    output: string
    waitFor(pattern: RegExp, timeoutMs?: number): Promise<RegExpMatchArray>
    crash(): Promise<void>
    stop(): Promise<void>
}

const repositoryRoot = process.cwd()
const runId = Date.now().toString(36).toUpperCase()
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'codever-cvp3-live-e2e-'))
const artifactDirectory = join(repositoryRoot, 'artifacts', 'e2e', `matrix-cvp3-${runId}`)
const gatewayDataDirectory = join(temporaryDirectory, 'gateway-data')
const gatewayAdminSocket = join(temporaryDirectory, 'gateway-admin.sock')
const fixturePath = join(temporaryDirectory, 'matrix-fixture.json')
const pwaPort = await freePort()
let matrixPort = await freePort()
while (matrixPort === pwaPort) matrixPort = await freePort()
const pwaUrl = `http://127.0.0.1:${pwaPort}`

let fixture: DisposableMatrixFixture | undefined
let pwa: ManagedProcess | undefined
let gateway: ManagedProcess | undefined
let browser: Browser | undefined
let first: Page | undefined
let second: Page | undefined
let previousGatewayOutput = ''
const logs = new Map<Page, string[]>()
const errors = new Map<Page, Error[]>()

try {
    process.stdout.write('[1/7] Starting disposable Synapse and encrypted project room…\n')
    fixture = await createDisposableMatrixFixture({
        runtimeDirectory: join(temporaryDirectory, 'matrix'),
        hostPort: matrixPort,
    })
    await writeFile(fixturePath, JSON.stringify({
        homeserver: fixture.homeserver,
        roomId: fixture.roomId,
        gatewayId: fixture.gatewayId,
        tester: { userId: fixture.tester.userId },
        gateway: { userId: fixture.gateway.userId },
    }, null, 2), 'utf8')
    process.stdout.write('[2/7] Building the actual PWA and starting the CVP/3 Gateway…\n')
    await runProcess(
        join(repositoryRoot, 'apps', 'pwa', 'node_modules', '.bin', 'vinext'),
        ['build'],
        join(repositoryRoot, 'apps', 'pwa'),
        180_000,
    )
    pwa = managedProcess(
        join(repositoryRoot, 'apps', 'pwa', 'node_modules', '.bin', 'wrangler'),
        ['dev', '--config', 'dist/server/wrangler.json', '--port', String(pwaPort), '--ip', '127.0.0.1'],
        join(repositoryRoot, 'apps', 'pwa'),
        process.env,
    )
    await waitFor(async () => (await fetch(`${pwaUrl}/api/version`).catch(() => null))?.ok ?? false, {
        description: 'PWA server',
        timeoutMs: STARTUP_TIMEOUT_MS,
    })
    gateway = launchGateway(fixture)
    const pairing = await gateway.waitFor(
        /Pairing link \(paste fallback\):\s*\n([^\n]+)\n/u,
        STARTUP_TIMEOUT_MS,
    )
    assert.ok(pairing[1])

    process.stdout.write('[3/7] Pairing the first cache-cold browser…\n')
    browser = await chromium.launch({ headless: true, executablePath: chromeExecutable() })
    // Playwright cannot route fetches owned by a service worker. Blocking SW
    // registration keeps Matrix requests page-owned so the recovery fault
    // injection below observes the exact production SDK traffic.
    first = await browser.newPage({ serviceWorkers: 'block' })
    capture(first)
    await pairBrowser(first, pairing[1]!.trim(), fixture)
    await gateway.waitFor(/Gateway ready with 1 trusted device\(s\)\./u)
    await assertProjectIdentity(first, repositoryRoot)

    process.stdout.write('[4/7] Creating a session and running a real Agent turn…\n')
    const firstSession = await createSession(first, 'codever-e2e-model')
    const firstPrompt = `CVP/3 first prompt ${runId}`
    await sendPrompt(first, firstPrompt)
    await waitForText(first, firstPrompt)

    process.stdout.write('[4p/7] Creating another session while the first Agent is working…\n')
    const secondSession = await createSession(first)
    assert.notEqual(secondSession, firstSession)
    await openSession(first, firstSession)
    await waitForText(first, PROVIDER_RESPONSE)

    process.stdout.write('[5/7] Pairing a second device and restoring inventory/history without refresh…\n')
    const admin = new GatewayAdminClient({ socketPath: gatewayAdminSocket, timeoutMs: 10_000 })
    const invitation = await admin.createInvitation({ matrixLogin: 'disabled', appUrl: pwaUrl })
    second = await browser.newPage({ serviceWorkers: 'block' })
    capture(second)
    await pairBrowser(second, invitation.pairingLink, fixture)
    await waitFor(async () => (await admin.devices()).length === 2, {
        description: 'two trusted devices',
        timeoutMs: STARTUP_TIMEOUT_MS,
    })
    await waitForSessionIds(second, [firstSession, secondSession])
    await openSession(second, firstSession)
    await waitForText(second, firstPrompt)
    await waitForText(second, PROVIDER_RESPONSE)

    process.stdout.write('[5u/7] Migrating a retained pre-manifest CVP/3 cache without losing its outbox…\n')
    await suspendAndSeedLegacyCvp3Database(second)
    await second.goto(pwaUrl)
    await waitForConnected(second)
    await waitForSessionIds(second, [firstSession, secondSession])
    await assertLegacyCvp3DatabaseMigrated(second)

    process.stdout.write('[5b/7] Repairing a corrupt local projection without replaying retained history…\n')
    await suspendAndPoisonCvp3ReadModel(second)
    await second.goto(pwaUrl)
    await waitForConnected(second)
    await waitForSessionIds(second, [firstSession, secondSession])

    process.stdout.write('[5d/7] Recovering an authoritative device grant omitted from local sync state…\n')
    await suspendAndClearCvp3ReadModel(second)
    await assertAuthoritativeGrantRecoversMissingSyncState(
        second,
        fixture,
        [firstSession, secondSession],
    )

    process.stdout.write('[5c/7] Cold-restoring a trusted browser without claiming an empty inventory…\n')
    const recoveryRegressions: Error[] = []
    await suspendAndClearCvp3ReadModel(second)
    await sendTimelineNoise(fixture, COLD_START_NOISE_EVENTS)
    const coldSnapshotIds = await currentSnapshotEventIds(fixture)
    const coldProjectionRegression = await assertColdProjectionWaitsForAuthority(
        second,
        coldSnapshotIds,
        [firstSession, secondSession],
    )
    if (coldProjectionRegression) recoveryRegressions.push(coldProjectionRegression)

    process.stdout.write('[5e/7] Automatically recovering a failed authoritative restore without user action…\n')
    await suspendAndClearCvp3ReadModel(second)
    const overwrittenFailureRegression = await assertRecoveryFailureSurvivesLaterSync(
        second,
        await currentSnapshotEventIds(fixture),
        [firstSession, secondSession],
    )
    if (overwrittenFailureRegression) recoveryRegressions.push(overwrittenFailureRegression)

    process.stdout.write('[5f/7] Preserving cached conversations while automatic recovery retries…\n')
    const cachedRecoveryRegression = await assertRecoveryFailureSurvivesLaterSync(
        second,
        await currentSnapshotEventIds(fixture),
        [firstSession, secondSession],
        [firstSession, secondSession],
    )
    if (cachedRecoveryRegression) recoveryRegressions.push(cachedRecoveryRegression)

    const androidSerial = process.env.CODEVER_ANDROID_SERIAL
    if (androidSerial) {
        process.stdout.write('[5a/7] Running the native Android CVP/3 acceptance journey…\n')
        const androidInvitation = await admin.createInvitation({
            matrixLogin: 'disabled',
            appUrl: pwaUrl,
        })
        await suspendAndClearCvp3ReadModel(second)
        await runAndroidMatrixCvp3Journey({
            repositoryRoot,
            serial: androidSerial,
            pwaUrl,
            pwaPort,
            matrixPort,
            pairingLink: androidInvitation.pairingLink,
            gatewayName: `CVP/3 E2E ${runId}`,
            matrixUserId: fixture.tester.userId,
            matrixPassword: fixture.tester.password,
            browserPage: first,
            existingSessionId: firstSession,
            providerResponse: PROVIDER_RESPONSE,
            runId,
            async onSessionCreated(createdSessionId) {
                process.stdout.write('  [A3c/6] Cold-restoring the trusted offline browser from Android state…\n')
                await second!.goto(pwaUrl)
                await waitForConnected(second!)
                await waitForSessionIds(second!, [
                    firstSession,
                    secondSession,
                    createdSessionId,
                ])
            },
        })
        await waitForSessionIds(second, [firstSession, secondSession])
    }
    if (recoveryRegressions.length > 0) {
        throw new AggregateError(
            recoveryRegressions,
            `${recoveryRegressions.length} authoritative CVP/3 startup regression(s) detected.`,
        )
    }

    process.stdout.write('[5r/7] Reauthorizing a stale device certificate with a real invitation…\n')
    await assertProjectAuthorizationRepair(
        second,
        admin,
        [firstSession, secondSession],
    )

    process.stdout.write('[5g/7] Converging two active turns after a real Gateway crash…\n')
    await openSession(first, firstSession)
    await openSession(second, secondSession)
    await Promise.all([
        sendPrompt(first, `CVP/3 interrupted first ${runId}`),
        sendPrompt(second, `CVP/3 interrupted second ${runId}`),
    ])
    await Promise.all([
        waitForSessionActive(first, firstSession),
        waitForSessionActive(second, secondSession),
        waitForDispatchedPromptSessions([firstSession, secondSession]),
    ])
    await gateway.crash()
    previousGatewayOutput += `${gateway.output}\n\n--- restarted Gateway ---\n`
    gateway = launchGateway(fixture)
    await gateway.waitFor(/Gateway ready with 2 trusted device\(s\)\./u, STARTUP_TIMEOUT_MS)
    await Promise.all([
        waitForConnected(first),
        waitForConnected(second),
    ])
    await Promise.all([
        waitForSessionSettled(first, firstSession),
        waitForSessionSettled(second, secondSession),
    ])
    await assertNoBlockingAlerts(first)
    await assertNoBlockingAlerts(second)

    process.stdout.write('[5x/7] Quarantining one poison timeline event without stalling later work…\n')
    await sendPoisonEvent(fixture)
    await openSession(second, secondSession)
    await openSession(first, secondSession)
    const crossDevicePrompt = `CVP/3 cross-device prompt ${runId}`
    await sendPrompt(second, crossDevicePrompt)
    await waitForText(first, crossDevicePrompt)
    await waitForText(first, PROVIDER_RESPONSE)

    process.stdout.write('[6/7] Reloading from durable projection and lazy thread history…\n')
    await second.reload()
    await waitForConnected(second)
    await waitForSessionIds(second, [firstSession, secondSession])
    await openSession(second, secondSession)
    await waitForText(second, crossDevicePrompt)
    await waitForText(second, PROVIDER_RESPONSE)

    process.stdout.write('[7/7] Archiving two sessions concurrently on separate devices…\n')
    await openSession(first, firstSession)
    await openSession(second, secondSession)
    await Promise.all([
        beginArchive(first),
        beginArchive(second),
    ])
    await Promise.all([
        waitForSessionIds(first, []),
        waitForSessionIds(second, []),
    ])
    assertNoErrors(first)
    assertNoErrors(second)
    await assertNoBlockingAlerts(first)
    await assertNoBlockingAlerts(second)
    process.stdout.write('PASS — CVP/3 over Matrix paired, created, ran concurrently, synchronized, restored, quarantined poison, and archived.\n')
} catch (error) {
    await mkdir(artifactDirectory, { recursive: true })
    await Promise.all([
        first?.screenshot({ path: join(artifactDirectory, 'browser-1.png'), fullPage: true }).catch(() => undefined),
        second?.screenshot({ path: join(artifactDirectory, 'browser-2.png'), fullPage: true }).catch(() => undefined),
        writeFile(
            join(artifactDirectory, 'gateway.log'),
            redact(`${previousGatewayOutput}${gateway?.output ?? ''}`),
            'utf8',
        ),
        writeFile(join(artifactDirectory, 'pwa.log'), redact(pwa?.output ?? ''), 'utf8'),
        writeFile(join(artifactDirectory, 'browser.log'), redact(
            [...logs.entries()].map(([page, lines], index) =>
                `browser-${index + 1} ${page.url()}\n${lines.join('\n')}`,
            ).join('\n\n'),
        ), 'utf8'),
        (async () => writeFile(
            join(artifactDirectory, 'feed.txt'),
            await first?.locator('.chat-feed').innerText().catch(() => '') ?? '',
            'utf8',
        ))(),
        cp(gatewayDataDirectory, join(artifactDirectory, 'gateway-data'), {
            recursive: true,
            force: true,
        }).catch(() => undefined),
    ])
    process.stderr.write(`CVP/3 over Matrix E2E artifacts: ${artifactDirectory}\n`)
    throw error
} finally {
    await browser?.close().catch(() => undefined)
    await gateway?.stop().catch(() => undefined)
    await pwa?.stop().catch(() => undefined)
    await fixture?.close().catch(() => undefined)
    await rm(temporaryDirectory, { recursive: true, force: true })
}

process.exit(0)

async function pairBrowser(
    page: Page,
    pairingLink: string,
    matrix: DisposableMatrixFixture,
): Promise<void> {
    await page.goto(`${pwaUrl}/#pair=${encodeURIComponent(pairingLink)}`)
    const dialog = page.getByRole('dialog', { name: 'Connect a computer' })
    await dialog.waitFor({ state: 'visible', timeout: STARTUP_TIMEOUT_MS })
    await dialog.getByText('Computer found').waitFor({ state: 'visible' })
    await dialog.getByPlaceholder('@you:example.org').fill(matrix.tester.userId)
    await dialog.getByPlaceholder('Your account password').fill(matrix.tester.password)
    await dialog.getByRole('button', { name: 'Sign in', exact: true }).click()
    const connect = dialog.getByRole('button', { name: /^Connect to /u })
    await waitFor(async () => {
        if (await isConnected(page)) return true
        return await connect.isVisible().catch(() => false)
            && await connect.isEnabled({ timeout: 500 }).catch(() => false)
    }, { description: 'pairing confirmation', timeoutMs: STARTUP_TIMEOUT_MS })
    if (!await isConnected(page)) await connect.click()
    await waitForConnected(page)
    // Pairing completion and the CVP/3 key grant can independently rerender and
    // auto-close this dialog. A locator action waits for element stability and
    // turns that successful auto-close into a false 30-second timeout.
    await page.evaluate(() => {
        const close = document.querySelector<HTMLButtonElement>(
            'button[aria-label="Close connection settings"]',
        )
        close?.click()
    })
}

async function assertProjectIdentity(page: Page, cwd: string): Promise<void> {
    await page.getByRole('button', { name: 'New conversation' }).click()
    const dialog = page.locator('.new-session-dialog')
    await dialog.waitFor({ state: 'visible' })
    assert.equal(await dialog.getByRole('option', { name: /New project/u }).count(), 0)
    const cwdInput = dialog.getByLabel('Working directory')
    assert.equal(await cwdInput.inputValue(), cwd)
    assert.equal(await cwdInput.isDisabled(), true)
    const model = dialog.getByRole('combobox', { name: 'Model' })
    assert.equal(await model.isEnabled(), true)
    assert.equal(
        await model.getByRole('option', { name: 'Codever E2E Model' }).count(),
        1,
    )
    await dialog.getByRole('button', { name: 'Cancel' }).click()
}

async function createSession(page: Page, model?: string): Promise<string> {
    const before = new Set(await sessionIds(page))
    await page.getByRole('button', { name: 'New conversation' }).click()
    const dialog = page.locator('.new-session-dialog')
    await dialog.waitFor({ state: 'visible' })
    if (model) {
        await dialog.getByRole('combobox', { name: 'Model' }).selectOption(model)
    }
    await dialog.getByRole('button', { name: 'Create session', exact: true }).click()
    let created = ''
    await waitFor(async () => {
        const additions = (await sessionIds(page)).filter(id => !before.has(id))
        if (additions.length !== 1) return false
        created = additions[0]!
        return true
    }, {
        description: 'exactly one newly created CVP/3 session',
        timeoutMs: CONVERGENCE_TIMEOUT_MS,
        failFast: () => assertNoErrors(page),
    })
    await openSession(page, created)
    await assertNoBlockingAlerts(page)
    return created
}

async function sendPrompt(page: Page, prompt: string): Promise<void> {
    await page.locator('textarea[aria-label^="Message "]').fill(prompt)
    await page.getByRole('button', { name: 'Send message' }).click()
}

async function beginArchive(page: Page): Promise<void> {
    const details = page.getByRole('button', { name: 'Conversation details' })
    if (await details.getAttribute('aria-expanded') !== 'true') await details.click()
    await page.getByRole('button').filter({
        has: page.locator('strong', { hasText: /^Archive session$/u }),
    }).click()
}

async function openSession(page: Page, sessionId: string): Promise<void> {
    const row = page.locator(`button.session-row[data-session-id="${sessionId}"]`)
    await row.waitFor({ state: 'attached', timeout: CONVERGENCE_TIMEOUT_MS })
    const group = page.locator('.project-session-group').filter({ has: row })
    const toggle = group.locator('button.project-session-toggle')
    if (await toggle.count() > 0 && await toggle.getAttribute('aria-expanded') !== 'true') {
        await toggle.click()
    }
    if (await row.getAttribute('aria-pressed') !== 'true') await row.click()
    await waitFor(async () => await row.getAttribute('aria-pressed') === 'true', {
        description: `selected session ${sessionId}`,
        timeoutMs: CONVERGENCE_TIMEOUT_MS,
        failFast: () => assertNoErrors(page),
    })
}

async function waitForText(page: Page, value: string): Promise<void> {
    await waitFor(
        () => page.locator('.chat-feed').getByText(value, { exact: false }).last().isVisible(),
        {
            description: `message ${JSON.stringify(value)}`,
            timeoutMs: CONVERGENCE_TIMEOUT_MS,
            failFast: () => assertNoErrors(page),
        },
    )
    await assertNoBlockingAlerts(page)
}

async function waitForSessionIds(page: Page, expected: string[]): Promise<void> {
    await waitFor(async () => {
        const actual = (await sessionIds(page)).toSorted()
        return JSON.stringify(actual) === JSON.stringify(expected.toSorted())
    }, {
        description: `sessions ${expected.join(', ') || '<empty>'}`,
        timeoutMs: CONVERGENCE_TIMEOUT_MS,
        failFast: () => assertNoErrors(page),
    })
    await assertNoBlockingAlerts(page)
}

async function waitForSessionActive(page: Page, sessionId: string): Promise<void> {
    const row = page.locator(`button.session-row[data-session-id="${sessionId}"]`)
    await waitFor(async () => /Sending|Starting|Agent is working|queued/iu.test(
        await row.getAttribute('aria-label') ?? '',
    ), {
        description: `active session ${sessionId}`,
        timeoutMs: CONVERGENCE_TIMEOUT_MS,
        failFast: () => assertNoErrors(page),
    })
}

async function waitForDispatchedPromptSessions(sessionIds: string[]): Promise<void> {
    const journalPath = join(gatewayDataDirectory, 'gateway-replay.jsonl.v3-commands.jsonl')
    await waitFor(async () => {
        const entries = (await readFile(journalPath, 'utf8'))
            .split(/\r?\n/u)
            .filter(Boolean)
            .map(line => JSON.parse(line) as {
                kind: string
                key?: string
                command?: { operation?: string; sessionId?: string }
            })
        const promptSessions = new Map<string, string>()
        const dispatched = new Set<string>()
        const terminal = new Set<string>()
        for (const entry of entries) {
            if (
                entry.kind === 'accepted'
                && entry.key
                && entry.command?.operation === 'prompt.submit'
                && entry.command.sessionId
            ) promptSessions.set(entry.key, entry.command.sessionId)
            if (entry.kind === 'dispatched' && entry.key) dispatched.add(entry.key)
            if (entry.kind === 'terminal' && entry.key) terminal.add(entry.key)
        }
        return sessionIds.every(sessionId => [...promptSessions].some(([key, candidate]) =>
            candidate === sessionId && dispatched.has(key) && !terminal.has(key)
        ))
    }, {
        description: 'both prompt commands to cross the durable dispatch boundary',
        timeoutMs: CONVERGENCE_TIMEOUT_MS,
    })
}

async function waitForSessionSettled(page: Page, sessionId: string): Promise<void> {
    const row = page.locator(`button.session-row[data-session-id="${sessionId}"]`)
    await waitFor(async () => {
        const label = await row.getAttribute('aria-label') ?? ''
        return !/Sending|Starting|Agent is working|queued|stopping/iu.test(label)
    }, {
        description: `interrupted session ${sessionId} to become idle`,
        timeoutMs: CONVERGENCE_TIMEOUT_MS,
        failFast: () => assertNoErrors(page),
    })
}

async function sessionIds(page: Page): Promise<string[]> {
    return page.locator('button.session-row').evaluateAll(rows => rows.flatMap(row => {
        const id = (row as HTMLElement).dataset.sessionId
        return id ? [id] : []
    }))
}

async function suspendAndSeedLegacyCvp3Database(page: Page): Promise<void> {
    // Simulate the deployed build whose CVP/3 database predates its entries in
    // the PWA storage manifest. The migration must clear Matrix-derived state
    // while retaining an independent outbox row in the same physical DB.
    await page.goto(`${pwaUrl}/api/version`, { waitUntil: 'domcontentloaded' })
    await page.evaluate(async ({ outboxKey, inboxKey, projectionKey, manifestKey }) => {
        const rawManifest = localStorage.getItem(manifestKey)
        if (!rawManifest) throw new Error('The IndexedDB upgrade manifest is unavailable.')
        const manifest = JSON.parse(rawManifest) as {
            stores?: Array<{ id?: string }>
            invalidated?: string[]
        }
        manifest.stores = (manifest.stores ?? []).filter(entry =>
            entry.id !== 'cvp3-command-outbox'
            && entry.id !== 'cvp3-inbox-and-projection'
        )
        manifest.invalidated = (manifest.invalidated ?? []).filter(id =>
            id !== 'cvp3-command-outbox'
            && id !== 'cvp3-inbox-and-projection'
        )
        localStorage.setItem(manifestKey, JSON.stringify(manifest))

        await new Promise<void>((resolve, reject) => {
            const opened = indexedDB.open('codever-matrix-v3', 2)
            opened.onerror = () => reject(opened.error ?? new Error('Could not open the CVP/3 test database.'))
            opened.onblocked = () => reject(new Error('The CVP/3 test database remained open after unloading.'))
            opened.onsuccess = () => {
                const database = opened.result
                const transaction = database.transaction(
                    ['outbox', 'inbox', 'projection'],
                    'readwrite',
                    { durability: 'strict' },
                )
                transaction.objectStore('outbox').put({
                    key: outboxKey,
                    scope: '__migration_fixture__',
                    scopeStatus: '__migration_fixture__\u0000completed',
                    status: 'completed',
                })
                transaction.objectStore('inbox').put({
                    key: inboxKey,
                    scope: '__migration_fixture__',
                    scopeStatus: '__migration_fixture__\u0000projected',
                    status: 'projected',
                    raw: {
                        roomId: '!legacy:example.test',
                        eventId: '$legacy',
                        sender: '@legacy:example.test',
                        timestamp: 1,
                        content: {},
                    },
                })
                transaction.objectStore('projection').put({
                    key: projectionKey,
                    state: { version: 0, legacy: true },
                })
                transaction.oncomplete = () => {
                    database.close()
                    resolve()
                }
                transaction.onerror = () => {
                    const error = transaction.error ?? new Error('Could not seed the legacy CVP/3 database.')
                    database.close()
                    reject(error)
                }
                transaction.onabort = transaction.onerror
            }
        })
    }, {
        outboxKey: LEGACY_CVP3_OUTBOX_SENTINEL,
        inboxKey: LEGACY_CVP3_INBOX_SENTINEL,
        projectionKey: LEGACY_CVP3_PROJECTION_SENTINEL,
        manifestKey: 'codever.indexeddb-state-manifest.v1',
    })
}

async function assertLegacyCvp3DatabaseMigrated(page: Page): Promise<void> {
    const result = await page.evaluate(async ({ outboxKey, inboxKey, projectionKey }) => {
        return new Promise<{ outbox: boolean; inbox: boolean; projection: boolean }>((resolve, reject) => {
            const opened = indexedDB.open('codever-matrix-v3', 2)
            opened.onerror = () => reject(opened.error ?? new Error('Could not inspect the CVP/3 test database.'))
            opened.onsuccess = () => {
                const database = opened.result
                const transaction = database.transaction(
                    ['outbox', 'inbox', 'projection'],
                    'readonly',
                )
                const outbox = transaction.objectStore('outbox').getKey(outboxKey)
                const inbox = transaction.objectStore('inbox').getKey(inboxKey)
                const projection = transaction.objectStore('projection').getKey(projectionKey)
                transaction.oncomplete = () => {
                    database.close()
                    resolve({
                        outbox: outbox.result !== undefined,
                        inbox: inbox.result !== undefined,
                        projection: projection.result !== undefined,
                    })
                }
                transaction.onerror = () => {
                    const error = transaction.error ?? new Error('Could not inspect the migrated CVP/3 database.')
                    database.close()
                    reject(error)
                }
                transaction.onabort = transaction.onerror
            }
        })
    }, {
        outboxKey: LEGACY_CVP3_OUTBOX_SENTINEL,
        inboxKey: LEGACY_CVP3_INBOX_SENTINEL,
        projectionKey: LEGACY_CVP3_PROJECTION_SENTINEL,
    })
    assert.deepEqual(result, {
        outbox: true,
        inbox: false,
        projection: false,
    }, 'CVP/3 migration must preserve outbox rows and discard only rebuildable state.')
}

async function suspendAndPoisonCvp3ReadModel(page: Page): Promise<void> {
    // A structurally incompatible projection and its inbox are one rebuildable
    // unit. Startup must discard both, retain the outbox, and continue directly
    // to bounded authoritative Matrix recovery.
    await page.goto(`${pwaUrl}/api/version`, { waitUntil: 'domcontentloaded' })
    const projectionRows = await page.evaluate(async (projectionStateVersion) => {
        return new Promise<number>((resolve, reject) => {
            const opened = indexedDB.open('codever-matrix-v3', 2)
            opened.onerror = () => reject(opened.error ?? new Error('Could not open the CVP/3 test database.'))
            opened.onblocked = () => reject(new Error('The CVP/3 test database remained open after unloading.'))
            opened.onsuccess = () => {
                const database = opened.result
                if (
                    !database.objectStoreNames.contains('projection')
                    || !database.objectStoreNames.contains('inbox')
                ) {
                    database.close()
                    reject(new Error('The CVP/3 read-model stores do not exist.'))
                    return
                }
                const transaction = database.transaction(
                    ['projection', 'inbox'],
                    'readwrite',
                    { durability: 'strict' },
                )
                let projectionRows = 0
                const projectionStore = transaction.objectStore('projection')
                const projections = projectionStore.getAll()
                projections.onsuccess = () => {
                    for (const row of projections.result as Array<{
                        key: string
                        state?: Record<string, unknown>
                    }>) {
                        if (
                            !row.state
                            || row.state.version !== projectionStateVersion
                        ) continue
                        projectionStore.put({
                            ...row,
                            state: {
                                ...row.state,
                                version: projectionStateVersion + 1,
                            },
                        })
                        projectionRows += 1
                    }
                }
                transaction.oncomplete = () => {
                    database.close()
                    resolve(projectionRows)
                }
                transaction.onerror = () => {
                    const error = transaction.error ?? new Error('Could not poison the CVP/3 read model.')
                    database.close()
                    reject(error)
                }
                transaction.onabort = transaction.onerror
            }
        })
    }, MATRIX_CVP3_PROJECTION_STATE_VERSION)
    assert.ok(
        projectionRows > 0,
        'Projection repair precondition failed: the trusted browser had no durable projection.',
    )
}

async function suspendAndClearCvp3ReadModel(page: Page): Promise<void> {
    // Keep this page and therefore its BrowserContext: Matrix login, device
    // identity, crypto store, and pinned Gateway trust must all survive. The
    // same-origin JSON route unloads the PWA before its CVP/3 IndexedDB read
    // model is cleared, so the live client cannot immediately repopulate it.
    await page.goto(`${pwaUrl}/api/version`, { waitUntil: 'domcontentloaded' })
    const clearedProjectionRows = await page.evaluate(async () => {
        return new Promise<number>((resolve, reject) => {
            const opened = indexedDB.open('codever-matrix-v3', 2)
            opened.onerror = () => reject(opened.error ?? new Error('Could not open the CVP/3 test database.'))
            opened.onblocked = () => reject(new Error('The CVP/3 test database remained open after unloading.'))
            opened.onsuccess = () => {
                const database = opened.result
                if (
                    !database.objectStoreNames.contains('projection')
                    || !database.objectStoreNames.contains('inbox')
                ) {
                    database.close()
                    reject(new Error('The CVP/3 read-model stores do not exist.'))
                    return
                }
                const transaction = database.transaction(
                    ['projection', 'inbox'],
                    'readwrite',
                    { durability: 'strict' },
                )
                const count = transaction.objectStore('projection').count()
                transaction.objectStore('projection').clear()
                transaction.objectStore('inbox').clear()
                transaction.oncomplete = () => {
                    const result = count.result
                    database.close()
                    resolve(result)
                }
                transaction.onerror = () => {
                    const error = transaction.error ?? new Error('Could not clear the CVP/3 read model.')
                    database.close()
                    reject(error)
                }
                transaction.onabort = transaction.onerror
            }
        })
    })
    assert.ok(
        clearedProjectionRows > 0,
        'Cold-start regression precondition failed: the trusted browser had no durable CVP/3 projection.',
    )
    const clearedSyncStores = await page.evaluate(async () => {
        const databaseNames = (await indexedDB.databases()).flatMap(database =>
            database.name?.startsWith('matrix-js-sdk:codever-matrix-sync-v1-')
                ? [database.name]
                : [],
        )
        await Promise.all(databaseNames.map(name => new Promise<void>((resolve, reject) => {
            const deleted = indexedDB.deleteDatabase(name)
            deleted.onsuccess = () => resolve()
            deleted.onerror = () => reject(deleted.error ?? new Error('Could not clear the Matrix sync cache.'))
            deleted.onblocked = () => reject(new Error('The Matrix sync cache remained open after unloading.'))
        })))
        return databaseNames.length
    })
    assert.equal(
        clearedSyncStores,
        1,
        'Cold-start regression precondition failed: expected one rebuildable Matrix sync cache.',
    )
}

async function assertAuthoritativeGrantRecoversMissingSyncState(
    page: Page,
    matrix: DisposableMatrixFixture,
    expectedSessionIds: string[],
): Promise<void> {
    let removedGrants = 0
    let removedPointers = 0
    let syncFetchClaimed = false
    const pattern = '**/*'
    const handler = async (route: Route) => {
        const requestUrl = new URL(route.request().url())
        if (
            syncFetchClaimed
            || !/\/_matrix\/client\/[^/]+\/sync$/u.test(requestUrl.pathname)
        ) {
            await route.continue()
            return
        }
        syncFetchClaimed = true
        const response = await route.fetch()
        const body = await response.json() as {
            rooms?: {
                join?: Record<string, {
                    state?: { events?: Array<{ type?: string }> }
                    'org.matrix.msc4222.state_after'?: {
                        events?: Array<{ type?: string }>
                    }
                    timeline?: { events?: Array<{ type?: string }> }
                }>
            }
        }
        const joinedRoom = body.rooms?.join?.[matrix.roomId]
        const eventLists = [
            joinedRoom?.state,
            joinedRoom?.['org.matrix.msc4222.state_after'],
            joinedRoom?.timeline,
        ]
        for (const list of eventLists) {
            if (!list?.events) continue
            list.events = list.events.filter(event => {
                if (event.type === CVP3_MATRIX_PROJECT_KEY_GRANT_EVENT_TYPE) {
                    removedGrants += 1
                    return false
                }
                if (
                    event.type === CVP3_MATRIX_PROJECT_POINTER_EVENT_TYPE
                    || event.type === CVP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE
                ) {
                    removedPointers += 1
                    return false
                }
                return true
            })
        }
        await route.fulfill({ response, json: body })
    }
    await page.route(pattern, handler)
    try {
        await page.goto(pwaUrl)
        await waitFor(() => removedGrants > 0 && removedPointers >= 2, {
            description: 'CVP/3 grant and pointers removed from the initial Matrix sync state',
            timeoutMs: CONVERGENCE_TIMEOUT_MS,
        })
        await waitForConnected(page)
        await waitForSessionIds(page, expectedSessionIds)
    } finally {
        await page.unrouteAll({ behavior: 'ignoreErrors' })
    }
}

async function assertProjectAuthorizationRepair(
    page: Page,
    admin: GatewayAdminClient,
    expectedSessionIds: string[],
): Promise<void> {
    await page.goto(`${pwaUrl}/api/version`, { waitUntil: 'domcontentloaded' })
    let originalCertificateId: string | null = null
    let injectedMismatches = 0
    const pattern = '**/*'
    const handler = async (route: Route) => {
        if (roomStateEventType(route.request().url()) !== CVP3_MATRIX_PROJECT_KEY_GRANT_EVENT_TYPE) {
            await route.continue()
            return
        }
        const response = await route.fetch()
        const content = await response.json() as Record<string, unknown>
        const certificateId = typeof content.certificateId === 'string'
            ? content.certificateId
            : null
        originalCertificateId ??= certificateId
        if (certificateId && certificateId === originalCertificateId) {
            injectedMismatches += 1
            await route.fulfill({
                response,
                json: {
                    ...content,
                    certificateId: `stale-${certificateId}`,
                },
            })
            return
        }
        await route.fulfill({ response, json: content })
    }
    await page.route(pattern, handler)
    try {
        await page.goto(pwaUrl)
        const dialog = page.getByRole('dialog', { name: 'Repair connection' })
        await dialog.waitFor({ state: 'visible', timeout: STARTUP_TIMEOUT_MS })
        await dialog.getByText('Reauthorize this device', { exact: true }).waitFor()
        await dialog.getByText('codever-matrix gateway invite', { exact: true }).waitFor()
        assert.ok(injectedMismatches > 0, 'The stale-certificate repair precondition was not injected.')
        assert.equal(
            await dialog.getByRole('button', { name: 'Try again', exact: true }).count(),
            0,
            'Authorization repair must not offer a retry that cannot change authorization.',
        )
        const downloadPromise = page.waitForEvent('download')
        await dialog.getByRole('button', { name: 'Export diagnostics' }).click()
        const download = await downloadPromise
        assert.match(download.suggestedFilename(), /^codever-connection-diagnostics-\d+\.json$/u)
        await download.delete()

        const invitation = await admin.createInvitation({
            matrixLogin: 'disabled',
            appUrl: pwaUrl,
        })
        await dialog.getByLabel('One-time pairing link').fill(invitation.pairingLink)
        await dialog.getByRole('button', { name: 'Continue', exact: true }).click()
        await dialog.getByText('Computer found').waitFor()
        await dialog.getByRole('button', { name: /^Connect to /u }).click()
        await waitForConnected(page)
        await waitForSessionIds(page, expectedSessionIds)
    } finally {
        await page.unroute(pattern, handler)
    }
}

async function assertColdProjectionWaitsForAuthority(
    page: Page,
    snapshotEventIds: Set<string>,
    expectedSessionIds: string[],
): Promise<Error | null> {
    const gate = await interceptSnapshotRequests(page, snapshotEventIds, 'hold')
    let regression: Error | null = null
    try {
        await page.goto(pwaUrl)
        await gate.waitForAll()
        // Let React render the state emitted after Matrix PREPARED while the
        // authoritative project snapshot and thread replay remain blocked.
        await delay(500)
        const actual = {
            connected: await isConnected(page),
            emptyInventoryVisible: await page.getByText(
                'Create your first conversation',
                { exact: true },
            ).isVisible().catch(() => false),
            recoveryIndicatorVisible: await page.locator('.connection-progress').isVisible().catch(() => false),
            visibleSessionIds: await sessionIds(page),
        }
        try {
            assert.deepEqual(actual, {
                connected: false,
                emptyInventoryVisible: false,
                recoveryIndicatorVisible: true,
                visibleSessionIds: [],
            }, 'A trusted browser must remain in recovery until authoritative CVP/3 state is available.')
        } catch (error) {
            if (!(error instanceof Error)) throw error
            regression = error
        }
    } finally {
        gate.release()
        await gate.dispose()
    }
    await waitForConnected(page)
    await waitForSessionIds(page, expectedSessionIds)
    return regression
}

async function assertRecoveryFailureSurvivesLaterSync(
    page: Page,
    snapshotEventIds: Set<string>,
    expectedSessionIds: string[],
    expectedSessionIdsDuringRecovery: string[] = [],
): Promise<Error | null> {
    const interceptor = await interceptSnapshotRequests(page, snapshotEventIds, 'fail')
    let regression: Error | null = null
    let interceptorDisposed = false
    try {
        await page.goto(pwaUrl)
        await interceptor.waitForAll()
        const alert = page.locator('.connection-toast[role="alert"]')
        await delay(100)
        const recoveryIndicatorVisible =
            await page.locator('.connection-progress').isVisible().catch(() => false)
            || await page.locator(
                '.gateway-card.connection-state-reconnecting,'
                + '.gateway-card.connection-state-connecting,'
                + '.gateway-card.connection-state-securing',
            ).isVisible().catch(() => false)
        const actual = {
            connected: await isConnected(page),
            blockingFailureVisible: await alert.isVisible().catch(() => false),
            recoveryIndicatorVisible,
            visibleSessionIds: await sessionIds(page),
        }
        try {
            assert.deepEqual(actual, {
                connected: false,
                blockingFailureVisible: false,
                recoveryIndicatorVisible: true,
                visibleSessionIds: expectedSessionIdsDuringRecovery,
            }, 'A recoverable CVP/3 failure must remain non-blocking while the supervisor retries.')
        } catch (error) {
            if (!(error instanceof Error)) throw error
            regression = error
        }
        await interceptor.dispose()
        interceptorDisposed = true
        await waitForConnected(page)
        await waitForSessionIds(page, expectedSessionIds)
        assert.equal(
            await alert.isVisible().catch(() => false),
            false,
            'Automatic recovery must converge without leaving a connection-attention prompt.',
        )
    } finally {
        interceptor.release()
        if (!interceptorDisposed) await interceptor.dispose()
    }
    return regression
}

async function currentSnapshotEventIds(matrix: DisposableMatrixFixture): Promise<Set<string>> {
    const response = await fetch(
        `${matrix.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(matrix.roomId)}/state`,
        { headers: { authorization: `Bearer ${matrix.tester.accessToken}` } },
    )
    if (!response.ok) {
        throw new Error(`Could not read CVP/3 pointer state: ${await response.text()}`)
    }
    const state = await response.json() as Array<{
        type?: string
        content?: { document?: { eventId?: string } }
    }>
    const ids = new Set(state.flatMap(event => {
        if (
            event.type !== CVP3_MATRIX_PROJECT_POINTER_EVENT_TYPE
            && event.type !== CVP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE
        ) return []
        const eventId = event.content?.document?.eventId
        return eventId ? [eventId] : []
    }))
    assert.equal(ids.size, 2, 'Expected current workspace and project CVP/3 snapshot pointers.')
    return ids
}

async function interceptSnapshotRequests(
    page: Page,
    snapshotEventIds: Set<string>,
    behavior: 'hold' | 'fail',
): Promise<{
    waitForAll(): Promise<void>
    release(): void
    dispose(): Promise<void>
}> {
    const intercepted = new Set<string>()
    const observedRoomEventIds = new Set<string>()
    let release!: () => void
    const released = new Promise<void>(resolve => { release = resolve })
    const pattern = '**/*'
    const handler = async (route: Route) => {
        const eventId = roomEventId(route.request().url())
        if (eventId) observedRoomEventIds.add(eventId)
        if (!eventId || !snapshotEventIds.has(eventId)) {
            await route.continue()
            return
        }
        intercepted.add(eventId)
        if (behavior === 'hold') {
            await released
            await route.continue()
            return
        }
        await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({
                errcode: 'M_UNKNOWN',
                error: 'Injected CVP/3 authoritative snapshot failure',
            }),
        })
    }
    await page.route(pattern, handler)
    return {
        async waitForAll() {
            try {
                await waitFor(() => intercepted.size === snapshotEventIds.size, {
                    description: `${behavior === 'hold' ? 'held' : 'failed'} current CVP/3 snapshot requests`,
                    timeoutMs: CONVERGENCE_TIMEOUT_MS,
                })
            } catch (error) {
                throw new Error(
                    `${formatError(error)}; expected=${[...snapshotEventIds].join(',')}`
                    + `; observed=${[...observedRoomEventIds].join(',') || '<none>'}`,
                )
            }
        },
        release,
        dispose: () => page.unroute(pattern, handler),
    }
}

function roomEventId(url: string): string | null {
    const match = new URL(url).pathname.match(/\/_matrix\/client\/[^/]+\/rooms\/[^/]+\/event\/([^/]+)$/u)
    return match?.[1] ? decodeURIComponent(match[1]) : null
}

function roomStateEventType(url: string): string | null {
    const match = new URL(url).pathname.match(
        /\/_matrix\/client\/[^/]+\/rooms\/[^/]+\/state\/([^/]+)\/[^/]+$/u,
    )
    return match?.[1] ? decodeURIComponent(match[1]) : null
}

async function sendTimelineNoise(
    matrix: DisposableMatrixFixture,
    count: number,
): Promise<void> {
    // Force prior session lifecycle events outside CVP/3's bounded 32-event
    // initial /sync window. The only valid way to rebuild the complete
    // inventory is then the authoritative snapshot plus thread directory.
    await Promise.all(Array.from({ length: count }, async (_, index) => {
        const transactionId = `cold-start-noise-${runId}-${index}`
        const response = await fetch(
            `${matrix.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(matrix.roomId)}`
            + `/send/io.codever.e2e.noise/${encodeURIComponent(transactionId)}`,
            {
                method: 'PUT',
                headers: {
                    authorization: `Bearer ${matrix.tester.accessToken}`,
                    'content-type': 'application/json',
                },
                body: JSON.stringify({ runId, index }),
            },
        )
        if (!response.ok) {
            throw new Error(`Could not send Matrix cold-start noise ${index}: ${await response.text()}`)
        }
    }))
}

async function sendPoisonEvent(matrix: DisposableMatrixFixture): Promise<void> {
    const response = await fetch(
        `${matrix.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(matrix.roomId)}`
        + `/send/m.room.message/${encodeURIComponent(`poison-${runId}`)}`,
        {
            method: 'PUT',
            headers: {
                authorization: `Bearer ${matrix.tester.accessToken}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                msgtype: 'm.notice',
                body: 'Malformed CVP/3 test event',
                'io.codever': { version: 3, envelope: { deliberately: 'invalid' } },
            }),
        },
    )
    assert.equal(response.ok, true, `Could not seed poison event: ${await response.text()}`)
}

function capture(page: Page): void {
    logs.set(page, [])
    errors.set(page, [])
    page.on('console', message => logs.get(page)?.push(`[console.${message.type()}] ${message.text()}`))
    page.on('pageerror', error => {
        logs.get(page)?.push(`[pageerror] ${error.stack ?? error.message}`)
        errors.get(page)?.push(error)
    })
    page.on('requestfailed', request => logs.get(page)?.push(
        `[requestfailed] ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`,
    ))
    page.on('response', response => {
        if (!response.url().includes('/_matrix/client/v3/sync')) return
        void response.json().then((body: unknown) => {
            const record = body && typeof body === 'object' ? body as Record<string, unknown> : null
            const rooms = record?.rooms && typeof record.rooms === 'object'
                ? record.rooms as Record<string, unknown>
                : null
            const joined = rooms?.join && typeof rooms.join === 'object'
                ? rooms.join as Record<string, unknown>
                : null
            for (const room of Object.values(joined ?? {})) {
                if (!room || typeof room !== 'object') continue
                const timeline = (room as Record<string, unknown>).timeline
                if (!timeline || typeof timeline !== 'object') continue
                const events = (timeline as Record<string, unknown>).events
                if (!Array.isArray(events)) continue
                for (const event of events) {
                    if (!event || typeof event !== 'object') continue
                    const value = event as Record<string, unknown>
                    logs.get(page)?.push(
                        `[matrix-sync-event] ${String(value.event_id)} ${String(value.type)}`,
                    )
                }
            }
        }).catch(() => undefined)
    })
}

function assertNoErrors(page: Page): void {
    const failures = errors.get(page) ?? []
    assert.deepEqual(failures, [], failures.map(error => error.stack ?? error.message).join('\n'))
}

async function assertNoBlockingAlerts(page: Page): Promise<void> {
    assertNoErrors(page)
    const alerts = await page.locator('[role="alert"]').allTextContents()
    const blocking = alerts.filter(value =>
        /could not|failed|needs review|must be acknowledged|previous action|did not acknowledge|too many requests/iu.test(value),
    )
    assert.deepEqual(blocking, [], `Blocking UI alert: ${blocking.join(' | ')}`)
}

async function waitForConnected(page: Page): Promise<void> {
    await waitFor(() => isConnected(page), {
        description: 'connected CVP/3 browser',
        timeoutMs: STARTUP_TIMEOUT_MS,
        failFast: () => assertNoErrors(page),
    })
    await assertNoBlockingAlerts(page)
}

async function isConnected(page: Page): Promise<boolean> {
    const label = await page.locator(
        'button[aria-label^="Open connection settings,"]',
    ).getAttribute('aria-label')
    return label?.endsWith('Online') ?? false
}

async function waitFor(
    predicate: () => boolean | Promise<boolean>,
    options: { description: string; timeoutMs: number; failFast?: () => void },
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

function managedProcess(
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
): ManagedProcess {
    const child = spawn(command, args, {
        cwd,
        env,
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
        async crash() {
            if (child.exitCode !== null || child.signalCode !== null) return
            const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
            signalProcess(child, 'SIGKILL')
            if (!await Promise.race([exited.then(() => true), delay(2_000).then(() => false)])) {
                throw new Error(`Process did not exit after SIGKILL: ${command} ${args.join(' ')}`)
            }
        },
        async stop() {
            if (child.exitCode !== null || child.signalCode !== null) return
            const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
            signalProcess(child, 'SIGTERM')
            if (!await Promise.race([exited.then(() => true), delay(10_000).then(() => false)])) {
                signalProcess(child, 'SIGKILL')
                await Promise.race([exited, delay(2_000)])
            }
        },
    }
}

function launchGateway(matrix: DisposableMatrixFixture): ManagedProcess {
    return managedProcess(
        join(repositoryRoot, 'node_modules', '.bin', 'tsx'),
        [join(repositoryRoot, 'scripts', 'matrix-local-gateway.ts')],
        repositoryRoot,
        {
            ...process.env,
            CODEVER_MATRIX_FIXTURE: fixturePath,
            CODEVER_MATRIX_DATA_DIR: gatewayDataDirectory,
            CODEVER_MATRIX_GATEWAY_USER: matrix.gateway.username,
            CODEVER_MATRIX_GATEWAY_PASSWORD: matrix.gateway.password,
            CODEVER_GATEWAY_NAME: `CVP/3 E2E ${runId}`,
            CODEVER_GATEWAY_ADMIN_SOCKET: gatewayAdminSocket,
            CODEVER_MATRIX_E2E_PROVIDER: '1',
            CODEVER_MATRIX_E2E_PROVIDER_DELAY_MS: '4000',
            CODEVER_CWD: repositoryRoot,
        },
    )
}

async function waitForOutput(
    child: ChildProcess,
    output: () => string,
    pattern: RegExp,
    timeoutMs: number,
): Promise<RegExpMatchArray> {
    return new Promise((resolve, reject) => {
        const inspect = () => {
            const match = output().match(pattern)
            if (!match) return
            cleanup()
            resolve(match)
        }
        const exited = (code: number | null, signal: NodeJS.Signals | null) => {
            cleanup()
            reject(new Error(`Process exited before ${pattern}: ${code}/${signal}\n${output().slice(-6000)}`))
        }
        const timer = setTimeout(() => {
            cleanup()
            reject(new Error(`Timed out waiting for ${pattern}\n${output().slice(-6000)}`))
        }, timeoutMs)
        const cleanup = () => {
            clearTimeout(timer)
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

async function runProcess(command: string, args: string[], cwd: string, timeoutMs: number): Promise<void> {
    const process = managedProcess(command, args, cwd, globalThis.process.env)
    const exited = await Promise.race([
        new Promise<{ code: number | null }>(resolve =>
            process.child.once('exit', code => resolve({ code })),
        ),
        delay(timeoutMs).then(() => null),
    ])
    if (!exited) {
        await process.stop()
        throw new Error(`Process timed out: ${command} ${args.join(' ')}\n${process.output.slice(-6000)}`)
    }
    if (exited.code !== 0) {
        throw new Error(`Process failed: ${command} ${args.join(' ')}\n${process.output.slice(-6000)}`)
    }
}

function signalProcess(child: ChildProcess, signal: NodeJS.Signals): void {
    if (process.platform !== 'win32' && child.pid) {
        try {
            process.kill(-child.pid, signal)
            return
        } catch {
            // Process group may already have exited.
        }
    }
    child.kill(signal)
}

async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer()
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            server.close(error => {
                if (error) reject(error)
                else resolve(typeof address === 'object' && address ? address.port : 0)
            })
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

function redact(value: string): string {
    return value.replace(/codever:\/\/[^\s]+/gu, '[REDACTED_PAIRING_LINK]')
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds))
}
