import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const PACKAGE_NAME = 'id.my.anciety.codever'
const MAIN_ACTIVITY = `${PACKAGE_NAME}/.web.MainActivity`
const APP_ORIGIN = 'https://rd.anciety.my.id/'
const ENABLE_ENV = 'CODEVER_ANDROID_LIVE_E2E'
const PHYSICAL_ENV = 'CODEVER_ANDROID_ALLOW_PHYSICAL'
const SERIAL_ENV = 'CODEVER_ANDROID_SERIAL'
const DEFAULT_TIMEOUT_MS = 30_000
const LIFECYCLE_TIMEOUT_MS = 90_000
const LIFECYCLE_LATENCY_WARNING_MS = 20_000

type JsonRecord = Record<string, unknown>

type CdpTarget = {
    type: string
    url: string
    webSocketDebuggerUrl: string
}

type PageState = {
    online: boolean
    connection: string
    activeSessionCount: number
    archivedSessionCount: number
    selectedTitle: string
    activeProjects: string[]
    archivedProjects: string[]
    archivedBanner: boolean
    recentMessagesVisible: boolean
    dialogs: string[]
    alerts: string[]
}

type PendingCall = {
    resolve(value: JsonRecord): void
    reject(error: Error): void
    timer: ReturnType<typeof setTimeout>
}

class DevtoolsPage {
    private nextId = 0
    private readonly pending = new Map<number, PendingCall>()

    private constructor(private readonly socket: WebSocket) {
        socket.addEventListener('message', event => {
            const response = JSON.parse(String(event.data)) as JsonRecord
            const id = typeof response.id === 'number' ? response.id : undefined
            if (id === undefined) return
            const call = this.pending.get(id)
            if (!call) return
            this.pending.delete(id)
            clearTimeout(call.timer)
            if (response.error) {
                call.reject(new Error(`CDP error: ${JSON.stringify(response.error)}`))
            } else {
                call.resolve(response)
            }
        })
        socket.addEventListener('close', () => {
            for (const call of this.pending.values()) {
                clearTimeout(call.timer)
                call.reject(new Error('The Android WebView debugging connection closed.'))
            }
            this.pending.clear()
        })
    }

