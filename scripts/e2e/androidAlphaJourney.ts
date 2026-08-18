import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
const LEGACY_OUTBOX_SEEDER = `${PACKAGE_NAME}/id.my.anciety.codever.e2e.LegacyOutboxSeederReceiver`
const MATRIX_SESSION_FAULT = `${PACKAGE_NAME}/id.my.anciety.codever.e2e.MatrixSessionFaultReceiver`
const NETWORK_AVAILABILITY_FAULT =
    `${PACKAGE_NAME}/id.my.anciety.codever.e2e.NetworkAvailabilityFaultReceiver`
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

type MatrixSyncGate = {
    readonly port: number
    intercepted(): number
    redeliveredCommandTransactions(): number
    observedCommandIds(): string[]
    observedPutPaths(): string[]
    injectNullOptionalSections(): number
    waitForNullOptionalInjection(after: number): Promise<void>
    waitForInjectedCursorAdvance(after: number): Promise<void>
    injectLimitedApplicationGap(): number
    waitForLimitedApplicationGap(after: number): Promise<void>
    holdNextGapBackfill(): number
    waitForGapBackfillInterception(after: number): Promise<void>
    releaseGapBackfill(): void
    hold(): number
    waitForInterception(after?: number, description?: string): Promise<void>
    release(): void
    close(): Promise<void>
}

type CommandReplayEvidence = {
    commandKey: string
    revision: number
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
    userMessages: string[]
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
    gatewayReplayLedgerPath: string
    gatewayOutput(): string
}

class AndroidWebView {
    private nextId = 0
    private readonly pending = new Map<number, PendingCall>()
    private closing = false

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
            if (this.closing) {
                for (const pending of this.pending.values()) clearTimeout(pending.timer)
                this.pending.clear()
                return
            }
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
        this.closing = true
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

