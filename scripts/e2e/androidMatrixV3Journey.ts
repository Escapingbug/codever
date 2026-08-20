import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Page } from 'playwright-core'

const execFileAsync = promisify(execFile)
const PACKAGE_NAME = 'id.my.anciety.codever.e2e'
const MAIN_ACTIVITY = `${PACKAGE_NAME}/id.my.anciety.codever.web.MainActivity`
const FOREGROUND_NOTIFICATION_ID = '1101'
const CONNECT_TIMEOUT_MS = 90_000
const CONVERGENCE_TIMEOUT_MS = 25_000

type JsonRecord = Record<string, unknown>
type PendingCall = {
    resolve(value: JsonRecord): void
    reject(error: Error): void
    timer: ReturnType<typeof setTimeout>
}

type AndroidState = {
    connected: boolean
    sessionIds: string[]
    selectedSessionId: string
    createPending: boolean
    bodyText: string
    alerts: string[]
}

export type AndroidMatrixV3JourneyOptions = {
    repositoryRoot: string
    serial: string
    pwaUrl: string
    pwaPort: number
    matrixPort: number
    pairingLink: string
    gatewayName: string
    matrixUserId: string
    matrixPassword: string
    browserPage: Page
    existingSessionId: string
    providerResponse: string
    runId: string
}

