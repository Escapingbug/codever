import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { commandSchema, type SessionExtensionBinding } from '@codever/protocol'
import type {
    ChannelMessage,
    ChannelPort,
    DecisionRequest,
    SessionStatus,
} from '@/bridge/channelPort'
import type {
    AgentProvider,
    AgentQueryConfig,
    AgentQueryHandle,
    AgentQueryInput,
} from '@/providers/provider'
import type { AgentEvent } from '@/providers/types'
import { createSessionExtensionRegistryFromEnvironment } from '@/runtime/sessionExtensionConfig'
import { SemanticSessionRuntime } from '@/runtime/semanticSessionRuntime'

const children = new Set<ChildProcess>()
const servers = new Set<Server>()
const temporaryDirectories = new Set<string>()

afterEach(async () => {
    await Promise.all([...children].map(stopChild))
    await Promise.all([...servers].map(closeServer))
    await Promise.all([...temporaryDirectories].map(path =>
        rm(path, { recursive: true, force: true })))
    children.clear()
    servers.clear()
    temporaryDirectories.clear()
})

describe('PWA session binding -> HaS process -> Agent runtime', () => {
    it('sends only sanitized text to the Agent and restores streamed output', async () => {
        const fixture = await startHasProcess()
        const binding = parsePwaSessionBinding('metapp-payroll-e2e')
        const registry = await registryFor(fixture)
        const normalized = registry.normalizeBindings([binding])
        const agent = new RecordingAgent([
            { kind: 'text', text: '李' },
            { kind: 'text', text: '四已收到请求' },
            { kind: 'result', status: 'success' },
        ])
        const channel = new RecordingChannel('send')
        const runtime = createRuntime(registry, normalized, agent, channel)

        await runtime.dispatch({
            kind: 'user_message',
            text: '请联系张三处理这份记录',
            source: 'channel',
        })

        expect(agent.inputs).toEqual(['请联系李四处理这份记录'])
        expect(channel.decisions).toHaveLength(1)
        expect(channel.decisions[0]?.details).toContain('请联系李四处理这份记录')
        expect(channel.decisions[0]?.details).not.toContain('张三')
        const visible = channel.messages.map(message => message.text).join('\n')
        expect(visible).toContain('张三已收到请求')
        expect(visible).not.toContain('李四已收到请求')

        await runtime.destroy()
        const vault = await readFile(join(fixture.stateDirectory, 'mapping-vault.json'), 'utf8')
        const audit = await readFile(join(fixture.stateDirectory, 'privacy-audit.jsonl'), 'utf8')
        expect(vault).not.toContain('张三')
        expect(audit).not.toContain('张三')
        expect(audit).not.toContain('metapp-payroll-e2e')
    })

    it('does not invoke the Agent when the outbound preview is denied', async () => {
        const fixture = await startHasProcess()
        const registry = await registryFor(fixture)
        const normalized = registry.normalizeBindings([
            parsePwaSessionBinding('metapp-denied-e2e'),
        ])
        const agent = new RecordingAgent([{ kind: 'result', status: 'success' }])
        const channel = new RecordingChannel('cancel')
        const runtime = createRuntime(registry, normalized, agent, channel)

        await runtime.dispatch({
            kind: 'user_message',
            text: '请联系张三',
            source: 'channel',
        })

        expect(channel.decisions).toHaveLength(1)
        expect(agent.inputs).toEqual([])
        expect(channel.messages.at(-1)?.text).toContain(
            'cancelled before it reached the Agent',
        )
        await runtime.destroy()
    })

    it('fails closed before Agent invocation when the bound process is offline', async () => {
        const fixture = await startHasProcess()
        const registry = await registryFor(fixture)
        const child = [...children][0]!
        await stopChild(child)
        children.delete(child)
        const normalized = registry.normalizeBindings([
            parsePwaSessionBinding('metapp-offline-e2e'),
        ])
        const agent = new RecordingAgent([{ kind: 'result', status: 'success' }])
        const channel = new RecordingChannel('send')
        const runtime = createRuntime(registry, normalized, agent, channel)

        await runtime.dispatch({
            kind: 'user_message',
            text: '请联系张三',
            source: 'channel',
        })

        expect(agent.inputs).toEqual([])
        expect(channel.messages.at(-1)?.text).toContain('extension')
        expect(channel.messages.at(-1)?.text).toContain('unavailable')
        await runtime.destroy()
    })
})

interface HasProcessFixture {
    extensionPort: number
    token: string
    stateDirectory: string
}

async function startHasProcess(): Promise<HasProcessFixture> {
    const modelServer = createServer(async (request, response) => {
        const body = await readRequest(request)
        const prompt = String(
            (body.messages as Array<{ content?: unknown }> | undefined)?.[0]?.content ?? '',
        )
        const content = prompt.includes('张三')
            ? JSON.stringify({ 个人姓名: ['张三'] })
            : '{}'
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content } }],
        }))
    })
    const modelPort = await listen(modelServer)
    servers.add(modelServer)

    const extensionPort = await unusedPort()
    const stateDirectory = await mkdtemp(join(tmpdir(), 'codever-has-e2e-'))
    temporaryDirectories.add(stateDirectory)
    const token = randomBytes(32).toString('base64url')
    const child = spawn(
        process.execPath,
        [
            resolve('node_modules/tsx/dist/cli.mjs'),
            resolve('extensions/has-privacy/src/main.ts'),
        ],
        {
            cwd: process.cwd(),
            env: {
                ...process.env,
                HAS_EXTENSION_PORT: String(extensionPort),
                HAS_EXTENSION_TOKEN: token,
                HAS_PRIVACY_VAULT_KEY: randomBytes(32).toString('base64'),
                HAS_MODEL: 'fixture-has',
                HAS_MODEL_REVISION: 'fixture-model-digest',
                HAS_ENDPOINT: `http://127.0.0.1:${modelPort}/v1/chat/completions`,
                HAS_PRIVACY_STATE_DIR: stateDirectory,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        },
    )
    children.add(child)
    await waitForChildReady(child)
    return { extensionPort, token, stateDirectory }
}