    static async connect(url: string): Promise<DevtoolsPage> {
        const socket = new WebSocket(url)
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error('Timed out opening the Android WebView debugger.')),
                5_000,
            )
            socket.addEventListener('open', () => {
                clearTimeout(timer)
                resolve()
            }, { once: true })
            socket.addEventListener('error', () => {
                clearTimeout(timer)
                reject(new Error('Could not open the Android WebView debugger.'))
            }, { once: true })
        })
        return new DevtoolsPage(socket)
    }

    close(): void {
        this.socket.close()
    }

    async evaluate<T>(expression: string): Promise<T> {
        const response = await this.call('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
        })
        const runtime = response.result as JsonRecord | undefined
        if (runtime?.exceptionDetails) {
            throw new Error(`WebView evaluation failed: ${JSON.stringify(runtime.exceptionDetails)}`)
        }
        const remote = runtime?.result as JsonRecord | undefined
        return remote?.value as T
    }

    async state(): Promise<PageState> {
        return this.evaluate<PageState>(PAGE_STATE_EXPRESSION)
    }

    async waitFor(
        description: string,
        predicate: (state: PageState) => boolean,
        timeoutMs = DEFAULT_TIMEOUT_MS,
    ): Promise<PageState> {
        const deadline = Date.now() + timeoutMs
        let last: PageState | undefined
        while (Date.now() < deadline) {
            last = await this.state()
            if (predicate(last)) return last
            await delay(250)
        }
        throw new Error(
            `Timed out waiting for ${description}. Last state: ${JSON.stringify(last)}`,
        )
    }

    async clickAria(label: string): Promise<void> {
        await this.click(`(() => {
            const target = Array.from(document.querySelectorAll('button'))
                .find(button => button.getAttribute('aria-label') === ${json(label)} && visible(button));
            return clickResult(target);
        })()`)
    }

    async clickButtonText(label: string, containerSelector?: string): Promise<void> {
        await this.click(`(() => {
            const root = ${containerSelector ? `document.querySelector(${json(containerSelector)})` : 'document'};
            const target = root && Array.from(root.querySelectorAll('button'))
                .find(button => normalized(button.innerText) === ${json(label)} && visible(button));
            return clickResult(target);
        })()`)
    }

    async waitForButtonTextEnabled(
        label: string,
        containerSelector?: string,
        timeoutMs = DEFAULT_TIMEOUT_MS,
    ): Promise<void> {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
            const ready = await this.evaluate<boolean>(`(() => {
                const normalized = value => String(value || '').replace(/\\s+/gu, ' ').trim();
                const root = ${containerSelector ? `document.querySelector(${json(containerSelector)})` : 'document'};
                const target = root && Array.from(root.querySelectorAll('button'))
                    .find(button => normalized(button.innerText) === ${json(label)} && button.getClientRects().length > 0);
                return Boolean(target && !target.disabled);
            })()`)
            if (ready) return
            await delay(250)
        }
        throw new Error(`Timed out waiting for the enabled ${label} button.`)
    }

    async clickConversationActionStrong(
        label: string,
        timeoutMs = DEFAULT_TIMEOUT_MS,
    ): Promise<void> {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
            const result = await this.evaluate<'clicked' | 'waiting' | 'missing'>(`(() => {
                const normalized = value => String(value || '').replace(/\\s+/gu, ' ').trim();
                const target = Array.from(document.querySelectorAll('button'))
                    .find(button => normalized(button.querySelector('strong')?.textContent || '') === ${json(label)} && button.getClientRects().length > 0);
                if (target) {
                    if (target.disabled) return 'waiting';
                    target.click();
                    return 'clicked';
                }
                const details = Array.from(document.querySelectorAll('button'))
                    .find(button => button.getAttribute('aria-label') === 'Conversation details' && button.getClientRects().length > 0);
                if (details && details.getAttribute('aria-expanded') !== 'true') details.click();
                return details ? 'waiting' : 'missing';
            })()`)
            if (result === 'clicked') return
            await delay(250)
        }
        throw new Error(`Timed out opening the enabled ${label} conversation action.`)
    }

    async createSession(projectName: string): Promise<void> {
        await this.clickAria('New conversation')
        await this.waitFor(
            'the new-session dialog',
            state => state.dialogs.some(dialog => dialog.startsWith('Create a session')),
        )
        const projectSelected = await this.evaluate<{ selected: boolean; cwd: string }>(`(() => {
            const dialog = document.querySelector('.new-session-dialog');
            if (!dialog) return { selected: false, cwd: '' };
            const project = dialog.querySelector('select');
            const projectNameInput = dialog.querySelector('input[placeholder="My project"]');
            const cwdInput = dialog.querySelector('input[placeholder="/Users/me/Documents/project"]');
            const originalCwd = cwdInput?.value || '';
            const newProject = Array.from(project?.options || [])
                .find(option => option.value === '__new_project__');
            if (!project || !newProject || !projectNameInput || !cwdInput || !originalCwd) {
                return { selected: false, cwd: originalCwd };
            }
            const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
            setter?.call(project, newProject.value);
            project.dispatchEvent(new Event('change', { bubbles: true }));
            return { selected: true, cwd: originalCwd };
        })()`)
        assert.equal(projectSelected.selected, true, 'Could not select a disposable live E2E project')
        const deadline = Date.now() + 5_000
        let configured = false
        while (!configured && Date.now() < deadline) {
            configured = await this.evaluate<boolean>(`(() => {
                const dialog = document.querySelector('.new-session-dialog');
                const projectNameInput = dialog?.querySelector('input[placeholder="My project"]');
                const cwdInput = dialog?.querySelector('input[placeholder="/Users/me/Documents/project"]');
                if (!projectNameInput || !cwdInput || projectNameInput.disabled || cwdInput.disabled) return false;
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
                if (!setter) return false;
                setter.call(projectNameInput, ${json(projectName)});
                projectNameInput.dispatchEvent(new Event('input', { bubbles: true }));
                setter.call(cwdInput, ${json(projectSelected.cwd)});
                cwdInput.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
            })()`)
            if (!configured) await delay(50)
        }
        assert.equal(configured, true, 'Could not configure the live E2E project')
        await this.clickButtonText('Create session', '.new-session-dialog')
    }

    async openActiveProjectSession(projectName: string): Promise<boolean> {
        return this.evaluate<boolean>(`(() => {
            const normalized = value => String(value || '').replace(/\\s+/gu, ' ').trim();
            const section = Array.from(document.querySelectorAll('.project-session-group'))
                .find(group => normalized(group.querySelector('.project-copy strong')?.textContent || '') === ${json(projectName)});
            const row = section?.querySelector('button.session-row');
            if (!row || row.disabled) return false;
            row.click();
            return true;
        })()`)
    }

    async openArchivedProjectSession(projectName: string): Promise<boolean> {
        const state = await this.state()
        if (!state.archivedProjects.includes(projectName)) {
            const toggle = await this.evaluate<boolean>(`(() => {
                const button = document.querySelector('button.archived-session-toggle');
                if (!button || button.getAttribute('aria-expanded') === 'true') return false;
                button.click();
                return true;
            })()`)
            if (toggle) await delay(100)
        }
        return this.evaluate<boolean>(`(() => {
            const normalized = value => String(value || '').replace(/\\s+/gu, ' ').trim();
            const row = Array.from(document.querySelectorAll('button.archived-session-row'))
                .find(button => normalized(button.querySelector('small')?.textContent || '').startsWith(${json(`${projectName} ·`)}));
            if (!row || row.disabled) return false;
            row.click();
            return true;
        })()`)
    }

    private async click(expression: string): Promise<void> {
        const result = await this.evaluate<{ found: boolean; disabled: boolean }>(
            `(() => { ${DOM_HELPERS} return ${expression}; })()`,
        )
        assert.equal(result.found, true, 'The expected visible WebView button was not found')
        assert.equal(result.disabled, false, 'The expected WebView button was disabled')
    }

    private call(method: string, params: JsonRecord): Promise<JsonRecord> {
        const id = ++this.nextId
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id)
                reject(new Error(`Timed out waiting for CDP method ${method}.`))
            }, 5_000)
            this.pending.set(id, { resolve, reject, timer })
            this.socket.send(JSON.stringify({ id, method, params }))
        })
    }
}

