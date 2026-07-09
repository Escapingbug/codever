import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    parseProviderProfilesFile,
    registerConfiguredProviders,
    resolveProviderProfiles,
} from '@/providers/configured'
import { OpencodeProvider } from '@/providers/opencode'
import {
    clearProviderRegistryForTesting,
    createProviderInstance,
    getProviderType,
    listProviders,
    registerProvider,
} from '@/providers/registry'
import { SemanticSessionRuntime } from '@/runtime/semanticSessionRuntime'
import type { ChannelPort, DecisionRequest, DecisionResponse } from '@/bridge/channelPort'
import type { AgentEvent } from '@/providers/types'
import type { AgentProvider, AgentQueryConfig, AgentQueryHandle } from '@/providers/provider'

const { spawnSyncMock, acpProviderConfigs } = vi.hoisted(() => ({
    spawnSyncMock: vi.fn(),
    acpProviderConfigs: [] as Array<{ name: string; command: string; args: string[]; env?: Record<string, string>; cwd?: string }>,
}))

vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>()
    return {
        ...actual,
        spawnSync: spawnSyncMock,
    }
})

vi.mock('@/providers/acp', () => ({
    AcpProvider: class {
        readonly name: string

        constructor(config: { name: string; command: string; args: string[]; env?: Record<string, string>; cwd?: string }) {
            this.name = config.name
            acpProviderConfigs.push(config)
        }
    },
}))

describe('provider profiles', () => {
    afterEach(() => {
        clearProviderRegistryForTesting()
        spawnSyncMock.mockReset()
        acpProviderConfigs.splice(0, acpProviderConfigs.length)
    })

    it('parses configured profiles and merges them with built-ins', () => {
        const parsed = parseProviderProfilesFile(JSON.stringify({
            defaultProvider: 'opencode-fast',
            providers: [
                {
                    id: 'opencode-fast',
                    type: 'opencode',
                    env: { OPENCODE_CONFIG: 'C:\\Users\\me\\.config\\opencode\\fast.json' },
                },
            ],
        }))

        expect(parsed.defaultProvider).toBe('opencode-fast')
        expect(resolveProviderProfiles(parsed)).toEqual(expect.arrayContaining([
            { id: 'opencode', type: 'opencode' },
            { id: 'agent', type: 'agent' },
            {
                id: 'opencode-fast',
                type: 'opencode',
                env: { OPENCODE_CONFIG: 'C:\\Users\\me\\.config\\opencode\\fast.json' },
            },
        ]))
    })

    it('rejects invalid duplicate profile ids', () => {
        expect(() => parseProviderProfilesFile(JSON.stringify({
            providers: [
                { id: 'opencode-fast', type: 'opencode' },
                { id: 'opencode-fast', type: 'opencode' },
            ],
        }))).toThrow(/duplicate provider id/)
    })

    it('registers profile ids with provider type metadata', () => {
        const dir = mkdtempSync(join(tmpdir(), 'codever-profiles-'))
        const file = join(dir, 'providers.json')
        try {
            writeFileSync(file, JSON.stringify({
                defaultProvider: 'opencode-fast',
                providers: [
                    {
                        id: 'opencode-fast',
                        type: 'opencode',
                        env: { OPENCODE_CONFIG: 'C:\\opencode-fast.json' },
                    },
                ],
            }))

            const registered = registerConfiguredProviders(file)

            expect(registered.defaultProvider).toBe('opencode-fast')
            expect(listProviders()).toEqual(expect.arrayContaining(['opencode', 'opencode-fast', 'agent', 'codex']))
            expect(getProviderType('opencode-fast')).toBe('opencode')
            expect(createProviderInstance('opencode-fast')?.name).toBe('opencode-fast')
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('uses profile env when listing opencode models', () => {
        spawnSyncMock.mockReturnValue({
            status: 0,
            error: undefined,
            stdout: 'anthropic/claude-sonnet\n',
            stderr: '',
        })

        const provider = new OpencodeProvider({
            name: 'opencode-fast',
            env: { OPENCODE_CONFIG: 'C:\\opencode-fast.json' },
        })

        expect(provider.getAvailableModels()).toEqual([
            { id: 'anthropic/claude-sonnet', name: 'claude-sonnet', provider: 'anthropic' },
        ])
        expect(spawnSyncMock).toHaveBeenCalledWith('opencode', ['models'], expect.objectContaining({
            env: expect.objectContaining({ OPENCODE_CONFIG: 'C:\\opencode-fast.json' }),
        }))
    })

    it('uses provider type metadata when selecting the runtime adapter', async () => {
        const provider = createMockProvider('opencode-fast', [
            {
                kind: 'raw',
                providerName: 'opencode-fast',
                rawMessage: {
                    sessionUpdate: 'config_option_update',
                    configOptions: [],
                },
            },
            { kind: 'result', status: 'success' },
        ])
        registerProvider(provider, () => provider, { type: 'opencode' })

        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'opencode-fast',
            channelPort: createChannel(),
        })

        await runtime.dispatch({ kind: 'user_message', text: 'hi', source: 'channel' })

        expect(runtime.journal.list()).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'command_result',
                command: 'config_option_update',
            }),
        ]))
    })
})

function createMockProvider(name: string, events: AgentEvent[]): AgentProvider {
    return {
        name,
        startQuery: vi.fn((_prompt: string, _config: AgentQueryConfig): AgentQueryHandle => ({
            events: (async function* () {
                for (const event of events) yield event
            })(),
            interrupt: vi.fn(),
        })),
        isReady: vi.fn(() => true),
        getInitError: vi.fn(() => null),
        getAvailableModels: vi.fn(() => []),
        getAvailablePermissionModes: vi.fn(() => []),
    }
}

function createChannel(): ChannelPort {
    return {
        send: vi.fn(async () => ({ messageId: 1 })),
        edit: vi.fn(async () => undefined),
        requestDecision: vi.fn(async (request: DecisionRequest): Promise<DecisionResponse> => ({
            value: request.options[0]?.value ?? '',
        })),
        notifyStatus: vi.fn(),
    }
}
