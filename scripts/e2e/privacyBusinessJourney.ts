import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile } from 'node:fs/promises'
import {
    createServer as createHttpServer,
    type IncomingMessage,
    type Server as HttpServer,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import type { Locator, Page } from 'playwright-core'
import { hasSessionExtensionDescriptor } from '../../extensions/has-privacy/src/manifest.js'

const CONVERGENCE_TIMEOUT_MS = 15_000
const UI_FEEDBACK_TIMEOUT_MS = 1_500
const EXTENSION_STARTUP_TIMEOUT_MS = 15_000
const PROVIDER_INVOCATION_PREFIX = '[e2e-provider] invocation sha256='
const PROVIDER_ECHO_PREFIX = 'Agent received exactly: '
const SENSITIVE_NAME = '张三'
const PSEUDONYM = '李四'

export interface PrivacyBusinessFixture {
    readonly gatewayRegistration: string
    readonly output: string
    readonly stateDirectory: string
    startExtension(): Promise<void>
    stopExtension(): Promise<void>
    close(): Promise<void>
}

export interface PrivacyBusinessJourneyOptions {
    repositoryRoot: string
    runId: string
    cwd: string
    firstPage: Page
    secondPage: Page
    directProjectName: string
    gatewayOutput(): string
    fixture: PrivacyBusinessFixture
}

export async function startPrivacyBusinessFixture(
    repositoryRoot: string,
    temporaryDirectory: string,
): Promise<PrivacyBusinessFixture> {
    const stateDirectory = join(temporaryDirectory, 'has-privacy-state')
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 })

    const modelServer = createHttpServer(async (request, response) => {
        try {
            const body = await readJsonRequest(request)
            const prompt = String(
                (body.messages as Array<{ content?: unknown }> | undefined)?.[0]?.content ?? '',
            )
            const content = prompt.includes(SENSITIVE_NAME)
                ? JSON.stringify({ '个人姓名': [SENSITIVE_NAME] })
                : '{}'
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end(JSON.stringify({
                choices: [{ finish_reason: 'stop', message: { content } }],
            }))
        } catch (error) {
            response.writeHead(400, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ error: formatError(error) }))
        }
    })
    const modelPort = await listen(modelServer)
    const extensionPort = await unusedPort()
    const bearerToken = randomBytes(32).toString('base64url')
    const vaultKey = randomBytes(32).toString('base64')
    let extension: ChildProcess | undefined
    let extensionOutput = ''

    const startExtension = async (): Promise<void> => {
        if (extension && extension.exitCode === null && extension.signalCode === null) return
        const outputOffset = extensionOutput.length
        const child = spawn(
            process.execPath,
            [
                resolve(repositoryRoot, 'node_modules/tsx/dist/cli.mjs'),
                resolve(repositoryRoot, 'extensions/has-privacy/src/main.ts'),
            ],
            {
                cwd: repositoryRoot,
                env: {
                    ...process.env,
                    HAS_EXTENSION_PORT: String(extensionPort),
                    HAS_EXTENSION_TOKEN: bearerToken,
                    HAS_PRIVACY_VAULT_KEY: vaultKey,
                    HAS_MODEL: 'business-e2e-fixture',
                    HAS_MODEL_REVISION: 'business-e2e-fixture-v1',
                    HAS_ENDPOINT: `http://127.0.0.1:${modelPort}/v1/chat/completions`,
                    HAS_PRIVACY_STATE_DIR: stateDirectory,
                    HAS_TIMEOUT_MS: '5000',
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            },
        )
        extension = child
        child.stdout?.on('data', chunk => { extensionOutput += String(chunk) })
        child.stderr?.on('data', chunk => { extensionOutput += String(chunk) })
        try {
            await waitForChildOutput(
                child,
                () => extensionOutput.slice(outputOffset),
                /HaS session extension:/u,
                EXTENSION_STARTUP_TIMEOUT_MS,
            )
        } catch (error) {
            await stopChild(child).catch(() => undefined)
            throw error
        }
    }

    const stopExtension = async (): Promise<void> => {
        const child = extension
        extension = undefined
        if (!child) return
        await stopChild(child)
    }

    try {
        await startExtension()
    } catch (error) {
        await closeServer(modelServer).catch(() => undefined)
        throw error
    }

    return {
        gatewayRegistration: JSON.stringify([{
            descriptor: hasSessionExtensionDescriptor,
            endpoint: `http://127.0.0.1:${extensionPort}`,
            bearerToken,
            timeoutMs: 5_000,
        }]),
        get output() { return extensionOutput },
        stateDirectory,
        startExtension,
        stopExtension,
        async close() {
            await stopExtension()
            await closeServer(modelServer)
        },
    }
}

