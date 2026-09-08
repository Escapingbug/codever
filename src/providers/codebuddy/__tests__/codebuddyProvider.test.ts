import { describe, expect, it, vi } from 'vitest'

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

describe('CodebuddyProvider', () => {
    it('launches CodeBuddy in ACP mode over stdio', async () => {
        const { CodebuddyProvider } = await import('../index')

        const provider = new CodebuddyProvider()

        expect(provider.name).toBe('codebuddy')
        expect(acpProviderConfigs).toEqual([
            expect.objectContaining({
                name: 'codebuddy',
                command: 'codebuddy',
                args: ['--acp'],
            }),
        ])
    })

    it('lists models advertised by CodeBuddy help', async () => {
        const { CodebuddyProvider } = await import('../index')
        spawnSyncMock.mockReturnValue({
            status: 0,
            error: undefined,
            stdout: '  --model <model>  Currently supported: (default-model, gemini-3.1-pro,\n gpt-5.4)',
            stderr: '',
        })

        expect(new CodebuddyProvider().getAvailableModels()).toEqual([
            { id: 'default-model', name: 'default-model', provider: 'codebuddy' },
            { id: 'gemini-3.1-pro', name: 'gemini-3.1-pro', provider: 'codebuddy' },
            { id: 'gpt-5.4', name: 'gpt-5.4', provider: 'codebuddy' },
        ])
        expect(spawnSyncMock).toHaveBeenCalledWith('codebuddy', ['--help'], expect.objectContaining({
            encoding: 'utf-8',
            timeout: 10_000,
        }))
    })
})

describe('parseCodebuddyModels', () => {
    it('returns an empty list when CodeBuddy does not advertise models', async () => {
        const { parseCodebuddyModels } = await import('../index')

        expect(parseCodebuddyModels('Usage: codebuddy [options]')).toEqual([])
    })
})
