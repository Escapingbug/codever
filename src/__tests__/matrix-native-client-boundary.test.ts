import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Matrix-native client boundary', () => {
    it('hard-cuts production application traffic over to protocol v3', async () => {
        const [daemon, localGateway, webClient, android, pwaUpgrade, packageJson] =
            await Promise.all([
                readFile(resolve('src/matrix-daemon.ts'), 'utf8'),
                readFile(resolve('scripts/matrix-local-gateway.ts'), 'utf8'),
                readFile(resolve('apps/pwa/app/client/web/WebCodeverClient.ts'), 'utf8'),
                readFile(
                    resolve(
                        'clients/android/app/src/main/java/id/my/anciety/codever/client/NativeClientRuntime.kt',
                    ),
                    'utf8',
                ),
                readFile(resolve('apps/pwa/app/stateUpgrade.ts'), 'utf8'),
                readFile(resolve('package.json'), 'utf8'),
            ])

        expect(daemon).toContain('new V3MatrixGatewayRunner(')
        expect(daemon).not.toContain('new MatrixGatewayRunner(')
        expect(localGateway).toContain('new V3MatrixGatewayRunner(')
        expect(localGateway).not.toContain('new MatrixGatewayRunner(')
        expect(webClient).toContain('connect: connectMatrixV3')
        expect(webClient).not.toMatch(/connect:\s*connectMatrix[,}]/u)

        const liveDecoder = android.slice(
            android.indexOf('private suspend fun processMatrixEvent'),
            android.indexOf('private suspend fun processMatrixV3Event'),
        )
        expect(liveDecoder).toContain('processMatrixV3Event')
        expect(liveDecoder).not.toContain('CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE')
        expect(liveDecoder).not.toContain('CODEVER_MATRIX_SESSION_STATE_EVENT_TYPE')
        expect(liveDecoder).not.toContain('CODEVER_MATRIX_SESSION_DIRECTORY_EVENT_TYPE')
        expect(liveDecoder).not.toContain('"secure_envelope"')
        expect(liveDecoder).not.toContain('"secure_envelope_bundle"')
        expect(liveDecoder).not.toContain('"timeline_envelope"')
        for (const removedV2DataType of [
            'CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE',
            'CODEVER_MATRIX_SESSION_STATE_EVENT_TYPE',
            'CODEVER_MATRIX_SESSION_DIRECTORY_EVENT_TYPE',
            '"secure_envelope"',
            '"secure_envelope_bundle"',
            '"timeline_envelope"',
            '"state_envelope"',
        ]) {
            expect(android).not.toContain(removedV2DataType)
        }

        const historyDecoder = android.slice(
            android.indexOf('private suspend fun decodeHistoricalMessage'),
            android.indexOf('private fun acceptPairingResponse'),
        )
        expect(historyDecoder).toContain('extension.long("version") == 3L')
        expect(historyDecoder).not.toContain('"timeline_envelope"')
        expect(pwaUpgrade).toContain('matrixProtocol: CODEVER_MATRIX_PROTOCOL_VERSION')
        expect(pwaUpgrade).not.toContain('MATRIX_NATIVE_PROTOCOL_VERSION')
        expect(packageJson).toContain('CODEVER_MATRIX_V3_REQUIRE_ANDROID=1')
    })

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
            matrixV3Protocol,
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
            readFile(resolve('packages/protocol/src/matrix-v3.ts'), 'utf8'),
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
            // `signed_event` is the authenticated v3 project-envelope payload
            // discriminant. Reject the removed bridge/RPC projection fields,
            // not the v3 signature boundary itself.
            expect(source).not.toContain('tool_card')
            expect(source).not.toContain('streamId')
            expect(source).not.toContain('toolCallId')
            expect(source).not.toContain('toolStatus')
        }
        expect(android).toContain('opened.plaintext.string("kind") != "signed_event"')
        expect(matrixV3Protocol).toContain("kind: z.literal('signed_event')")
        expect(secureContent).not.toContain('return transport.sendEncryptedRoomEvent')
        expect(secureContent).toContain(
            'Matrix transport does not support application timeline events',
        )
        expect(secureContent).toContain(
            'Matrix transport does not support application control events',
        )
        const commitCursor = androidConnection.indexOf(
            'currentFiles.applicationControlCursor.save(since)',
        )
        const commitBatch = androidConnection.lastIndexOf(
            'val processed = processMatrixApplicationEventBatch(',
            commitCursor,
        )
        const commitWindow = androidConnection.slice(commitBatch, commitCursor)
        expect(commitBatch).toBeGreaterThan(-1)
        expect(commitWindow).toContain('onEvent = onDecryptedEvent')
        expect(commitCursor).toBeGreaterThan(commitBatch)

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
