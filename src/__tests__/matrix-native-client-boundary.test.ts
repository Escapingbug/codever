import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Matrix-native client boundary', () => {
    it('has no pre-release Gateway state or history RPC implementation', async () => {
        const [web, android, gateway, secureContent, protocol] = await Promise.all([
            readFile(resolve('apps/pwa/app/matrix.ts'), 'utf8'),
            readFile(
                resolve(
                    'clients/android/app/src/main/java/id/my/anciety/codever/client/NativeClientRuntime.kt',
                ),
                'utf8',
            ),
            readFile(resolve('src/gateway/matrix/gateway.ts'), 'utf8'),
            readFile(resolve('src/gateway/matrix/secureContent.ts'), 'utf8'),
            readFile(resolve('packages/protocol/src/schema.ts'), 'utf8'),
        ])

        for (const source of [web, android, gateway, secureContent, protocol]) {
            expect(source).not.toContain('codever.gateway.state.request')
            expect(source).not.toContain('gateway_state_request')
            expect(source).not.toContain('codever.history.request')
            expect(source).not.toContain('history_request')
            expect(source).not.toContain('history_page')
            expect(source).not.toContain('history_replay')
        }
        expect(web).toContain('client.scrollback(room')
        expect(web).toContain('room.fetchRoomThreads()')
        expect(android).toContain('matrix.paginateRoomHistory(100)')
    })
})
