import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Matrix-native client boundary', () => {
    it('has no pre-release Gateway state or history RPC implementation', async () => {
        const [
            web,
            android,
            androidConnection,
            androidDriver,
            androidStorage,
            nativeBridgeTypes,
            nativeBridgeValidation,
            gateway,
            secureContent,
            protocol,
        ] = await Promise.all([
            readFile(resolve('apps/pwa/app/matrix.ts'), 'utf8'),
            readFile(
                resolve(
                    'clients/android/app/src/main/java/id/my/anciety/codever/client/NativeClientRuntime.kt',
                ),
                'utf8',
            ),
            readFile(
                resolve(
                    'clients/android/app/src/main/java/id/my/anciety/codever/matrix/MatrixConnectionRuntime.kt',
                ),
                'utf8',
            ),
            readFile(
                resolve(
                    'clients/android/app/src/main/java/id/my/anciety/codever/matrix/OfficialMatrixSdkDriver.kt',
                ),
                'utf8',
            ),
            readFile(
                resolve(
                    'clients/android/app/src/main/java/id/my/anciety/codever/matrix/MatrixAccountStorage.kt',
                ),
                'utf8',
            ),
            readFile(resolve('packages/native-bridge/src/types.ts'), 'utf8'),
            readFile(resolve('packages/native-bridge/src/validation.ts'), 'utf8'),
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
        expect(web).not.toContain('client.scrollback(room')
        expect(web).toContain('room.fetchRoomThreads()')
        expect(web).toContain('client.relations(')
        expect(web).not.toContain('client.paginateEventTimeline(thread.liveTimeline')
        expect(android).toContain('matrix.loadThreadHistory(threadRoot, from, maxOf(30, limit))')
        expect(android).not.toContain('paginateRoomHistory')
        expect(android).not.toContain('history-checkpoints')
        expect(androidDriver).not.toContain('paginateRoomHistory')
        expect(androidDriver).toContain('ensurePairingTimeline()')
        expect(androidDriver).toContain('override suspend fun sendPairingMessage')
        expect(androidDriver).toContain('const val ROOM_LIST_TIMELINE_LIMIT = 0u')
        expect(androidConnection).toContain('onPairingTransportReady(identity)')
        expect(androidConnection.indexOf('onPairingTransportReady(identity)')).toBeLessThan(
            androidConnection.indexOf('onTransportReady(identity)'),
        )
        expect(android).toContain('override fun onPairingTransportReady')
        const initialSyncFinalization = androidDriver.slice(
            androidDriver.indexOf('private fun scheduleInitialSyncFinalization'),
            androidDriver.indexOf('private suspend fun finalizeInitialSync'),
        )
        expect(initialSyncFinalization).not.toContain('ensurePairingTimeline()')
        expect(androidStorage).not.toContain('DecryptedEventJournal')
        expect(androidStorage).toContain('applicationControlCursor')
        expect(androidConnection).not.toContain('JournalEventInput')
        for (const source of [web, android, nativeBridgeTypes, nativeBridgeValidation]) {
            expect(source).not.toContain('signed_event')
            expect(source).not.toContain('tool_card')
            expect(source).not.toContain('streamId')
            expect(source).not.toContain('toolCallId')
            expect(source).not.toContain('toolStatus')
        }
        expect(secureContent).not.toContain('return transport.sendEncryptedRoomEvent')
        expect(secureContent).toContain(
            'Matrix transport does not support application timeline events',
        )
        expect(secureContent).toContain(
            'Matrix transport does not support application control events',
        )
        const commitEvent = androidConnection.indexOf('onDecryptedEvent(event)')
        const commitCursor = androidConnection.indexOf(
            'currentFiles.applicationControlCursor.save(since)',
        )
        expect(commitEvent).toBeGreaterThan(-1)
        expect(commitCursor).toBeGreaterThan(commitEvent)

        const pairingExecution = android.slice(
            android.indexOf('private suspend fun executePairing'),
            android.indexOf('suspend fun cancelPairing'),
        )
        const pairingStateCommit = pairingExecution.indexOf('pairing.transaction.request_persisted')
        const pairingSend = pairingExecution.indexOf('matrix.sendPairingMessage')
        expect(pairingStateCommit).toBeGreaterThan(-1)
        expect(pairingSend).toBeGreaterThan(pairingStateCommit)
    })
})
