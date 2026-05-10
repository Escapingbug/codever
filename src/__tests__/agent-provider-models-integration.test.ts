import { describe, expect, it, vi, afterEach } from 'vitest'
import { AgentProvider, parseAgentModels } from '@/providers/agent'
import { modelKeyboard, modelProviderDetailKeyboard, modelProviderKeyboard } from '@/channel/telegram/keyboard'
import type { ModelEntry } from '@/providers/provider'

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

function flattenButtonCallbacks(keyboard: unknown): string[] {
    const rows = (keyboard as { inline_keyboard?: Array<Array<{ callback_data?: string }>> }).inline_keyboard ?? []
    return rows.flat().map(button => button.callback_data).filter((value): value is string => Boolean(value))
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
            { id: 'auto', name: 'Auto', provider: 'cursor' },
            { id: 'composer-2-fast', name: 'Composer 2 Fast (default)', provider: 'cursor' },
            { id: 'gpt-5.5-medium', name: 'GPT-5.5 1M', provider: 'cursor' },
        ])
    })

    it('parses model lines and ignores headings or tips from agent models output', () => {
        expect(parseAgentModels('Available models\n\nauto - Auto\nTip: use --model <id>\n')).toEqual([
            { id: 'auto', name: 'Auto', provider: 'cursor' },
        ])
    })

    it('does not show unsupported hard-coded model fallbacks when discovery returns no models', () => {
        expect(flattenButtonTexts(modelKeyboard([]))).toEqual([])
        expect(flattenButtonTexts(modelProviderKeyboard([]))).toEqual([])
    })

    it('groups Cursor Agent models under one provider and paginates the model list', () => {
        const models = Array.from({ length: 12 }, (_, index): ModelEntry => ({
            id: `gpt-${index}`,
            name: `GPT ${index}`,
            provider: 'cursor',
        }))

        expect(flattenButtonTexts(modelProviderKeyboard(models))).toEqual(['cursor (12)'])
        expect(flattenButtonTexts(modelProviderDetailKeyboard(models, 'cursor', 0))).toEqual([
            'GPT 0',
            'GPT 1',
            'GPT 2',
            'GPT 3',
            'GPT 4',
            'GPT 5',
            'GPT 6',
            'GPT 7',
            'GPT 8',
            'GPT 9',
            '1/2',
            'Next ➡️',
            '⬅️ Back to providers',
        ])
        expect(flattenButtonTexts(modelProviderDetailKeyboard(models, 'cursor', 1))).toEqual([
            'GPT 10',
            'GPT 11',
            '⬅️ Prev',
            '2/2',
            '⬅️ Back to providers',
        ])
    })

    it('paginates provider groups when there are many providers', () => {
        const models = Array.from({ length: 12 }, (_, index): ModelEntry => ({
            id: `provider-${index}/model`,
            name: 'model',
            provider: `provider-${index.toString().padStart(2, '0')}`,
        }))

        const firstPage = modelProviderKeyboard(models, 0)
        const secondPage = modelProviderKeyboard(models, 1)

        expect(flattenButtonTexts(firstPage)).toContain('1/2')
        expect(flattenButtonTexts(firstPage)).toContain('Next ➡️')
        expect(flattenButtonCallbacks(firstPage)).toContain('mprovlist:1')
        expect(flattenButtonTexts(secondPage)).toContain('⬅️ Prev')
        expect(flattenButtonTexts(secondPage)).toContain('2/2')
        expect(flattenButtonCallbacks(secondPage)).toContain('mprovlist:0')
    })
})
