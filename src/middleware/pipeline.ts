import type { Middleware, MiddlewareOutput, MiddlewareContext, MiddlewareResult } from './types'
import type { FormattingMiddleware } from './formatting'
import type { TimeoutMiddleware } from './timeout'
import { StructureDetector } from './structureDetector'
import { splitHtmlChunks } from '@/utils/formatting'

/** Max length for a single message before splitting */
const MAX_MESSAGE_LENGTH = 4000
/** Buffer length threshold that triggers a split+flush for long text */
const SPLIT_THRESHOLD = 3800

export interface OutputMessage {
    text: string
    isToolEvent: boolean
    isDone: boolean
    /** If true, text is raw Markdown (agent output) — use sendMarkdown(). If false, text is HTML — use sendFormatted(). */
    isMarkdown: boolean
    replyMarkup?: unknown
    /** The toolUseId this message relates to (for progressive display tracking) */
    toolUseId?: string
}

export interface PipelineOutput {
    messages: OutputMessage[]
    event: MiddlewareOutput
}

export interface MiddlewarePipelineConfig {
    formatting: FormattingMiddleware
    timeout?: TimeoutMiddleware
    /** Max message length for HTML splitting (default: 4000) */
    maxMessageLength?: number
    /** Optional debug log callback */
    onDebug?: (message: string) => void
}

/**
 * MiddlewarePipeline — Buffers streaming text events and flushes only when:
 * 1. A non-text event arrives (tool_use, tool_result, result) — signals end of a text paragraph
 * 2. The buffer exceeds SPLIT_THRESHOLD — splits at a structure-safe boundary
 * 3. An explicit flush is called (query completed, error, stop, etc.)
 *
 * Design principle: continuous text from the LLM should stay together in as few
 * messages as possible. The only reason to split is Telegram's message length limit.
 */
export class MiddlewarePipeline {
    private middlewares: Middleware[] = []
    private textBuffer = ''
    private structureDetector = new StructureDetector()
    // Inlined content-limit
    private maxMessageLength: number

    constructor(private config: MiddlewarePipelineConfig) {
        const mws: Middleware[] = [config.formatting]
        if (config.timeout) mws.push(config.timeout)
        this.middlewares = mws
        this.maxMessageLength = config.maxMessageLength ?? MAX_MESSAGE_LENGTH
    }

    private debug(message: string): void {
        if (this.config.onDebug) {
            this.config.onDebug(message)
        } else {
            console.error(message)
        }
    }

    processEvent(event: MiddlewareOutput, context: MiddlewareContext): PipelineOutput {
        let currentEvent = event
        let formatted: string | null = null

        for (const middleware of this.middlewares) {
            const result = middleware.process(currentEvent, context)
            if (result === null) {
                return { messages: [], event: currentEvent }
            }
            currentEvent = result.event
            // Save formatting result from the formatting middleware
            if (middleware.name === 'formatting') {
                formatted = result.formatted
            }
        }

        if (formatted === null) {
            return { messages: [], event: currentEvent }
        }

        const isToolEvent = event.kind === 'tool_use' || event.kind === 'tool_result' || event.kind === 'result'
        const isDone = event.kind === 'result'

        if (event.kind === 'text') {
            return this.handleTextEvent(formatted, currentEvent)
        }

        return this.handleNonTextEvent(formatted, currentEvent, isToolEvent, isDone)
    }

    /**
     * Text events are simply buffered. The only reason to flush mid-stream
     * is when the buffer exceeds the Telegram message length limit — in that
     * case we split at a structure-safe boundary.
     */
    private handleTextEvent(formatted: string, event: MiddlewareOutput): PipelineOutput {
        this.textBuffer += formatted
        const messages: OutputMessage[] = []

        // If buffer exceeds threshold, split and flush the front portion
        if (this.textBuffer.length >= SPLIT_THRESHOLD) {
            const splitAt = this.structureDetector.findStructureBoundary(
                this.textBuffer, SPLIT_THRESHOLD
            )
            const chunk = this.textBuffer.slice(0, splitAt)
            this.textBuffer = this.textBuffer.slice(splitAt)

            const trimmed = chunk.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '')
            if (trimmed) {
                messages.push({ text: trimmed, isToolEvent: false, isDone: false, isMarkdown: true })
            }
        }

        return { messages, event }
    }

    /**
     * Non-text events signal the end of a text paragraph. Flush all buffered
     * text first, then handle the non-text event itself.
     */
    private handleNonTextEvent(formatted: string, event: MiddlewareOutput, isToolEvent: boolean, isDone: boolean): PipelineOutput {
        const messages: OutputMessage[] = []

        // Flush any buffered text first — non-text event means text paragraph is done
        if (this.textBuffer.trim()) {
            const text = this.flushTextBufferSync('non-text-flush')
            if (text) {
                messages.push({ text, isToolEvent: false, isDone: false, isMarkdown: true })
            }
        }

        // Then handle the non-text event itself
        const chunks = this.splitMessage(formatted)
        const toolUseId = this.getToolUseId(event)
        for (const chunk of chunks) {
            messages.push({ text: chunk, isToolEvent, isDone, isMarkdown: false, toolUseId })
        }

        return { messages, event }
    }

    private getToolUseId(event: MiddlewareOutput): string | undefined {
        if (event.kind === 'tool_use') return (event as any).toolUseId
        if (event.kind === 'tool_result') return (event as any).toolUseId
        return undefined
    }

    flush(reason: string = 'manual'): Promise<OutputMessage | null> {
        return Promise.resolve(this.flushTextBufferSync(reason))
            .then(msg => msg ? { text: msg, isToolEvent: false, isDone: false, isMarkdown: true } : null)
    }

    flushSync(reason: string = 'manual'): OutputMessage | null {
        const text = this.flushTextBufferSync(reason)
        if (!text) return null
        return { text, isToolEvent: false, isDone: false, isMarkdown: true }
    }

    private flushTextBufferSync(reason: string = 'manual'): string | null {
        if (!this.textBuffer.trim()) return null
        // Trim the full buffer once (leading/trailing whitespace of the complete message)
        const buffered = this.textBuffer.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '')
        this.textBuffer = ''
        return buffered
    }

    // --- Inlined content-limit method ---

    splitMessage(text: string): string[] {
        if (text.length <= this.maxMessageLength) {
            return [text]
        }
        return splitHtmlChunks(text, this.maxMessageLength)
    }

    // --- Reset and accessors ---

    reset(): void {
        this.textBuffer = ''
        this.config.formatting.reset()
    }

    getFormatting(): FormattingMiddleware {
        return this.config.formatting
    }

    getTimeout(): TimeoutMiddleware | undefined {
        return this.config.timeout
    }
}

export function createMiddlewarePipeline(config: MiddlewarePipelineConfig): MiddlewarePipeline {
    return new MiddlewarePipeline(config)
}
