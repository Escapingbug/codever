import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Matrix-native client boundary', () => {
    it('cannot send version-1 Gateway state or history RPC requests', async () => {
        const [web, android] = await Promise.all([
            readFile(resolve('apps/pwa/app/matrix.ts'), 'utf8'),
            readFile(
                resolve(
                    'clients/android/app/src/main/java/id/my/anciety/codever/client/NativeClientRuntime.kt',
                ),
                'utf8',
            ),
        ])

        for (const client of [web, android]) {
            expect(client).not.toContain('codever.gateway.state.request')
            expect(client).not.toContain('gateway_state_request')
            expect(client).not.toContain('codever.history.request')
            expect(client).not.toContain('"history_request"')
        }
        expect(web).toContain('client.scrollback(room')
        expect(web).toContain('room.fetchRoomThreads()')
        expect(android).toContain('matrix.paginateRoomHistory(100)')
    })
})
