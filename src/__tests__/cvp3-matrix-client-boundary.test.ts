import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('CVP/3 Matrix transport boundary', () => {
    it('hard-cuts production application traffic over to CVP/3', async () => {
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

        expect(daemon).toContain('new MatrixCvp3GatewayRunner(')
        expect(daemon).not.toContain('new MatrixGatewayRunner(')
        expect(localGateway).toContain('new MatrixCvp3GatewayRunner(')
        expect(localGateway).not.toContain('new MatrixGatewayRunner(')
        expect(webClient).toContain('connect: connectMatrixCvp3')
        expect(webClient).not.toMatch(/connect:\s*connectMatrix[,}]/u)

        const liveDecoder = android.slice(
            android.indexOf('private suspend fun processMatrixEvent'),
            android.indexOf('private suspend fun processMatrixCvp3Event'),
        )
        expect(liveDecoder).toContain('processMatrixCvp3Event')
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
        expect(pwaUpgrade).toContain('matrixProtocol: CODEVER_PROTOCOL_VERSION')
        expect(pwaUpgrade).not.toContain('LEGACY_MATRIX_NATIVE_ENVELOPE_VERSION')
        expect(packageJson).toContain('CODEVER_MATRIX_CVP3_REQUIRE_ANDROID=1')
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
            codeverApp,
            nativeRpcBridge,
            gateway,
            secureContent,
            protocol,
            matrixCvp3Protocol,
            matrixCvp3Connection,
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
            readFile(resolve('apps/pwa/app/CodeverApp.tsx'), 'utf8'),
            readFile(resolve('apps/pwa/app/client/native/NativeRpcBridge.ts'), 'utf8'),
            readFile(resolve('src/gateway/matrix/gateway.ts'), 'utf8'),
            readFile(resolve('src/gateway/matrix/secureContent.ts'), 'utf8'),
            readFile(resolve('packages/protocol/src/schema.ts'), 'utf8'),
            readFile(resolve('packages/protocol/src/cvp-v3.ts'), 'utf8'),
            readFile(resolve('apps/pwa/app/matrixCvp3Connection.ts'), 'utf8'),
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
        expect(codeverApp).not.toContain('loadRecentHistory')
        expect(codeverApp).not.toContain('history:cross-device-sync')
        expect(codeverApp).not.toContain('shouldReconcileRecentHistory')
        expect(codeverApp).not.toContain('shouldRecoverVisibleHistory')
        const nativeHistory = android.slice(
            android.indexOf('suspend fun historyPage'),
            android.indexOf('suspend fun uploadAttachment'),
        )
        expect(nativeHistory).toContain('withTimeout(HISTORY_PAGE_TOTAL_TIMEOUT_MS)')
        expect(nativeHistory).toContain('historyMutexes.computeIfAbsent(sessionId)')
        expect(nativeHistory.indexOf('withTimeout(HISTORY_PAGE_TOTAL_TIMEOUT_MS)')).toBeLessThan(
            nativeHistory.indexOf('historyMutexes.computeIfAbsent(sessionId)'),
        )
        const nativeHistoryBridgeTimeout = nativeRpcBridge.match(
            /const NATIVE_HISTORY_PAGE_TIMEOUT_MS = ([0-9_]+);/u,
        )
        const nativeHistoryBudget = android.match(
            /const val HISTORY_PAGE_TOTAL_TIMEOUT_MS = ([0-9_]+)L/u,
        )
        expect(nativeHistoryBridgeTimeout).not.toBeNull()
        expect(nativeHistoryBudget).not.toBeNull()
        expect(Number(nativeHistoryBudget![1].replaceAll('_', ''))).toBeLessThan(
            Number(nativeHistoryBridgeTimeout![1].replaceAll('_', '')),
        )
        expect(androidConnection).toContain('matrix.application_control.gap_persisted')
        expect(androidConnection).toContain('startApplicationControlGapRecovery(')
        expect(nativeHistory).toContain('val externalHasMore = allowRemote && online')
        expect(matrixCvp3Connection).toContain('hasMore: available.length > messages.length')
        expect(matrixCvp3Connection).not.toContain(
            'hasMore: active.projection.sessionMessages(sessionId).length > messages.length',
        )
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
            // `signed_event` is the authenticated CVP/3 project-envelope payload
            // discriminant. Reject the removed bridge/RPC projection fields,
            // not the CVP/3 signature boundary itself.
            expect(source).not.toContain('tool_card')
            expect(source).not.toContain('streamId')
            expect(source).not.toContain('toolCallId')
            expect(source).not.toContain('toolStatus')
        }
        expect(android).toContain('opened.plaintext.string("kind") != "signed_event"')
        expect(matrixCvp3Protocol).toContain("kind: z.literal('signed_event')")
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
