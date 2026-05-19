import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SemanticSessionRuntime } from '@/runtime/semanticSessionRuntime'
import type { ChannelMessage, ChannelPort, DecisionRequest, DecisionResponse, SessionStatus } from '@/bridge/channelPort'
import type { AgentEvent } from '@/providers/types'
import type { AgentQueryConfig, AgentQueryHandle, AgentQueryInput } from '@/providers/provider'

vi.mock('@/providers/acp', () => {
    class MockAcpProvider {
        readonly name: string

        constructor(options: { name: string }) {
            this.name = options.name
        }

        startQuery(_prompt: AgentQueryInput, config: AgentQueryConfig): AgentQueryHandle {
            return {
                events: (async function* () {
                    const result = await config.permissionHandler!.handleToolCall(
                        'WebSearch',
                        { query: 'site:www.bing.com Bing' },
                        { signal: config.signal },
                    )
                    yield { kind: 'text', text: `permission:${result.behavior}` } as AgentEvent
                    yield { kind: 'result', status: 'success' } as AgentEvent
                })(),
                interrupt: vi.fn(),
            }
        }

        isReady(): boolean {
            return true
        }

        getInitError(): string | null {
            return null
        }

        getAvailableModels(): [] {
            return []
        }

        getAvailablePermissionModes(): string[] {
            return ['default', 'acceptEdits', 'bypassPermissions']
        }
    }

    return { AcpProvider: MockAcpProvider }
})

const tempDirs: string[] = []

function createChannel(decisionValue = 'allow'): ChannelPort & {
    sent: ChannelMessage[]
    decisions: DecisionRequest[]
    statuses: SessionStatus[]
} {
    const sent: ChannelMessage[] = []
    const decisions: DecisionRequest[] = []
    const statuses: SessionStatus[] = []
    return {
        sent,
        decisions,
        statuses,
        send: vi.fn(async (message) => {
            sent.push(message)
            return { messageId: sent.length }
        }),
        edit: vi.fn(async (_messageId, message) => {
            sent.push({ ...message, text: `EDIT:${message.text}` })
        }),
        requestDecision: vi.fn(async (request): Promise<DecisionResponse> => {
            decisions.push(request)
            return { value: decisionValue }
        }),
        notifyStatus: vi.fn((status) => {
            statuses.push(status)
        }),
    }
}

async function createCursorCliConfig(contents: Record<string, unknown>): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'codever-cursor-home-'))
    tempDirs.push(home)
    const cursorDir = join(home, '.cursor')
    await mkdir(cursorDir, { recursive: true })
    await writeFile(join(cursorDir, 'cli-config.json'), JSON.stringify(contents, null, 2), 'utf8')
    return home
}

afterEach(async () => {
    vi.unstubAllEnvs()
    await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('Cursor provider ACP permissions', () => {
    it('does not surface Cursor ACP WebSearch permission requests when Cursor CLI approval mode is unrestricted', async () => {
        const home = await createCursorCliConfig({
            approvalMode: 'unrestricted',
            permissions: {
                allow: ['WebSearch(**)', 'WebFetch(**)'],
                deny: [],
            },
            webFetchDomainAllowlist: ['*'],
        })
        vi.stubEnv('HOME', home)
        vi.stubEnv('USERPROFILE', home)

        const { AgentProvider } = await import('../index')
        const provider = new AgentProvider()
        const channel = createChannel()
        const runtime = new SemanticSessionRuntime({
            sessionId: 'session-1',
            cwd: '/repo',
            provider,
            providerName: 'agent',
            channelPort: channel,
        })

        await runtime.dispatch({ kind: 'user_message', text: 'search bing', source: 'channel' })

        expect(channel.decisions).toEqual([])
        expect(channel.sent.map(message => message.text)).toContain('permission:allow')
    })
})