export async function runPrivacyBusinessJourney(
    options: PrivacyBusinessJourneyOptions,
): Promise<void> {
    const projectName = `Codever Privacy E2E ${options.runId}`
    const contextId = `metapp-private-${options.runId}`

    process.stdout.write('  [P1/7] Creating a privacy-bound session through the shipped PWA…\n')
    await createPrivacySession(options.firstPage, projectName, options.cwd, contextId)
    await waitForProject(options.secondPage, projectName)
    await assertPrivacyBadge(options.firstPage, projectName)
    await assertPrivacyBadge(options.secondPage, projectName)

    process.stdout.write('  [P2/7] Denying the exact sanitized preview before Agent egress…\n')
    const deniedPrompt = `请联系${SENSITIVE_NAME}处理隐私拒绝请求 ${options.runId}`
    const deniedSanitized = deniedPrompt.replaceAll(SENSITIVE_NAME, PSEUDONYM)
    const beforeDenied = providerInvocationCount(options.gatewayOutput())
    await sendPrompt(options.firstPage, deniedPrompt)
    const deniedDecision = await waitForPrivacyDecision(
        options.firstPage,
        deniedSanitized,
    )
    assert.equal(providerInvocationCount(options.gatewayOutput()), beforeDenied)
    await deniedDecision.getByRole('button', { name: 'Cancel', exact: true }).click()
    await waitForText(options.firstPage, 'Request cancelled before it reached the Agent.')
    await waitForDecisionState(deniedDecision, 'Denied')
    assert.equal(
        providerInvocationCount(options.gatewayOutput()),
        beforeDenied,
        'The denied privacy preview reached the Agent provider',
    )

    process.stdout.write('  [P3/7] Approving sanitized egress and restoring Agent output locally…\n')
    const approvedPrompt = `请联系${SENSITIVE_NAME}处理隐私批准请求 ${options.runId}`
    const approvedSanitized = approvedPrompt.replaceAll(SENSITIVE_NAME, PSEUDONYM)
    const beforeApproved = providerInvocationCount(options.gatewayOutput())
    await sendPrompt(options.firstPage, approvedPrompt)
    const approvedDecision = await waitForPrivacyDecision(
        options.firstPage,
        approvedSanitized,
    )
    await approvedDecision.getByRole('button', { name: 'Send to Agent', exact: true }).click()
    await waitForProviderInvocation(
        options.gatewayOutput,
        approvedSanitized,
        beforeApproved + 1,
    )
    assert.equal(
        options.gatewayOutput().includes(`${PROVIDER_INVOCATION_PREFIX}${sha256(approvedPrompt)}`),
        false,
        'The deterministic Agent provider received the unsanitized prompt',
    )
    const restoredAgentText = `${PROVIDER_ECHO_PREFIX}${approvedPrompt}`
    await waitForAgentText(options.firstPage, restoredAgentText)
    await waitForDecisionState(approvedDecision, 'Allowed once')
    assert.equal(
        await options.firstPage.locator('.agent-bubble').filter({
            hasText: `${PROVIDER_ECHO_PREFIX}${approvedSanitized}`,
        }).count(),
        0,
        'The PWA exposed the Agent-facing pseudonym instead of restoring private text',
    )

    process.stdout.write('  [P4/7] Converging and restoring the protected transcript on another browser…\n')
    await openProjectSession(options.secondPage, projectName)
    await waitForText(options.secondPage, approvedPrompt)
    await waitForAgentText(options.secondPage, restoredAgentText)
    await options.secondPage.reload({ waitUntil: 'domcontentloaded' })
    await waitForConnected(options.secondPage)
    await waitForProject(options.secondPage, projectName)
    await openProjectSession(options.secondPage, projectName)
    await waitForAgentText(options.secondPage, restoredAgentText)
    await assertPrivacyBadge(options.secondPage, projectName)

    process.stdout.write('  [P5/7] Stopping HaS and proving bound sessions fail closed…\n')
    await options.fixture.stopExtension()
    await openProjectSession(options.firstPage, options.directProjectName)
    const directPrompt = `unbound privacy availability probe ${options.runId}`
    const beforeDirect = providerInvocationCount(options.gatewayOutput())
    await sendPrompt(options.firstPage, directPrompt)
    await waitForProviderInvocation(options.gatewayOutput, directPrompt, beforeDirect + 1)
    await waitForAgentText(options.firstPage, `${PROVIDER_ECHO_PREFIX}${directPrompt}`)

    await openProjectSession(options.firstPage, projectName)
    const offlinePrompt = `请联系${SENSITIVE_NAME}处理扩展离线请求 ${options.runId}`
    const beforeOffline = providerInvocationCount(options.gatewayOutput())
    await sendPrompt(options.firstPage, offlinePrompt)
    await waitFor(async () => {
        const text = await options.firstPage.locator('.agent-bubble, .error-bubble')
            .last().textContent()
        return /has-privacy|extension/iu.test(text ?? '')
            && /unavailable/iu.test(text ?? '')
    }, {
        description: 'visible fail-closed privacy extension error',
        timeoutMs: CONVERGENCE_TIMEOUT_MS,
    })
    assert.equal(
        providerInvocationCount(options.gatewayOutput()),
        beforeOffline,
        'A privacy-bound prompt bypassed the unavailable extension',
    )
    assert.equal(
        options.gatewayOutput().includes(`${PROVIDER_INVOCATION_PREFIX}${sha256(offlinePrompt)}`),
        false,
        'The offline privacy-bound prompt reached the Agent provider',
    )

    process.stdout.write('  [P6/7] Restarting HaS with its encrypted mapping state…\n')
    await options.fixture.startExtension()
    const recoveryPrompt = `请联系${SENSITIVE_NAME}处理隐私恢复请求 ${options.runId}`
    const recoverySanitized = recoveryPrompt.replaceAll(SENSITIVE_NAME, PSEUDONYM)
    const beforeRecovery = providerInvocationCount(options.gatewayOutput())
    await sendPrompt(options.firstPage, recoveryPrompt)
    const recoveryDecision = await waitForPrivacyDecision(
        options.firstPage,
        recoverySanitized,
    )
    await recoveryDecision.getByRole('button', { name: 'Send to Agent', exact: true }).click()
    await waitForProviderInvocation(
        options.gatewayOutput,
        recoverySanitized,
        beforeRecovery + 1,
    )
    await waitForAgentText(
        options.firstPage,
        `${PROVIDER_ECHO_PREFIX}${recoveryPrompt}`,
    )
    await assertProtectedStorage(options.fixture.stateDirectory, [
        SENSITIVE_NAME,
        contextId,
        deniedPrompt,
        approvedPrompt,
        offlinePrompt,
        recoveryPrompt,
    ])

    process.stdout.write('  [P7/7] Deleting the protected session and converging removal…\n')
    await deleteSelectedSession(options.firstPage)
    await Promise.all([
        waitForProjectAbsent(options.firstPage, projectName),
        waitForProjectAbsent(options.secondPage, projectName),
    ])
}

