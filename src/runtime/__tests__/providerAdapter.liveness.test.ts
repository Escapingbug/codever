import { describe, expect, it } from 'vitest'
import { createProviderSemanticAdapter } from '../providerAdapter'

describe('ACP semantic event amplification', () => {
    it('bounds progressive updates for one tool call to a start and one meaningful update', () => {
        const adapter = createProviderSemanticAdapter('codex-acp', { boundedToolUpdates: true })
        const context = { sessionId: 'session-1', turnId: 'turn-1', provider: 'codex-acp' }
        const emitted = []

        for (let index = 1; index <= 1_000; index += 1) {
            emitted.push(...adapter.toConversationEvents({
                kind: 'tool_use', toolName: 'Bash', toolUseId: 'tool-1',
                input: { command: 'x'.repeat(index) }, rawInput: JSON.stringify({ command: 'x'.repeat(index) }),
                status: 'pending', isInputComplete: false, toolKind: 'execute',
            }, context))
        }
        emitted.push(...adapter.toConversationEvents({
            kind: 'tool_use', toolName: 'Bash', toolUseId: 'tool-1',
            input: { command: 'x'.repeat(1_000) }, rawInput: JSON.stringify({ command: 'x'.repeat(1_000) }),
            status: 'running', isInputComplete: true, toolKind: 'execute',
        }, context))

        expect(emitted).toHaveLength(2)
        expect(emitted.map(event => event.kind === 'tool' ? event.phase : event.kind)).toEqual(['started', 'updated'])
        expect(emitted[1]).toMatchObject({ kind: 'tool', input: { command: 'x'.repeat(1_000) } })
    })
})
