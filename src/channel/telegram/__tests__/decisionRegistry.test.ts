import { afterEach, describe, expect, it } from 'vitest'
import {
    buildPendingDecisionReplyMarkup,
    clearPendingDecisionsForTests,
    handlePendingDecisionCallback,
    registerPendingDecision,
} from '../decisionRegistry'

describe('Telegram decision registry', () => {
    afterEach(() => clearPendingDecisionsForTests())

    it('resolves a single selection by index without embedding its value in callback data', async () => {
        const longValue = 'a very long option value '.repeat(20)
        const { decisionId, promise } = registerPendingDecision({
            decisionOptions: [{ label: 'Long option', value: longValue }],
        })

        const callbackData = buildPendingDecisionReplyMarkup(decisionId).inline_keyboard[0][0].callback_data
        const buttonText = buildPendingDecisionReplyMarkup(decisionId).inline_keyboard[0][0].text
        expect(callbackData.length).toBeLessThanOrEqual(64)
        expect(callbackData).not.toContain(longValue)
        expect(buttonText).toBe('1 · Long option')
        expect(handlePendingDecisionCallback(decisionId, 'select', 0)).toMatchObject({ status: 'completed' })
        await expect(promise).resolves.toEqual({ value: longValue })
    })

    it('uses numbered compact button labels while preserving full option values', async () => {
        const longLabel = 'Use the migration approach that keeps both schemas available during rollout'
        const { decisionId, promise } = registerPendingDecision({
            decisionOptions: [{ label: longLabel, value: 'expand-contract' }],
        })

        const markup = buildPendingDecisionReplyMarkup(decisionId)
        expect(markup.inline_keyboard).toHaveLength(1)
        expect(markup.inline_keyboard[0][0].text).toMatch(/^1 · Use the migration approach/)
        expect(markup.inline_keyboard[0][0].text).toContain('…')
        expect(markup.inline_keyboard[0][0].text).not.toContain('during rollout')

        handlePendingDecisionCallback(decisionId, 'select', 0)
        await expect(promise).resolves.toEqual({ value: 'expand-contract' })
    })

    it('toggles multiple options and preserves their original order on confirmation', async () => {
        const { decisionId, promise } = registerPendingDecision({
            multiple: true,
            decisionOptions: [
                { label: 'API', value: 'API' },
                { label: 'UI', value: 'UI' },
                { label: 'Tests', value: 'Tests' },
            ],
        })

        expect(handlePendingDecisionCallback(decisionId, 'toggle', 2)).toMatchObject({ status: 'updated' })
        const toggled = handlePendingDecisionCallback(decisionId, 'toggle', 0)
        expect(toggled).toMatchObject({ status: 'updated' })
        if (toggled.status === 'updated') {
            expect(toggled.replyMarkup.inline_keyboard[0][0].text).toContain('✅')
            expect(toggled.replyMarkup.inline_keyboard[2][0].text).toContain('✅')
        }

        expect(handlePendingDecisionCallback(decisionId, 'done')).toMatchObject({ status: 'completed' })
        await expect(promise).resolves.toEqual({ value: ['API', 'Tests'] })
    })

    it('does not complete a multi-select question with no choices', () => {
        const { decisionId } = registerPendingDecision({
            multiple: true,
            decisionOptions: [{ label: 'API', value: 'API' }],
        })

        expect(handlePendingDecisionCallback(decisionId, 'done')).toMatchObject({
            status: 'updated',
            notice: 'Select at least one option',
        })
    })
})
