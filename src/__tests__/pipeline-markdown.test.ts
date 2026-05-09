import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MiddlewarePipeline, createMiddlewarePipeline, type OutputMessage } from '@/middleware/pipeline'
import { FormattingMiddleware } from '@/middleware/formatting'

import type { MiddlewareOutput, MiddlewareContext } from '@/middleware/types'
import type { AgentEvent } from '@/providers/types'

function createPipeline(): MiddlewarePipeline {
    return createMiddlewarePipeline({
        formatting: new FormattingMiddleware(),
    })
}

function createTextEvent(text: string): AgentEvent {
    return { kind: 'text', text }
}

function createToolUseEvent(toolName: string): AgentEvent {
    return {
        kind: 'tool_use',
        toolUseId: `tool-${toolName}`,
        toolName,
        input: {},
    }
}

function createResultEvent(): AgentEvent {
    return { kind: 'result', status: 'success' }
}

const defaultContext: MiddlewareContext = {
    sessionId: 'test',
    queryId: 'q1',
    verboseLevel: 1,
    providerSettings: {},
    timeoutSeconds: 60,
    bus: { emit: vi.fn() } as any,
}

describe('OutputMessage.isMarkdown', () => {
    let pipeline: MiddlewarePipeline

    beforeEach(() => {
        pipeline = createPipeline()
    })

    it('should mark text events as isMarkdown=true when flushed', () => {
        pipeline.processEvent(createTextEvent('hello world'), defaultContext)

        const result = pipeline.processEvent(createResultEvent(), defaultContext)
        const mdMsg = result.messages.find(m => m.isMarkdown)
        expect(mdMsg).toBeDefined()
        expect(mdMsg!.isMarkdown).toBe(true)
    })

    it('should mark tool events as isMarkdown=false', () => {
        const result = pipeline.processEvent(createToolUseEvent('Bash'), defaultContext)

        for (const msg of result.messages) {
            if (!msg.isMarkdown) {
                expect(msg.isMarkdown).toBe(false)
            }
        }
    })

    it('should mark result events as isMarkdown=false', () => {
        const result = pipeline.processEvent(createResultEvent(), defaultContext)

        for (const msg of result.messages) {
            if (!msg.isMarkdown) {
                expect(msg.isMarkdown).toBe(false)
            }
        }
    })

    it('flushSync should return isMarkdown=true for text buffer', () => {
        // Process text event (goes into buffer)
        pipeline.processEvent(createTextEvent('some markdown **bold**'), defaultContext)

        const flushed = pipeline.flushSync('test')
        expect(flushed).not.toBeNull()
        expect(flushed!.isMarkdown).toBe(true)
    })

    it('flush should return isMarkdown=true for text buffer', async () => {
        pipeline.processEvent(createTextEvent('some text'), defaultContext)

        const flushed = await pipeline.flush('test')
        expect(flushed).not.toBeNull()
        expect(flushed!.isMarkdown).toBe(true)
    })

    it('text followed by result should produce markdown message then result message', () => {
        pipeline.processEvent(createTextEvent('some text'), defaultContext)
        const result = pipeline.processEvent(createResultEvent(), defaultContext)

        // First message should be the flushed text (markdown)
        const mdMsgs = result.messages.filter(m => m.isMarkdown)
        expect(mdMsgs.length).toBe(1)
        expect(mdMsgs[0].text).toContain('some text')

        // Last message should be the result (not markdown)
        const resultMsg = result.messages.find(m => m.isDone)
        expect(resultMsg).toBeDefined()
        expect(resultMsg!.isMarkdown).toBe(false)
    })
})