const DOM_HELPERS = `
const normalized = value => String(value || '').replace(/\\s+/gu, ' ').trim();
const visible = element => element.getClientRects().length > 0;
const clickResult = target => {
    if (!target) return { found: false, disabled: false };
    if (!target.disabled) target.click();
    return { found: true, disabled: Boolean(target.disabled) };
};
`

const PAGE_STATE_EXPRESSION = `(() => {
    const normalized = value => String(value || '').replace(/\\s+/gu, ' ').trim();
    const connectionButton = Array.from(document.querySelectorAll('button'))
        .find(button => button.getAttribute('aria-label')?.startsWith('Open connection settings'));
    const activeProjects = Array.from(document.querySelectorAll('.project-session-toggle .project-copy strong'))
        .map(element => normalized(element.textContent));
    const archivedProjects = Array.from(document.querySelectorAll('button.archived-session-row small'))
        .map(element => normalized(element.textContent).split(' · ')[0] || '');
    const archivedCountText = document.querySelector('.archived-session-toggle b')?.textContent || '0';
    return {
        online: navigator.onLine,
        connection: connectionButton?.getAttribute('aria-label') || '',
        activeSessionCount: document.querySelectorAll('button.session-row').length,
        archivedSessionCount: Number.parseInt(archivedCountText, 10) || 0,
        selectedTitle: normalized(document.querySelector('.conversation-heading h2')?.textContent),
        activeProjects,
        archivedProjects,
        archivedBanner: Boolean(document.querySelector('.archived-session-banner')),
        recentMessagesVisible: document.body?.innerText.includes('Recent messages') || false,
        dialogs: Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'))
            .map(element => normalized(element.querySelector('h2')?.textContent || element.textContent || '')),
        alerts: Array.from(document.querySelectorAll('[role="alert"]'))
            .map(element => normalized(element.textContent)),
    };
})()`