async function createPrivacySession(
    page: Page,
    projectName: string,
    cwd: string,
    contextId: string,
): Promise<void> {
    await page.getByRole('button', { name: 'New conversation' }).click()
    const dialog = page.locator('.new-session-dialog')
    await dialog.waitFor({ state: 'visible', timeout: CONVERGENCE_TIMEOUT_MS })
    await dialog.locator('select').first().selectOption('__new_project__')
    await dialog.getByPlaceholder('My project').fill(projectName)
    await dialog.getByPlaceholder('/Users/me/Documents/project').fill(cwd)

    const option = dialog.locator('.session-extension-option').filter({ hasText: 'HaS privacy' })
    await option.waitFor({ state: 'visible', timeout: CONVERGENCE_TIMEOUT_MS })
    const toggle = option.locator('.session-extension-toggle input[type="checkbox"]')
    assert.equal(await toggle.isChecked(), false, 'HaS privacy must be off by default')
    assert.equal(
        await dialog.getByRole('button', { name: 'Create session', exact: true }).isEnabled(),
        true,
        'An optional privacy extension changed the direct-session default path',
    )
    await toggle.check()
    assert.equal(
        await dialog.getByRole('button', { name: 'Create session', exact: true }).isDisabled(),
        true,
        'The required privacy context did not block session creation',
    )
    const review = option.locator('.session-extension-boolean input[type="checkbox"]')
    assert.equal(await review.isChecked(), true, 'Privacy egress review must default to enabled')
    await option.getByPlaceholder('payroll-system-id').fill(contextId)

    const startedAt = Date.now()
    await dialog.getByRole('button', { name: 'Create session', exact: true }).click()
    await page.locator('.session-create-pending').waitFor({
        state: 'visible',
        timeout: UI_FEEDBACK_TIMEOUT_MS,
    })
    await waitForProject(page, projectName)
    assert.ok(
        Date.now() - startedAt <= CONVERGENCE_TIMEOUT_MS,
        `Privacy session creation exceeded ${CONVERGENCE_TIMEOUT_MS} ms`,
    )
}

