import { describe, expect, it, vi } from 'vitest'
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
    it('launches Codex through the ACP adapter over stdio', async () => {
        const { CodexProvider } = await import('../index')

        const provider = new CodexProvider()

        expect(provider.name).toBe('codex')
        expect(acpProviderConfigs).toEqual([
            {
                name: 'codex',
                command: 'npx',
                args: ['-y', '@zed-industries/codex-acp'],
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
                    { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list' },
                    { slug: 'gpt-hidden', display_name: 'Hidden', visibility: 'hidden' },
                ],
            }),
            stderr: '',
        })

        expect(new CodexProvider().getAvailableModels()).toEqual([
            { id: 'gpt-5.5', name: 'GPT-5.5', provider: 'openai' },
        ])
        expect(spawnSyncMock).toHaveBeenCalled()
    })
})

describe('parseCodexModels', () => {
    it('parses visible Codex model catalog entries', () => {
        expect(parseCodexModels(JSON.stringify({
            models: [
                { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list' },
                { slug: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
                { slug: 'internal', display_name: 'Internal', visibility: 'hidden' },
            ],
        }))).toEqual([
            { id: 'gpt-5.5', name: 'GPT-5.5', provider: 'openai' },
            { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', provider: 'openai' },
        ])
    })
})
