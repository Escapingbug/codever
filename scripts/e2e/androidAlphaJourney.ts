import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import {
    createServer as createHttpServer,
    request as requestHttp,
    type Server as HttpServer,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Page } from 'playwright-core'

const execFileAsync = promisify(execFile)

const PACKAGE_NAME = 'id.my.anciety.codever.e2e'
const MAIN_ACTIVITY = `${PACKAGE_NAME}/id.my.anciety.codever.web.MainActivity`
const CONNECT_TIMEOUT_MS = 90_000
const CONVERGENCE_TIMEOUT_MS = 15_000
const UI_FEEDBACK_TIMEOUT_MS = 1_500
const RETURN_TIMEOUT_MS = 8_000
const FOREGROUND_NOTIFICATION_ID = '1101'
const TASK_NOTIFICATION_TITLE = 'Agent task completed'

type JsonRecord = Record<string, unknown>

type CdpTarget = {
    type: string
    url: string
    webSocketDebuggerUrl: string
}

type PendingCall = {
    resolve(value: JsonRecord): void
    reject(error: Error): void
    timer: ReturnType<typeof setTimeout>
}

type FirstSyncGate = {
    readonly port: number
    intercepted(): number
    waitForInterception(): Promise<void>
    release(): void
    close(): Promise<void>
}

type AndroidPageState = {
    connection: string
    selectedProject: string
    projectNames: string[]
    archivedProjects: string[]
    archivedBanner: boolean
    sessionCreatePending: boolean
    selectedSessionId: string
    selectedSessionCount: number
    mobileChatOpen: boolean
    dialogs: string[]
    alerts: string[]
    bodyText: string
}

export type AndroidAlphaJourneyOptions = {
    repositoryRoot: string
    pwaUrl: string
    pwaPort: number
    matrixPort: number
    runId: string
    browserPage: Page
    testerUserId: string
    testerPassword: string
    providerResponse: string
    artifactDirectory: string
}

class AndroidWebView {
    private nextId = 0
    private readonly pending = new Map<number, PendingCall>()

    private constructor(private readonly socket: WebSocket) {
        socket.addEventListener('message', event => {
            const response = JSON.parse(String(event.data)) as JsonRecord
            const id = typeof response.id === 'number' ? response.id : undefined
            if (id === undefined) return
            const pending = this.pending.get(id)
            if (!pending) return
            this.pending.delete(id)
            clearTimeout(pending.timer)
            if (response.error) {
                pending.reject(new Error(`CDP error: ${JSON.stringify(response.error)}`))
            } else {
                pending.resolve(response)
            }
        })
        socket.addEventListener('close', () => {
            for (const pending of this.pending.values()) {
                clearTimeout(pending.timer)
                pending.reject(new Error('The Android WebView debugger closed.'))
            }
            this.pending.clear()
        })
    }

