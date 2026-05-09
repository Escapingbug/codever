import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MiddlewarePipeline, createMiddlewarePipeline, type OutputMessage } from '@/middleware/pipeline'
import { FormattingMiddleware } from '@/middleware/formatting'

import type { MiddlewareContext } from '@/middleware/types'
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

/** Collect all output messages from pipeline events */
function collectMessages(pipeline: MiddlewarePipeline, events: AgentEvent[], ctx: MiddlewareContext): OutputMessage[] {
    const messages: OutputMessage[] = []

    for (const event of events) {
        const result = pipeline.processEvent(event, ctx)
        messages.push(...result.messages)
    }

    return messages
}

describe('Code block handling (new pipeline: no premature flush)', () => {
    let pipeline: MiddlewarePipeline

    beforeEach(() => {
        pipeline = createPipeline()
    })

    it('should not flush when text buffer has an unclosed code block', () => {
        // Text with unclosed code block — should just buffer
        const result = pipeline.processEvent(createTextEvent('```python\ndef hello():'), defaultContext)
        expect(result.messages.length).toBe(0)
    })

    it('should flush buffered code block when non-text event arrives', () => {
        // Start with unclosed code block
        pipeline.processEvent(createTextEvent('```python\ndef hello():'), defaultContext)

        // Close the code block
        pipeline.processEvent(createTextEvent('\n    return True\n```'), defaultContext)

        // Non-text event triggers flush
        const result = pipeline.processEvent(createResultEvent(), defaultContext)
        const mdMsg = result.messages.find(m => m.isMarkdown)
        expect(mdMsg).toBeDefined()
        expect(mdMsg!.text).toContain('```python')
        expect(mdMsg!.text).toContain('```')
    })

    it('should flush unclosed code block when non-text event arrives (even if not closed)', () => {
        // Unclosed code block — flush when tool event arrives
        pipeline.processEvent(createTextEvent('```js\nconst x = 1;'), defaultContext)

        const result = pipeline.processEvent(createToolUseEvent('Bash'), defaultContext)
        const mdMsg = result.messages.find(m => m.isMarkdown)
        expect(mdMsg).toBeDefined()
        expect(mdMsg!.text).toContain('```js')
    })

    it('should flush text buffer on tool event when no code block is open', () => {
        // Normal text
        pipeline.processEvent(createTextEvent('Some text here'), defaultContext)

        // Tool event — should flush text buffer immediately
        const result = pipeline.processEvent(createToolUseEvent('Bash'), defaultContext)
        const mdMsg = result.messages.find(m => m.isMarkdown)
        expect(mdMsg).toBeDefined()
        expect(mdMsg!.text).toContain('Some text here')
    })

    it('should handle closed code blocks normally (buffered, flushed on non-text event)', () => {
        // Text with a properly closed code block
        const codeBlock = '\n```\ncode here\n```'

        const messages = collectMessages(pipeline, [
            createTextEvent('A'.repeat(500) + codeBlock),
            createResultEvent(),
        ], defaultContext)

        const mdMsg = messages.find(m => m.isMarkdown)
        expect(mdMsg).toBeDefined()
        expect(mdMsg!.text).toContain('```')
    })

    it('should handle tilde-fenced code blocks (~~~)', () => {
        // Unclosed tilde fence — should buffer
        pipeline.processEvent(createTextEvent('~~~python\ndef hello():'), defaultContext)

        // Close with tildes
        pipeline.processEvent(createTextEvent('\n    return True\n~~~'), defaultContext)

        // Flush on non-text event
        const result = pipeline.processEvent(createResultEvent(), defaultContext)
        const mdMsg = result.messages.find(m => m.isMarkdown)
        expect(mdMsg).toBeDefined()
        expect(mdMsg!.text).toContain('~~~python')
    })

    it('should handle multiple code blocks correctly', () => {
        // First code block (closed), then second (open) — all buffered
        pipeline.processEvent(
            createTextEvent('```\nclosed1\n```\n```python\nopen'),
            defaultContext,
        )

        // Close second block
        pipeline.processEvent(createTextEvent('\n```'), defaultContext)

        // Flush everything
        const result = pipeline.processEvent(createResultEvent(), defaultContext)
        const mdMsg = result.messages.find(m => m.isMarkdown)
        expect(mdMsg).toBeDefined()
        expect(mdMsg!.text).toContain('closed1')
        expect(mdMsg!.text).toContain('open')
    })

    it('should respect reset() by clearing text buffer', () => {
        // Unclosed code block
        pipeline.processEvent(createTextEvent('```python\ndef hello():'), defaultContext)

        // Reset before any flush
        pipeline.reset()

        // flushSync should return null since buffer was cleared
        const flushed = pipeline.flushSync('force')
        expect(flushed).toBeNull()
    })

    it('flushSync should force-flush even with unclosed code block', () => {
        // When the caller explicitly asks for a flush (e.g., query completed),
        // we should flush regardless of code block state
        pipeline.processEvent(createTextEvent('```python\ndef hello():'), defaultContext)

        const flushed = pipeline.flushSync('force')
        expect(flushed).not.toBeNull()
        expect(flushed!.isMarkdown).toBe(true)
        expect(flushed!.text).toContain('```python')
    })

    it('should not delay flush for inline code (single backticks)', () => {
        // Inline code with single backticks — should NOT trigger code block detection
        pipeline.processEvent(createTextEvent('A'.repeat(500) + ' `code` here'), defaultContext)

        const result = pipeline.processEvent(createResultEvent(), defaultContext)
        const mdMsg = result.messages.find(m => m.isMarkdown)
        expect(mdMsg).toBeDefined()
        expect(mdMsg!.text).toContain('`code`')
    })

    it('should handle double backticks that are not code fences', () => {
        // Two backticks is not a fence (needs 3+)
        pipeline.processEvent(createTextEvent('A'.repeat(500) + ' ``code`` here'), defaultContext)

        const result = pipeline.processEvent(createResultEvent(), defaultContext)
        const mdMsg = result.messages.find(m => m.isMarkdown)
        expect(mdMsg).toBeDefined()
    })

    it('should split long text at structure boundary even mid-stream', () => {
        // Text that exceeds the 3800-char threshold
        const longText = 'A'.repeat(4000)
        const result = pipeline.processEvent(createTextEvent(longText), defaultContext)

        // Should have split and flushed the front portion
        expect(result.messages.length).toBeGreaterThanOrEqual(1)
        expect(result.messages[0].isMarkdown).toBe(true)
    })
})