function registryFor(fixture: HasProcessFixture) {
    return createSessionExtensionRegistryFromEnvironment({
        CODEVER_SESSION_EXTENSIONS_JSON: JSON.stringify([{
            endpoint: `http://127.0.0.1:${fixture.extensionPort}`,
            bearerToken: fixture.token,
            expectedExtensionId: 'has-privacy',
            timeoutMs: 5_000,
        }]),
    })
}

function parsePwaSessionBinding(contextId: string): SessionExtensionBinding {
    const command = commandSchema.parse({
        kind: 'codever.command',
        version: 1,
        commandId: randomUUID(),
        gatewayId: 'gateway-e2e',
        deviceId: 'pwa-e2e',
        sequenceEpoch: 'epoch-e2e',
        conversationId: 'conversation-e2e',
        revisionEpoch: 'revision-epoch-e2e',
        sequence: 1,
        baseRevision: 0,
        operation: 'session.create',
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        nonce: randomBytes(18).toString('base64url'),
        payload: {
            operation: 'session.create',
            cwd: '/workspace',
            projectName: 'Metapp E2E',
            extensions: [{
                id: 'has-privacy',
                config: { contextId, reviewRequired: true },
            }],
        },
    })
    if (command.payload.operation !== 'session.create') {
        throw new Error('Expected a session.create command')
    }
    const binding = command.payload.extensions?.[0]
    if (!binding) throw new Error('Expected the PWA extension binding')
    return binding
}

function createRuntime(
    registry: Awaited<ReturnType<typeof createSessionExtensionRegistryFromEnvironment>>,
    bindings: readonly SessionExtensionBinding[],
    agent: RecordingAgent,
    channel: RecordingChannel,
): SemanticSessionRuntime {
    const sessionId = `session-${randomUUID()}`
    return new SemanticSessionRuntime({
        sessionId,
        cwd: '/workspace',
        provider: agent,
        providerName: agent.name,
        channelPort: channel,
        extensions: registry.createInstances(bindings, {
            sessionId,
            cwd: '/workspace',
            providerName: agent.name,
        }),
    })
}

class RecordingAgent implements AgentProvider {
    readonly name = 'simulated-acp-agent'
    readonly inputs: AgentQueryInput[] = []

    constructor(private readonly output: readonly AgentEvent[]) {}

    startQuery(input: AgentQueryInput, _config: AgentQueryConfig): AgentQueryHandle {
        this.inputs.push(input)
        const output = this.output
        return {
            events: (async function* () {
                for (const event of output) yield event
            })(),
            interrupt: async () => {},
        }
    }

    isReady(): boolean { return true }
    getInitError(): string | null { return null }
    getAvailableModels(): [] { return [] }
    getAvailablePermissionModes(): [] { return [] }
}

class RecordingChannel implements ChannelPort {
    readonly messages: ChannelMessage[] = []
    readonly decisions: DecisionRequest[] = []
    readonly statuses: SessionStatus[] = []

    constructor(private readonly decision: string) {}

    async send(message: ChannelMessage) {
        this.messages.push(message)
        return { messageId: this.messages.length }
    }

    async edit(_messageId: string | number, message: ChannelMessage): Promise<void> {
        this.messages.push(message)
    }

    async requestDecision(request: DecisionRequest) {
        this.decisions.push(request)
        return { value: this.decision }
    }

    notifyStatus(status: SessionStatus): void {
        this.statuses.push(status)
    }
}

async function unusedPort(): Promise<number> {
    const server = createServer()
    const port = await listen(server)
    await closeServer(server)
    return port
}

async function listen(server: Server): Promise<number> {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server address is unavailable')
    return address.port
}

async function closeServer(server: Server): Promise<void> {
    if (!server.listening) return
    await new Promise<void>((resolveClose, rejectClose) =>
        server.close(error => error ? rejectClose(error) : resolveClose()))
}

async function stopChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    await once(child, 'exit')
}

async function waitForChildReady(child: ChildProcess): Promise<void> {
    await new Promise<void>((resolveReady, rejectReady) => {
        let stdout = ''
        let stderr = ''
        const timer = setTimeout(() => {
            rejectReady(new Error(`HaS extension startup timed out: ${stderr}`))
        }, 10_000)
        child.stdout?.on('data', chunk => {
            stdout += String(chunk)
            if (stdout.includes('HaS session extension:')) {
                clearTimeout(timer)
                resolveReady()
            }
        })
        child.stderr?.on('data', chunk => { stderr += String(chunk) })
        child.once('exit', code => {
            clearTimeout(timer)
            rejectReady(new Error(`HaS extension exited during startup (${code}): ${stderr}`))
        })
    })
}

async function readRequest(request: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}