    static async connect(url: string): Promise<AndroidWebView> {
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
        return new AndroidWebView(socket)
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

    async state(): Promise<AndroidPageState> {
        return this.evaluate<AndroidPageState>(ANDROID_PAGE_STATE)
    }

    async waitFor(
        description: string,
        predicate: (state: AndroidPageState) => boolean,
        timeoutMs = CONVERGENCE_TIMEOUT_MS,
    ): Promise<AndroidPageState> {
        const deadline = Date.now() + timeoutMs
        let last: AndroidPageState | undefined
        while (Date.now() < deadline) {
            last = await this.state()
            assertHealthy(last)
            if (predicate(last)) return last
            await delay(200)
        }
        throw new Error(`Timed out waiting for ${description}. Last state: ${JSON.stringify(last)}`)
    }

    async navigate(url: string): Promise<void> {
        await this.call('Page.navigate', { url })
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

    async clickButtonPrefix(prefix: string, timeoutMs = CONNECT_TIMEOUT_MS): Promise<void> {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
            const result = await this.evaluate<'clicked' | 'connected' | 'disabled' | 'missing'>(`(() => {
                const normalized = value => String(value || '').replace(/\\s+/gu, ' ').trim();
                const connection = Array.from(document.querySelectorAll('button'))
                    .find(button => button.getAttribute('aria-label')?.startsWith('Open connection settings,'));
                if (connection?.getAttribute('aria-label')?.endsWith('Connected')) return 'connected';
                const target = Array.from(document.querySelectorAll('button'))
                    .find(button => normalized(button.innerText).startsWith(${json(prefix)}) && button.getClientRects().length > 0);
                if (!target) return 'missing';
                if (target.disabled) return 'disabled';
                target.click();
                return 'clicked';
            })()`)
            if (result === 'clicked' || result === 'connected') return
            await delay(200)
        }
        throw new Error(`Timed out waiting for the enabled ${prefix} button.`)
    }

    async signInForPairing(userId: string, password: string): Promise<void> {
        const configured = await this.evaluate<boolean>(`(() => {
            const dialog = document.querySelector('.matrix-settings');
            const user = dialog?.querySelector('input[placeholder="@you:example.org"]');
            const password = dialog?.querySelector('input[placeholder="Your account password"]');
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (!user || !password || !setter) return false;
            setter.call(user, ${json(userId)});
            user.dispatchEvent(new Event('input', { bubbles: true }));
            setter.call(password, ${json(password)});
            password.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        })()`)
        assert.equal(configured, true, 'Could not fill the native Matrix sign-in fallback')
        await this.clickButtonText('Sign in', '.matrix-settings')
    }

    async createSession(projectName: string): Promise<void> {
        await this.clickAria('New conversation')
        await this.waitFor(
            'new-session dialog',
            state => state.dialogs.some(dialog => dialog.startsWith('Create a session')),
        )
        const selected = await this.evaluate<{ selected: boolean; cwd: string }>(`(() => {
            const dialog = document.querySelector('.new-session-dialog');
            const select = dialog?.querySelector('select');
            const cwd = dialog?.querySelector('input[placeholder="/Users/me/Documents/project"]');
            if (!select || !cwd || !cwd.value) return { selected: false, cwd: cwd?.value || '' };
            const existingCwd = cwd.value;
            const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
            if (!selectSetter) return { selected: false, cwd: cwd.value };
            selectSetter.call(select, '__new_project__');
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return { selected: true, cwd: existingCwd };
        })()`)
        assert.equal(selected.selected, true, 'Could not select a new Android Alpha project')
        await waitFor(async () => this.evaluate<boolean>(`(() => {
            const dialog = document.querySelector('.new-session-dialog');
            const project = dialog?.querySelector('input[placeholder="My project"]');
            if (!project || project.disabled) return false;
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (!setter) return false;
            setter.call(project, ${json(projectName)});
            project.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        })()`), {
            description: 'enabled Android Alpha project name',
            timeoutMs: 5_000,
        })
        await waitFor(async () => this.evaluate<boolean>(`(() => {
            const dialog = document.querySelector('.new-session-dialog');
            const cwd = dialog?.querySelector('input[placeholder="/Users/me/Documents/project"]');
            if (!cwd || cwd.disabled) return false;
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (!setter) return false;
            setter.call(cwd, ${json(selected.cwd)});
            cwd.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        })()`), {
            description: 'enabled Android Alpha working directory',
            timeoutMs: 5_000,
        })
        await waitFor(async () => this.evaluate<boolean>(`(() => {
            const dialog = document.querySelector('.new-session-dialog');
            const button = Array.from(dialog?.querySelectorAll('button') || [])
                .find(item => item.textContent?.trim() === 'Create session');
            return Boolean(button && !button.disabled);
        })()`), {
            description: 'enabled Android Create session button',
            timeoutMs: 5_000,
        })
        await this.clickButtonText('Create session', '.new-session-dialog')
    }

    async sendPrompt(prompt: string): Promise<void> {
        const result = await this.evaluate<{ filled: boolean; sent: boolean; disabled: boolean }>(`(() => {
            const textarea = Array.from(document.querySelectorAll('textarea'))
                .find(item => item.getAttribute('aria-label')?.startsWith('Message ') && item.getClientRects().length > 0);
            if (!textarea || textarea.disabled) return { filled: false, sent: false, disabled: Boolean(textarea?.disabled) };
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
            if (!setter) return { filled: false, sent: false, disabled: false };
            setter.call(textarea, ${json(prompt)});
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            const send = Array.from(document.querySelectorAll('button'))
                .find(button => /^(Send|Queue) message$/u.test(button.getAttribute('aria-label') || '') && button.getClientRects().length > 0);
            if (!send || send.disabled) return { filled: true, sent: false, disabled: Boolean(send?.disabled) };
            send.click();
            return { filled: true, sent: true, disabled: false };
        })()`)
        assert.deepEqual(result, { filled: true, sent: true, disabled: false })
    }

    async openProject(projectName: string): Promise<void> {
        const opened = await this.evaluate<boolean>(`(() => {
            const groups = Array.from(document.querySelectorAll('.project-session-group'));
            const group = groups.find(item => item.querySelector('.project-copy strong')?.textContent?.trim() === ${json(projectName)});
            const toggle = group?.querySelector('button.project-session-toggle');
            if (!group || !toggle) return false;
            if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
            const row = group.querySelector('button.session-row');
            if (row && !row.disabled) row.click();
            return Boolean(row && !row.disabled);
        })()`)
        assert.equal(opened, true, `Could not open Android project ${projectName}`)
        await this.waitFor(`selected Android project ${projectName}`, state => state.selectedProject === projectName)
    }

    async restoreSelected(): Promise<void> {
        await this.clickButtonText('Restore')
    }

    private async click(expression: string): Promise<void> {
        const result = await this.evaluate<{ found: boolean; disabled: boolean }>(
            `(() => { ${DOM_HELPERS} return ${expression}; })()`,
        )
        assert.equal(result.found, true, 'The expected Android WebView button was not found')
        assert.equal(result.disabled, false, 'The expected Android WebView button was disabled')
    }

    private call(method: string, params: JsonRecord): Promise<JsonRecord> {
        const id = ++this.nextId
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id)
                reject(new Error(`Timed out waiting for CDP method ${method}.`))
            }, 10_000)
            this.pending.set(id, { resolve, reject, timer })
            this.socket.send(JSON.stringify({ id, method, params }))
        })
    }
}