    async createSession(
        projectName: string,
        options: { privacyContextId?: string } = {},
    ): Promise<void> {
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
        if (options.privacyContextId) {
            const defaults = await this.evaluate<{
                available: boolean
                offByDefault: boolean
                directCreationEnabled: boolean
            }>(`(() => {
                const dialog = document.querySelector('.new-session-dialog');
                const option = Array.from(dialog?.querySelectorAll('.session-extension-option') || [])
                    .find(item => item.textContent?.includes('HaS privacy'));
                const toggle = option?.querySelector('.session-extension-toggle input[type="checkbox"]');
                const create = Array.from(dialog?.querySelectorAll('button') || [])
                    .find(item => item.textContent?.trim() === 'Create session');
                return {
                    available: Boolean(option && toggle),
                    offByDefault: Boolean(toggle && !toggle.checked),
                    directCreationEnabled: Boolean(create && !create.disabled),
                };
            })()`)
            assert.deepEqual(defaults, {
                available: true,
                offByDefault: true,
                directCreationEnabled: true,
            })
            await this.evaluate(`(() => {
                const dialog = document.querySelector('.new-session-dialog');
                const option = Array.from(dialog?.querySelectorAll('.session-extension-option') || [])
                    .find(item => item.textContent?.includes('HaS privacy'));
                option?.querySelector('.session-extension-toggle input[type="checkbox"]')?.click();
            })()`)
            await waitFor(async () => this.evaluate<boolean>(`(() => {
                const dialog = document.querySelector('.new-session-dialog');
                const option = Array.from(dialog?.querySelectorAll('.session-extension-option') || [])
                    .find(item => item.textContent?.includes('HaS privacy'));
                const context = option?.querySelector('input[placeholder="payroll-system-id"]');
                const review = option?.querySelector('.session-extension-boolean input[type="checkbox"]');
                const create = Array.from(dialog?.querySelectorAll('button') || [])
                    .find(item => item.textContent?.trim() === 'Create session');
                return Boolean(context && review?.checked && create?.disabled);
            })()`), {
                description: 'required Android privacy context and review default',
                timeoutMs: 5_000,
            })
            const configured = await this.evaluate<boolean>(`(() => {
                const context = document.querySelector('.new-session-dialog input[placeholder="payroll-system-id"]');
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
                if (!context || !setter) return false;
                setter.call(context, ${json(options.privacyContextId)});
                context.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
            })()`)
            assert.equal(configured, true, 'Could not configure the Android privacy context')
        }
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

    async waitForPromptReview(): Promise<void> {
        await waitFor(async () => this.evaluate<boolean>(`(() => {
            const cards = Array.from(document.querySelectorAll('.revision-conflict-card'));
            return cards.some(card => {
                const title = card.querySelector('strong')?.textContent?.trim();
                const discard = Array.from(card.querySelectorAll('button'))
                    .find(button => button.textContent?.trim() === 'Discard');
                return /^A previous (prompt|action) needs review$/u.test(title || '')
                    && Boolean(discard && !discard.disabled);
            });
        })()`), {
            description: 'Android stale prompt review card',
            timeoutMs: CONVERGENCE_TIMEOUT_MS,
        })
    }

    async discardPromptReview(): Promise<void> {
        await this.click(`(() => {
            const card = Array.from(document.querySelectorAll('.revision-conflict-card'))
                .find(item => /^A previous (prompt|action) needs review$/u.test(
                    item.querySelector('strong')?.textContent?.trim() || '',
                ));
            const target = Array.from(card?.querySelectorAll('button') || [])
                .find(button => normalized(button.textContent) === 'Discard' && visible(button));
            return clickResult(target);
        })()`)
        await waitFor(async () => this.evaluate<boolean>(`(() =>
            !Array.from(document.querySelectorAll('.revision-conflict-card'))
                .some(card => /^A previous (prompt|action) needs review$/u.test(
                    card.querySelector('strong')?.textContent?.trim() || '',
                ))
        )()`), {
            description: 'discarded Android prompt review to clear',
            timeoutMs: UI_FEEDBACK_TIMEOUT_MS,
        })
    }

    async openProject(projectName: string): Promise<void> {
        const onConversation = await this.evaluate<boolean>(`(() =>
            document.querySelector('.app-shell')?.classList.contains('mobile-chat-open') === true
        )()`)
        if (onConversation) {
            await this.clickAria('Back to conversations')
            await waitFor(
                async () => !(await this.state()).mobileChatOpen,
                {
                    description: 'Android conversation list after using the visible mobile Back control',
                    timeoutMs: UI_FEEDBACK_TIMEOUT_MS,
                },
            )
        }
        const expanded = await this.evaluate<boolean>(`(() => {
            const groups = Array.from(document.querySelectorAll('.project-session-group'));
            for (const group of groups) {
                const toggle = group.querySelector('button.project-session-toggle');
                if (toggle?.getAttribute('aria-expanded') !== 'true') toggle.click();
            }
            return groups.length > 0;
        })()`)
        assert.equal(expanded, true, `Could not expand Android project ${projectName}`)
        await waitFor(async () => this.evaluate<boolean>(`(() => {
            const row = Array.from(document.querySelectorAll('button.session-row'))
                .find(item => item.dataset.projectName === ${json(projectName)});
            return Boolean(row && row.getClientRects().length > 0 && !row.disabled);
        })()`), {
            description: `visible Android conversation in project ${projectName}`,
            timeoutMs: UI_FEEDBACK_TIMEOUT_MS,
        })
        const opened = await this.evaluate<boolean>(`(() => {
            const rows = Array.from(document.querySelectorAll('button.session-row'))
                .filter(item => item.dataset.projectName === ${json(projectName)});
            const row = rows.find(item => item.getAttribute('aria-pressed') === 'true') || rows[0];
            if (row && !row.disabled) row.click();
            return Boolean(row && !row.disabled);
        })()`)
        assert.equal(opened, true, `Could not open Android project ${projectName}`)
        await this.waitFor(`selected Android project ${projectName}`, state => state.selectedProject === projectName)
    }

    async restoreSelected(): Promise<void> {
        await this.clickButtonText('Restore')
    }

    async deleteSelected(): Promise<void> {
        const detailsReady = await this.evaluate<boolean>(`(() => {
            const details = Array.from(document.querySelectorAll('button'))
                .find(button => button.getAttribute('aria-label') === 'Conversation details' && button.getClientRects().length > 0);
            if (!details || details.disabled) return false;
            if (details.getAttribute('aria-expanded') !== 'true') details.click();
            return true;
        })()`)
        assert.equal(detailsReady, true, 'Could not open Android conversation details')
        await waitFor(async () => this.evaluate<boolean>(`(() =>
            Array.from(document.querySelectorAll('button')).some(button =>
                button.getClientRects().length > 0 &&
                Array.from(button.querySelectorAll('strong')).some(strong => strong.textContent?.trim() === 'Delete session')
            )
        )()`), {
            description: 'Android Delete session action',
            timeoutMs: UI_FEEDBACK_TIMEOUT_MS,
        })
        await this.click(`(() => {
            const target = Array.from(document.querySelectorAll('button')).find(button =>
                visible(button) && Array.from(button.querySelectorAll('strong'))
                    .some(strong => normalized(strong.textContent) === 'Delete session'));
            return clickResult(target);
        })()`)
        await this.waitFor(
            'Android delete confirmation',
            state => state.dialogs.some(dialog => dialog.startsWith('Delete ')),
            UI_FEEDBACK_TIMEOUT_MS,
        )
        await this.clickButtonText('Delete session', '[role="alertdialog"]')
        await this.waitFor(
            'immediate Android deletion feedback',
            state => !state.dialogs.some(dialog => dialog.startsWith('Delete ')),
            UI_FEEDBACK_TIMEOUT_MS,
        )
    }

    async decidePrivacy(expectedSanitizedPrompt: string, action: 'Cancel' | 'Send to Agent'): Promise<void> {
        await waitFor(async () => this.evaluate<boolean>(`(() => {
            const cards = Array.from(document.querySelectorAll('.permission-card'));
            const card = cards.reverse().find(item => item.textContent?.includes('Review privacy-protected Agent request'));
            const details = card?.querySelector('.permission-details')?.textContent || '';
            const button = Array.from(card?.querySelectorAll('button') || [])
                .find(item => item.textContent?.trim() === ${json(action)});
            return Boolean(
                card && button && !button.disabled &&
                details.includes('The Agent will receive exactly:') &&
                details.includes(${json(expectedSanitizedPrompt)}) &&
                !details.includes('张三')
            );
        })()`), {
            description: `exact Android privacy preview for ${action}`,
            timeoutMs: CONVERGENCE_TIMEOUT_MS,
        })
        await this.click(`(() => {
            const cards = Array.from(document.querySelectorAll('.permission-card'));
            const card = cards.reverse().find(item =>
                item.querySelector('.permission-details')?.textContent?.includes(${json(expectedSanitizedPrompt)}));
            const target = Array.from(card?.querySelectorAll('button') || [])
                .find(item => normalized(item.textContent) === ${json(action)} && visible(item));
             return clickResult(target);
         })()`)
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
    const postCommitRecoveryPrompt = `Android post-commit recovery prompt ${options.runId}`
    const browserRevisionAdvancePrompt = `Browser revision advance ${options.runId}`
    const browserGapPrompt = `Browser gap recovery ${options.runId}`
    const largeResponsePrompt = `CODEVER_E2E_LARGE_RESPONSE:${options.runId}`
    const largeResponseBegin = `CODEVER-E2E-LARGE-BEGIN-${options.runId}`
    const largeResponseEnd = `CODEVER-E2E-LARGE-END-${options.runId}`
    const stalePromptToLinearize = `Android stale prompt to linearize ${options.runId}`
    const privacyProjectName = `Codever Alpha Privacy ${options.runId}`
    const migrationProjectName = `Codever Alpha Upgrade ${options.runId}`
    const privacyContextId = `android-private-${options.runId}`
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
    let syncGate: MatrixSyncGate | undefined
    let privacySessionCreated = false
    let migrationSessionCreated = false
    try {
        process.stdout.write('  [A1/12] Building and installing a fresh isolated Android E2E package…\n')
        await buildE2eApk(options.repositoryRoot, options.pwaUrl)
        await adbMaybe(serial, 'uninstall', PACKAGE_NAME)
        await adb(serial, 'install', '-r', '-t', apkPath)
        await adb(serial, 'shell', 'cmd', 'package', 'compile', '-m', 'speed', '-f', PACKAGE_NAME)
        await adb(serial, 'shell', 'pm', 'grant', PACKAGE_NAME, 'android.permission.POST_NOTIFICATIONS')
        await adb(serial, 'reverse', `tcp:${options.pwaPort}`, `tcp:${options.pwaPort}`)
        syncGate = await createMatrixSyncGate(options.matrixPort)
        await adb(serial, 'reverse', `tcp:${options.matrixPort}`, `tcp:${syncGate.port}`)

        process.stdout.write('  [A2/12] Creating a real one-time invitation and pairing the fresh APK…\n')
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
        process.stdout.write('  [A2a/12] Holding the first native sync beyond its watchdog window…\n')
        await syncGate.waitForInterception()
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
        syncGate.release()
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
        process.stdout.write('  [A2b/12] Killing Android after native confirmation and resuming the durable pairing transaction…\n')
        const requestPersistenceBaseline = await diagnosticCount(
            serial,
            'pairing.transaction.request_persisted',
        )
        const pairingSyncBaseline = syncGate.hold()
        await tapNativePairingConfirmation(serial, options.runId)
        await waitFor(
            async () => await diagnosticCount(
                serial,
                'pairing.transaction.request_persisted',
            ) > requestPersistenceBaseline,
            {
                description: 'durable signed native pairing request before process death',
                timeoutMs: CONNECT_TIMEOUT_MS,
            },
        )
        await syncGate.waitForInterception(
            pairingSyncBaseline,
            'a held Matrix sync after the signed native pairing request was persisted',
        )
        android.close()
        android = undefined
        if (forwardedDevtoolsPort) {
            await adbMaybe(serial, 'forward', '--remove', `tcp:${forwardedDevtoolsPort}`)
            forwardedDevtoolsPort = undefined
        }
        await adb(serial, 'shell', 'am', 'force-stop', PACKAGE_NAME)
        syncGate.release()
        await adb(serial, 'shell', 'am', 'start', '-W', '-n', MAIN_ACTIVITY)
        ;({ page: android, port: forwardedDevtoolsPort } = await attachWebView(
            serial,
            options.pwaUrl,
        ))
        await waitFor(
            async () => await diagnosticCount(
                serial,
                'pairing.transaction.restored request=true',
            ) > 0,
            {
                description: 'native pairing transaction restoration after process death',
                timeoutMs: CONNECT_TIMEOUT_MS,
            },
        )
        const paired = await android.waitFor(
            'fresh native Gateway Room State',
            state => state.connection.endsWith('Connected') && state.projectNames.length > 0,
            CONNECT_TIMEOUT_MS,
        )
        assert.ok(paired.bodyText.includes('Recent messages'), 'Fresh APK did not bootstrap existing history')
        await closeBrowserConnectionSettings(options.browserPage)
        await assertForegroundNotification(serial)

        process.stdout.write('  [A3/12] Creating on Android and converging the session into the browser…\n')
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

        process.stdout.write('  [A4/12] Completing an Android task in the background and opening its notification…\n')
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

        process.stdout.write('  [A5/12] Verifying foreground suppression and browser-to-APK history sync…\n')
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

        // Separate a pure transport-loss assertion from the preceding
        // cross-device revision race. Foregrounding explicitly requests an
        // authoritative Room State before the independent privacy journey
        // advances the shared state again.
        const stateResponseBaseline = await gatewayStateResponseCount(serial)
        const backgroundLifecycleBaseline = await diagnosticCount(
            serial,
            'service.ui_foreground running=false',
        )
        const foregroundLifecycleBaseline = await diagnosticCount(
            serial,
            'service.ui_foreground running=true',
        )
        await adb(serial, 'shell', 'input', 'keyevent', 'KEYCODE_HOME')
        await waitFor(
            async () => await diagnosticCount(
                serial,
                'service.ui_foreground running=false',
            ) > backgroundLifecycleBaseline,
            {
                description: 'Android Activity background lifecycle before foreground recovery',
                timeoutMs: UI_FEEDBACK_TIMEOUT_MS,
            },
        )
        await adb(serial, 'shell', 'am', 'start', '-W', '-n', MAIN_ACTIVITY)
        await waitFor(
            async () => await diagnosticCount(
                serial,
                'service.ui_foreground running=true',
            ) > foregroundLifecycleBaseline,
            {
                description: 'Android Activity foreground lifecycle before Gateway convergence',
                timeoutMs: UI_FEEDBACK_TIMEOUT_MS,
            },
        )
        await waitFor(
            async () => await gatewayStateResponseCount(serial) > stateResponseBaseline,
            {
                description: 'authoritative Android Gateway state before privacy and transport recovery',
                timeoutMs: CONNECT_TIMEOUT_MS,
            },
        )
        await android.waitFor(
            'Android connection after authoritative Gateway convergence',
            state => state.connection.endsWith('Connected'),
            CONNECT_TIMEOUT_MS,
        )

        process.stdout.write('  [AP/11] Enforcing privacy sanitize/review/restore through the installed APK…\n')
        await android.createSession(privacyProjectName, { privacyContextId })
        await android.waitFor(
            'immediate native privacy session creation feedback',
            state => state.sessionCreatePending,
            UI_FEEDBACK_TIMEOUT_MS,
        )
        await android.waitFor(
            `Android privacy session ${privacyProjectName}`,
            state => state.projectNames.includes(privacyProjectName)
                && state.selectedProject === privacyProjectName,
        )
        privacySessionCreated = true
        await waitForBrowserProject(options.browserPage, privacyProjectName)
        await openBrowserProject(options.browserPage, privacyProjectName)

        const deniedPrivacyPrompt = `请联系张三处理 Android 隐私拒绝 ${options.runId}`
        const deniedSanitized = deniedPrivacyPrompt.replaceAll('张三', '李四')
        const beforeDenied = providerInvocationCount(options.gatewayOutput())
        await android.sendPrompt(deniedPrivacyPrompt)
        await android.decidePrivacy(deniedSanitized, 'Cancel')
        await android.waitFor(
            'Android privacy denial before Agent egress',
            state => state.bodyText.includes('Request cancelled before it reached the Agent.'),
        )
        assert.equal(providerInvocationCount(options.gatewayOutput()), beforeDenied)

        const approvedPrivacyPrompt = `请联系张三处理 Android 隐私批准 ${options.runId}`
        const approvedSanitized = approvedPrivacyPrompt.replaceAll('张三', '李四')
        const beforeApproved = providerInvocationCount(options.gatewayOutput())
        await android.sendPrompt(approvedPrivacyPrompt)
        await android.decidePrivacy(approvedSanitized, 'Send to Agent')
        await waitForProviderDigest(
            options.gatewayOutput,
            approvedSanitized,
            beforeApproved + 1,
        )
        const restoredPrivacyResponse = `Agent received exactly: ${approvedPrivacyPrompt}`
        await android.waitFor(
            'locally restored private Agent response on Android',
            state => state.bodyText.includes(restoredPrivacyResponse)
                && !state.bodyText.includes(`Agent received exactly: ${approvedSanitized}`),
        )
        await waitForBrowserText(options.browserPage, restoredPrivacyResponse)

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
            'privacy session inventory after Android process restart',
            state => state.connection.endsWith('Connected')
                && state.projectNames.includes(privacyProjectName),
            CONNECT_TIMEOUT_MS,
        )
        await android.openProject(privacyProjectName)
        await android.waitFor(
            'privacy history after Android process restart',
            state => state.bodyText.includes(restoredPrivacyResponse),
            CONNECT_TIMEOUT_MS,
        )
        await deleteBrowserSession(options.browserPage, privacyProjectName)
        await android.waitFor(
            'privacy session deletion on Android',
            state => !state.projectNames.includes(privacyProjectName)
                && !state.archivedProjects.includes(privacyProjectName),
        )
        privacySessionCreated = false
        await openBrowserProject(options.browserPage, projectName)
        await android.openProject(projectName)

        process.stdout.write('  [A5n/12] Flapping Android connectivity while native Matrix sync remains alive…\n')
        let offlineTransitions = await diagnosticCount(
            serial,
            'matrix.state detail=network_unavailable phase=OFFLINE',
        )
        let activeTransitions = await diagnosticCount(
            serial,
            'matrix.state detail=matrix_sync_active phase=SYNCING',
        )
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            await injectNetworkAvailability(serial, false)
            await waitFor(
                async () => await diagnosticCount(
                    serial,
                    'matrix.state detail=network_unavailable phase=OFFLINE',
                ) > offlineTransitions,
                {
                    description: `native offline transition for network flap ${attempt}`,
                    timeoutMs: CONNECT_TIMEOUT_MS,
                },
            )
            offlineTransitions = await diagnosticCount(
                serial,
                'matrix.state detail=network_unavailable phase=OFFLINE',
            )
            await injectNetworkAvailability(serial, true)
            await waitFor(
                async () => await diagnosticCount(
                    serial,
                    'matrix.state detail=matrix_sync_active phase=SYNCING',
                ) > activeTransitions,
                {
                    description: `active native sync after network flap ${attempt}`,
                    timeoutMs: CONNECT_TIMEOUT_MS,
                },
            )
            activeTransitions = await diagnosticCount(
                serial,
                'matrix.state detail=matrix_sync_active phase=SYNCING',
            )
        }
        await android.waitFor(
            'connected Android after repeated OS network flaps',
            state => state.connection.endsWith('Connected'),
            CONNECT_TIMEOUT_MS,
        )

        process.stdout.write('  [A5o/12] Restoring one chunked large Agent response after process death…\n')
        await sendBrowserPrompt(options.browserPage, largeResponsePrompt)
        await waitFor(
            async () => {
                const text = await options.browserPage.locator('.chat-feed').innerText()
                return text.includes(largeResponseBegin) && text.includes(largeResponseEnd)
            },
            { description: 'complete large Agent response in browser', timeoutMs: CONNECT_TIMEOUT_MS },
        )
        await android.waitFor(
            'complete large Agent response on Android',
            state => state.bodyText.includes(largeResponseBegin) &&
                state.bodyText.includes(largeResponseEnd) &&
                countText(state.bodyText, largeResponseEnd) === 1,
            CONNECT_TIMEOUT_MS,
        )
        android.close()
        android = undefined
        if (forwardedDevtoolsPort) {
            await adbMaybe(serial, 'forward', '--remove', `tcp:${forwardedDevtoolsPort}`)
            forwardedDevtoolsPort = undefined
        }
        await adb(serial, 'shell', 'am', 'force-stop', PACKAGE_NAME)
        await adb(serial, 'shell', 'am', 'start', '-W', '-n', MAIN_ACTIVITY)
        ;({ page: android, port: forwardedDevtoolsPort } = await attachWebView(
            serial,
            options.pwaUrl,
        ))
        await android.waitFor(
            'chunked large Agent history after Android process restart',
            state => state.connection.endsWith('Connected') &&
                state.bodyText.includes(largeResponseBegin) &&
                state.bodyText.includes(largeResponseEnd) &&
                countText(state.bodyText, largeResponseEnd) === 1,
            CONNECT_TIMEOUT_MS,
        )
        assert.equal(providerDigestCount(options.gatewayOutput(), largeResponsePrompt), 1)

        process.stdout.write('  [A5p/12] Injecting nullable Matrix sync sections and proving cursor progress…\n')
        const rawArgumentFailures = await diagnosticCount(
            serial,
            'matrix.application_control.receiver_retry error=IllegalArgumentException',
        )
        const injectionBaseline = syncGate.injectNullOptionalSections()
        await syncGate.waitForNullOptionalInjection(injectionBaseline)
        await syncGate.waitForInjectedCursorAdvance(injectionBaseline)
        assert.equal(
            await diagnosticCount(
                serial,
                'matrix.application_control.receiver_retry error=IllegalArgumentException',
            ),
            rawArgumentFailures,
            'A nullable optional Matrix sync section escaped as an unbounded parser retry.',
        )
        await android.waitFor(
            'connected Android after nullable Matrix sync response',
            state => state.connection.endsWith('Connected'),
            CONNECT_TIMEOUT_MS,
        )

        process.stdout.write('  [A5q/12] Closing a limited-sync gap without discarding its cursor…\n')
        const gapPersistedBefore = await diagnosticCount(
            serial,
            'matrix.application_control.gap_persisted',
        )
        const gapClosedBefore = await diagnosticCount(
            serial,
            'matrix.application_control.gap_closed',
        )
        const gapRequestBaseline = syncGate.holdNextGapBackfill()
        const gapBaseline = syncGate.injectLimitedApplicationGap()
        await sendBrowserPrompt(options.browserPage, browserGapPrompt)
        await syncGate.waitForLimitedApplicationGap(gapBaseline)
        await waitFor(
            async () => await diagnosticCount(
                serial,
                'matrix.application_control.gap_persisted',
            ) > gapPersistedBefore,
            {
                description: 'durable Matrix gap persistence before process death',
                timeoutMs: CONNECT_TIMEOUT_MS,
            },
        )
        await syncGate.waitForGapBackfillInterception(gapRequestBaseline)
        android.close()
        android = undefined
        if (forwardedDevtoolsPort) {
            await adbMaybe(serial, 'forward', '--remove', `tcp:${forwardedDevtoolsPort}`)
            forwardedDevtoolsPort = undefined
        }
        await adb(serial, 'shell', 'am', 'force-stop', PACKAGE_NAME)
        syncGate.releaseGapBackfill()
        await adb(serial, 'shell', 'am', 'start', '-W', '-n', MAIN_ACTIVITY)
        ;({ page: android, port: forwardedDevtoolsPort } = await attachWebView(
            serial,
            options.pwaUrl,
        ))
        // The held response may have reached the kernel after force-stop but before
        // the old process could durably commit it. A Matrix homeserver keeps the
        // underlying room history readable, so require the restarted process to
        // request the same persisted gap again instead of accepting that first
        // best-effort delivery as recovery evidence.
        await syncGate.waitForGapBackfillInterception(gapRequestBaseline + 1)
        await waitFor(
            async () => await diagnosticCount(
                serial,
                'matrix.application_control.gap_closed',
            ) > gapClosedBefore,
            {
                description: 'Matrix gap closure after Android process restart',
                timeoutMs: CONNECT_TIMEOUT_MS,
            },
        )
        await waitForBrowserText(options.browserPage, browserGapPrompt)
        await android.waitFor(
            'exactly-once Android message recovered from the Matrix gap',
            state => state.connection.endsWith('Connected') &&
                state.userMessages.filter(message => message === browserGapPrompt).length === 1,
            CONNECT_TIMEOUT_MS,
        )

        process.stdout.write('  [A6/12] Recovering one pre-delivery Android command across a Matrix disconnect…\n')
        await adb(serial, 'reverse', '--remove', `tcp:${options.matrixPort}`)
        await android.sendPrompt(recoveryPrompt)
        await delay(1_500)
        await adb(serial, 'reverse', `tcp:${options.matrixPort}`, `tcp:${syncGate.port}`)
        await waitForBrowserText(options.browserPage, recoveryPrompt)
        await waitForProviderResponseCount(options.browserPage, 3)
        await android.waitFor(
            'recovered prompt exactly once on Android',
            state => state.userMessages.filter(message => message === recoveryPrompt).length === 1
                && countText(state.bodyText, options.providerResponse) >= 3,
            CONNECT_TIMEOUT_MS,
        )
        assert.equal(await browserTextCount(options.browserPage, recoveryPrompt), 1)
        assert.equal(
            providerDigestCount(options.gatewayOutput(), recoveryPrompt),
            1,
            'The recovered Android prompt reached the Agent more than once',
        )

        process.stdout.write('  [A7/12] Withholding a committed delete result through automatic Android recovery…\n')
        const deleteReplayStart = await replayLedgerLineCount(options.gatewayReplayLedgerPath)
        const deleteGatewayLogStart = options.gatewayOutput().length
        const redeliveredTransactionStart = syncGate.redeliveredCommandTransactions()
        const deleteRecoveryStart = await diagnosticCount(
            serial,
            'command.recovery.attempted action=session.delete',
        )
        const deleteSyncBaseline = syncGate.hold()
        await android.deleteSelected()
        await waitForBrowserProjectAbsent(options.browserPage, projectName)
        await syncGate.waitForInterception(
            deleteSyncBaseline,
            'the Android delete acknowledgement/result sync response to be blocked',
        )
        sessionCreated = false
        const deleteEvidence = await waitForSingleCommittedCommand(
            options.gatewayReplayLedgerPath,
            deleteReplayStart,
            'Android session deletion',
        )
        const deleteControlSendStart = await diagnosticCount(
            serial,
            'matrix.application_control.sent',
        )
        await waitFor(
            async () => await diagnosticCount(
                serial,
                'command.recovery.attempted action=session.delete',
            ) > deleteRecoveryStart,
            {
                description: 'Android to retry the committed delete after its acknowledgement timeout',
                timeoutMs: CONNECT_TIMEOUT_MS,
            },
        )
        await waitFor(
            async () => await diagnosticCount(
                serial,
                'matrix.application_control.sent',
            ) > deleteControlSendStart,
            {
                description: 'Android committed-command recovery to reach Matrix',
                timeoutMs: CONNECT_TIMEOUT_MS,
            },
        )
        assert.ok(
            syncGate.redeliveredCommandTransactions() > redeliveredTransactionStart,
            'The Alpha fault proxy did not redeliver the recovered Matrix command as a new event. '
                + `Observed PUT paths: ${JSON.stringify(syncGate.observedPutPaths())}`,
        )
        syncGate.release()
        await android.waitFor(
            'post-commit Android deletion result after its forced retry',
            state =>
                state.connection.endsWith('Connected') &&
                !state.projectNames.includes(projectName) &&
                !state.archivedProjects.includes(projectName),
            CONNECT_TIMEOUT_MS,
        )
        await assertCommandRecordedExactlyOnce(options.gatewayReplayLedgerPath, deleteEvidence)
        await delay(1_000)
        assert.doesNotMatch(
            options.gatewayOutput().slice(deleteGatewayLogStart),
            /(?:Accepted command id does not match its durable execution record|Secure envelope was already opened|\[matrix-gateway\] rejected .*replay)/iu,
            'Post-commit Android recovery was rejected as a non-idempotent replay',
        )

        // A recovered delete must release the single-command native outbox.
        // Re-create and delete immediately so a stale RECOVERY_REQUIRED entry
        // cannot masquerade as successful state convergence.
        await android.createSession(projectName)
        await android.waitFor(
            'Android creation after recovered deletion',
            state => state.projectNames.includes(projectName) && state.selectedProject === projectName,
        )
        await waitForBrowserProject(options.browserPage, projectName)
        sessionCreated = true
        await android.deleteSelected()
        await waitForBrowserProjectAbsent(options.browserPage, projectName)
        await android.waitFor(
            'Android deletion immediately after recovered deletion',
            state => !state.projectNames.includes(projectName),
        )
        sessionCreated = false

        process.stdout.write('  [A8/12] Losing create acknowledgement after Gateway commit, then restarting Android…\n')
        const createReplayStart = await replayLedgerLineCount(options.gatewayReplayLedgerPath)
        const createSyncBaseline = syncGate.hold()
        await android.createSession(projectName)
        await waitForBrowserProject(options.browserPage, projectName)
        await syncGate.waitForInterception(
            createSyncBaseline,
            'the Android create acknowledgement/result sync response to be blocked',
        )
        sessionCreated = true
        const createEvidence = await waitForSingleCommittedCommand(
            options.gatewayReplayLedgerPath,
            createReplayStart,
            'Android session creation',
        )

        android.close()
        android = undefined
        if (forwardedDevtoolsPort) {
            await adbMaybe(serial, 'forward', '--remove', `tcp:${forwardedDevtoolsPort}`)
            forwardedDevtoolsPort = undefined
        }
        await adb(serial, 'shell', 'am', 'force-stop', PACKAGE_NAME)
        syncGate.release()
        await adb(serial, 'shell', 'am', 'start', '-W', '-n', MAIN_ACTIVITY)
        ;({ page: android, port: forwardedDevtoolsPort } = await attachWebView(serial, options.pwaUrl))
        await android.waitFor(
            'post-commit Android creation recovery',
            state =>
                state.connection.endsWith('Connected') &&
                state.projectNames.includes(projectName),
            CONNECT_TIMEOUT_MS,
        )
        await assertCommandRecordedExactlyOnce(options.gatewayReplayLedgerPath, createEvidence)
        await android.openProject(projectName)
        await openBrowserProject(options.browserPage, projectName)
        await android.sendPrompt(postCommitRecoveryPrompt)
        await waitForBrowserText(options.browserPage, postCommitRecoveryPrompt)
        await waitForBrowserText(options.browserPage, options.providerResponse)
        assert.equal(await browserTextCount(options.browserPage, postCommitRecoveryPrompt), 1)
        assert.equal(await browserTextCount(options.browserPage, options.providerResponse), 1)

        process.stdout.write('  [A9/12] Linearizing a stale cross-device Android prompt without user review…\n')
        const staleSyncBaseline = syncGate.hold()
        await sendBrowserPrompt(options.browserPage, browserRevisionAdvancePrompt)
        await waitForBrowserText(options.browserPage, browserRevisionAdvancePrompt)
        await waitForProviderResponseCount(options.browserPage, 2)
        await syncGate.waitForInterception(
            staleSyncBaseline,
            'the browser revision advance to be withheld from Android',
        )
        await android.sendPrompt(stalePromptToLinearize)
        syncGate.release()
        await waitForBrowserText(options.browserPage, stalePromptToLinearize)
        await waitForProviderResponseCount(options.browserPage, 3)
        await android.waitFor(
            'linearly accepted Android prompt',
            state => state.userMessages.filter(message => message === stalePromptToLinearize).length === 1
                && state.alerts.length === 0
                && !state.bodyText.includes('needs review')
                && !state.bodyText.includes('TASK NEEDS ATTENTION')
                && !state.bodyText.includes('Open connection settings')
                && countText(state.bodyText, options.providerResponse) >= 3,
            CONNECT_TIMEOUT_MS,
        )
        assert.equal(await browserTextCount(options.browserPage, stalePromptToLinearize), 1)
        assert.equal(
            providerDigestCount(options.gatewayOutput(), stalePromptToLinearize),
            1,
            'The linearly accepted Android prompt did not reach the Agent exactly once',
        )

        process.stdout.write('  [A10/12] Alternating archive/restore/delete across browser and APK, then restarting…\n')
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

        process.stdout.write('  [A11/12] Cover-installing over an encrypted legacy submitted command…\n')
        const migrationDiagnostic = 'command.outbox.migrated quarantined=1 schema=2'
        const migrationCountBefore = await diagnosticCount(serial, migrationDiagnostic)
        android.close()
        android = undefined
        if (forwardedDevtoolsPort) {
            await adbMaybe(serial, 'forward', '--remove', `tcp:${forwardedDevtoolsPort}`)
            forwardedDevtoolsPort = undefined
        }
        await adb(serial, 'shell', 'am', 'force-stop', PACKAGE_NAME)
        const quarantinedCommandId = await seedLegacySubmittedCommand(serial, options.runId)

        // `-r` is the important boundary here: identity, encrypted storage,
        // Matrix login, and app data survive exactly as they do for a real APK
        // update. A fresh uninstall/install cannot exercise this regression.
        await adb(serial, 'install', '-r', '-t', apkPath)
        await adb(serial, 'shell', 'cmd', 'package', 'compile', '-m', 'speed', '-f', PACKAGE_NAME)
        await adb(serial, 'reverse', `tcp:${options.pwaPort}`, `tcp:${options.pwaPort}`)
        await adb(serial, 'reverse', `tcp:${options.matrixPort}`, `tcp:${syncGate.port}`)
        await adb(serial, 'shell', 'am', 'start', '-W', '-n', MAIN_ACTIVITY)
        ;({ page: android, port: forwardedDevtoolsPort } = await attachWebView(serial, options.pwaUrl))
        await android.waitFor(
            'connected Android after legacy outbox cover-install migration',
            state => state.connection.endsWith('Connected'),
            CONNECT_TIMEOUT_MS,
        )
        await waitFor(
            async () => await diagnosticCount(serial, migrationDiagnostic) === migrationCountBefore + 1,
            {
                description: 'one atomic schema-2 command outbox migration',
                timeoutMs: CONNECT_TIMEOUT_MS,
            },
        )
        assert.ok(
            !syncGate.observedCommandIds().includes(quarantinedCommandId),
            'The ambiguous legacy submitted command was retransmitted after upgrade.',
        )

        // A migration is only useful when it frees the single-command lane.
        // Exercise a new command all the way through Gateway convergence.
        await android.createSession(migrationProjectName)
        await android.waitFor(
            'new Android session after legacy outbox migration',
            state => state.projectNames.includes(migrationProjectName)
                && state.selectedProject === migrationProjectName,
            CONNECT_TIMEOUT_MS,
        )
        migrationSessionCreated = true
        await waitForBrowserProject(options.browserPage, migrationProjectName)
        await android.deleteSelected()
        await waitForBrowserProjectAbsent(options.browserPage, migrationProjectName)
        await android.waitFor(
            'Android deletion after legacy outbox migration',
            state => !state.projectNames.includes(migrationProjectName)
                && !state.archivedProjects.includes(migrationProjectName),
            CONNECT_TIMEOUT_MS,
        )
        migrationSessionCreated = false

        const migrationCountAfter = await diagnosticCount(serial, migrationDiagnostic)
        assert.equal(migrationCountAfter, migrationCountBefore + 1)
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
            'second Android restart after one-time outbox migration',
            state => state.connection.endsWith('Connected')
                && !state.projectNames.includes(migrationProjectName),
            CONNECT_TIMEOUT_MS,
        )
        assert.equal(
            await diagnosticCount(serial, migrationDiagnostic),
            migrationCountAfter,
            'The legacy outbox migrated more than once.',
        )
        assert.ok(
            !syncGate.observedCommandIds().includes(quarantinedCommandId),
            'The quarantined command was transmitted on a later restart.',
        )

