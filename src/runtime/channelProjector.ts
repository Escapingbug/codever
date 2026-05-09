import type { ChannelMessage } from '@/bridge/channelPort'
import type { OutputMessage } from '@/middleware/pipeline'
import type { ConversationEvent } from './semantic'
import { escapeHtml } from '@/utils/formatting'
import { formatToolBubble } from '@/channel/telegram/toolBubble'

export interface ProjectedMessage {
    message: ChannelMessage
    toolUseId?: string
    isToolEvent: boolean
    isTerminal: boolean
    semanticEvent?: ConversationEvent
}

export class ChannelProjector {
    private textBuffer = ''

    fromPipelineOutput(output: OutputMessage, semanticEvent?: ConversationEvent): ProjectedMessage {
        return {
            message: output.isMarkdown
                ? { text: output.text, format: 'markdown' }
                : { text: output.text, format: 'html', replyMarkup: output.replyMarkup },
            toolUseId: output.toolUseId,
            isToolEvent: output.isToolEvent,
            isTerminal: output.isDone,
            semanticEvent,
        }
    }

    project(event: ConversationEvent): ProjectedMessage[] {
        switch (event.kind) {
            case 'assistant_text_delta':
                this.textBuffer += event.text
                return []

            case 'tool':
                return [
                    ...this.flushText(),
                    this.projectTool(event),
                ]

            case 'decision_request':
                return [
                    ...this.flushText(),
                    {
                        message: {
                            text: `<b>${escapeHtml(event.title)}</b>${event.body ? `\n\n${escapeHtml(event.body)}` : ''}`,
                            format: 'html',
                            replyMarkup: {
                                inline_keyboard: [
                                    event.options.map(option => ({
                                        text: option.label,
                                        callback_data: `decision:${event.decisionId}:${option.id}`,
                                    })),
                                ],
                            },
                        },
                        isToolEvent: false,
                        isTerminal: false,
                        semanticEvent: event,
                    },
                ]

            case 'mode_change':
                return [
                    ...this.flushText(),
                    {
                        message: { text: `Mode: <code>${escapeHtml(event.mode)}</code>`, format: 'html' },
                        isToolEvent: false,
                        isTerminal: false,
                        semanticEvent: event,
                    },
                ]

            case 'command_result':
                return [
                    ...this.flushText(),
                    {
                        message: {
                            text: `<b>${escapeHtml(event.command)}</b>\n<pre>${escapeHtml(formatUnknown(event.output))}</pre>`,
                            format: 'html',
                        },
                        isToolEvent: false,
                        isTerminal: false,
                        semanticEvent: event,
                    },
                ]

            case 'turn_finished':
                return this.flushText(event)

            case 'turn_started':
            case 'provider_raw':
                return []
        }
    }

    flush(semanticEvent?: ConversationEvent): ProjectedMessage[] {
        return this.flushText(semanticEvent)
    }

    statusMessage(text: string): ProjectedMessage {
        return {
            message: { text, format: 'html' },
            isToolEvent: false,
            isTerminal: false,
        }
    }

    reset(): void {
        this.textBuffer = ''
    }

    private flushText(semanticEvent?: ConversationEvent): ProjectedMessage[] {
        const text = this.textBuffer
        this.textBuffer = ''
        if (!text.trim()) return []
        return [{
            message: { text, format: 'markdown' },
            isToolEvent: false,
            isTerminal: semanticEvent?.kind === 'turn_finished',
            semanticEvent,
        }]
    }

    private projectTool(event: Extract<ConversationEvent, { kind: 'tool' }>): ProjectedMessage {
        const status = event.phase === 'failed'
            ? 'interrupted'
            : event.phase === 'completed'
                ? 'completed'
                : event.phase === 'updated'
                    ? 'running'
                    : 'pending'
        return {
            message: {
                text: formatToolBubble({
                    toolName: event.toolName,
                    input: event.input,
                    status,
                    output: typeof event.output === 'string' ? event.output : event.output === undefined ? undefined : formatUnknown(event.output),
                    isError: event.isError,
                }),
                format: 'html',
            },
            toolUseId: event.toolCallId,
            isToolEvent: true,
            isTerminal: event.phase === 'completed' || event.phase === 'failed',
            semanticEvent: event,
        }
    }
}

function formatUnknown(value: unknown): string {
    if (typeof value === 'string') return value
    try {
        return JSON.stringify(value, null, 2)
    } catch {
        return String(value)
    }
}