export async function runAndroidAlphaJourney(
    options: AndroidAlphaJourneyOptions,
): Promise<void> {
    const serial = process.env.CODEVER_ANDROID_SERIAL
    assert.ok(serial, 'CODEVER_ANDROID_SERIAL is required for Alpha release acceptance')
    assert.equal(await adb(serial, 'shell', 'getprop', 'ro.kernel.qemu'), '1', 'Alpha E2E requires an emulator')

    const projectName = `Codever Alpha Android ${options.runId}`
    const backgroundPrompt = `Android background prompt ${options.runId}`
    const browserPrompt = `Browser to Android prompt ${options.runId}`
    const recoveryPrompt = `Android reconnect prompt ${options.runId}`
    const apkPath = join(
        options.repositoryRoot,
        'clients',
        'android',
        'app',
        'build',
        'outputs',
        'apk',
        'e2e',
        'app-e2e.apk',
    )
    let android: AndroidWebView | undefined
    let forwardedDevtoolsPort: string | undefined
    let sessionCreated = false
    let firstSyncGate: FirstSyncGate | undefined

    try {
        process.stdout.write('  [A1/7] Building and installing a fresh isolated Android E2E package…\n')
        await buildE2eApk(options.repositoryRoot, options.pwaUrl)
        await adbMaybe(serial, 'uninstall', PACKAGE_NAME)
        await adb(serial, 'install', '-r', '-t', apkPath)
        await adb(serial, 'shell', 'pm', 'grant', PACKAGE_NAME, 'android.permission.POST_NOTIFICATIONS')
        await adb(serial, 'reverse', `tcp:${options.pwaPort}`, `tcp:${options.pwaPort}`)
        firstSyncGate = await createFirstSyncGate(options.matrixPort)
        await adb(serial, 'reverse', `tcp:${options.matrixPort}`, `tcp:${firstSyncGate.port}`)

        process.stdout.write('  [A2/7] Creating a real one-time invitation and pairing the fresh APK…\n')
        const invitation = await createBrowserDeviceInvitation(
            options.browserPage,
            options.testerPassword,
        )
        await adb(serial, 'shell', 'am', 'start', '-W', '-n', MAIN_ACTIVITY)
        ;({ page: android, port: forwardedDevtoolsPort } = await attachWebView(
            serial,
            options.pwaUrl,
        ))
        await android.navigate(`${options.pwaUrl}/#pair=${encodeURIComponent(invitation.link)}`)
        await android.waitFor(
            'native invitation preview',
            state => state.dialogs.some(dialog => dialog.startsWith('Connect a computer')),
            CONNECT_TIMEOUT_MS,
        )
        if (!invitation.includesMatrixLogin) {
            await android.signInForPairing(options.testerUserId, options.testerPassword)
        }
        await android.clickButtonPrefix('Connect to ')
        process.stdout.write('  [A2a/7] Holding the first native sync beyond its watchdog window…\n')
        await firstSyncGate.waitForInterception()
        await waitFor(
            async () => await diagnosticCount(serial, 'matrix.driver.sync_service_state stage=RUNNING') > 0,
            {
                description: 'running native Matrix sync service behind the first-sync gate',
                timeoutMs: CONNECT_TIMEOUT_MS,
            },
        )
        await delay(7_000)
        const prematureTimeouts = await diagnosticCount(
            serial,
            'matrix.watchdog.failure reason=FIRST_SYNC_TIMEOUT running=true',
        )
        firstSyncGate.release()
        assert.equal(
            prematureTimeouts,
            0,
            'A running internally supervised Matrix sync was killed while its first response was delayed',
        )
        await waitFor(
            async () => await diagnosticCount(serial, 'matrix.transport.ready') > 0,
            {
                description: 'native Matrix transport after releasing the delayed first sync',
                timeoutMs: CONNECT_TIMEOUT_MS,
            },
        )
        await tapNativePairingConfirmation(serial, options.runId)
        const paired = await android.waitFor(
            'fresh native Gateway checkpoint',
            state => state.connection.endsWith('Connected') && state.projectNames.length > 0,
            CONNECT_TIMEOUT_MS,
        )
        assert.ok(paired.bodyText.includes('Recent messages'), 'Fresh APK did not bootstrap existing history')
        await closeBrowserConnectionSettings(options.browserPage)
        await assertForegroundNotification(serial)

        process.stdout.write('  [A3/7] Creating on Android and converging the session into the browser…\n')
        const creationStarted = Date.now()
        await android.createSession(projectName)
        await android.waitFor(
            'immediate native session creation feedback',
            state => state.sessionCreatePending,
            UI_FEEDBACK_TIMEOUT_MS,
        )
        const created = await android.waitFor(
            `Android session ${projectName}`,
            state => state.projectNames.includes(projectName) && state.selectedProject === projectName,
        )
        assert.ok(Date.now() - creationStarted <= CONVERGENCE_TIMEOUT_MS)
        assert.ok(created.selectedSessionId, 'Android did not select its new session')
        sessionCreated = true
        await waitForBrowserProject(options.browserPage, projectName)
        await openBrowserProject(options.browserPage, projectName)

        process.stdout.write('  [A4/7] Completing an Android task in the background and opening its notification…\n')
        const postedBefore = await diagnosticCount(serial, 'notification.task_posted')
        await android.sendPrompt(backgroundPrompt)
        await adb(serial, 'shell', 'input', 'keyevent', 'KEYCODE_HOME')
        await waitForBrowserText(options.browserPage, backgroundPrompt)
        await waitForBrowserText(options.browserPage, options.providerResponse)
        await waitFor(async () => (await taskNotificationKeys(serial)).length === 1, {
            description: 'exactly one Android task completion notification',
            timeoutMs: CONVERGENCE_TIMEOUT_MS,
        })
        assert.equal(await diagnosticCount(serial, 'notification.task_posted'), postedBefore + 1)
        await assertForegroundNotification(serial)
        const returnStarted = Date.now()
        android.close()
        android = undefined
        if (forwardedDevtoolsPort) {
            await adbMaybe(serial, 'forward', '--remove', `tcp:${forwardedDevtoolsPort}`)
            forwardedDevtoolsPort = undefined
        }
        await tapTaskNotification(serial)
        ;({ page: android, port: forwardedDevtoolsPort } = await attachWebView(
            serial,
            options.pwaUrl,
        ))
        const reopened = await android.waitFor(
            'notification deep link with current history',
            state =>
                state.connection.endsWith('Connected') &&
                state.selectedProject === projectName &&
                state.bodyText.includes(backgroundPrompt) &&
                state.bodyText.includes(options.providerResponse),
            RETURN_TIMEOUT_MS,
        )
        assert.ok(Date.now() - returnStarted <= RETURN_TIMEOUT_MS)
        assert.equal(reopened.selectedProject, projectName)
        await waitFor(async () => (await taskNotificationKeys(serial)).length === 0, {
            description: 'task notification auto-cancel after opening',
            timeoutMs: 5_000,
        })

        process.stdout.write('  [A5/7] Verifying foreground suppression and browser-to-APK history sync…\n')
        const foregroundPostedBefore = await diagnosticCount(serial, 'notification.task_posted')
        await sendBrowserPrompt(options.browserPage, browserPrompt)
        await waitForBrowserText(options.browserPage, browserPrompt)
        await android.waitFor(
            'browser prompt on Android',
            state => state.bodyText.includes(browserPrompt),
        )
        await waitForProviderResponseCount(options.browserPage, 2)
        await android.waitFor(
            'browser agent response on Android',
            state => countText(state.bodyText, options.providerResponse) >= 2,
        )
        assert.equal(await diagnosticCount(serial, 'notification.task_posted'), foregroundPostedBefore)
        assert.equal((await taskNotificationKeys(serial)).length, 0)

        process.stdout.write('  [A6/7] Recovering one in-flight Android command across a Matrix disconnect…\n')
        await adb(serial, 'reverse', '--remove', `tcp:${options.matrixPort}`)
        await android.sendPrompt(recoveryPrompt)
        await delay(1_500)
        await adb(serial, 'reverse', `tcp:${options.matrixPort}`, `tcp:${options.matrixPort}`)
        await waitForBrowserText(options.browserPage, recoveryPrompt)
        await waitForProviderResponseCount(options.browserPage, 3)
        await android.waitFor(
            'recovered prompt exactly once on Android',
            state => countText(state.bodyText, recoveryPrompt) === 1 && countText(state.bodyText, options.providerResponse) >= 3,
            CONNECT_TIMEOUT_MS,
        )
        assert.equal(await browserTextCount(options.browserPage, recoveryPrompt), 1)

        process.stdout.write('  [A7/7] Alternating archive/restore/delete across browser and APK, then restarting…\n')
        await archiveBrowserSession(options.browserPage)
        await android.waitFor('browser archive on Android', state => state.archivedBanner)
        await android.restoreSelected()
        await android.waitFor('Android restore', state => !state.archivedBanner && state.projectNames.includes(projectName))
        await waitForBrowserProject(options.browserPage, projectName)
        await deleteBrowserSession(options.browserPage, projectName)
        await android.waitFor(
            'browser deletion on Android',
            state => !state.projectNames.includes(projectName) && !state.archivedProjects.includes(projectName),
        )
        sessionCreated = false

        android.close()
        android = undefined
        if (forwardedDevtoolsPort) {
            await adbMaybe(serial, 'forward', '--remove', `tcp:${forwardedDevtoolsPort}`)
            forwardedDevtoolsPort = undefined
        }
        await adb(serial, 'shell', 'am', 'force-stop', PACKAGE_NAME)
        await adb(serial, 'shell', 'am', 'start', '-W', '-n', MAIN_ACTIVITY)
        ;({ page: android, port: forwardedDevtoolsPort } = await attachWebView(serial, options.pwaUrl))
        await android.waitFor(
            'durable cross-device deletion after Android process restart',
            state =>
                state.connection.endsWith('Connected') &&
                !state.projectNames.includes(projectName) &&
                !state.archivedProjects.includes(projectName),
            CONNECT_TIMEOUT_MS,
        )

        const versionName = await installedVersionName(serial)
        await mkdir(options.artifactDirectory, { recursive: true })
        await writeFile(join(options.artifactDirectory, 'alpha-result.json'), JSON.stringify({
            status: 'passed',
            runId: options.runId,
            sourceRevision: await gitRevision(options.repositoryRoot),
            pwaUrl: options.pwaUrl,
            androidPackage: PACKAGE_NAME,
            androidVersionName: versionName,
            protocol: 'matrix-native-v2',
            journeys: [
                'browser-offline-cache-recovery',
                'fresh-native-pairing',
                'delayed-first-native-sync-recovery',
                'browser-android-session-sync',
                'background-task-notification',
                'notification-deep-link-recovery',
                'foreground-notification-suppression',
                'in-flight-matrix-recovery-exactly-once',
                'cross-device-archive-restore-delete',
                'android-process-restart',
            ],
        }, null, 2), 'utf8')
        process.stdout.write(`  Alpha APK ${versionName} passed fresh pairing, cross-device, background, notification, and recovery acceptance.\n`)
    } catch (error) {
        await captureFailureArtifacts(options, serial, android).catch(artifactError => {
            process.stderr.write(
                `Could not capture all Android Alpha failure artifacts: ${formatError(artifactError)}\n`,
            )
        })
        throw error
    } finally {
        if (sessionCreated) {
            await cleanupBrowserProject(options.browserPage, projectName).catch(() => undefined)
        }
        android?.close()
        if (forwardedDevtoolsPort) {
            await adbMaybe(serial, 'forward', '--remove', `tcp:${forwardedDevtoolsPort}`)
        }
        await adbMaybe(serial, 'reverse', '--remove', `tcp:${options.pwaPort}`)
        await adbMaybe(serial, 'reverse', '--remove', `tcp:${options.matrixPort}`)
        firstSyncGate?.release()
        await firstSyncGate?.close().catch(() => undefined)
    }
}