class WebViewPage {
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
            if (response.error) call.reject(new Error(JSON.stringify(response.error)))
            else call.resolve(response)
        })
        socket.addEventListener('close', () => {
            for (const call of this.pending.values()) {
                clearTimeout(call.timer)
                call.reject(new Error('The Android WebView debugger closed.'))
            }
            this.pending.clear()
        })
    }

    static async connect(url: string): Promise<WebViewPage> {
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
        return new WebViewPage(socket)
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
        const outer = response.result as JsonRecord | undefined
        if (outer?.exceptionDetails) {
            throw new Error(`WebView evaluation failed: ${JSON.stringify(outer.exceptionDetails)}`)
        }
        return (outer?.result as JsonRecord | undefined)?.value as T
    }

    state(): Promise<AndroidState> {
        return this.evaluate<AndroidState>(`(() => {
            const normalized = value => String(value || '').replace(/\\s+/gu, ' ').trim();
            const selected = document.querySelector('button.session-row[aria-pressed="true"]');
            const connection = document.querySelector('button[aria-label^="Open connection settings,"]');
            return {
                connected: Boolean(connection?.getAttribute('aria-label')?.endsWith('Connected')),
                sessionIds: Array.from(document.querySelectorAll('button.session-row'))
                    .map(row => row.dataset.sessionId || '').filter(Boolean),
                selectedSessionId: selected?.dataset.sessionId || '',
                createPending: Boolean(document.querySelector('.session-create-pending')),
                bodyText: normalized(document.body?.innerText),
                alerts: Array.from(document.querySelectorAll('[role="alert"]'))
                    .map(element => normalized(element.textContent)),
            };
        })()`)
    }

    async navigate(url: string): Promise<void> {
        await this.evaluate(`location.assign(${JSON.stringify(url)}); true`)
    }

    async clickButton(
        label: string,
        options: { prefix?: boolean; container?: string } = {},
    ): Promise<void> {
        const clicked = await this.evaluate<boolean>(`(() => {
            const normalized = value => String(value || '').replace(/\\s+/gu, ' ').trim();
            const root = ${options.container
                ? `document.querySelector(${JSON.stringify(options.container)})`
                : 'document'};
            const target = root && Array.from(root.querySelectorAll('button')).find(button => {
                const accessible = normalized(button.getAttribute('aria-label') || button.textContent);
                const primary = normalized(button.querySelector('strong')?.textContent);
                return ${options.prefix
                    ? `(accessible.startsWith(${JSON.stringify(label)}) || primary.startsWith(${JSON.stringify(label)}))`
                    : `(accessible === ${JSON.stringify(label)} || primary === ${JSON.stringify(label)})`}
                    && !button.disabled && button.getClientRects().length > 0;
            });
            if (!target) return false;
            target.click();
            return true;
        })()`)
        assert.equal(clicked, true, `Android button was unavailable: ${label}`)
    }

    async clickSession(sessionId: string): Promise<void> {
        const clicked = await this.evaluate<boolean>(`(() => {
            const target = document.querySelector(
                'button.session-row[data-session-id="' + CSS.escape(${JSON.stringify(sessionId)}) + '"]'
            );
            if (!target) return false;
            const group = target.closest('.project-session-group');
            const toggle = group?.querySelector('button.project-session-toggle');
            if (toggle?.getAttribute('aria-expanded') !== 'true') toggle?.click();
            target.click();
            return true;
        })()`)
        assert.equal(clicked, true, `Android session was unavailable: ${sessionId}`)
    }

    async fillComposer(text: string): Promise<void> {
        const filled = await this.evaluate<boolean>(`(() => {
            const target = Array.from(document.querySelectorAll('textarea')).find(
                element => element.getAttribute('aria-label')?.startsWith('Message ')
                    && element.getClientRects().length > 0
            );
            if (!target) return false;
            const setter = Object.getOwnPropertyDescriptor(
                HTMLTextAreaElement.prototype,
                'value',
            )?.set;
            setter?.call(target, ${JSON.stringify(text)});
            target.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        })()`)
        assert.equal(filled, true, 'The Android composer was unavailable.')
    }

    async fillInput(placeholder: string, value: string): Promise<void> {
        const filled = await this.evaluate<boolean>(`(() => {
            const target = document.querySelector(
                'input[placeholder=' + JSON.stringify(${JSON.stringify(placeholder)}) + ']'
            );
            if (!target) return false;
            const setter = Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype,
                'value',
            )?.set;
            setter?.call(target, ${JSON.stringify(value)});
            target.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        })()`)
        assert.equal(filled, true, `Android input was unavailable: ${placeholder}`)
    }

    hasInput(placeholder: string): Promise<boolean> {
        return this.evaluate<boolean>(`Boolean(document.querySelector(
            'input[placeholder=' + JSON.stringify(${JSON.stringify(placeholder)}) + ']'
        ))`)
    }

    hasButton(label: string): Promise<boolean> {
        return this.evaluate<boolean>(`(() => {
            const normalized = value => String(value || '').replace(/\\s+/gu, ' ').trim();
            return Array.from(document.querySelectorAll('button')).some(button =>
                (
                    normalized(button.getAttribute('aria-label') || button.textContent)
                        === ${JSON.stringify(label)}
                    || normalized(button.querySelector('strong')?.textContent)
                        === ${JSON.stringify(label)}
                )
                && !button.disabled
                && button.getClientRects().length > 0
            );
        })()`)
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

export async function runAndroidMatrixV3Journey(
    options: AndroidMatrixV3JourneyOptions,
): Promise<void> {
    assert.equal(
        await adb(options.serial, 'shell', 'getprop', 'ro.kernel.qemu'),
        '1',
        'The v3 Android acceptance journey requires an emulator.',
    )
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
    let android: WebViewPage | undefined
    let forwardedPort: string | undefined
    try {
        process.stdout.write('  [A1/6] Building and installing the isolated v3 APK…\n')
        await execFileAsync('./gradlew', [':app:assembleE2e'], {
            cwd: join(options.repositoryRoot, 'clients', 'android'),
            env: { ...process.env, CODEVER_ANDROID_E2E_WEB_ORIGIN: options.pwaUrl },
            encoding: 'utf8',
            timeout: 180_000,
            maxBuffer: 16 * 1024 * 1024,
        })
        await adbMaybe(options.serial, 'uninstall', PACKAGE_NAME)
        await adb(options.serial, 'install', '-r', '-t', apkPath)
        await adb(
            options.serial,
            'shell',
            'pm',
            'grant',
            PACKAGE_NAME,
            'android.permission.POST_NOTIFICATIONS',
        )
        await reverse(options.serial, options.pwaPort)
        await reverse(options.serial, options.matrixPort)

        process.stdout.write('  [A2/6] Pairing native v3 and restoring existing Matrix history…\n')
        await startActivity(options.serial)
        ;({ page: android, port: forwardedPort } = await attachWebView(
            options.serial,
            options.pwaUrl,
        ))
        await android.navigate(
            `${options.pwaUrl}/#pair=${encodeURIComponent(options.pairingLink)}`,
        )
        await waitFor(async () => {
            const state = await android!.state()
            assertHealthy(state)
            return state.bodyText.includes(`Connect to ${options.gatewayName}`)
                || await android!.hasInput('@you:example.org')
        }, 'native pairing preview', CONNECT_TIMEOUT_MS)
        const preview = await android.state()
        if (!preview.bodyText.includes(`Connect to ${options.gatewayName}`)) {
            await android.fillInput('@you:example.org', options.matrixUserId)
            await android.fillInput('Your account password', options.matrixPassword)
            await android.clickButton('Sign in')
            await waitFor(
                async () => (await android!.state()).bodyText.includes(
                    `Connect to ${options.gatewayName}`,
                ),
                'native Matrix sign-in before pairing',
                CONNECT_TIMEOUT_MS,
            )
        }
        await android.clickButton(`Connect to ${options.gatewayName}`)
        await tapNativePairingConfirmation(options.serial, options.gatewayName)
        await waitFor(async () => {
            const state = await android!.state()
            assertHealthy(state)
            return state.connected && state.sessionIds.includes(options.existingSessionId)
        }, 'connected native v3 projection', CONNECT_TIMEOUT_MS)
        await android.clickSession(options.existingSessionId)
        await waitFor(
            async () => (await android!.state()).bodyText.includes(options.providerResponse),
            'native Matrix thread history',
            CONVERGENCE_TIMEOUT_MS,
        )
        await assertForegroundNotification(options.serial)

        process.stdout.write('  [A3/6] Creating in Android and converging the session into the browser…\n')
        const before = new Set((await android.state()).sessionIds)
        await android.clickButton('New conversation')
        await android.clickButton('Create session')
        let createdSessionId = ''
        await waitFor(async () => {
            const state = await android!.state()
            assertHealthy(state)
            if (
                state.createPending
                || !state.selectedSessionId
                || before.has(state.selectedSessionId)
                || !state.sessionIds.includes(state.selectedSessionId)
            ) return false
            // An older session can finish cold-start convergence in the same
            // window. The create result is the newly selected session, not
            // necessarily the only row added since the pre-click sample.
            createdSessionId = state.selectedSessionId
            return true
        }, 'one Android-created v3 session', CONVERGENCE_TIMEOUT_MS)
        await waitFor(
            async () => (await browserSessionIds(options.browserPage)).includes(createdSessionId),
            'browser convergence of the Android session',
            CONVERGENCE_TIMEOUT_MS,
        )

        process.stdout.write('  [A4/6] Completing an Android task while its Activity is backgrounded…\n')
        await android.clickSession(createdSessionId)
        const prompt = `v3 Android background prompt ${options.runId}`
        await android.fillComposer(prompt)
        await android.clickButton('Send message')
        await adb(options.serial, 'shell', 'input', 'keyevent', 'KEYCODE_HOME')
        await openBrowserSession(options.browserPage, createdSessionId)
        await waitFor(
            () => options.browserPage.locator('.chat-feed').getByText(prompt, { exact: false }).isVisible(),
            'Android prompt on the browser',
            CONVERGENCE_TIMEOUT_MS,
        )
        await waitFor(
            () => options.browserPage.locator('.chat-feed').getByText(
                options.providerResponse,
                { exact: false },
            ).last().isVisible(),
            'Agent response on the browser',
            CONVERGENCE_TIMEOUT_MS,
        )
        await waitFor(
            async () => (await notificationIds(options.serial)).some(
                id => id !== FOREGROUND_NOTIFICATION_ID,
            ),
            'Android task-completion notification',
            CONVERGENCE_TIMEOUT_MS,
        )
        await assertForegroundNotification(options.serial)

        process.stdout.write('  [A5/6] Restarting and rebuilding the conversation from durable v3 state…\n')
        android.close()
        android = undefined
        if (forwardedPort) {
            await adbMaybe(options.serial, 'forward', '--remove', `tcp:${forwardedPort}`)
        }
        forwardedPort = undefined
        await adb(options.serial, 'shell', 'am', 'force-stop', PACKAGE_NAME)
        await startActivity(options.serial)
        ;({ page: android, port: forwardedPort } = await attachWebView(
            options.serial,
            options.pwaUrl,
        ))
        await waitFor(async () => {
            const state = await android!.state()
            assertHealthy(state)
            return state.connected && state.sessionIds.includes(createdSessionId)
        }, 'native v3 restart recovery', CONNECT_TIMEOUT_MS)
        await android.clickSession(createdSessionId)
        await waitFor(async () => {
            const body = (await android!.state()).bodyText
            return body.includes(prompt) && body.includes(options.providerResponse)
        }, 'native durable thread after restart', CONVERGENCE_TIMEOUT_MS)

        process.stdout.write('  [A6/6] Deleting from Android and converging into the browser…\n')
        await android.clickButton('Conversation details')
        await waitFor(
            () => android!.hasButton('Delete session'),
            'Android conversation actions',
            5_000,
        )
        await android.clickButton('Delete session')
        await waitFor(
            async () => (await android!.state()).bodyText.includes('Copies already stored'),
            'Android delete confirmation',
            5_000,
        )
        await android.clickButton('Delete session', { container: '[role="alertdialog"]' })
        await waitFor(
            async () => !(await android!.state()).sessionIds.includes(createdSessionId),
            'Android session deletion',
            CONVERGENCE_TIMEOUT_MS,
        )
        await waitFor(
            async () => !(await browserSessionIds(options.browserPage)).includes(createdSessionId),
            'browser convergence of Android deletion',
            CONVERGENCE_TIMEOUT_MS,
        )
        process.stdout.write(
            '  PASS — Android v3 paired, restored, ran in background, notified, restarted, and deleted.\n',
        )
    } finally {
        android?.close()
        if (forwardedPort) {
            await adbMaybe(options.serial, 'forward', '--remove', `tcp:${forwardedPort}`)
        }
        await adbMaybe(options.serial, 'shell', 'am', 'force-stop', PACKAGE_NAME)
    }
}

async function attachWebView(
    serial: string,
    pwaUrl: string,
): Promise<{ page: WebViewPage; port: string }> {
    const deadline = Date.now() + CONNECT_TIMEOUT_MS
    let lastError = 'WebView process did not start'
    // `am start` can succeed while Android later kills the newborn process
    // with "failed to attach" / "start timeout" under emulator load. Waiting
    // for DevTools alone can never recover that OS-level launch failure, so
    // retry the Activity after the process disappears. This is not a retry of
    // pairing or a business command; the service-owned durable state remains
    // the same across launches.
    let nextRelaunchAt = Date.now() + 12_000
    while (Date.now() < deadline) {
        const pid = (await adbMaybe(serial, 'shell', 'pidof', PACKAGE_NAME)).split(/\s+/u)[0]
        if (!pid) {
            if (Date.now() >= nextRelaunchAt) {
                lastError = 'Android killed the Activity process before WebView attached; relaunching'
                await startActivity(serial)
                nextRelaunchAt = Date.now() + 12_000
            }
            await delay(250)
            continue
        }
        const port = await adbMaybe(
            serial,
            'forward',
            'tcp:0',
            `localabstract:webview_devtools_remote_${pid}`,
        )
        if (!port) {
            await delay(250)
            continue
        }
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/list`)
            const targets = await response.json() as Array<{
                type?: string
                url?: string
                webSocketDebuggerUrl?: string
            }>
            const target = targets.find(candidate =>
                candidate.type === 'page' && candidate.url?.startsWith(pwaUrl),
            )
            if (!target?.webSocketDebuggerUrl) throw new Error('The v3 WebView page is not ready.')
            return { page: await WebViewPage.connect(target.webSocketDebuggerUrl), port }
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error)
            await adbMaybe(serial, 'forward', '--remove', `tcp:${port}`)
            await delay(250)
        }
    }
    throw new Error(`Timed out attaching to the v3 Android WebView: ${lastError}`)
}

async function tapNativePairingConfirmation(serial: string, gatewayName: string): Promise<void> {
    const deadline = Date.now() + CONNECT_TIMEOUT_MS
    const path = '/sdcard/codever-v3-pairing.xml'
    while (Date.now() < deadline) {
        await adbMaybe(serial, 'shell', 'uiautomator', 'dump', path)
        const xml = await adbMaybe(serial, 'shell', 'cat', path)
        if (!xml.includes(`Pair with ${gatewayName}?`)) {
            await delay(250)
            continue
        }
        const match = xml.match(
            /resource-id="android:id\/button1"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/u,
        ) ?? xml.match(
            /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*resource-id="android:id\/button1"/u,
        )
        assert.ok(match, 'The native v3 pairing dialog did not expose its Pair action.')
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
    throw new Error('Timed out confirming native v3 pairing.')
}

async function openBrowserSession(page: Page, sessionId: string): Promise<void> {
    const row = page.locator(`button.session-row[data-session-id="${sessionId}"]`)
    await row.waitFor({ state: 'attached', timeout: CONVERGENCE_TIMEOUT_MS })
    const group = page.locator('.project-session-group').filter({ has: row })
    const toggle = group.locator('button.project-session-toggle')
    if (await toggle.count() > 0 && await toggle.getAttribute('aria-expanded') !== 'true') {
        await toggle.click()
    }
    if (await row.getAttribute('aria-pressed') !== 'true') await row.click()
}

async function browserSessionIds(page: Page): Promise<string[]> {
    return page.locator('button.session-row').evaluateAll(rows => rows.flatMap(row => {
        const id = (row as HTMLElement).dataset.sessionId
        return id ? [id] : []
    }))
}

function assertHealthy(state: AndroidState): void {
    const blocking = state.alerts.filter(alert =>
        /could not|failed|needs review|must be acknowledged|previous action|did not acknowledge|too many requests/iu.test(alert),
    )
    assert.deepEqual(blocking, [], `Blocking Android alert: ${blocking.join(' | ')}`)
}

async function assertForegroundNotification(serial: string): Promise<void> {
    assert.ok(
        (await notificationIds(serial)).includes(FOREGROUND_NOTIFICATION_ID),
        'The persistent Android foreground-service notification is missing.',
    )
}

async function notificationIds(serial: string): Promise<string[]> {
    const output = await adb(serial, 'shell', 'cmd', 'notification', 'list')
    return output.split(/\r?\n/u).flatMap(line => {
        const fields = line.trim().split('|')
        return fields[1] === PACKAGE_NAME && fields[2] ? [fields[2]] : []
    })
}

async function startActivity(serial: string): Promise<void> {
    await adb(serial, 'shell', 'am', 'start', '-W', '-n', MAIN_ACTIVITY)
}

async function reverse(serial: string, port: number): Promise<void> {
    await adb(serial, 'reverse', `tcp:${port}`, `tcp:${port}`)
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

async function waitFor(
    predicate: () => boolean | Promise<boolean>,
    description: string,
    timeoutMs: number,
): Promise<void> {
    const deadline = Date.now() + timeoutMs
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
        `Timed out waiting for ${description}`
        + (lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ''),
    )
}

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds))
}
