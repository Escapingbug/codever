import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GatewayToolOutputStore } from '../toolOutputStore'

describe('GatewayToolOutputStore', () => {
    it('reads retained output in bounded chunks and supports explicit cleanup', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'codever-tool-output-'))
        try {
            const store = await GatewayToolOutputStore.open(directory)
            const reference = await store.retain({
                sessionId: 'session-1', toolCallId: 'tool-1', toolName: 'Bash',
                value: { output: 'x'.repeat(400_000) }, createdAt: '2026-07-20T00:00:00.000Z',
            })
            const first = await store.readChunk('session-1', reference.outputId, 0, 64 * 1024)
            expect(Buffer.from(first.data, 'base64')).toHaveLength(64 * 1024)
            expect(first.nextOffset).toBe(64 * 1024)
            expect(await store.delete('session-1', [reference.outputId])).toBe(1)
            expect(await store.list('session-1')).toEqual([])
        } finally {
            await rm(directory, { recursive: true, force: true })
        }
    })
})