async function createFirstSyncGate(targetPort: number): Promise<FirstSyncGate> {
    let released = false
    let intercepted = 0
    let releaseGate: (() => void) | undefined
    const gate = new Promise<void>(resolve => {
        releaseGate = resolve
    })
    const server = createHttpServer(async (incoming, outgoing) => {
        const requestPath = incoming.url ?? '/'
        if (isMatrixSyncRequest(requestPath) && !released) {
            intercepted += 1
            await gate
        }
        if (incoming.destroyed) return

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
            outgoing.writeHead(response.statusCode ?? 502, response.statusMessage, response.headers)
            response.pipe(outgoing)
        })
        upstream.on('error', error => {
            if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'text/plain' })
            outgoing.end(`Matrix E2E proxy failed: ${formatError(error)}`)
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
        port: address.port,
        intercepted: () => intercepted,
        waitForInterception: () => waitFor(() => intercepted > 0, {
            description: 'the APK first Matrix sync request to reach the delay gate',
            timeoutMs: CONNECT_TIMEOUT_MS,
        }),
        release: () => {
            if (released) return
            released = true
            releaseGate?.()
        },
        close: () => closeHttpServer(server),
    }
}

function isMatrixSyncRequest(path: string): boolean {
    return /^\/_matrix\/client\/(?:v3|unstable\/[^/]+)\/sync(?:\?|$)/u.test(path)
}