        process.stdout.write('  [A12/12] Repairing a selectively missing Matrix session without replacing Codever trust…\n')
        const repairInvitation = await createBrowserDeviceInvitation(
            options.browserPage,
            options.testerPassword,
        )
        await closeBrowserConnectionSettings(options.browserPage)
        android.close()
        android = undefined
        if (forwardedDevtoolsPort) {
            await adbMaybe(serial, 'forward', '--remove', `tcp:${forwardedDevtoolsPort}`)
            forwardedDevtoolsPort = undefined
        }
        await adb(serial, 'shell', 'am', 'force-stop', PACKAGE_NAME)
        await removePersistedMatrixSession(serial)
        await adb(serial, 'shell', 'am', 'start', '-W', '-n', MAIN_ACTIVITY)
        ;({ page: android, port: forwardedDevtoolsPort } = await attachWebView(serial, options.pwaUrl))
        const repairState = await android.waitFor(
            'actionable native Matrix session repair state',
            state => state.connection.includes('Connection repair required')
                && state.dialogs.some(dialog => dialog.startsWith('Repair connection')),
            CONNECT_TIMEOUT_MS,
        )
        assert.match(repairState.bodyText, /another connected Codever device/iu)
        assert.match(repairState.bodyText, /device identity.*stay the same/iu)
        await android.navigate(`${options.pwaUrl}/#pair=${encodeURIComponent(repairInvitation.link)}`)
        await android.waitFor(
            'same-Gateway repair invitation preview',
            state => state.bodyText.toLocaleLowerCase().includes('computer found'),
            CONNECT_TIMEOUT_MS,
        )
        if (!repairInvitation.includesMatrixLogin) {
            await android.signInForPairing(options.testerUserId, options.testerPassword)
        }
        await android.clickButtonPrefix('Connect to ')
        await tapNativePairingConfirmation(serial, options.runId)
        await android.waitFor(
            'connected Android after same-device Matrix session repair',
            state => state.connection.endsWith('Connected'),
            CONNECT_TIMEOUT_MS,
        )
        assert.ok(
            await diagnosticCount(serial, 'matrix.session.restore stage=missing') > 0,
            'The selective Matrix session loss was not recorded in diagnostics.',
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
                'native-confirmed-pairing-process-death-recovery',
                'browser-android-session-sync',
                'background-task-notification',
                'notification-deep-link-recovery',
                'foreground-notification-suppression',
                'running-native-sync-survives-repeated-os-network-flaps',
                'chunked-large-agent-output-survives-process-death',
                'nullable-matrix-sync-sections-advance-native-cursor',
                'limited-matrix-sync-gap-backfilled-exactly-once',
                'android-privacy-sanitize-review-deny-restore-restart',
                'pre-delivery-matrix-recovery-exactly-once',
                'post-commit-delete-result-loss-recovery-exactly-once',
                'post-commit-create-result-loss-recovery-exactly-once',
                'native-outbox-release-after-post-commit-recovery',
                'cross-device-stale-prompt-linearized-exactly-once',
                'cross-device-archive-restore-delete',
                'android-process-restart',
                'legacy-encrypted-outbox-cover-install-migration',
                'ambiguous-legacy-command-quarantine-no-replay',
                'post-migration-command-lane-recovery',
                'one-time-outbox-migration-across-restart',
                'trusted-device-missing-matrix-session-detection',
                'same-device-matrix-session-repair',
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
        if (privacySessionCreated) {
            await cleanupBrowserProject(options.browserPage, privacyProjectName).catch(() => undefined)
        }
        if (migrationSessionCreated) {
            await cleanupBrowserProject(options.browserPage, migrationProjectName).catch(() => undefined)
        }
        android?.close()
        if (forwardedDevtoolsPort) {
            await adbMaybe(serial, 'forward', '--remove', `tcp:${forwardedDevtoolsPort}`)
        }
        await adbMaybe(serial, 'reverse', '--remove', `tcp:${options.pwaPort}`)
        await adbMaybe(serial, 'reverse', '--remove', `tcp:${options.matrixPort}`)
        syncGate?.release()
        syncGate?.releaseGapBackfill()
        await syncGate?.close().catch(() => undefined)
    }
}