async function waitForPrivacyDecision(page: Page, sanitizedPrompt: string): Promise<Locator> {
    const card = page.locator('.permission-card').filter({
        hasText: sanitizedPrompt,
    }).last()
    await card.waitFor({ state: 'visible', timeout: CONVERGENCE_TIMEOUT_MS })
    const details = card.locator('.permission-details')
    await details.waitFor({ state: 'visible', timeout: CONVERGENCE_TIMEOUT_MS })
    const text = await details.textContent() ?? ''
    assert.match(text, /The Agent will receive exactly:/u)
    assert.ok(text.includes(sanitizedPrompt), 'The PWA omitted the exact sanitized Agent prompt')
    assert.equal(text.includes(SENSITIVE_NAME), false, 'The privacy preview exposed source private text')
    assert.ok(text.includes(PSEUDONYM), 'The privacy preview omitted the replacement pseudonym')
    return card
}

async function waitForDecisionState(card: Locator, state: string): Promise<void> {
    await card.locator('.decision-state').filter({ hasText: state }).waitFor({
        state: 'visible',
        timeout: CONVERGENCE_TIMEOUT_MS,
    })
}

async function assertPrivacyBadge(page: Page, projectName: string): Promise<void> {
    const group = projectGroup(page, projectName)
    const toggle = group.locator('button.project-session-toggle')
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
    await group.locator('.session-extension-badge').filter({ hasText: 'HaS privacy' }).waitFor({
        state: 'visible',
        timeout: CONVERGENCE_TIMEOUT_MS,
    })
}

async function openProjectSession(page: Page, projectName: string): Promise<void> {
    const group = projectGroup(page, projectName)
    const toggle = group.locator('button.project-session-toggle')
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
    const row = group.locator('button.session-row').first()
    if (!(await row.getAttribute('class'))?.includes('selected')) await row.click()
    await waitFor(async () => (await row.getAttribute('class'))?.includes('selected') ?? false, {
        description: `selected privacy journey session in ${projectName}`,
        timeoutMs: CONVERGENCE_TIMEOUT_MS,
    })
}

async function sendPrompt(page: Page, prompt: string): Promise<void> {
    const composer = page.locator('textarea[aria-label^="Message "]')
    await waitFor(async () => await composer.isEnabled(), {
        description: 'enabled privacy journey composer',
        timeoutMs: CONVERGENCE_TIMEOUT_MS,
    })
    await composer.fill(prompt)
    await page.getByRole('button', { name: /^(Send|Queue) message$/u }).click()
}

async function deleteSelectedSession(page: Page): Promise<void> {
    const details = page.getByRole('button', { name: 'Conversation details' })
    if (await details.getAttribute('aria-expanded') !== 'true') await details.click()
    await page.getByRole('button').filter({
        has: page.locator('strong', { hasText: /^Delete session$/u }),
    }).click()
    const dialog = page.getByRole('alertdialog')
    await dialog.waitFor({ state: 'visible', timeout: CONVERGENCE_TIMEOUT_MS })
    await dialog.getByRole('button', { name: 'Delete session', exact: true }).click()
}

async function waitForProviderInvocation(
    gatewayOutput: () => string,
    expectedInput: string,
    expectedCount: number,
): Promise<void> {
    const digest = sha256(expectedInput)
    await waitFor(() => gatewayOutput().includes(`${PROVIDER_INVOCATION_PREFIX}${digest}`), {
        description: `Agent provider invocation ${digest}`,
        timeoutMs: CONVERGENCE_TIMEOUT_MS,
    })
    assert.equal(
        providerInvocationCount(gatewayOutput()),
        expectedCount,
        'The privacy journey produced an unexpected number of Agent invocations',
    )
}