async function closeHttpServer(server: HttpServer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
        server.closeAllConnections()
    })
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

const ANDROID_PAGE_STATE = `(() => {
    const normalized = value => String(value || '').replace(/\\s+/gu, ' ').trim();
    const connection = Array.from(document.querySelectorAll('button'))
        .find(button => button.getAttribute('aria-label')?.startsWith('Open connection settings,'));
    const selected = document.querySelector('button.session-row.selected, button.archived-session-row.selected');
    return {
        connection: connection?.getAttribute('aria-label') || '',
        selectedProject: selected?.dataset.projectName || normalized(document.querySelector('.conversation-heading span')?.textContent?.split('·')[0]),
        projectNames: Array.from(document.querySelectorAll('.project-session-group .project-copy strong'))
            .map(element => normalized(element.textContent)),
        archivedProjects: Array.from(document.querySelectorAll('button.archived-session-row'))
            .map(element => element.dataset.projectName || ''),
        archivedBanner: Boolean(document.querySelector('.archived-session-banner')),
        sessionCreatePending: Boolean(document.querySelector('.session-create-pending')),
        selectedSessionId: selected?.dataset.sessionId || '',
        selectedSessionCount: document.querySelectorAll('button.session-row.selected, button.archived-session-row.selected').length,
        mobileChatOpen: document.querySelector('.app-shell')?.classList.contains('mobile-chat-open') || false,
        dialogs: Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'))
            .map(element => normalized(element.querySelector('h2')?.textContent || element.textContent || '')),
        alerts: Array.from(document.querySelectorAll('[role="alert"]')).map(element => normalized(element.textContent)),
        bodyText: normalized(document.body?.innerText),
    };
})()`