if (process.env[ENABLE_ENV] !== '1') {
    throw new Error(
        `Live Android E2E changes emulator network and Gateway session state. Set ${ENABLE_ENV}=1 to run it.`,
    )
}

const serial = await resolveSerial()
const isEmulator = (await adb(serial, 'shell', 'getprop', 'ro.kernel.qemu')) === '1'
if (!isEmulator && process.env[PHYSICAL_ENV] !== '1') {
    throw new Error(
        `Refusing to mutate a physical Android device. Set ${PHYSICAL_ENV}=1 only after explicit approval.`,
    )
}

await adb(serial, 'shell', 'dumpsys', 'package', PACKAGE_NAME)
const initialAirplaneMode = await airplaneMode(serial)
assert.equal(initialAirplaneMode, false, 'The device must be online before live E2E starts')

const runId = Date.now().toString(36).toUpperCase()
const testProjects = [`Codever Android E2E ${runId} A`, `Codever Android E2E ${runId} B`]
const pendingCleanup = new Set<string>()
const latencyWarnings: string[] = []
let page: DevtoolsPage | undefined
let forwardedPort: string | undefined

try {
    process.stdout.write(`[1/5] Cold-starting ${PACKAGE_NAME} on ${serial}...\n`)
    ;({ page, port: forwardedPort } = await restartAndAttach(serial, page, forwardedPort))
    const online = await page.waitFor(
        'the paired Gateway connection',
        state => state.online && state.connection.endsWith('Connected'),
    )
    assertHealthy(online)
    assert.ok(online.activeSessionCount + online.archivedSessionCount > 0, 'No paired Gateway sessions were visible')
    assert.ok(online.selectedTitle, 'No current conversation was selected')
    const baselineSessionCount = online.activeSessionCount + online.archivedSessionCount
    const baselineTitle = online.selectedTitle

    process.stdout.write('[2/5] Cold-starting offline and verifying cached sessions/history...\n')
    await setAirplaneMode(serial, true)
    ;({ page, port: forwardedPort } = await restartAndAttach(serial, page, forwardedPort))
    const offline = await page.waitFor(
        'the offline cached UI',
        state => !state.online && state.connection.includes('offline') && state.recentMessagesVisible,
    )
    assertHealthy(offline)
    assert.equal(offline.activeSessionCount + offline.archivedSessionCount, baselineSessionCount)
    assert.equal(offline.selectedTitle, baselineTitle)

    process.stdout.write('[3/5] Restoring network and waiting for native Matrix recovery...\n')
    await setAirplaneMode(serial, false)
    const recovered = await page.waitFor(
        'the recovered Gateway connection',
        state => state.online && state.connection.endsWith('Connected'),
        45_000,
    )
    assertHealthy(recovered)
    assert.equal(recovered.activeSessionCount + recovered.archivedSessionCount, baselineSessionCount)

    process.stdout.write('[4/5] Exercising create/archive/restore/delete twice...\n')
    for (const [index, projectName] of testProjects.entries()) {
        pendingCleanup.add(projectName)
        await exerciseSessionLifecycle(
            page,
            projectName,
            baselineSessionCount,
            latencyWarnings,
        )
        pendingCleanup.delete(projectName)
        if (index === 0) {
            ;({ page, port: forwardedPort } = await restartAndAttach(serial, page, forwardedPort))
            const restarted = await page.waitFor(
                'Gateway recovery after lifecycle process restart',
                state => state.connection.endsWith('Connected'),
            )
            assertHealthy(restarted)
            assert.equal(
                restarted.activeSessionCount + restarted.archivedSessionCount,
                baselineSessionCount,
            )
        }
    }

    if (latencyWarnings.length > 0) {
        process.stderr.write(
            `Lifecycle latency warnings (>${LIFECYCLE_LATENCY_WARNING_MS} ms):\n` +
            latencyWarnings.map(warning => `  - ${warning}\n`).join(''),
        )
    }
    process.stdout.write(
        `[5/5] PASS${latencyWarnings.length > 0 ? ' with latency warnings' : ''} — ` +
        'network, process restart, cached history, and lifecycle recovery passed.\n',
    )
} finally {
    if (await airplaneMode(serial).catch(() => initialAirplaneMode)) {
        await setAirplaneMode(serial, initialAirplaneMode).catch(error => {
            process.stderr.write(`Could not restore airplane mode: ${formatError(error)}\n`)
        })
    }
    if (page) {
        for (const projectName of pendingCleanup) {
            await cleanupProjectSession(page, projectName).catch(error => {
                process.stderr.write(`Could not clean ${projectName}: ${formatError(error)}\n`)
            })
        }
        page.close()
    }
    if (forwardedPort) {
        await adbMaybe(serial, 'forward', '--remove', `tcp:${forwardedPort}`)
    }
}

