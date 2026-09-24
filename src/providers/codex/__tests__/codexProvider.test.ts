import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseCodexModels } from '../index'

const { acpProviderConfigs } = vi.hoisted(() => ({
    acpProviderConfigs: [] as Array<{ name: string; command: string; args: string[] }>,
}))

const { spawnSyncMock } = vi.hoisted(() => ({
    spawnSyncMock: vi.fn(),
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

        constructor(config: { name: string; command: string; args: string[] }) {
            this.name = config.name
            acpProviderConfigs.push(config)
        }
    },
}))

describe('CodexProvider', () => {
    beforeEach(() => acpProviderConfigs.splice(0))
    it('uses the ACP-advertised model ID with the requested reasoning effort', async () => {
        const { CodexProvider } = await import('../index')
        const provider = new CodexProvider() as any
        const configuration = {
            models: {
                currentModelId: 'gpt-6-astra[high]',
                availableModels: [
                    { modelId: 'gpt-6-sol[medium]', name: 'GPT-6-Sol (medium)' },
                    { modelId: 'gpt-6-sol[high]', name: 'GPT-6-Sol (high)' },
                ],
            },
        }

        expect(provider.resolveSessionModel('gpt-6-sol', configuration, {
            providerSettings: { reasoningEffort: 'high' },
        })).toBe('gpt-6-sol[high]')
        expect(provider.resolveSessionModel('gpt-6-luna', configuration, {
            providerSettings: { reasoningEffort: 'high' },
        })).toBe('gpt-6-luna[high]')
    })

    it('launches Codex through the ACP adapter over stdio', async () => {
        const { CodexProvider } = await import('../index')

        const provider = new CodexProvider()

        expect(provider.name).toBe('codex')
        expect(acpProviderConfigs).toEqual([
            {
                name: 'codex',
                requireModelSetter: true,
                deferInitialSessionReconnect: true,
                env: { CODEX_PATH: 'codex' },
                command: 'npx',
                args: [
                    '-y',
                    '--package=@openai/codex@0.156.1',
                    '--package=@agentclientprotocol/codex-acp@1.13.0',
                    'codex-acp',
                ],
            },
        ])
    })

    it('lists subscription models from codex debug models', async () => {
        const { CodexProvider } = await import('../index')
        spawnSyncMock.mockReturnValue({
            status: 0,
            error: undefined,
            stdout: JSON.stringify({
                models: [
                    {
                        slug: 'gpt-5.5',
                        display_name: 'GPT-5.5',
                        visibility: 'list',
                        default_reasoning_level: 'medium',
                        supported_reasoning_levels: [
                            { effort: 'low', description: 'Fast' },
                            { effort: 'medium', description: 'Balanced' },
                        ],
                    },
                    { slug: 'gpt-hidden', display_name: 'Hidden', visibility: 'hidden' },
                ],
            }),
            stderr: '',
        })

        expect(new CodexProvider().getAvailableModels()).toEqual([
            {
                id: 'gpt-5.5',
                name: 'GPT-5.5',
                provider: 'openai',
                defaultReasoningLevel: 'medium',
                supportedReasoningLevels: [
                    { effort: 'low', description: 'Fast' },
                    { effort: 'medium', description: 'Balanced' },
                ],
            },
        ])
        expect(spawnSyncMock).toHaveBeenCalledWith(
            'npx',
            ['-y', '@openai/codex@0.156.1', 'debug', 'models'],
            expect.objectContaining({
                encoding: 'utf-8',
                timeout: 10_000,
                windowsHide: true,
            }),
        )
    })
})

describe('parseCodexModels', () => {
    it('parses visible Codex model catalog entries', () => {
        expect(parseCodexModels(JSON.stringify({
            models: [
                { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list' },
                {
                    slug: 'gpt-5.3-codex',
                    name: 'GPT-5.3 Codex',
                    default_reasoning_level: 'high',
                    supported_reasoning_levels: [
                        { effort: 'medium' },
                        { effort: 'high', description: 'Deep' },
                    ],
                },
                { slug: 'internal', display_name: 'Internal', visibility: 'hidden' },
            ],
        }))).toEqual([
            { id: 'gpt-5.5', name: 'GPT-5.5', provider: 'openai' },
            {
                id: 'gpt-5.3-codex',
                name: 'GPT-5.3 Codex',
                provider: 'openai',
                defaultReasoningLevel: 'high',
                supportedReasoningLevels: [
                    { effort: 'medium' },
                    { effort: 'high', description: 'Deep' },
                ],
            },
        ])
    })
})
