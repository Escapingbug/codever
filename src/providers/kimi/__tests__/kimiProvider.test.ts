import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { parseKimiModels, parseKimiSessions } from '../index'

const { acpProviderConfigs, spawnMock, spawnSyncMock } = vi.hoisted(() => ({
    acpProviderConfigs: [] as Array<Record<string, unknown>>,
    spawnMock: vi.fn(),
    spawnSyncMock: vi.fn(),
}))

vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>()
    return {
        ...actual,
        spawn: spawnMock,
        spawnSync: spawnSyncMock,
    }
})

vi.mock('@/providers/acp', () => ({
    AcpProvider: class {
        readonly name: string

        constructor(config: Record<string, unknown>) {
            this.name = String(config.name)
            acpProviderConfigs.push(config)
        }
    },
}))

describe('KimiProvider', () => {
    afterEach(() => {
        spawnSyncMock.mockReset()
        spawnMock.mockReset()
        acpProviderConfigs.splice(0, acpProviderConfigs.length)
    })

    it('launches Kimi Code through ACP and maps Codever settings to Kimi config options', async () => {
        const { KimiProvider } = await import('../index')

        const provider = new KimiProvider()

        expect(provider.name).toBe('kimi')
        expect(acpProviderConfigs).toEqual([{
            name: 'kimi',
            command: 'kimi',
            args: ['acp'],
            reasoningConfigId: 'thinking',
            permissionModeConfigId: 'mode',
            permissionModeValues: ['default', 'plan', 'auto', 'yolo'],
        }])
        expect(provider.getAvailablePermissionModes()).toEqual(['default', 'plan', 'auto', 'yolo'])
    })

    it('discovers the configured Kimi model catalog', async () => {
        const { KimiProvider } = await import('../index')
        spawnSyncMock.mockReturnValue({
            status: 0,
            error: undefined,
            stdout: JSON.stringify({
                providers: { 'kimi-code': { type: 'kimi' } },
                models: {
                    'kimi-code/k3': {
                        provider: 'kimi-code',
                        model: 'kimi-k3',
                        displayName: 'Kimi K3',
                        capabilities: ['thinking', 'tool_use'],
                        supportEfforts: ['low', 'medium', 'high'],
                        defaultEffort: 'medium',
                    },
                },
            }),
            stderr: '',
        })

        expect(new KimiProvider().getAvailableModels()).toEqual([{
            id: 'kimi-code/k3',
            name: 'Kimi K3',
            provider: 'kimi-code',
            defaultReasoningLevel: 'medium',
            supportedReasoningLevels: [
                { effort: 'off' },
                { effort: 'low' },
                { effort: 'medium' },
                { effort: 'high' },
            ],
        }])
        expect(spawnSyncMock).toHaveBeenCalledWith(
            'kimi',
            ['provider', 'list', '--json'],
            expect.objectContaining({ encoding: 'utf-8', timeout: 10_000 }),
        )
    })

    it('lists resumable Kimi sessions for the active project', async () => {
        const { KimiProvider } = await import('../index')
        spawnMock.mockImplementation(() => {
            const child = new EventEmitter() as EventEmitter & {
                stdout: EventEmitter
                stderr: EventEmitter
                kill: ReturnType<typeof vi.fn>
            }
            child.stdout = new EventEmitter()
            child.stderr = new EventEmitter()
            child.kill = vi.fn()
            queueMicrotask(() => {
                child.stdout.emit('data', Buffer.from(JSON.stringify([{
                    id: 'session_123',
                    title: 'Implement the gateway',
                    workDir: '/repo',
                    updatedAt: 1_789_000_000_000,
                }])))
                child.emit('close', 0)
            })
            return child
        })

        await expect(new KimiProvider().listSessions('/repo')).resolves.toEqual([{
            sessionId: 'session_123',
            title: 'Implement the gateway',
            cwd: '/repo',
            updated: 1_789_000_000_000,
            firstMessage: '',
        }])
        expect(spawnMock).toHaveBeenCalledWith(
            'kimi',
            ['session', 'list', '--cwd', '/repo', '--json'],
            expect.objectContaining({ cwd: '/repo' }),
        )
    })
})

describe('Kimi output parsing', () => {
    it('supports Kimi model overrides and snake_case compatibility', () => {
        expect(parseKimiModels(JSON.stringify({
            models: {
                fast: {
                    provider: 'custom',
                    model: 'raw-model-id',
                    display_name: 'Base name',
                    capabilities: ['thinking'],
                    support_efforts: ['low', 'high'],
                    default_effort: 'low',
                    overrides: {
                        displayName: 'Fast override',
                        defaultEffort: 'high',
                    },
                },
                invalid: 'not-an-object',
            },
        }))).toEqual([{
            id: 'fast',
            name: 'Fast override',
            provider: 'custom',
            defaultReasoningLevel: 'high',
            supportedReasoningLevels: [{ effort: 'off' }, { effort: 'low' }, { effort: 'high' }],
        }])
    })

    it('maps Kimi session summaries to resumable Codever sessions', () => {
        expect(parseKimiSessions(JSON.stringify([
            {
                id: 'session_123',
                title: 'Implement the gateway',
                workDir: '/repo',
                updatedAt: 1_789_000_000_000,
                lastPrompt: 'Add Kimi support',
            },
        ]))).toEqual([{
            sessionId: 'session_123',
            title: 'Implement the gateway',
            cwd: '/repo',
            updated: 1_789_000_000_000,
            firstMessage: 'Add Kimi support',
        }])
    })
})
