import { describe, expect, it, vi, afterEach } from 'vitest'
import { AgentProvider, parseAgentModels, resolveCursorSessionModel } from '@/providers/agent'
import type { AcpSessionConfiguration } from '@/providers/acp'
import { modelKeyboard, modelProviderDetailKeyboard, modelProviderKeyboard, providerKeyboard } from '@/channel/telegram/keyboard'
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

function buttonRows(keyboard: unknown): Array<Array<{ text: string; callback_data?: string }>> {
    return (keyboard as { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> }).inline_keyboard ?? []
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

        const provider = new AgentProvider()
        const models = provider.getAvailableModels()

        expect(spawnSyncMock).toHaveBeenCalledWith('agent models', expect.objectContaining({ shell: true }))
        expect(models).toEqual([
            { id: 'auto', name: 'Auto', provider: 'cursor' },
            { id: 'composer-2-fast', name: 'Composer 2 Fast (default)', provider: 'cursor' },
            { id: 'gpt-5.5-medium', name: 'GPT-5.5 1M', provider: 'cursor' },
        ])
        expect(provider.getAvailableModels()).toEqual(models)
        expect(spawnSyncMock).toHaveBeenCalledTimes(1)
    })

    it('parses model lines and ignores headings or tips from agent models output', () => {
        expect(parseAgentModels('Available models\n\nauto - Auto\nTip: use --model <id>\n')).toEqual([
            { id: 'auto', name: 'Auto', provider: 'cursor' },
        ])
    })

    it('maps Cursor CLI aliases to the exact model id advertised by the ACP session', () => {
        const availableModels = [
            { modelId: 'gpt-5.6-sol[context=272k,reasoning=medium,fast=false]', name: 'gpt-5.6-sol' },
            { modelId: 'claude-opus-5[thinking=true,context=300k,effort=high,fast=true]', name: 'claude-opus-5' },
            { modelId: 'kimi-k3[reasoning=max]', name: 'kimi-k3' },
        ]

        expect(resolveCursorSessionModel('gpt-5.6-sol', availableModels)).toBe(availableModels[0].modelId)
        expect(resolveCursorSessionModel('claude-opus-5-thinking-high-fast', availableModels)).toBe(availableModels[1].modelId)
        expect(resolveCursorSessionModel(availableModels[2].modelId, availableModels)).toBe(availableModels[2].modelId)
        expect(resolveCursorSessionModel('kimi-k3-high', availableModels)).toBe(availableModels[2].modelId)
        expect(resolveCursorSessionModel('unknown-high', availableModels)).toBeUndefined()
    })

    it('uses CLI variant parameters to disambiguate multiple ACP ids in one model family', () => {
        const availableModels = [
            { modelId: 'gpt-5.6-sol[reasoning=medium,fast=false]', name: 'gpt-5.6-sol' },
            { modelId: 'gpt-5.6-sol[reasoning=high,fast=true]', name: 'gpt-5.6-sol' },
        ]

        expect(resolveCursorSessionModel('gpt-5.6-sol-high-fast', availableModels)).toBe(availableModels[1].modelId)
        expect(resolveCursorSessionModel('gpt-5.6-sol-low', availableModels)).toBeUndefined()
    })

    it('keeps the CLI catalog intact after Cursor advertises ACP session models', () => {
        class TestAgentProvider extends AgentProvider {
            capture(configuration: AcpSessionConfiguration): void {
                this.captureSessionConfiguration(configuration)
            }
        }
        const provider = new TestAgentProvider()
        spawnSyncMock.mockReturnValue({
            status: 0,
            error: undefined,
            stdout: 'Available models\n\nkimi-k3-high - Kimi K3 High\nkimi-k3-max - Kimi K3 Max\n',
            stderr: '',
        })
        provider.capture({
            models: {
                currentModelId: 'auto-smart[optimize_for=balanced]',
                availableModels: [
                    { modelId: 'auto-smart[optimize_for=balanced]', name: 'Auto Balance' },
                    { modelId: 'kimi-k3[reasoning=max]', name: 'kimi-k3' },
                ],
            },
        })

        expect(provider.getAvailableModels()).toEqual([
            { id: 'kimi-k3-high', name: 'Kimi K3 High', provider: 'cursor' },
            { id: 'kimi-k3-max', name: 'Kimi K3 Max', provider: 'cursor' },
        ])
        expect(provider.resolveModel('kimi-k3')).toBe('kimi-k3')
    })

    it('does not show unsupported hard-coded model fallbacks when discovery returns no models', () => {
        expect(flattenButtonTexts(modelKeyboard([]))).toEqual([])
        expect(flattenButtonTexts(modelProviderKeyboard([]))).toEqual([])
    })

    it('renders Codever provider profiles one per row so long names remain distinguishable', () => {
        const rows = buttonRows(providerKeyboard(['opencode', 'opencode-ark', 'opencode-ark-long-profile'], 'opencode-ark'))

        expect(rows).toHaveLength(3)
        expect(rows.every(row => row.length === 1)).toBe(true)
        expect(rows[1][0].text).toContain('opencode-ark')
        expect(rows[1][0].callback_data).toBe('provider:opencode-ark')
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
