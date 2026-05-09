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

const context: MiddlewareContext = {
    sessionId: 'test',
    queryId: 'q1',
    verboseLevel: 1,
    providerSettings: {},
    timeoutSeconds: 60,
    bus: { emit: vi.fn(), on: vi.fn(), once: vi.fn(), removeAllListeners: vi.fn() } as any,
}

describe('Pipeline: text buffering and flush', () => {
    it('pipeline config without permission still works', () => {
        const pipeline = createMiddlewarePipeline(createPipelineConfig())
        const result = pipeline.processEvent({ kind: 'text', text: 'Hello' }, context)
        expect(result).toBeDefined()
    })

    it('flushSync returns buffered text', () => {
        const pipeline = createMiddlewarePipeline(createPipelineConfig())

        pipeline.processEvent({ kind: 'text', text: 'Hello world' }, context)
        const flushed = pipeline.flushSync('test')
        expect(flushed).not.toBeNull()
        expect(flushed!.text).toContain('Hello world')
    })

    it('flushSync returns null when buffer is empty', () => {
        const pipeline = createMiddlewarePipeline(createPipelineConfig())

        const flushed = pipeline.flushSync('test')
        expect(flushed).toBeNull()
    })

    it('second flush after first flush returns null (buffer drained)', () => {
        const pipeline = createMiddlewarePipeline(createPipelineConfig())

        pipeline.processEvent({ kind: 'text', text: 'Hello' }, context)
        const first = pipeline.flushSync('test')
        expect(first).not.toBeNull()

        // No new events — flush should return null (buffer was drained)
        const second = pipeline.flushSync('test')
        expect(second).toBeNull()
    })

    it('different text events pass through independently', () => {
        const pipeline = createMiddlewarePipeline(createPipelineConfig())

        pipeline.processEvent({ kind: 'text', text: 'First message' }, context)
        const first = pipeline.flushSync('test')
        expect(first).not.toBeNull()

        pipeline.processEvent({ kind: 'text', text: 'Second message' }, context)
        const second = pipeline.flushSync('test')
        expect(second).not.toBeNull()
        expect(second!.text).toContain('Second message')
    })

    it('reset clears buffer state', () => {
        const pipeline = createMiddlewarePipeline(createPipelineConfig())

        pipeline.processEvent({ kind: 'text', text: 'Hello' }, context)
        pipeline.reset()

        // After reset, buffer is empty — flush should return null
        const flushed = pipeline.flushSync('test')
        expect(flushed).toBeNull()
    })
})