async function buildE2eApk(repositoryRoot: string, pwaUrl: string): Promise<void> {
    await execFileAsync('./gradlew', [':app:assembleE2e'], {
        cwd: join(repositoryRoot, 'clients', 'android'),
        env: { ...process.env, CODEVER_ANDROID_E2E_WEB_ORIGIN: pwaUrl },
        encoding: 'utf8',
        timeout: 180_000,
        maxBuffer: 16 * 1024 * 1024,
    })
}

async function createBrowserDeviceInvitation(
    page: Page,
    password: string,
): Promise<{ link: string; includesMatrixLogin: boolean }> {
    await page.locator('button[aria-label^="Open connection settings,"]').click()
    const dialog = page.getByRole('dialog', { name: 'Connection' })
    await dialog.waitFor({ state: 'visible' })
    await dialog.getByRole('button', { name: 'Add another device' }).click()
    const invitation = dialog.locator('.generated-device-invitation')
    const reauth = dialog.locator('.invitation-reauth')
    await waitFor(async () =>
        await invitation.isVisible().catch(() => false) || await reauth.isVisible().catch(() => false), {
        description: 'one-time Android invitation or Matrix reauthentication',
        timeoutMs: CONNECT_TIMEOUT_MS,
    })
    if (await reauth.isVisible().catch(() => false)) {
        await reauth.locator('input[type="password"]').fill(password)
        await reauth.getByRole('button', { name: 'Create secure invitation' }).click()
    }
    await invitation.waitFor({ state: 'visible', timeout: CONNECT_TIMEOUT_MS })
    const copy = await invitation.textContent() ?? ''
    const includesMatrixLogin = /automatically signs in the new device/iu.test(copy)
    assert.ok(
        includesMatrixLogin || /new device will ask you to sign in/iu.test(copy),
        'The invitation did not explain how the new device will sign in',
    )
    const link = await invitation.locator('textarea').inputValue()
    assert.ok(link, 'The browser did not produce a one-time Android invitation link')
    return { link, includesMatrixLogin }
}

async function closeBrowserConnectionSettings(page: Page): Promise<void> {
    const done = page.getByRole('button', { name: 'Done', exact: true })
    if (await done.isVisible().catch(() => false)) await done.click()
    const close = page.getByRole('button', { name: 'Close connection settings' })
    if (await close.isVisible().catch(() => false)) await close.click()
}

async function waitForBrowserProject(page: Page, projectName: string): Promise<void> {
    await waitFor(async () => await browserProjectGroup(page, projectName).count() === 1, {
        description: `browser project ${projectName}`,
        timeoutMs: CONVERGENCE_TIMEOUT_MS,
    })
    await assertBrowserHealthy(page)
}

async function openBrowserProject(page: Page, projectName: string): Promise<void> {
    const group = browserProjectGroup(page, projectName)
    const toggle = group.locator('button.project-session-toggle')
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
    await group.locator('button.session-row').first().click()
    await page.locator('.conversation-heading span', { hasText: projectName }).waitFor({
        state: 'visible',
        timeout: UI_FEEDBACK_TIMEOUT_MS,
    })
}

function browserProjectGroup(page: Page, projectName: string) {
    return page.locator('.project-session-group').filter({
        has: page.locator('.project-copy strong', {
            hasText: new RegExp(`^${escapeRegex(projectName)}$`, 'u'),
        }),
    })
}

async function sendBrowserPrompt(page: Page, prompt: string): Promise<void> {
    const composer = page.locator('textarea[aria-label^="Message "]')
    await composer.fill(prompt)
    await page.getByRole('button', { name: 'Send message' }).click()
}

async function waitForBrowserText(page: Page, text: string): Promise<void> {
    await waitFor(async () => await browserTextCount(page, text) > 0, {
        description: `browser text ${JSON.stringify(text)}`,
        timeoutMs: CONVERGENCE_TIMEOUT_MS,
    })
    await assertBrowserHealthy(page)
}

async function browserTextCount(page: Page, text: string): Promise<number> {
    return page.locator('.chat-feed').getByText(text, { exact: true }).count()
}

async function waitForProviderResponseCount(page: Page, count: number): Promise<void> {
    await waitFor(async () => await browserTextCount(page, 'Codever deterministic E2E response') >= count, {
        description: `${count} deterministic provider responses`,
        timeoutMs: CONNECT_TIMEOUT_MS,
    })
}