async function exerciseSessionLifecycle(
    page: DevtoolsPage,
    projectName: string,
    baselineSessionCount: number,
    latencyWarnings: string[],
): Promise<void> {
    let startedAt = Date.now()
    await page.createSession(projectName)
    const created = await page.waitFor(
        `created session in ${projectName}`,
        state =>
            state.activeProjects.includes(projectName) &&
            state.selectedTitle === 'New session' &&
            state.activeSessionCount + state.archivedSessionCount === baselineSessionCount + 1,
        LIFECYCLE_TIMEOUT_MS,
    )
    assertHealthy(created)
    recordLatency(projectName, 'create', startedAt, latencyWarnings)

    startedAt = Date.now()
    await page.clickConversationActionStrong('Archive session')
    const archived = await page.waitFor(
        `archived session in ${projectName}`,
        state => state.archivedBanner && state.archivedSessionCount > 0,
        LIFECYCLE_TIMEOUT_MS,
    )
    assertHealthy(archived)
    recordLatency(projectName, 'archive', startedAt, latencyWarnings)

    startedAt = Date.now()
    await page.waitForButtonTextEnabled('Restore')
    await page.clickButtonText('Restore')
    const restored = await page.waitFor(
        `restored session in ${projectName}`,
        state => state.activeProjects.includes(projectName) && !state.archivedBanner,
        LIFECYCLE_TIMEOUT_MS,
    )
    assertHealthy(restored)
    recordLatency(projectName, 'restore', startedAt, latencyWarnings)

    startedAt = Date.now()
    await deleteSelectedSession(page)
    const deleted = await page.waitFor(
        `deleted session in ${projectName}`,
        state =>
            !state.activeProjects.includes(projectName) &&
            state.activeSessionCount + state.archivedSessionCount === baselineSessionCount,
        LIFECYCLE_TIMEOUT_MS,
    )
    assertHealthy(deleted)
    recordLatency(projectName, 'delete', startedAt, latencyWarnings)
}

async function deleteSelectedSession(page: DevtoolsPage): Promise<void> {
    await page.clickConversationActionStrong('Delete session')
    await page.waitFor(
        'the delete confirmation',
        state => state.dialogs.some(dialog => dialog.startsWith('Delete “')),
    )
    await page.clickButtonText('Delete session', '[role="alertdialog"]')
}

async function cleanupProjectSession(page: DevtoolsPage, projectName: string): Promise<void> {
    let state = await page.state()
    if (!state.activeProjects.includes(projectName) && state.archivedSessionCount === 0) return

    let opened = await page.openActiveProjectSession(projectName)
    if (!opened) opened = await page.openArchivedProjectSession(projectName)
    if (!opened) return
    await page.waitFor('the disposable session to open', current => current.selectedTitle === 'New session')
    state = await page.state()
    const sessionCountBeforeDelete = state.activeSessionCount + state.archivedSessionCount
    await deleteSelectedSession(page)
    await page.waitFor(
        `cleanup of ${projectName}`,
        current =>
            !current.activeProjects.includes(projectName) &&
            !current.archivedProjects.includes(projectName) &&
            current.activeSessionCount + current.archivedSessionCount < sessionCountBeforeDelete,
        LIFECYCLE_TIMEOUT_MS,
    )
    state = await page.state()
    assertHealthy(state)
}