function providerInvocationCount(output: string): number {
    return output.split(PROVIDER_INVOCATION_PREFIX).length - 1
}

async function waitForAgentText(page: Page, text: string): Promise<void> {
    await page.locator('.agent-bubble').filter({ hasText: text }).last().waitFor({
        state: 'visible',
        timeout: CONVERGENCE_TIMEOUT_MS,
    })
}

async function waitForText(page: Page, text: string): Promise<void> {
    await page.getByText(text, { exact: false }).last().waitFor({
        state: 'visible',
        timeout: CONVERGENCE_TIMEOUT_MS,
    })
}

async function waitForConnected(page: Page): Promise<void> {
    await waitFor(async () => {
        const label = await page.locator('button[aria-label^="Open connection settings,"]')
            .getAttribute('aria-label')
        return label?.endsWith('Connected') ?? false
    }, {
        description: 'privacy journey browser reconnection',
        timeoutMs: CONVERGENCE_TIMEOUT_MS,
    })
}

async function waitForProject(page: Page, projectName: string): Promise<void> {
    await projectGroup(page, projectName).waitFor({
        state: 'visible',
        timeout: CONVERGENCE_TIMEOUT_MS,
    })
}

async function waitForProjectAbsent(page: Page, projectName: string): Promise<void> {
    await waitFor(async () => await projectGroup(page, projectName).count() === 0, {
        description: `privacy project ${projectName} to disappear`,
        timeoutMs: CONVERGENCE_TIMEOUT_MS,
    })
}

function projectGroup(page: Page, projectName: string): Locator {
    return page.locator('.project-session-group').filter({
        has: page.locator('.project-copy strong', { hasText: projectName }),
    })
}

async function assertProtectedStorage(
    stateDirectory: string,
    forbiddenPlaintext: readonly string[],
): Promise<void> {
    const [vault, audit] = await Promise.all([
        readFile(join(stateDirectory, 'mapping-vault.json'), 'utf8'),
        readFile(join(stateDirectory, 'privacy-audit.jsonl'), 'utf8'),
    ])
    assert.match(vault, /"ciphertext"/u, 'The privacy mapping vault did not persist ciphertext')
    assert.match(audit, /"action":"commit"/u, 'The privacy audit did not record a committed turn')
    for (const value of forbiddenPlaintext) {
        assert.equal(vault.includes(value), false, `The encrypted privacy vault contains ${value}`)
        assert.equal(audit.includes(value), false, `The metadata-only privacy audit contains ${value}`)
    }
}

async function readJsonRequest(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

async function listen(server: HttpServer): Promise<number> {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    return (server.address() as AddressInfo).port
}

async function unusedPort(): Promise<number> {
    const server = createHttpServer()
    const port = await listen(server)
    await closeServer(server)
    return port
}

async function closeServer(server: HttpServer): Promise<void> {
    if (!server.listening) return
    await new Promise<void>((resolveClose, rejectClose) =>
        server.close(error => error ? rejectClose(error) : resolveClose()))
}

async function stopChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    const graceful = await Promise.race([
        exited.then(() => true),
        delay(5_000).then(() => false),
    ])
    if (!graceful) {
        child.kill('SIGKILL')
        await once(child, 'exit')
    }
}

async function waitForChildOutput(
    child: ChildProcess,
    output: () => string,
    pattern: RegExp,
    timeoutMs: number,
): Promise<void> {
    await new Promise<void>((resolveReady, rejectReady) => {
        const timer = setTimeout(() => {
            cleanup()
            rejectReady(new Error(
                `Timed out waiting for privacy fixture ${pattern}. Last output:\n${output().slice(-4_000)}`,
            ))
        }, timeoutMs)
        const inspect = () => {
            if (!pattern.test(output())) return
            cleanup()
            resolveReady()
        }
        const exited = (code: number | null, signal: NodeJS.Signals | null) => {
            cleanup()
            rejectReady(new Error(
                `Privacy fixture exited during startup: code=${code} signal=${signal}\n${output().slice(-4_000)}`,
            ))
        }
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

function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex')
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds))
}