async function archiveBrowserSession(page: Page): Promise<void> {
    const details = page.getByRole('button', { name: 'Conversation details' })
    if (await details.getAttribute('aria-expanded') !== 'true') await details.click()
    await page.getByRole('button').filter({
        has: page.locator('strong', { hasText: /^Archive session$/u }),
    }).click()
    await page.locator('.archived-session-banner').waitFor({ state: 'visible', timeout: CONVERGENCE_TIMEOUT_MS })
}

async function deleteBrowserSession(page: Page, projectName: string): Promise<void> {
    const details = page.getByRole('button', { name: 'Conversation details' })
    if (await details.getAttribute('aria-expanded') !== 'true') await details.click()
    await page.getByRole('button').filter({
        has: page.locator('strong', { hasText: /^Delete session$/u }),
    }).click()
    const dialog = page.getByRole('alertdialog')
    await dialog.getByRole('button', { name: 'Delete session', exact: true }).click()
    await waitFor(async () => await browserProjectGroup(page, projectName).count() === 0, {
        description: `browser deletion of ${projectName}`,
        timeoutMs: CONVERGENCE_TIMEOUT_MS,
    })
}

async function cleanupBrowserProject(page: Page, projectName: string): Promise<void> {
    if (await browserProjectGroup(page, projectName).count() === 0) return
    await openBrowserProject(page, projectName)
    await deleteBrowserSession(page, projectName)
}

async function assertBrowserHealthy(page: Page): Promise<void> {
    const alerts = await page.locator('[role="alert"]').allTextContents()
    const blocking = alerts.filter(alert =>
        /history could not be restored|native bridge did not answer|matrix runtime failed|needs review|must be acknowledged|previous action|connected device did not respond|too many requests/iu.test(alert),
    )
    assert.deepEqual(blocking, [], `Blocking browser alert appeared: ${blocking.join(' | ')}`)
}

function assertHealthy(state: AndroidPageState): void {
    const blocking = state.alerts.filter(alert =>
        /history could not be restored|native bridge did not answer|matrix runtime failed|needs review|must be acknowledged|previous action|connected device did not respond|too many requests/iu.test(alert),
    )
    assert.deepEqual(blocking, [], `Blocking Android alert appeared: ${blocking.join(' | ')}`)
}

async function attachWebView(
    serial: string,
    pwaUrl: string,
): Promise<{ page: AndroidWebView; port: string }> {
    const deadline = Date.now() + CONNECT_TIMEOUT_MS
    let lastError = 'WebView process did not start'
    while (Date.now() < deadline) {
        const pid = await adbMaybe(serial, 'shell', 'pidof', PACKAGE_NAME)
        if (!pid) {
            await delay(250)
            continue
        }
        const socket = `webview_devtools_remote_${pid.split(/\s+/u)[0]}`
        const port = await adbMaybe(serial, 'forward', 'tcp:0', `localabstract:${socket}`)
        if (!port) {
            await delay(250)
            continue
        }
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/list`)
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const targets = await response.json() as CdpTarget[]
            const target = targets.find(candidate => candidate.type === 'page' && candidate.url.startsWith(pwaUrl))
            if (!target?.webSocketDebuggerUrl) throw new Error('The Alpha WebView page target is not ready')
            return { page: await AndroidWebView.connect(target.webSocketDebuggerUrl), port }
        } catch (error) {
            lastError = formatError(error)
            await adbMaybe(serial, 'forward', '--remove', `tcp:${port}`)
            await delay(250)
        }
    }
    throw new Error(`Timed out attaching to the Alpha WebView: ${lastError}`)
}

async function assertForegroundNotification(serial: string): Promise<void> {
    const keys = await notificationKeys(serial)
    assert.ok(
        keys.some(key => key.packageName === PACKAGE_NAME && key.id === FOREGROUND_NOTIFICATION_ID),
        'The persistent Android foreground-service notification is missing',
    )
}

async function taskNotificationKeys(serial: string): Promise<NotificationKey[]> {
    return (await notificationKeys(serial)).filter(key =>
        key.packageName === PACKAGE_NAME && key.id !== FOREGROUND_NOTIFICATION_ID,
    )
}

type NotificationKey = { raw: string; packageName: string; id: string }

async function notificationKeys(serial: string): Promise<NotificationKey[]> {
    const output = await adb(serial, 'shell', 'cmd', 'notification', 'list')
    return output.split(/\r?\n/u).flatMap(raw => {
        const fields = raw.trim().split('|')
        return fields.length >= 3
            ? [{ raw: raw.trim(), packageName: fields[1] ?? '', id: fields[2] ?? '' }]
            : []
    })
}

async function tapTaskNotification(serial: string): Promise<void> {
    await adb(serial, 'shell', 'cmd', 'statusbar', 'expand-notifications')
    await delay(750)
    const path = '/sdcard/codever-alpha-notifications.xml'
    await adb(serial, 'shell', 'uiautomator', 'dump', path)
    const xml = await adb(serial, 'shell', 'cat', path)
    const escapedTitle = escapeRegex(TASK_NOTIFICATION_TITLE)
    const match = xml.match(new RegExp(`text="${escapedTitle}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`, 'u'))
        ?? xml.match(new RegExp(`bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"[^>]*text="${escapedTitle}"`, 'u'))
    assert.ok(match, `Could not find the ${TASK_NOTIFICATION_TITLE} notification in System UI`)
    const [, left, top, right, bottom] = match.map(Number)
    await adb(serial, 'shell', 'input', 'tap', String(Math.floor((left + right) / 2)), String(Math.floor((top + bottom) / 2)))
}

async function tapNativePairingConfirmation(serial: string, runId: string): Promise<void> {
    const deadline = Date.now() + CONNECT_TIMEOUT_MS
    const path = '/sdcard/codever-alpha-pairing.xml'
    while (Date.now() < deadline) {
        await adbMaybe(serial, 'shell', 'uiautomator', 'dump', path)
        const xml = await adbMaybe(serial, 'shell', 'cat', path)
        if (!xml.includes(`Pair with Codever E2E Gateway ${runId}?`)) {
            await delay(200)
            continue
        }
        const match = xml.match(/resource-id="android:id\/button1"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/u)
            ?? xml.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*resource-id="android:id\/button1"/u)
        assert.ok(match, 'The native pairing confirmation did not expose its Pair action')
        const [, left, top, right, bottom] = match.map(Number)
        await adb(
            serial,
            'shell',
            'input',
            'tap',
            String(Math.floor((left + right) / 2)),
            String(Math.floor((top + bottom) / 2)),
        )
        return
    }
    throw new Error('Timed out waiting for the native Android pairing confirmation.')
}