async function injectNetworkAvailability(serial: string, available: boolean): Promise<void> {
    const output = await adb(
        serial,
        'shell',
        'am',
        'broadcast',
        '-f',
        '0x20',
        '-n',
        NETWORK_AVAILABILITY_FAULT,
        '--ez',
        'available',
        available ? 'true' : 'false',
    )
    assert.match(
        output,
        /Broadcast completed: result=-1, data="network-availability-injected"/u,
        `The E2E APK could not inject network availability=${available}: ${output}`,
    )
}

async function createMatrixSyncGate(targetPort: number): Promise<MatrixSyncGate> {
    let intercepted = 0
    let repeatedCommandTransactions = 0
    let requestedNullOptionalInjections = 0
    let completedNullOptionalInjections = 0
    let injectedCursorAdvances = 0
    let injectedNextBatch: string | undefined
    let requestedLimitedGaps = 0
    let completedLimitedGaps = 0
    let interceptedGapBackfills = 0
    let pendingGap: { from: string; to: string; events: JsonRecord[] } | undefined
    const observedPutPaths: string[] = []
    const seenCommandIds = new Set<string>()
    const seenCommandTransactions = new Set<string>()
    let cycle = heldSyncCycle()
    let gapCycle = releasedSyncCycle()
    const server = createHttpServer((incoming, outgoing) => {
        const requestPath = incoming.url ?? '/'
        if (pendingGap && matrixGapRequestMatches(requestPath, pendingGap)) {
            const requestedGap = pendingGap
            const blockedCycle = gapCycle
            interceptedGapBackfills += 1
            incoming.resume()
            void (async () => {
                if (blockedCycle.held) await blockedCycle.wait
                if (outgoing.destroyed || pendingGap !== requestedGap) return
                const body = Buffer.from(JSON.stringify({
                    start: requestedGap.from,
                    end: requestedGap.to,
                    chunk: requestedGap.events,
                }), 'utf8')
                outgoing.writeHead(200, {
                    'content-type': 'application/json',
                    'content-length': String(body.byteLength),
                })
                outgoing.end(body)
            })().catch(error => {
                if (!outgoing.destroyed) outgoing.destroy(error)
            })
            return
        }
        if (
            injectedNextBatch &&
            applicationControlSince(requestPath) === injectedNextBatch
        ) {
            injectedCursorAdvances += 1
            injectedNextBatch = undefined
        }
        if (incoming.method === 'PUT') observedPutPaths.push(requestPath)
        const upstreamPath = rewriteRepeatedCommandTransaction(
            incoming.method,
            requestPath,
            seenCommandIds,
            seenCommandTransactions,
            () => ++repeatedCommandTransactions,
        )
        const upstream = requestHttp({
            hostname: '127.0.0.1',
            port: targetPort,
            method: incoming.method,
            path: upstreamPath,
            headers: {
                ...incoming.headers,
                host: `127.0.0.1:${targetPort}`,
                'accept-encoding': 'identity',
            },
        }, response => {
            void (async () => {
                const blockedCycle = cycle
                if (isMatrixSyncRequest(requestPath) && blockedCycle.held) {
                    response.pause()
                    intercepted += 1
                    await blockedCycle.wait
                }
                if (outgoing.destroyed) {
                    response.destroy()
                    return
                }
                if (
                    requestedNullOptionalInjections > completedNullOptionalInjections &&
                    applicationControlRoomId(requestPath)
                ) {
                    const mutated = await nullOptionalMatrixSyncResponse(
                        response,
                        applicationControlRoomId(requestPath)!,
                    )
                    completedNullOptionalInjections += 1
                    injectedNextBatch = mutated.nextBatch
                    const headers = { ...response.headers }
                    delete headers['content-length']
                    delete headers['content-encoding']
                    delete headers['transfer-encoding']
                    headers['content-length'] = String(mutated.body.byteLength)
                    outgoing.writeHead(
                        response.statusCode ?? 502,
                        response.statusMessage,
                        headers,
                    )
                    outgoing.end(mutated.body)
                    return
                }
                if (
                    requestedLimitedGaps > completedLimitedGaps &&
                    applicationControlSince(requestPath)
                ) {
                    const mutation = await limitedMatrixSyncResponse(
                        response,
                        applicationControlRoomId(requestPath)!,
                        applicationControlSince(requestPath)!,
                        completedLimitedGaps + 1,
                    )
                    const headers = { ...response.headers }
                    delete headers['content-length']
                    delete headers['content-encoding']
                    delete headers['transfer-encoding']
                    headers['content-type'] = 'application/json'
                    headers['content-length'] = String(mutation.body.byteLength)
                    outgoing.writeHead(200, headers)
                    outgoing.end(mutation.body)
                    if (mutation.gap) {
                        completedLimitedGaps += 1
                        pendingGap = mutation.gap
                    }
                    return
                }
                outgoing.writeHead(response.statusCode ?? 502, response.statusMessage, response.headers)
                response.pipe(outgoing)
                response.resume()
            })().catch(error => {
                response.destroy()
                if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'text/plain' })
                outgoing.end(`Matrix E2E proxy failed: ${formatError(error)}`)
            })
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
        redeliveredCommandTransactions: () => repeatedCommandTransactions,
        observedCommandIds: () => [...seenCommandIds],
        observedPutPaths: () => observedPutPaths.slice(-20),
        injectNullOptionalSections: () => {
            requestedNullOptionalInjections += 1
            return completedNullOptionalInjections
        },
        waitForNullOptionalInjection: after => waitFor(
            () => completedNullOptionalInjections > after,
            {
                description: 'the nullable Matrix sync response injection',
                timeoutMs: CONNECT_TIMEOUT_MS,
            },
        ),
        waitForInjectedCursorAdvance: after => waitFor(
            () => injectedCursorAdvances > after,
            {
                description: 'the native application sync cursor to advance past nullable sections',
                timeoutMs: CONNECT_TIMEOUT_MS,
            },
        ),
        injectLimitedApplicationGap: () => {
            requestedLimitedGaps += 1
            return completedLimitedGaps
        },
        waitForLimitedApplicationGap: after => waitFor(
            () => completedLimitedGaps > after,
            {
                description: 'a limited Matrix application sync with an omitted event',
                timeoutMs: CONNECT_TIMEOUT_MS,
            },
        ),
        holdNextGapBackfill: () => {
            gapCycle = heldSyncCycle()
            return interceptedGapBackfills
        },
        waitForGapBackfillInterception: after => waitFor(
            () => interceptedGapBackfills > after,
            {
                description: 'the persisted Matrix gap backfill request',
                timeoutMs: CONNECT_TIMEOUT_MS,
            },
        ),
        releaseGapBackfill: () => {
            if (!gapCycle.held) return
            gapCycle.held = false
            gapCycle.release()
        },
        hold: () => {
            if (!cycle.held) cycle = heldSyncCycle()
            return intercepted
        },
        waitForInterception: (after = 0, description = 'the APK Matrix sync response to reach the delay gate') => waitFor(
            () => intercepted > after,
            {
                description,
                timeoutMs: CONNECT_TIMEOUT_MS,
            },
        ),
        release: () => {
            if (!cycle.held) return
            cycle.held = false
            cycle.release()
        },
        close: () => closeHttpServer(server),
    }
}

function applicationControlRoomId(path: string): string | undefined {
    let url: URL
    try {
        url = new URL(path, 'http://matrix-e2e.invalid')
    } catch {
        return undefined
    }
    if (url.pathname !== '/_matrix/client/v3/sync') return undefined
    const encodedFilter = url.searchParams.get('filter')
    if (!encodedFilter) return undefined
    try {
        const filter = JSON.parse(encodedFilter) as JsonRecord
        const room = filter.room as JsonRecord | undefined
        const rooms = room?.rooms
        const timeline = room?.timeline as JsonRecord | undefined
        const types = timeline?.types
        return Array.isArray(rooms) &&
            typeof rooms[0] === 'string' &&
            Array.isArray(types) &&
            types.includes('io.codever.secure_control.v1')
            ? rooms[0]
            : undefined
    } catch {
        return undefined
    }
}

function applicationControlSince(path: string): string | undefined {
    if (!applicationControlRoomId(path)) return undefined
    try {
        return new URL(path, 'http://matrix-e2e.invalid').searchParams.get('since') ?? undefined
    } catch {
        return undefined
    }
}

async function nullOptionalMatrixSyncResponse(
    response: AsyncIterable<Uint8Array | string>,
    roomId: string,
): Promise<{ body: Buffer; nextBatch: string }> {
    const chunks: Buffer[] = []
    for await (const chunk of response) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const root = JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonRecord
    const nextBatch = root.next_batch
    assert.ok(
        typeof nextBatch === 'string' && nextBatch.length > 0,
        'Injected Matrix sync response has no cursor',
    )
    const rooms = root.rooms && typeof root.rooms === 'object' && !Array.isArray(root.rooms)
        ? root.rooms as JsonRecord
        : {}
    const joined = rooms.join && typeof rooms.join === 'object' && !Array.isArray(rooms.join)
        ? rooms.join as JsonRecord
        : {}
    const currentRoom = joined[roomId] &&
        typeof joined[roomId] === 'object' &&
        !Array.isArray(joined[roomId])
        ? joined[roomId] as JsonRecord
        : {}
    const timeline = currentRoom.timeline &&
        typeof currentRoom.timeline === 'object' &&
        !Array.isArray(currentRoom.timeline)
        ? currentRoom.timeline as JsonRecord
        : { events: null }
    timeline.limited = null
    currentRoom.state = null
    currentRoom.timeline = timeline
    joined[roomId] = currentRoom
    rooms.join = joined
    root.rooms = rooms
    return {
        body: Buffer.from(JSON.stringify(root), 'utf8'),
        nextBatch,
    }
}

async function limitedMatrixSyncResponse(
    response: AsyncIterable<Uint8Array | string>,
    roomId: string,
    from: string,
    sequence: number,
): Promise<{
    body: Buffer
    gap?: { from: string; to: string; events: JsonRecord[] }
}> {
    const chunks: Buffer[] = []
    for await (const chunk of response) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const root = JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonRecord
    const rooms = root.rooms as JsonRecord | undefined
    const joined = rooms?.join as JsonRecord | undefined
    const currentRoom = joined?.[roomId] as JsonRecord | undefined
    const timeline = currentRoom?.timeline as JsonRecord | undefined
    const events = Array.isArray(timeline?.events)
        ? timeline.events.filter((event): event is JsonRecord =>
            Boolean(event && typeof event === 'object' && !Array.isArray(event)))
        : []
    if (events.length === 0) {
        return { body: Buffer.from(JSON.stringify(root), 'utf8') }
    }
    const to = `codever-e2e-gap-${sequence}`
    timeline!.limited = true
    timeline!.prev_batch = to
    timeline!.events = []
    return {
        body: Buffer.from(JSON.stringify(root), 'utf8'),
        gap: { from, to, events },
    }
}

function matrixGapRequestMatches(
    path: string,
    gap: { from: string; to: string },
): boolean {
    try {
        const url = new URL(path, 'http://matrix-e2e.invalid')
        return /\/_matrix\/client\/v3\/rooms\/[^/]+\/messages$/u.test(url.pathname) &&
            url.searchParams.get('dir') === 'f' &&
            url.searchParams.get('from') === gap.from &&
            url.searchParams.get('to') === gap.to
    } catch {
        return false
    }
}

function heldSyncCycle(): { held: boolean; wait: Promise<void>; release(): void } {
    let release: () => void = () => undefined
    const wait = new Promise<void>(resolve => {
        release = resolve
    })
    return { held: true, wait, release }
}

function releasedSyncCycle(): { held: boolean; wait: Promise<void>; release(): void } {
    return { held: false, wait: Promise.resolve(), release: () => undefined }
}

function isMatrixSyncRequest(path: string): boolean {
    return /^\/_matrix\/client\/(?:v3|unstable\/[^/]+)\/sync(?:\?|$)/u.test(path)
}

function rewriteRepeatedCommandTransaction(
    method: string | undefined,
    path: string,
    seenCommandIds: Set<string>,
    seenTransactions: Set<string>,
    nextSequence: () => number,
): string {
    if (method !== 'PUT') return path
    const queryIndex = path.indexOf('?')
    const pathname = queryIndex >= 0 ? path.slice(0, queryIndex) : path
    const query = queryIndex >= 0 ? path.slice(queryIndex) : ''
    let decodedPathname: string
    try {
        decodedPathname = decodeURIComponent(pathname)
    } catch {
        return path
    }
    const commandId = decodedPathname.match(
        /\/send\/io\.codever\.secure_control\.v1\/codever\.command\.([^./?]+)(?:\.|$)/u,
    )?.[1]
    if (!commandId) return path

    const redelivery = seenCommandIds.has(commandId)
    seenCommandIds.add(commandId)
    const repeatedTransaction = seenTransactions.has(pathname)
    seenTransactions.add(pathname)
    const redeliverySequence = redelivery ? nextSequence() : null

    // Existing clients reuse the Matrix transaction ID. Rewrite only that
    // case so Synapse cannot hide the application-level retry. Fixed clients
    // use a fresh transaction themselves and pass through unchanged.
    return repeatedTransaction
        ? `${pathname}-e2e-redelivery-${redeliverySequence}${query}`
        : path
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
        projectNames: Array.from(new Set(
            Array.from(document.querySelectorAll('button.session-row'))
                .map(element => element.dataset.projectName || '')
                .filter(Boolean),
        )),
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
        userMessages: Array.from(document.querySelectorAll('.chat-feed .user-bubble > p'))
            .map(element => normalized(element.textContent)),
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
    await waitFor(async () => await browserProjectRows(page, projectName).count() >= 1, {
        description: `browser project ${projectName}`,
        timeoutMs: CONVERGENCE_TIMEOUT_MS,
    })
    await assertBrowserHealthy(page)
}

async function waitForBrowserProjectAbsent(page: Page, projectName: string): Promise<void> {
    await waitFor(async () => await browserProjectRows(page, projectName).count() === 0, {
        description: `browser removal of project ${projectName}`,
        timeoutMs: CONVERGENCE_TIMEOUT_MS,
    })
    await assertBrowserHealthy(page)
}

async function openBrowserProject(page: Page, projectName: string): Promise<void> {
    const toggles = page.locator('button.project-session-toggle')
    for (let index = 0; index < await toggles.count(); index += 1) {
        const toggle = toggles.nth(index)
        if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
    }
    const rows = browserProjectRows(page, projectName)
    const selected = page.locator(
        `button.session-row[data-project-name=${JSON.stringify(projectName)}][aria-pressed="true"]`,
    )
    const row = await selected.count() > 0 ? selected.first() : rows.first()
    await row.waitFor({ state: 'attached', timeout: UI_FEEDBACK_TIMEOUT_MS })
    if (await row.getAttribute('aria-pressed') !== 'true') await row.click()
    await waitFor(async () => await row.getAttribute('aria-pressed') === 'true', {
        description: `selected browser session for ${projectName}`,
        timeoutMs: UI_FEEDBACK_TIMEOUT_MS,
    })
}

function browserProjectRows(page: Page, projectName: string) {
    return page.locator(
        `button.session-row[data-project-name=${JSON.stringify(projectName)}]`,
    )
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
    await waitFor(async () => await browserProjectRows(page, projectName).count() === 0, {
        description: `browser deletion of ${projectName}`,
        timeoutMs: CONVERGENCE_TIMEOUT_MS,
    })
}

async function cleanupBrowserProject(page: Page, projectName: string): Promise<void> {
    if (await browserProjectRows(page, projectName).count() === 0) return
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
    const startedAt = Date.now()
    let activityRestarted = false
    let lastError = 'WebView process did not start'
    while (Date.now() < deadline) {
        const pid = await adbMaybe(serial, 'shell', 'pidof', PACKAGE_NAME)
        if (!pid) {
            if (!activityRestarted && Date.now() - startedAt >= 5_000) {
                activityRestarted = true
                const launch = await adbMaybe(
                    serial,
                    'shell',
                    'am',
                    'start',
                    '-W',
                    '-n',
                    MAIN_ACTIVITY,
                )
                lastError = launch
                    ? 'WebView process was absent; Activity restart requested'
                    : 'WebView process was absent and Activity restart failed'
            }
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
    const confirmedBefore = await diagnosticCount(
        serial,
        'activity.pairing_completion.confirmed',
    )
    // The emulator may have received a foreground intent while native Matrix
    // completed its first sync, or another local acceptance task may briefly
    // foreground a different app. A coordinate injection is not evidence that
    // Android delivered the click, so reacquire the Activity and require the
    // native confirmation diagnostic before returning.
    while (Date.now() < deadline) {
        await adb(serial, 'shell', 'am', 'start', '-n', MAIN_ACTIVITY)
        await delay(250)
        await adbMaybe(serial, 'shell', 'uiautomator', 'dump', path)
        const xml = await adbMaybe(serial, 'shell', 'cat', path)
        if (!xml.includes(`Pair with Codever E2E Gateway ${runId}?`)) {
            if (
                await diagnosticCount(
                    serial,
                    'activity.pairing_completion.confirmed',
                ) > confirmedBefore
            ) return
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
        await delay(500)
        if (
            await diagnosticCount(
                serial,
                'activity.pairing_completion.confirmed',
            ) > confirmedBefore
        ) return
    }
    throw new Error('Timed out completing the native Android pairing confirmation.')
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

async function gatewayStateResponseCount(serial: string): Promise<number> {
    return await diagnosticCount(serial, 'gateway.room_state.accepted')
        + await diagnosticCount(serial, 'gateway.room_state.duplicate')
}

async function installedVersionName(serial: string): Promise<string> {
    const output = await adb(serial, 'shell', 'dumpsys', 'package', PACKAGE_NAME)
    const match = output.match(/versionName=([^\s]+)/u)
    assert.ok(match?.[1], 'The installed Alpha APK version is unavailable')
    return match[1]
}

async function seedLegacySubmittedCommand(serial: string, runId: string): Promise<string> {
    const output = await adb(
        serial,
        'shell',
        'am',
        'broadcast',
        '-f',
        '0x20', // Intent.FLAG_INCLUDE_STOPPED_PACKAGES
        '-n',
        LEGACY_OUTBOX_SEEDER,
        '--es',
        'run_id',
        runId,
    )
    const result = output.match(/Broadcast completed: result=(-?\d+), data="([^"]+)"/u)
    assert.equal(
        result?.[1],
        '-1',
        `The E2E APK could not seed its encrypted legacy outbox: ${output}`,
    )
    const commandId = result?.[2]
    assert.ok(commandId, `The E2E APK did not return its legacy command id: ${output}`)
    return commandId
}

async function removePersistedMatrixSession(serial: string): Promise<void> {
    const output = await adb(
        serial,
        'shell',
        'am',
        'broadcast',
        '-f',
        '0x20',
        '-n',
        MATRIX_SESSION_FAULT,
    )
    const result = output.match(/Broadcast completed: result=(-?\d+), data="([^"]+)"/u)
    assert.equal(result?.[1], '-1', `The E2E APK could not remove its Matrix session: ${output}`)
    assert.equal(result?.[2], 'matrix-session-removed')
}

async function replayLedgerLineCount(path: string): Promise<number> {
    return (await replayLedgerEntries(path)).length
}

async function waitForSingleCommittedCommand(
    path: string,
    startLine: number,
    description: string,
): Promise<CommandReplayEvidence> {
    let evidence: CommandReplayEvidence | undefined
    await waitFor(async () => {
        const appended = (await replayLedgerEntries(path)).slice(startLine)
        const acceptances = appended.flatMap(entry => {
            const revision = asJsonRecord(entry.revision)
            return revision && typeof revision.commandKey === 'string' && typeof revision.value === 'number'
                ? [{ commandKey: revision.commandKey, revision: revision.value }]
                : []
        })
        assert.ok(
            acceptances.length <= 1,
            `${description} produced ${acceptances.length} durable command acceptances`,
        )
        const accepted = acceptances[0]
        if (!accepted) return false
        const results = appended.filter(entry =>
            entry.kind === 'command_result' && entry.commandKey === accepted.commandKey,
        )
        assert.ok(
            results.length <= 1,
            `${description} produced ${results.length} durable terminal results`,
        )
        if (results.length !== 1) return false
        evidence = accepted
        return true
    }, {
        description: `${description} to commit before Android receives its acknowledgement`,
        timeoutMs: CONVERGENCE_TIMEOUT_MS,
    })
    assert.ok(evidence, `${description} did not leave durable replay evidence`)
    return evidence
}

async function assertCommandRecordedExactlyOnce(
    path: string,
    evidence: CommandReplayEvidence,
): Promise<void> {
    const entries = await replayLedgerEntries(path)
    const acceptances = entries.filter(entry => {
        const revision = asJsonRecord(entry.revision)
        return revision?.commandKey === evidence.commandKey
    })
    const results = entries.filter(entry =>
        entry.kind === 'command_result' && entry.commandKey === evidence.commandKey,
    )
    assert.equal(
        acceptances.length,
        1,
        `Recovered command revision ${evidence.revision} was accepted more than once`,
    )
    assert.equal(
        results.length,
        1,
        `Recovered command revision ${evidence.revision} produced more than one terminal result`,
    )
}

async function replayLedgerEntries(path: string): Promise<JsonRecord[]> {
    const text = await readFile(path, 'utf8')
    return text
        .split(/\r?\n/u)
        .filter(line => line.trim().length > 0)
        .map(line => JSON.parse(line) as JsonRecord)
}

function asJsonRecord(value: unknown): JsonRecord | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonRecord
        : null
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
    const systemLog = await adbMaybe(
        serial,
        'logcat',
        '-d',
        '-v',
        'threadtime',
        'AndroidRuntime:E',
        'ActivityTaskManager:I',
        'ActivityManager:I',
        'chromium:W',
        '*:S',
    )
    await Promise.all([
        writeFile(join(options.artifactDirectory, 'android-state.json'), JSON.stringify(state, null, 2), 'utf8'),
        writeFile(join(options.artifactDirectory, 'android-native.log'), diagnostics, 'utf8'),
        writeFile(join(options.artifactDirectory, 'android-notifications.log'), notifications, 'utf8'),
        writeFile(join(options.artifactDirectory, 'android-system.log'), systemLog, 'utf8'),
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

async function waitForProviderDigest(
    gatewayOutput: () => string,
    expectedInput: string,
    expectedCount: number,
): Promise<void> {
    const marker = `[e2e-provider] invocation sha256=${sha256(expectedInput)}`
    await waitFor(() => gatewayOutput().includes(marker), {
        description: `Android privacy Agent invocation ${marker}`,
        timeoutMs: CONVERGENCE_TIMEOUT_MS,
    })
    assert.equal(
        providerInvocationCount(gatewayOutput()),
        expectedCount,
        'The Android privacy journey produced an unexpected Agent invocation',
    )
}

function providerInvocationCount(output: string): number {
    return output.split('[e2e-provider] invocation sha256=').length - 1
}

function providerDigestCount(output: string, input: string): number {
    return output.split(`[e2e-provider] invocation sha256=${sha256(input)}`).length - 1
}

function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex')
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
