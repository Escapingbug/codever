import { describe, it, expect, vi } from 'vitest'
import { createMiddlewarePipeline, type MiddlewarePipelineConfig } from '@/middleware/pipeline'
import { createFormattingMiddleware } from '@/middleware/formatting'

import type { MiddlewareOutput, MiddlewareContext } from '@/middleware/types'
import type { AgentEvent } from '@/providers/types'

function createPipelineConfig(): MiddlewarePipelineConfig {
    return {
        formatting: createFormattingMiddleware(),
    }
}

function textEvent(text: string): AgentEvent {
    return { kind: 'text', text }
}

function toolUseEvent(toolName: string, input?: unknown): AgentEvent {
    return { kind: 'tool_use', toolName, input: input ?? '', toolUseId: 'tu-1' }
}

function toolResultEvent(output: string): AgentEvent {
    return { kind: 'tool_result', output, toolUseId: 'tu-1', isError: false }
}

function resultEvent(status: 'success' | 'error' = 'success'): AgentEvent {
    return { kind: 'result', status }
}

describe('Pipeline: Structure-aware flush (tables, lists, blockquotes)', () => {
    const context: MiddlewareContext = {
        sessionId: 'test',
        queryId: 'q1',
        verboseLevel: 1,
        providerSettings: {},
        timeoutSeconds: 60,
        bus: { emit: vi.fn(), on: vi.fn(), once: vi.fn(), removeAllListeners: vi.fn() } as any,
    }

    it('should buffer text with unclosed table (no flush until non-text event)', () => {
        const pipeline = createMiddlewarePipeline(createPipelineConfig())

        // Table without closing blank line — should just buffer, no flush
        const result = pipeline.processEvent(textEvent('| A | B |\n|---|---|\n| 1 |'), context)
        expect(result.messages.length).toBe(0)
    })

    it('should flush buffered table when non-text event arrives', () => {
        const pipeline = createMiddlewarePipeline(createPipelineConfig())

        pipeline.processEvent(textEvent('| A | B |\n|---|---|\n| 1 | 2 |'), context)

        // Tool event signals end of text paragraph — should flush buffered text
        const result = pipeline.processEvent(toolUseEvent('Bash'), context)
        const mdMsg = result.messages.find(m => m.isMarkdown)
        expect(mdMsg).toBeDefined()
        expect(mdMsg!.text).toContain('| A | B |')
    })

    it('should flush buffered table on result event', () => {
        const pipeline = createMiddlewarePipeline(createPipelineConfig())

        pipeline.processEvent(textEvent('| A | B |\n|---|---|\n| 1 | 2 |'), context)

        const result = pipeline.processEvent(resultEvent(), context)
        const mdMsg = result.messages.find(m => m.isMarkdown)
        expect(mdMsg).toBeDefined()
        expect(mdMsg!.text).toContain('| A | B |')
    })

    it('should buffer text with unclosed list (no flush until non-text event)', () => {
        const pipeline = createMiddlewarePipeline(createPipelineConfig())

        const result = pipeline.processEvent(textEvent('- item 1\n- item 2'), context)
        expect(result.messages.length).toBe(0)
    })

    it('should flush buffered list when non-text event arrives', () => {
        const pipeline = createMiddlewarePipeline(createPipelineConfig())

        pipeline.processEvent(textEvent('- item 1\n- item 2'), context)

        const result = pipeline.processEvent(toolUseEvent('Bash'), context)
        const mdMsg = result.messages.find(m => m.isMarkdown)
        expect(mdMsg).toBeDefined()
        expect(mdMsg!.text).toContain('- item 1')
    })

    it('should buffer text with unclosed blockquote (no flush until non-text event)', () => {
        const pipeline = createMiddlewarePipeline(createPipelineConfig())

        const result = pipeline.processEvent(textEvent('> quote line 1\n> quote line 2'), context)
        expect(result.messages.length).toBe(0)
    })

    it('should flush buffered blockquote when non-text event arrives', () => {
        const pipeline = createMiddlewarePipeline(createPipelineConfig())

        pipeline.processEvent(textEvent('> quote line'), context)

        const result = pipeline.processEvent(toolUseEvent('Bash'), context)
        const mdMsg = result.messages.find(m => m.isMarkdown)
        expect(mdMsg).toBeDefined()
        expect(mdMsg!.text).toContain('> quote line')
    })

    it('should buffer text with unclosed code block (no flush until non-text event)', () => {
        const pipeline = createMiddlewarePipeline(createPipelineConfig())

        const result = pipeline.processEvent(textEvent('```js\ncode here'), context)
        expect(result.messages.length).toBe(0)
    })

    it('should flush buffered code block when non-text event arrives', () => {
        const pipeline = createMiddlewarePipeline(createPipelineConfig())

        pipeline.processEvent(textEvent('```js\ncode here\n```'), context)

        const result = pipeline.processEvent(toolUseEvent('Bash'), context)
        const mdMsg = result.messages.find(m => m.isMarkdown)
        expect(mdMsg).toBeDefined()
        expect(mdMsg!.text).toContain('```js')
    })

    it('should NOT flush between consecutive text events (no premature fragmentation)', () => {
        const pipeline = createMiddlewarePipeline(createPipelineConfig())

        // Simulate streaming deltas — a table arriving in pieces with blank lines
        const r1 = pipeline.processEvent(textEvent('| A | B |\n|---|---|\n| 1 | 2 |\n'), context)
        expect(r1.messages.length).toBe(0)

        // Blank line between deltas — should NOT trigger flush
        const r2 = pipeline.processEvent(textEvent('\n'), context)
        expect(r2.messages.length).toBe(0)

        // More table rows
        const r3 = pipeline.processEvent(textEvent('| 3 | 4 |\n'), context)
        expect(r3.messages.length).toBe(0)

        // Another blank line — still should NOT flush
        const r4 = pipeline.processEvent(textEvent('\n'), context)
        expect(r4.messages.length).toBe(0)

        // Now a non-text event arrives — should flush everything as one message
        const r5 = pipeline.processEvent(resultEvent(), context)
        const mdMsg = r5.messages.find(m => m.isMarkdown)
        expect(mdMsg).toBeDefined()
        expect(mdMsg!.text).toContain('| A | B |')
        expect(mdMsg!.text).toContain('| 3 | 4 |')
    })

    it('should accumulate text across multiple deltas and flush on non-text event', () => {
        const pipeline = createMiddlewarePipeline(createPipelineConfig())

        pipeline.processEvent(textEvent('Hello '), context)
        pipeline.processEvent(textEvent('world '), context)
        pipeline.processEvent(textEvent('from LLM'), context)

        const result = pipeline.processEvent(resultEvent(), context)
        const mdMsg = result.messages.find(m => m.isMarkdown)
        expect(mdMsg).toBeDefined()
        expect(mdMsg!.text).toContain('Hello world from LLM')
    })
})
