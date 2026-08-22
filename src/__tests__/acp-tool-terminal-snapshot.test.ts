import { describe, expect, it } from 'vitest'
import { mapSessionUpdate } from '@/providers/acp/eventAdapter'
import { createProviderSemanticAdapter } from '@/runtime/providerAdapter'
import { ChannelProjector } from '@/runtime/channelProjector'

describe('ACP terminal tool snapshots', () => {
    it.each([
        ['completed', 'completed', false],
        ['failed', 'failed', true],
    ] as const)(
        'closes a tool received first as %s without waiting for an update',
        (status, expectedPhase, expectedError) => {
            const updates = mapSessionUpdate({
                sessionUpdate: 'tool_call',
                toolCallId: `bash-${status}`,
                title: 'Bash',
                kind: 'execute',
                status,
                rawInput: { command: 'pnpm test' },
                rawOutput: status === 'completed' ? 'ok' : 'exit 1',
                content: [],
            } as Parameters<typeof mapSessionUpdate>[0])

            expect(updates.map((event) => event.kind)).toEqual([
                'tool_use',
                'tool_result',
            ])

            const adapter = createProviderSemanticAdapter('agent')
            const projector = new ChannelProjector()
            const projected = updates.flatMap((event) =>
                adapter
                    .toConversationEvents(event, {
                        sessionId: 'session-1',
                        turnId: 'turn-1',
                        provider: 'agent',
                    })
                    .flatMap((semanticEvent) => projector.project(semanticEvent)),
            )
            const terminal = projected.at(-1)

            expect(terminal?.isTerminal).toBe(true)
            expect(terminal?.message.presentation).toMatchObject({
                kind: 'tool_group',
                tools: [{
                    name: 'Bash',
                    phase: expectedPhase,
                    isError: expectedError,
                }],
            })
        },
    )
})