async function diagnosticCount(serial: string, marker: string): Promise<number> {
    const output = await adbMaybe(
        serial,
        'exec-out',
        'run-as',
        PACKAGE_NAME,
        'sh',
        '-c',
        'cat files/diagnostics/native-previous.log files/diagnostics/native-current.log 2>/dev/null',
    )
    return output.split(/\r?\n/u).filter(line => line.includes(marker)).length
}

async function installedVersionName(serial: string): Promise<string> {
    const output = await adb(serial, 'shell', 'dumpsys', 'package', PACKAGE_NAME)
    const match = output.match(/versionName=([^\s]+)/u)
    assert.ok(match?.[1], 'The installed Alpha APK version is unavailable')
    return match[1]
}

async function gitRevision(repositoryRoot: string): Promise<string> {
    const result = await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
    })
    return result.stdout.trim()
}

async function captureFailureArtifacts(
    options: AndroidAlphaJourneyOptions,
    serial: string,
    android: AndroidWebView | undefined,
): Promise<void> {
    await mkdir(options.artifactDirectory, { recursive: true })
    const state = android ? await android.state().catch(() => null) : null
    const diagnostics = await adbMaybe(
        serial,
        'exec-out',
        'run-as',
        PACKAGE_NAME,
        'sh',
        '-c',
        'cat files/diagnostics/native-previous.log files/diagnostics/native-current.log 2>/dev/null',
    )
    const notifications = await adbMaybe(serial, 'shell', 'dumpsys', 'notification', '--noredact')
    await Promise.all([
        writeFile(join(options.artifactDirectory, 'android-state.json'), JSON.stringify(state, null, 2), 'utf8'),
        writeFile(join(options.artifactDirectory, 'android-native.log'), diagnostics, 'utf8'),
        writeFile(join(options.artifactDirectory, 'android-notifications.log'), notifications, 'utf8'),
        options.browserPage.screenshot({
            path: join(options.artifactDirectory, 'alpha-browser.png'),
            fullPage: true,
        }).catch(() => undefined),
    ])
    await adbBuffer(serial, 'exec-out', 'screencap', '-p').then(async screenshot => {
        if (screenshot.length > 0) {
            await writeFile(join(options.artifactDirectory, 'alpha-android-screen.png'), screenshot)
        }
    }).catch(() => undefined)
    process.stderr.write(`Android Alpha failure artifacts: ${options.artifactDirectory}\n`)
}

async function adb(serial: string, ...args: string[]): Promise<string> {
    const result = await execFileAsync('adb', ['-s', serial, ...args], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
    })
    return result.stdout.trim()
}

async function adbMaybe(serial: string, ...args: string[]): Promise<string> {
    try {
        return await adb(serial, ...args)
    } catch {
        return ''
    }
}

async function adbBuffer(serial: string, ...args: string[]): Promise<Buffer> {
    const result = await execFileAsync('adb', ['-s', serial, ...args], {
        encoding: null,
        maxBuffer: 16 * 1024 * 1024,
    })
    return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout)
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
        await delay(150)
    }
    throw new Error(
        `Timed out waiting for ${options.description}`
        + (lastError ? `: ${formatError(lastError)}` : ''),
    )
}

function countText(haystack: string, needle: string): number {
    if (!needle) return 0
    return haystack.split(needle).length - 1
}

function json(value: string): string {
    return JSON.stringify(value)
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
