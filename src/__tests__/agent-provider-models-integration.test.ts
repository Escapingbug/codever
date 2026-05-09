import { describe, expect, it, vi, afterEach } from 'vitest'
import { AgentProvider, parseAgentModels } from '@/providers/agent'
import { modelKeyboard, modelProviderKeyboard } from '@/transport/telegram/keyboard'

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

        constructor(config: { name: string }) {
            this.name = config.name
        }
    },
}))

function flattenButtonTexts(keyboard: unknown): string[] {
    const rows = (keyboard as { inline_keyboard?: Array<Array<{ text: string }>> }).inline_keyboard ?? []
    return rows.flat().map(button => button.text)
}

describe('AgentProvider model discovery integration', () => {
    afterEach(() => {
        vi.restoreAllMocks()
        spawnSyncMock.mockReset()
    })

    it('lists Cursor Agent models on Windows where the agent command is a .cmd shim', () => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
        spawnSyncMock.mockImplementation((command: string, argsOrOptions: unknown) => {
            if (command === 'agent') {
                return {
                    status: null,
                    error: new Error('spawnSync agent ENOENT'),
                    stdout: '',
                    stderr: '',
                }
            }
            if (command === 'agent models' && !Array.isArray(argsOrOptions) && (argsOrOptions as { shell?: boolean }).shell === true) {
                return {
                    status: 0,
                    error: undefined,
                    stdout: [
                        'Available models',
                        '',
                        'auto - Auto',
                        'composer-2-fast - Composer 2 Fast (default)',
                        'gpt-5.5-medium - GPT-5.5 1M',
                        '',
                        'Tip: use --model <id> (or /model <id> in interactive mode) to switch.',
                    ].join('\n'),
                    stderr: '',
                }
            }
            throw new Error(`unexpected spawnSync call: ${command}`)
        })

        const models = new AgentProvider().getAvailableModels()

        expect(spawnSyncMock).toHaveBeenCalledWith('agent models', expect.objectContaining({ shell: true }))
        expect(models).toEqual([
            { id: 'auto', name: 'Auto' },
            { id: 'composer-2-fast', name: 'Composer 2 Fast (default)' },
            { id: 'gpt-5.5-medium', name: 'GPT-5.5 1M' },
        ])
    })

    it('parses model lines and ignores headings or tips from agent models output', () => {
        expect(parseAgentModels('Available models\n\nauto - Auto\nTip: use --model <id>\n')).toEqual([
            { id: 'auto', name: 'Auto' },
        ])
    })

    it('does not show unsupported hard-coded model fallbacks when discovery returns no models', () => {
        expect(flattenButtonTexts(modelKeyboard([]))).toEqual([])
        expect(flattenButtonTexts(modelProviderKeyboard([]))).toEqual([])
    })
})
