import { describe, it, expect } from 'vitest'
import { formatAgentEventForTelegram } from '@/channel/telegram/agentFormatter'
import type { AgentEvent } from '@/providers/types'

describe('formatAgentEventForTelegram: verbose level behavior', () => {
    const bashUseEvent: AgentEvent = {
        kind: 'tool_use',
        toolName: 'Bash',
        input: { command: 'echo hello' },
    }

    const bashResultEvent: AgentEvent = {
        kind: 'tool_result',
        toolName: 'Bash',
        output: 'hello\n',
        isError: false,
    }

    describe('verbose=0 (Quiet)', () => {
        it('should hide Bash tool_use', () => {
            const result = formatAgentEventForTelegram(bashUseEvent, { verboseLevel: 0 })
            expect(result).toBeNull()
        })

        it('should hide Bash tool_result', () => {
            const result = formatAgentEventForTelegram(bashResultEvent, { verboseLevel: 0 })
            expect(result).toBeNull()
        })
    })

    describe('verbose=1 (Normal)', () => {
        it('should show Bash tool_use (command)', () => {
            const result = formatAgentEventForTelegram(bashUseEvent, { verboseLevel: 1 })
            expect(result).not.toBeNull()
            expect(result).toContain('echo hello')
        })

        it('should NOT show Bash tool_result (command output)', () => {
            const result = formatAgentEventForTelegram(bashResultEvent, { verboseLevel: 1 })
            expect(result).toBeNull()
        })

        it('should show Bash tool_result if it is an error', () => {
            const errorResult: AgentEvent = {
                kind: 'tool_result',
                toolName: 'Bash',
                output: 'command not found',
                isError: true,
            }
            const result = formatAgentEventForTelegram(errorResult, { verboseLevel: 1 })
            expect(result).not.toBeNull()
            expect(result).toContain('❌')
        })
    })

    describe('verbose=2 (Verbose)', () => {
        it('should show Bash tool_use (command)', () => {
            const result = formatAgentEventForTelegram(bashUseEvent, { verboseLevel: 2 })
            expect(result).not.toBeNull()
            expect(result).toContain('echo hello')
        })

        it('should show Bash tool_result (command output)', () => {
            const result = formatAgentEventForTelegram(bashResultEvent, { verboseLevel: 2 })
            expect(result).not.toBeNull()
            expect(result).toContain('hello')
        })
    })
})