function recordLatency(
    projectName: string,
    action: string,
    startedAt: number,
    warnings: string[],
): void {
    const durationMs = Date.now() - startedAt
    const sample = `${projectName} ${action}: ${durationMs} ms`
    process.stdout.write(`  ${sample}\n`)
    if (durationMs > LIFECYCLE_LATENCY_WARNING_MS) warnings.push(sample)
}

function assertHealthy(state: PageState): void {
    const unexpected = state.alerts.filter(alert =>
        /history could not be restored|native bridge did not answer|matrix runtime failed|needs review|must be acknowledged/iu.test(alert),
    )
    assert.deepEqual(unexpected, [], `Blocking Codever alert appeared: ${unexpected.join(' | ')}`)
}

async function restartAndAttach(
    serial: string,
    previousPage?: DevtoolsPage,
    previousPort?: string,
): Promise<{ page: DevtoolsPage; port: string }> {
    previousPage?.close()
    if (previousPort) await adbMaybe(serial, 'forward', '--remove', `tcp:${previousPort}`)
    await adb(serial, 'shell', 'am', 'force-stop', PACKAGE_NAME)
    await adb(serial, 'shell', 'am', 'start', '-W', '-n', MAIN_ACTIVITY)
    return attachWebView(serial)
}

async function attachWebView(serial: string): Promise<{ page: DevtoolsPage; port: string }> {
    const deadline = Date.now() + DEFAULT_TIMEOUT_MS
    let lastError = 'WebView process did not start'
    while (Date.now() < deadline) {
        const pid = await adbMaybe(serial, 'shell', 'pidof', PACKAGE_NAME)
        if (!pid) {
            await delay(250)
            continue
        }
        const socket = `webview_devtools_remote_${pid.split(/\s+/u)[0]}`
        const port = await adbMaybe(
            serial,
            'forward',
            'tcp:0',
            `localabstract:${socket}`,
        )
        if (!port) {
            await delay(250)
            continue
        }
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/list`)
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const targets = await response.json() as CdpTarget[]
            const target = targets.find(candidate =>
                candidate.type === 'page' && candidate.url.startsWith(APP_ORIGIN),
            )
            if (!target?.webSocketDebuggerUrl) {
                throw new Error('The Codever WebView page target is not ready')
            }
            return {
                page: await DevtoolsPage.connect(target.webSocketDebuggerUrl),
                port,
            }
        } catch (error) {
            lastError = formatError(error)
            await adbMaybe(serial, 'forward', '--remove', `tcp:${port}`)
            await delay(250)
        }
    }
    throw new Error(`Timed out attaching to Codever WebView: ${lastError}`)
}

async function resolveSerial(): Promise<string> {
    const devices = (await adbRaw('devices'))
        .split(/\r?\n/u)
        .slice(1)
        .map(line => line.trim().split(/\s+/u))
        .filter(parts => parts[0] && parts[1] === 'device')
        .map(parts => parts[0]!)
    const requested = process.env[SERIAL_ENV]
    if (requested) {
        assert.ok(devices.includes(requested), `ADB device ${requested} is not connected`)
        return requested
    }
    assert.equal(devices.length, 1, `Expected exactly one ADB device, found: ${devices.join(', ') || 'none'}`)
    return devices[0]!
}

async function airplaneMode(serial: string): Promise<boolean> {
    return (await adb(serial, 'shell', 'cmd', 'connectivity', 'airplane-mode')) === 'enabled'
}

async function setAirplaneMode(serial: string, enabled: boolean): Promise<void> {
    await adb(
        serial,
        'shell',
        'cmd',
        'connectivity',
        'airplane-mode',
        enabled ? 'enable' : 'disable',
    )
}

async function adb(serial: string, ...args: string[]): Promise<string> {
    return adbRaw('-s', serial, ...args)
}

async function adbMaybe(serial: string, ...args: string[]): Promise<string> {
    try {
        return await adb(serial, ...args)
    } catch {
        return ''
    }
}

async function adbRaw(...args: string[]): Promise<string> {
    const result = await execFileAsync('adb', args, {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
    })
    return result.stdout.trim()
}

function json(value: string): string {
    return JSON.stringify(value)
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds))
}
