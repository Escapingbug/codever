package id.my.anciety.codever.client

import android.content.Context
import id.my.anciety.codever.client.command.CommandCompletion as DurableCompletion
import id.my.anciety.codever.client.command.CommandAuthorizationPolicy
import id.my.anciety.codever.client.command.CommandPayloadValidator
import id.my.anciety.codever.client.command.CommandOutcome as DurableOutcome
import id.my.anciety.codever.client.command.CommandOperation
import id.my.anciety.codever.client.command.CommandReceipt as DurableReceipt
import id.my.anciety.codever.client.command.CommandState as DurableState
import id.my.anciety.codever.client.command.CommandTransmission
import id.my.anciety.codever.client.command.CommandView as DurableView
import id.my.anciety.codever.client.command.DurableCommandOutbox
import id.my.anciety.codever.client.command.PublicCommandError as DurableError
import id.my.anciety.codever.client.command.RevisionConflictAction
import id.my.anciety.codever.client.events.ClientEventHub
import id.my.anciety.codever.client.events.ClientEventListener
import id.my.anciety.codever.client.events.ClientEventType
import id.my.anciety.codever.client.events.ClientLifecycle
import id.my.anciety.codever.client.events.ClientMessage
import id.my.anciety.codever.client.events.ClientMessageFormat
import id.my.anciety.codever.client.events.ClientMessageKind
import id.my.anciety.codever.client.events.ClientSnapshot
import id.my.anciety.codever.client.events.CommandCompletion
import id.my.anciety.codever.client.events.CommandOutcome
import id.my.anciety.codever.client.events.CommandState
import id.my.anciety.codever.client.events.CommandView
import id.my.anciety.codever.client.events.EncryptedAtomicClientEventPersistence
import id.my.anciety.codever.client.events.ForegroundServiceState
import id.my.anciety.codever.client.events.HistoryPage
import id.my.anciety.codever.client.events.LifecyclePhase
import id.my.anciety.codever.client.events.MAX_BRIDGE_EVENT_PAYLOAD_BYTES
import id.my.anciety.codever.client.events.PublicClientJson
import id.my.anciety.codever.client.events.PublicCommandError
import id.my.anciety.codever.client.events.PublicTrustState
import id.my.anciety.codever.client.events.SubscriptionBootstrap
import id.my.anciety.codever.client.events.SubscriptionCursorResult
import id.my.anciety.codever.client.events.compactSnapshotCommands
import id.my.anciety.codever.diagnostics.NativeDiagnosticLog
import id.my.anciety.codever.matrix.MatrixBootstrap
import id.my.anciety.codever.matrix.MatrixDecryptedEvent
import id.my.anciety.codever.matrix.MatrixIdentifiers
import id.my.anciety.codever.matrix.MatrixLoginTokenIssueResult
import id.my.anciety.codever.matrix.MatrixRuntimePhase
import id.my.anciety.codever.matrix.MatrixTransportIdentity
import id.my.anciety.codever.matrix.PublicMatrixSession
import id.my.anciety.codever.security.AndroidKeystoreSecretCipher
import id.my.anciety.codever.security.SecretCipher
import id.my.anciety.codever.security.codever.AndroidKeystoreP256Identity
import id.my.anciety.codever.security.codever.Base64Url
import id.my.anciety.codever.security.codever.CanonicalJson
import id.my.anciety.codever.security.codever.CodeverCrypto
import id.my.anciety.codever.security.codever.CodeverPrivateIdentity
import id.my.anciety.codever.security.codever.CodeverSecurityException
import id.my.anciety.codever.security.codever.EncryptedGatewayTrustStore
import id.my.anciety.codever.security.codever.GatewayTrust
import id.my.anciety.codever.security.codever.GatewayTransportCodec
import id.my.anciety.codever.security.codever.MatrixTransportBinding
import id.my.anciety.codever.security.codever.MatrixTimelineBindings
import id.my.anciety.codever.security.codever.MatrixTimelineEnvelopeCodec
import id.my.anciety.codever.security.codever.MatrixTimelineEnvelopes
import id.my.anciety.codever.security.codever.PairingCodec
import id.my.anciety.codever.security.codever.PairingRequest
import id.my.anciety.codever.security.codever.PairingSecurity
import id.my.anciety.codever.security.codever.SecureEnvelopeBindings
import id.my.anciety.codever.security.codever.SecureEnvelopeBundleBindings
import id.my.anciety.codever.security.codever.SecureEnvelopeBundleCodec
import id.my.anciety.codever.security.codever.SecureEnvelopeBundles
import id.my.anciety.codever.security.codever.SecureEnvelopeCodec
import id.my.anciety.codever.security.codever.SecureEnvelopeDirection
import id.my.anciety.codever.security.codever.SecureEnvelopes
import id.my.anciety.codever.security.codever.SignedPairingOffer
import id.my.anciety.codever.security.codever.SignedPairingRequest
import id.my.anciety.codever.security.codever.SignedPairingResponse
import java.security.SecureRandom
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

data class NativePairingPreview(
    val pairingId: String,
    val gatewayId: String,
    val gatewayName: String,
    val verificationCode: String,
    val expiresAt: Long,
)

class NativePairingRejectedException(message: String) : IllegalStateException(message)
class NativeTrustRequiredException(message: String) : IllegalStateException(message)

/**
 * Service-owned Codever domain runtime. Matrix tokens, application private
 * keys, raw Matrix events and encrypted payloads terminate here and never
 * become bridge values.
 */
class NativeClientRuntime(
    context: Context,
    private val matrix: NativeMatrixPort = MatrixNativePort(context),
    private val identity: CodeverPrivateIdentity = AndroidKeystoreP256Identity(),
    private val cipher: SecretCipher = AndroidKeystoreSecretCipher(),
    private val foregroundState: () -> Pair<Boolean, Boolean>,
    private val onCommandCompletion: (CommandOperation, DurableCompletion) -> Unit = { _, _ -> },
    private val now: () -> Long = System::currentTimeMillis,
) : NativeMatrixObserver {
    private data class PendingPairing(
        val offer: SignedPairingOffer,
        var request: SignedPairingRequest? = null,
        var response: CompletableDeferred<SignedPairingResponse>? = null,
    )

    val deviceId: String = identity.publicIdentity.keyId
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mutex = Mutex()
    private val timelinePaginationMutex = Mutex()
    private val diagnostics = NativeDiagnosticLog.get(context)
    private val files = NativeRuntimeFiles(context, deviceId)
    private val replayStore = AtomicEncryptedReplayStore(files.replay, cipher, deviceId)
    private val historyCheckpoints = AtomicEncryptedGatewayHistoryCheckpointStore(
        files.historyCheckpoints,
        cipher,
        deviceId,
    )
    private val timelineKeys = AtomicEncryptedTimelineKeyStore(
        files.timelineKeys,
        cipher,
        deviceId,
    )
    private val trustStore = EncryptedGatewayTrustStore(
        AtomicEncryptedTrustBlobStore(files.trust),
        cipher,
        now,
    )
    private val outbox = DurableCommandOutbox.encrypted(files.commands, cipher, deviceId)
    private val transfers = AttachmentTransferManager(files.transfers, matrix, cipher, now)
    private val ackTimeouts = ConcurrentHashMap<String, Job>()
    private val commandRecoveryJobs = ConcurrentHashMap<String, Job>()
    private val commandRecoveryAttempts = ConcurrentHashMap<String, Int>()
    private val automaticRevisionRetryAttempts = ConcurrentHashMap<String, Int>()
    private val json = Json { isLenient = false; allowSpecialFloatingPointValues = false }
    private val nativeProjection = MatrixNativeProjection()
    private val restoredTrust = runCatching { trustStore.load() }
    @Volatile private var transportIdentity: MatrixTransportIdentity? = null
    @Volatile private var trust: GatewayTrust? = restoredTrust.getOrNull()
    @Volatile private var trustStorageBlocked = restoredTrust.isFailure
    @Volatile private var gatewayState: JsonObject? = null
    @Volatile private var gatewayStateSynchronized = false
    @Volatile private var gatewayStateSyncJob: Job? = null
    @Volatile private var pendingPairing: PendingPairing? = null
    @Volatile private var lastLifecycle: Pair<LifecyclePhase, String?>? = null

    private val eventHub = ClientEventHub(
        EncryptedAtomicClientEventPersistence(files.events, cipher, deviceId),
        initialSnapshot(),
    )

    init {
        gatewayState = eventHub.snapshot().gatewayState
        if (gatewayState != null) diagnostics.record("gateway.state.cache.restored")
        matrix.setObserver(this)
        refreshSnapshot(publishLifecycle = false)
        scope.launch {
            while (isActive) {
                delay(1_000)
                runCatching { refreshSnapshot(publishLifecycle = true) }
            }
        }
    }

    fun start(): ClientSnapshot {
        matrix.start()
        refreshSnapshot(publishLifecycle = true)
        return snapshot()
    }

    suspend fun bootstrap(input: MatrixBootstrap): Pair<PublicMatrixSession, ClientSnapshot> =
        mutex.withLock {
            val session = matrix.bootstrap(input)
            refreshSnapshot(publishLifecycle = true)
            session to snapshot()
        }

    fun snapshot(): ClientSnapshot = eventHub.snapshot()

    fun trustState(): PublicTrustState = publicTrust()

    fun subscribe(
        afterCursor: String?,
        maxReplayEvents: Int,
        listener: ClientEventListener,
    ): SubscriptionBootstrap = eventHub.subscribe(afterCursor, maxReplayEvents, listener)

    fun activate(subscriptionId: String, throughCursor: String): SubscriptionCursorResult =
        eventHub.activate(subscriptionId, throughCursor)

    fun acknowledge(subscriptionId: String, throughCursor: String): SubscriptionCursorResult =
        eventHub.acknowledge(subscriptionId, throughCursor)

    fun unsubscribe(subscriptionId: String): Boolean = eventHub.unsubscribe(subscriptionId)

    suspend fun historyPage(sessionId: String, before: String?, limit: Int): HistoryPage {
        diagnostics.record("history.page.requested")
        var local = eventHub.historyPage(
            sessionId,
            before,
            limit,
            externalHasMore = matrix.status.phase == MatrixRuntimePhase.SYNCING,
        )
        if (local.hasMore || matrix.status.phase != MatrixRuntimePhase.SYNCING) {
            diagnostics.record("history.page.local")
            return local
        }
        val reachedStart = matrix.paginateRoomHistory(maxOf(30, limit))
        local = eventHub.historyPage(
            sessionId,
            before,
            limit,
            externalHasMore = matrixRoomHistoryHasMore(reachedStart),
        )
        diagnostics.record("history.page.completed")
        return local
    }

    fun inspectPairing(link: String): NativePairingPreview {
        val offer = PairingCodec.decodePairingLink(link)
        PairingSecurity.verifyOffer(offer, now = now())
        assertOfferRoute(offer)
        pendingPairing = PendingPairing(offer)
        val preview = NativePairingPreview(
            pairingId = offer.offer.offerId,
            gatewayId = offer.offer.gatewayId,
            gatewayName = offer.offer.gatewayName,
            verificationCode = verificationCode(offer),
            expiresAt = offer.offer.expiresAt,
        )
        eventHub.publish(ClientEventType.PAIRING_CHANGED, preview.toJson(), refreshedSnapshot())
        return preview
    }

    fun pairingPreview(pairingId: String): NativePairingPreview? = pendingPairing
        ?.offer
        ?.takeIf { it.offer.offerId == pairingId }
        ?.let { offer ->
            NativePairingPreview(
                pairingId = offer.offer.offerId,
                gatewayId = offer.offer.gatewayId,
                gatewayName = offer.offer.gatewayName,
                verificationCode = verificationCode(offer),
                expiresAt = offer.offer.expiresAt,
            )
        }

    suspend fun completePairing(
        pairingId: String,
        deviceName: String,
    ): Pair<PublicTrustState.Trusted, ClientSnapshot> {
        val (pending, signedRequest, response) = mutex.withLock {
            val pending = pendingPairing?.takeIf { it.offer.offer.offerId == pairingId }
                ?: throw IllegalArgumentException("The pairing preview is no longer available.")
            check(now() < pending.offer.offer.expiresAt) { "The pairing offer has expired." }
            val session = matrix.publicSession()
                ?: throw IllegalStateException("A native Matrix session is required before pairing.")
            val transport = transportIdentity
                ?: throw IllegalStateException("Matrix encryption keys are not ready yet.")
            val issuedAt = now()
            val request = PairingRequest(
                requestId = UUID.randomUUID().toString(),
                offerId = pending.offer.offer.offerId,
                offerDigest = PairingSecurity.offerDigest(pending.offer),
                gatewayId = pending.offer.offer.gatewayId,
                deviceId = deviceId,
                deviceName = deviceName.trim().ifEmpty { "Codever Android" }.take(128),
                deviceKey = identity.publicIdentity,
                deviceTransport = MatrixTransportBinding(
                    homeserver = session.homeserver,
                    roomId = session.roomBinding.roomId,
                    userId = session.userId,
                    deviceId = transport.deviceId,
                    ed25519 = transport.ed25519,
                ),
                requestedOperations = pending.offer.offer.allowedOperations,
                issuedAt = issuedAt,
                expiresAt = minOf(pending.offer.offer.expiresAt, issuedAt + PAIRING_REQUEST_MS),
            )
            val signedRequest = PairingSecurity.signRequest(request, pending.offer, identity)
            val response = CompletableDeferred<SignedPairingResponse>()
            pending.request = signedRequest
            pending.response = response
            // A failed pre-sync attempt may have created a Megolm session before
            // the Gateway device list was ready. Pairing starts a fresh session
            // only after the native Matrix driver has completed its first sync.
            matrix.sendRoomMessage(
                pairingRequestContent(signedRequest).toString(),
                rotateRoomKey = true,
            )
            Triple(pending, signedRequest, response)
        }
        val signedResponse = try {
            try {
                withTimeout(PAIRING_RESPONSE_TIMEOUT_MS) { response.await() }
            } catch (_: TimeoutCancellationException) {
                throw NativePairingRejectedException(
                    "The Gateway did not answer the native pairing request in time.",
                )
            }
        } finally {
            mutex.withLock {
                if (pendingPairing === pending && pending.response === response) {
                    pending.response = null
                }
            }
        }
        return mutex.withLock {
            check(pendingPairing === pending) { "The pairing request is no longer active." }
            PairingSecurity.verifyResponse(
                signedResponse,
                pending.offer,
                signedRequest,
                pending.offer.offer.gatewayKey,
                now(),
            )
            val nextTrust = GatewayTrust(pending.offer, signedRequest, signedResponse).validate(now())
            trustStore.save(nextTrust)
            trust = nextTrust
            trustStorageBlocked = false
            pendingPairing = null
            val public = publicTrust() as PublicTrustState.Trusted
            val nextSnapshot = refreshedSnapshot()
            eventHub.publish(ClientEventType.TRUST_CHANGED, PublicClientJson.encodeTrust(public), nextSnapshot)
            startGatewayStateSync(recoverTransport = false)
            public to snapshot()
        }
    }

    fun cancelPairing(pairingId: String): Boolean {
        val pending = pendingPairing?.takeIf { it.offer.offer.offerId == pairingId } ?: return false
        pending.response?.completeExceptionally(NativePairingRejectedException("Pairing was cancelled."))
        pendingPairing = null
        eventHub.publish(
            ClientEventType.PAIRING_CHANGED,
            buildJsonObject { put("pairingId", pairingId); put("cancelled", true) },
            refreshedSnapshot(),
        )
        return true
    }

    suspend fun sendCommand(idempotencyKey: String, payload: JsonObject): DurableReceipt =
        mutex.withLock {
            val activeTrust = trust
                ?: throw NativeTrustRequiredException("Pair the Gateway before sending commands.")
            check(gatewayState != null) { "Gateway state is not synchronized yet." }
            CommandAuthorizationPolicy.requireAuthorized(
                CommandPayloadValidator.validate(payload),
                activeTrust.certificate.allowedOperations,
            )
            val receipt = outbox.enqueue(
                idempotencyKey,
                payload,
                payload.string("sessionId"),
            )
            val current = outbox.get(receipt.commandId) ?: error("Durable command disappeared.")
            if (current.state == DurableState.QUEUED) {
                launchCommandTransmission(current.commandId, recovery = false)
            }
            publicReceipt(outbox.get(receipt.commandId) ?: current)
        }

    suspend fun cancelCommand(
        idempotencyKey: String,
        sessionId: String,
        targetCommandId: String?,
    ): DurableReceipt = sendCommand(
        idempotencyKey,
        buildJsonObject {
            put("operation", "cancel")
            put("sessionId", sessionId)
            targetCommandId?.let { put("targetCommandId", it) }
        },
    )

    suspend fun recoverCommand(commandId: String): DurableReceipt {
        val current = outbox.get(commandId) ?: throw IllegalArgumentException("Command was not found.")
        if (current.state == DurableState.RECOVERY_REQUIRED) {
            cancelScheduledCommandRecovery(commandId, resetAttempts = false)
            launchCommandTransmission(commandId, recovery = true)
        }
        return publicReceipt(outbox.get(commandId) ?: current)
    }

    fun command(commandId: String): CommandView = outbox.get(commandId)?.let(::publicCommand)
        ?: throw IllegalArgumentException("Command was not found.")

    suspend fun issueMatrixLoginToken(
        invitationId: String,
        password: String?,
    ): MatrixLoginTokenIssueResult {
        mutex.withLock {
            check(trust != null) { "Pair the Gateway before creating another device invitation." }
            check(outbox.operation(invitationId) == CommandOperation.DEVICE_INVITE) {
                "The invitation is not owned by this native bridge."
            }
            check(outbox.get(invitationId)?.completion?.outcome == DurableOutcome.SUCCEEDED) {
                "The Gateway must accept the device invitation before Matrix sign-in is issued."
            }
        }
        // The one-time token is returned directly from the in-memory Matrix
        // session and is never written to the native command/event stores.
        return matrix.issueLoginToken(password)
    }

    fun releaseCommand(commandId: String): Boolean {
        ackTimeouts.remove(commandId)?.cancel()
        cancelScheduledCommandRecovery(commandId)
        outbox.get(commandId)?.operationId?.let(automaticRevisionRetryAttempts::remove)
        val released = outbox.release(commandId)
        if (released) refreshSnapshot(publishLifecycle = false)
        return released
    }

    suspend fun resolveConflict(commandId: String, action: RevisionConflictAction): DurableReceipt {
        // DurableCommandOutbox serializes its own state. Conflict decisions
        // intentionally bypass the broader runtime mutex so discard remains a
        // local escape hatch even while unrelated Matrix recovery is slow.
        val receipt = outbox.resolveRevisionConflict(commandId, action)
        automaticRevisionRetryAttempts.remove(receipt.operationId)
        publishCommand(outbox.get(receipt.commandId) ?: error("Resolved command disappeared."))
        if (action == RevisionConflictAction.RETRY) {
            launchCommandTransmission(receipt.commandId, recovery = false)
        }
        return publicReceipt(outbox.get(receipt.commandId) ?: error("Resolved command disappeared."))
    }

    fun openUpload(name: String, mimeType: String, size: Long, sha256: String): UploadTransfer =
        transfers.openUpload(name, mimeType, size, sha256)

    fun uploadChunk(
        transferId: String,
        index: Int,
        dataBase64Url: String,
        chunkSha256: String,
    ): UploadChunkReceipt = transfers.writeUploadChunk(transferId, index, dataBase64Url, chunkSha256)

    suspend fun finishUpload(transferId: String) = transfers.finishUpload(transferId)
    fun abortUpload(transferId: String): Boolean = transfers.abortUpload(transferId)
    suspend fun openDownload(attachment: id.my.anciety.codever.client.events.CodeverAttachment) =
        transfers.openDownload(attachment)
    fun readDownload(transferId: String, index: Int) = transfers.readDownload(transferId, index)
    fun closeDownload(transferId: String): Boolean = transfers.closeDownload(transferId)

    suspend fun disconnect(revoke: Boolean): ClientSnapshot = mutex.withLock {
        if (revoke) {
            matrix.revokeSession()
        } else {
            matrix.stop(clearSession = false)
        }
        ackTimeouts.keys.toList().forEach { commandId ->
            ackTimeouts.remove(commandId)?.cancel()
            outbox.markAcknowledgementTimedOut(commandId)?.let(::publishCommand)
        }
        cancelAllCommandRecoveries()
        automaticRevisionRetryAttempts.clear()
        gatewayStateSyncJob?.cancel()
        gatewayStateSyncJob = null
        gatewayStateSynchronized = false
        if (revoke) {
            trustStore.clear()
            replayStore.clear()
            historyCheckpoints.clear()
            timelineKeys.clear()
            outbox.clear()
            transfers.clear()
            trust = null
            trustStorageBlocked = false
            gatewayState = null
            pendingPairing = null
        }
        refreshSnapshot(publishLifecycle = true)
        snapshot()
    }

    suspend fun close() {
        matrix.setObserver(null)
        ackTimeouts.values.forEach(Job::cancel)
        ackTimeouts.clear()
        cancelAllCommandRecoveries()
        automaticRevisionRetryAttempts.clear()
        gatewayStateSyncJob?.cancel()
        gatewayStateSyncJob = null
        transfers.clear()
        matrix.close()
        scope.cancel()
    }

    override fun onTransportReady(identity: MatrixTransportIdentity) {
        transportIdentity = identity
        refreshSnapshot(publishLifecycle = true)
        if (trust != null) {
            startGatewayStateSync(recoverTransport = true)
        }
    }

    override fun onConvergenceRequired(reason: String) {
        requestAuthoritativeConvergence(reason)
    }

    fun requestAuthoritativeConvergence(reason: String) {
        val diagnosticReason = reason
            .replace(Regex("[^A-Za-z0-9._:+/-]"), "_")
            .take(160)
            .ifBlank { "unspecified" }
        diagnostics.record(
            "gateway.convergence.requested",
            mapOf("reason" to diagnosticReason),
        )
        if (trust == null || gatewayStateSyncJob?.isActive == true) return
        startGatewayStateSync(recoverTransport = false)
    }

    override fun onDecryptedEvent(event: MatrixDecryptedEvent) {
        scope.launch {
            mutex.withLock {
                try {
                    processMatrixEvent(event)
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    if (error !is CodeverSecurityException) {
                        publishStatus(lifecycle().phase, "native_event_rejected")
                    }
                }
            }
        }
    }

    private fun launchCommandTransmission(commandId: String, recovery: Boolean) {
        scope.launch {
            try {
                transmit(commandId, recovery)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                diagnostics.record(
                    "command.transmission.failure",
                    mapOf(
                        "action" to (outbox.operation(commandId)?.wireName ?: "unknown"),
                        "stage" to if (recovery) "recovery" else "initial",
                        "error" to diagnosticErrorName(error),
                    ),
                )
            }
        }
    }

    /**
     * Command Matrix I/O must never run while [mutex] is held. Bridge mutations
     * only commit durable command state synchronously; delivery continues in a
     * background task so a slow Matrix send cannot starve local recovery RPCs.
     */
    private suspend fun transmit(commandId: String, recovery: Boolean) {
        val transmission = mutex.withLock {
            val claimed = if (recovery) {
                outbox.claimRecovery(commandId)
            } else {
                outbox.claimForTransmission(commandId)
            } ?: return@withLock null
            publishCommand(outbox.get(commandId) ?: return@withLock null)
            claimed
        } ?: return
        try {
            sendTrustedControlMessage(
                signedCommandContent(transmission).toString(),
                "codever.command.${transmission.commandId}",
            )
        } catch (error: Exception) {
            mutex.withLock {
                outbox.markAcknowledgementTimedOut(commandId)?.let(::publishCommand)
                scheduleCommandRecovery(commandId)
            }
            throw error
        }
        mutex.withLock {
            if (outbox.get(commandId)?.state == DurableState.TRANSMITTING) {
                ackTimeouts.remove(commandId)?.cancel()
                ackTimeouts[commandId] = scope.launch {
                    delay(COMMAND_ACK_TIMEOUT_MS)
                    mutex.withLock {
                        ackTimeouts.remove(commandId)
                        val timedOut = outbox.markAcknowledgementTimedOut(commandId)
                        timedOut?.let(::publishCommand)
                        if (timedOut?.state == DurableState.RECOVERY_REQUIRED) {
                            diagnostics.record(
                                "command.recovery.required",
                                mapOf("action" to (outbox.operation(commandId)?.wireName ?: "unknown")),
                            )
                            scheduleCommandRecovery(commandId)
                        }
                    }
                }
            }
        }
    }

    private fun schedulePendingCommandRecoveries(immediate: Boolean) {
        recoverableCommandIds(outbox.list()).forEach { commandId ->
            scheduleCommandRecovery(commandId, immediate)
        }
    }

    private fun scheduleCommandRecovery(commandId: String, immediate: Boolean = false) {
        synchronized(commandRecoveryJobs) {
            if (commandRecoveryJobs[commandId]?.isActive == true) return
            val completedAttempts = commandRecoveryAttempts[commandId] ?: 0
            val retryDelayMs = if (immediate) 0L else commandRecoveryDelayMs(completedAttempts)
            val job = scope.launch {
                var retryAfterFailure = false
                try {
                    if (retryDelayMs > 0) delay(retryDelayMs)
                    val readyToTransmit = mutex.withLock {
                        val command = outbox.get(commandId)
                        if (command?.state != DurableState.RECOVERY_REQUIRED) return@withLock false
                        if (
                            trust == null ||
                            transportIdentity == null ||
                            gatewayState == null ||
                            !gatewayStateSynchronized
                        ) {
                            diagnostics.record(
                                "command.recovery.waiting_for_connection",
                                mapOf("action" to (outbox.operation(commandId)?.wireName ?: "unknown")),
                            )
                            return@withLock false
                        }
                        commandRecoveryAttempts[commandId] = completedAttempts + 1
                        diagnostics.record(
                            "command.recovery.attempted",
                            mapOf(
                                "action" to (outbox.operation(commandId)?.wireName ?: "unknown"),
                                "stage" to if (completedAttempts == 0) "initial" else "retry",
                            ),
                        )
                        true
                    }
                    if (readyToTransmit) {
                        try {
                            transmit(commandId, recovery = true)
                        } catch (error: CancellationException) {
                            throw error
                        } catch (error: Exception) {
                            retryAfterFailure = true
                            diagnostics.record(
                                "command.recovery.failure",
                                mapOf("error" to diagnosticErrorName(error)),
                            )
                        }
                    }
                } finally {
                    val currentJob = coroutineContext[Job]
                    if (currentJob != null) commandRecoveryJobs.remove(commandId, currentJob)
                }
                if (retryAfterFailure) scheduleCommandRecovery(commandId)
            }
            commandRecoveryJobs[commandId] = job
        }
    }

    private fun cancelScheduledCommandRecovery(
        commandId: String,
        resetAttempts: Boolean = true,
    ) {
        commandRecoveryJobs.remove(commandId)?.cancel()
        if (resetAttempts) commandRecoveryAttempts.remove(commandId)
    }

    private fun cancelAllCommandRecoveries() {
        commandRecoveryJobs.values.forEach(Job::cancel)
        commandRecoveryJobs.clear()
        commandRecoveryAttempts.clear()
    }

    private fun signedCommandContent(transmission: CommandTransmission): JsonObject {
        val activeTrust = trust ?: throw NativeTrustRequiredException("Pair the Gateway before sending commands.")
        val state = gatewayState ?: throw IllegalStateException("Gateway state is not synchronized yet.")
        val revisionEpoch = state.string("revision_epoch")
            ?: throw IllegalStateException("Gateway revision epoch is unavailable.")
        val operation = transmission.payload.string("operation")
            ?: throw IllegalArgumentException("Command operation is invalid.")
        val timestamp = now()
        val command = buildJsonObject {
            put("kind", "codever.command")
            put("version", 1)
            put("commandId", transmission.commandId)
            put("gatewayId", activeTrust.gatewayId)
            put("deviceId", deviceId)
            put("sequenceEpoch", activeTrust.certificate.certificateId)
            put("conversationId", matrix.publicSession()?.roomBinding?.conversationId
                ?: throw IllegalStateException("Matrix room binding is unavailable."))
            put("revisionEpoch", revisionEpoch)
            put("sequence", transmission.sequence)
            put("baseRevision", transmission.baseRevision)
            put("operation", operation)
            put("issuedAt", timestamp)
            put("expiresAt", timestamp + COMMAND_LIFETIME_MS)
            put("nonce", randomNonce())
            put("payload", transmission.payload)
        }
        val signed = buildJsonObject {
            put("command", command)
            put("signature", buildJsonObject {
                put("algorithm", "ES256")
                put("keyId", deviceId)
                put("value", Base64Url.encode(identity.sign(CanonicalJson.bytes(command))))
            })
        }
        val content = buildJsonObject {
            put("msgtype", "m.text")
            put("body", "Encrypted Codever command")
            put("io.codever", buildJsonObject {
                put("version", 1)
                put("kind", "signed_command")
                put("signed_command", signed)
            })
        }
        val certificate = activeTrust.certificate
        val envelope = SecureEnvelopes.sealSecureEnvelope(
            bindings = SecureEnvelopeBindings(
                gatewayId = activeTrust.gatewayId,
                conversationId = certificate.deviceTransport.roomId.let {
                    matrix.publicSession()?.roomBinding?.conversationId
                        ?: throw IllegalStateException("Matrix room binding is unavailable.")
                },
                direction = SecureEnvelopeDirection.DEVICE_TO_GATEWAY,
                senderDeviceId = certificate.deviceId,
                recipientDeviceId = certificate.gatewayId,
                senderKeyId = deviceId,
                recipientKeyId = activeTrust.gatewayKey.keyId,
            ),
            plaintext = content,
            senderIdentity = identity,
            recipientPublicKey = activeTrust.gatewayKey,
            envelopeId = "codever.${transmission.commandId}",
            now = timestamp,
            lifetimeMs = COMMAND_LIFETIME_MS,
        )
        return buildJsonObject {
            put("msgtype", "m.notice")
            put("body", "Encrypted Codever message")
            put("io.codever", buildJsonObject {
                put("version", 1)
                put("kind", "secure_envelope")
                put("secure_envelope", envelope.toJson())
            })
        }
    }

    private fun startGatewayStateSync(recoverTransport: Boolean) {
        gatewayStateSynchronized = false
        gatewayStateSyncJob?.cancel()
        gatewayStateSyncJob = scope.launch {
            if (recoverTransport) {
                mutex.withLock {
                    runCatching { recoverGatewayTransportSnapshotLocked() }
                        .onFailure { error ->
                            diagnostics.record(
                                "gateway.transport.recovery.failure",
                                mapOf("error" to diagnosticErrorName(error)),
                            )
                        }
                }
            }
            if (trust != null && matrix.status.phase == MatrixRuntimePhase.SYNCING) {
                runCatching { backfillNativeTimeline() }
                    .onSuccess { result ->
                        diagnostics.record(
                            "matrix.native_timeline.paginated",
                            mapOf(
                                "pages" to result.pages.toString(),
                                "reached_start" to result.reachedStart.toString(),
                            ),
                        )
                    }
                    .onFailure { error ->
                        diagnostics.record(
                            "matrix.native_timeline.pagination_failure",
                            mapOf("error" to diagnosticErrorName(error)),
                        )
                    }
            }
        }
    }

    private suspend fun backfillNativeTimeline(): MatrixTimelineBackfillResult =
        timelinePaginationMutex.withLock {
            paginateMatrixTimelineToStart(MAX_NATIVE_TIMELINE_BACKFILL_PAGES) {
                matrix.paginateRoomHistory(100)
            }
        }

    private fun diagnosticErrorName(error: Throwable): String =
        error::class.simpleName?.take(160)?.takeIf { it.isNotBlank() } ?: "Exception"

    /**
     * The content is already signed and encrypted to the paired Gateway by
     * Codever. Sending it as an application control event avoids coupling
     * command and recovery traffic to Matrix Megolm device-key distribution.
     */
    private suspend fun sendTrustedControlMessage(contentJson: String, transactionId: String) {
        matrix.sendApplicationControlEvent(contentJson, transactionId)
        diagnostics.record("matrix.application_control.sent")
    }

    private suspend fun processMatrixEvent(event: MatrixDecryptedEvent) {
        if (event.roomId != matrix.publicSession()?.roomBinding?.roomId) return
        val root = json.parseToJsonElement(event.rawJson).jsonObject
        val content = (root["content"] as? JsonObject) ?: return
        val extension = content["io.codever"] as? JsonObject ?: return
        val kind = extension.string("kind") ?: return
        if (kind == "pairing_response") {
            acceptPairingResponse(event, extension)
            return
        }
        if (kind == "pairing_rejection") {
            val pending = pendingPairing ?: return
            val request = pending.request ?: return
            if (event.sender != pending.offer.offer.gatewayTransport.userId) return
            val signed = PairingCodec.parseRejection(
                extension.objectValue("pairing_rejection").toString(),
            )
            val rejection = PairingSecurity.verifyRejection(
                signed,
                pending.offer,
                request,
                now(),
            )
            pending.response?.completeExceptionally(
                NativePairingRejectedException(rejection.message),
            )
            return
        }
        if (kind == "gateway_device_rotation") {
            acceptGatewayDeviceRotation(event, extension)
            return
        }
        val activeTrust = trust ?: return
        if (event.sender != activeTrust.transportTrust.currentTransport.userId) return
        val plaintext = when (kind) {
            "secure_envelope" -> {
                val signed = SecureEnvelopeCodec.parse(
                    extension.objectValue("secure_envelope").toString(),
                )
                if (signed.envelope.recipientDeviceId != deviceId) return
                SecureEnvelopes.openSecureEnvelope(
                    signed,
                    identity,
                    activeTrust.gatewayKey,
                    incomingBindings(activeTrust),
                    replayStore,
                    now(),
                ).plaintext
            }
            "secure_envelope_bundle" -> {
                val signed = SecureEnvelopeBundleCodec.parse(
                    extension.objectValue("secure_envelope_bundle").toString(),
                )
                if (signed.bundle.recipients.none {
                        it.recipientDeviceId == deviceId && it.recipientKeyId == deviceId
                    }
                ) return
                SecureEnvelopeBundles.open(
                    signed,
                    identity,
                    activeTrust.gatewayKey,
                    SecureEnvelopeBundleBindings(
                        gatewayId = activeTrust.gatewayId,
                        conversationId = conversationId(),
                        direction = SecureEnvelopeDirection.GATEWAY_TO_DEVICE,
                        senderDeviceId = activeTrust.certificate.gatewayId,
                        senderKeyId = activeTrust.gatewayKey.keyId,
                    ),
                    deviceId,
                    replayStore,
                    now(),
                ).plaintext
            }
            "timeline_envelope" -> {
                val signed = MatrixTimelineEnvelopeCodec.parse(
                    extension.objectValue("timeline_envelope").toString(),
                )
                var key = timelineKeys.key(signed.envelope.epochId)
                if (key == null) {
                    val keyBundleValue = extension["timeline_key_ring_bundle"] as? JsonObject
                        ?: return
                    val keyBundle = SecureEnvelopeBundleCodec.parse(keyBundleValue.toString())
                    if (keyBundle.bundle.recipients.none {
                            it.recipientDeviceId == deviceId && it.recipientKeyId == deviceId
                        }
                    ) return
                    val grant = SecureEnvelopeBundles.open(
                        keyBundle,
                        identity,
                        activeTrust.gatewayKey,
                        SecureEnvelopeBundleBindings(
                            gatewayId = activeTrust.gatewayId,
                            conversationId = conversationId(),
                            direction = SecureEnvelopeDirection.GATEWAY_TO_DEVICE,
                            senderDeviceId = activeTrust.certificate.gatewayId,
                            senderKeyId = activeTrust.gatewayKey.keyId,
                        ),
                        deviceId,
                        replayStore,
                        keyBundle.bundle.issuedAt,
                    ).plaintext as? JsonObject ?: return
                    acceptTimelineKeyRingValue(grant)
                    key = timelineKeys.key(signed.envelope.epochId) ?: return
                }
                try {
                    MatrixTimelineEnvelopes.open(
                        signed,
                        key,
                        activeTrust.gatewayKey,
                        MatrixTimelineBindings(
                            gatewayId = activeTrust.gatewayId,
                            conversationId = conversationId(),
                            roomId = event.roomId,
                            epochId = signed.envelope.epochId,
                            sessionId = signed.envelope.sessionId,
                            threadRootEventId = signed.envelope.threadRootEventId,
                        ),
                    )
                } finally {
                    key.fill(0)
                }
            }
            else -> return
        }
        val decryptedContent = plaintext as? JsonObject ?: return
        if (kind == "timeline_envelope") {
            val signed = MatrixTimelineEnvelopeCodec.parse(
                extension.objectValue("timeline_envelope").toString(),
            )
            require(
                CanonicalJson.encode(content["m.relates_to"] ?: JsonNull) ==
                    CanonicalJson.encode(decryptedContent["m.relates_to"] ?: JsonNull),
            ) { "The Matrix homeserver changed a signed timeline relation." }
            val decryptedExtension = decryptedContent["io.codever"] as? JsonObject ?: return
            require(decryptedExtension.string("session_id") == signed.envelope.sessionId)
            val relation = decryptedContent["m.relates_to"] as? JsonObject
            val contentRoot = if (relation?.string("rel_type") == "m.thread") {
                relation.string("event_id")
            } else {
                decryptedExtension.string("thread_root_event_id")
            }
            require(contentRoot == signed.envelope.threadRootEventId)
        }
        processAuthenticatedContent(event, decryptedContent)
    }

    private fun acceptPairingResponse(event: MatrixDecryptedEvent, extension: JsonObject) {
        val pending = pendingPairing ?: return
        if (event.sender != pending.offer.offer.gatewayTransport.userId) return
        val signed = PairingCodec.parseResponse(extension.objectValue("pairing_response").toString())
        if (signed.response.requestId != pending.request?.request?.requestId) return
        pending.response?.complete(signed)
    }

    private fun acceptGatewayDeviceRotation(event: MatrixDecryptedEvent, extension: JsonObject) {
        val activeTrust = trust ?: return
        val signed = GatewayTransportCodec.parseRotation(
            extension.objectValue("gateway_device_rotation").toString(),
        )
        if (event.sender != signed.rotation.nextTransport.userId) return
        val next = activeTrust.copy(
            transportTrust = activeTrust.transportTrust.applyRotation(signed, now()),
        )
        trustStore.save(next)
        trust = next
        eventHub.publish(
            ClientEventType.TRUST_CHANGED,
            PublicClientJson.encodeTrust(publicTrust()),
            refreshedSnapshot(),
        )
    }

    private suspend fun recoverGatewayTransportSnapshotLocked() {
        val activeTrust = trust ?: return
        val current = activeTrust.transportTrust.currentTransport
        val profile = matrix.profileProperty(current.userId, GATEWAY_TRANSPORT_PROFILE_FIELD) ?: return
        require(profile.keys == setOf("version", "signed_snapshot")) {
            "Gateway transport recovery profile has an invalid shape."
        }
        require(profile.long("version") == 1L)
        val signed = GatewayTransportCodec.parseSnapshot(
            profile.objectValue("signed_snapshot").toString(),
        )
        val nextTransport = try {
            activeTrust.transportTrust.applySnapshot(signed, now())
        } catch (error: CodeverSecurityException) {
            if (error.code == id.my.anciety.codever.security.codever.SecurityErrorCode.REPLAY) return
            throw error
        }
        val next = activeTrust.copy(transportTrust = nextTransport)
        trustStore.save(next)
        trust = next
        diagnostics.record("gateway.transport.recovery.accepted")
        eventHub.publish(
            ClientEventType.TRUST_CHANGED,
            PublicClientJson.encodeTrust(publicTrust()),
            refreshedSnapshot(),
        )
    }

    private suspend fun processAuthenticatedContent(event: MatrixDecryptedEvent, content: JsonObject) {
        val extension = content["io.codever"] as? JsonObject ?: return
        when (extension.string("kind")) {
            "timeline_key_ring_grant" -> acceptTimelineKeyRing(extension)
            "session_root", "session_update", "session_lifecycle", "gateway_checkpoint" ->
                nativeProjection.apply(extension)?.let { acceptGatewayState(it) }
            "gateway_state" -> acceptGatewayState(extension)
            "command_ack" -> acceptCommandAck(extension)
            "revision_conflict" -> acceptRevisionConflict(extension)
            "command_result" -> acceptCommandResult(event, extension)
            else -> {
                if (extension.string("kind") == "status") {
                    nativeProjection.applyStatus(extension)?.let { acceptGatewayState(it) }
                }
                if (extension.string("kind") == "collaboration_command") {
                    acceptTimelineRevision(extension)
                }
                parseMessage(event, content)?.let { message ->
                    val sessionId = message.sessionId ?: currentSessionId() ?: conversationId()
                    eventHub.upsertMessage(sessionId, message.copy(sessionId = sessionId), refreshedSnapshot())
                }
            }
        }
    }

    private suspend fun acceptTimelineRevision(extension: JsonObject) {
        val state = gatewayState ?: return
        val revision = extension.long("revision")?.takeIf { it >= 0 } ?: return
        val epoch = extension.string("revision_epoch") ?: return
        val generation = extension.long("revision_epoch_generation")?.takeIf { it > 0 } ?: return
        val currentEpoch = state.string("revision_epoch") ?: return
        val currentGeneration = state.long("revision_epoch_generation") ?: return
        if (generation < currentGeneration) return
        if (generation > currentGeneration) {
            diagnostics.record("gateway.revision.checkpoint_required")
            return
        }
        require(epoch == currentEpoch) {
            "Matrix timeline revision epoch does not match Gateway state."
        }
        if (revision < (state.long("revision") ?: 0)) return
        acceptGatewayState(JsonObject(state + ("revision" to JsonPrimitive(revision))))
    }

    private fun acceptTimelineKeyRing(extension: JsonObject) {
        val grant = extension["timeline_key_ring_grant"] as? JsonObject ?: return
        acceptTimelineKeyRingValue(grant)
    }

    private fun acceptTimelineKeyRingValue(grant: JsonObject) {
        val activeTrust = trust ?: return
        require(grant.long("version") == 2L)
        require(grant.string("kind") == "timeline_key_ring_grant")
        require(grant.string("gateway_id") == activeTrust.gatewayId)
        require(grant.string("conversation_id") == conversationId())
        require(grant.string("room_id") == matrix.publicSession()?.roomBinding?.roomId)
        val changed = timelineKeys.save(grant)
        diagnostics.record("matrix.timeline_keys.accepted")
        if (!changed) return
        scope.launch {
            runCatching { backfillNativeTimeline() }
                .onFailure { error ->
                    diagnostics.record(
                        "matrix.timeline_keys.replay_failure",
                        mapOf("error" to diagnosticErrorName(error)),
                    )
                }
        }
    }

    private suspend fun acceptGatewayState(extension: JsonObject) {
        if (extension.toString().toByteArray(Charsets.UTF_8).size > MAX_BRIDGE_EVENT_PAYLOAD_BYTES) return
        val revision = extension.long("revision")?.takeIf { it >= 0 } ?: return
        val revisionEpoch = extension.string("revision_epoch") ?: return
        if (revisionEpoch.isBlank()) return
        gatewayState = extension
        outbox.updateKnownRevision(revision)
        eventHub.publish(
            ClientEventType.GATEWAY_STATE_CHANGED,
            extension,
            refreshedSnapshot(),
        )
        gatewayStateSynchronized = true
        gatewayStateSyncJob?.cancel()
        gatewayStateSyncJob = null
        diagnostics.record("gateway.state.response.accepted")
        resumePendingSafeRevisionConflict()
        schedulePendingCommandRecoveries(immediate = true)
    }

    private fun acceptCommandAck(extension: JsonObject) {
        val commandId = extension.string("command_id") ?: return
        val sequence = extension.long("sequence")?.takeIf { it > 0 } ?: return
        val revision = extension.long("revision")?.takeIf { it >= 0 } ?: return
        val operationId = outbox.get(commandId)?.operationId
        if (outbox.recordAcknowledgement(commandId, sequence, revision)) {
            ackTimeouts.remove(commandId)?.cancel()
            cancelScheduledCommandRecovery(commandId)
            operationId?.let(automaticRevisionRetryAttempts::remove)
            outbox.get(commandId)?.let(::publishCommand)
        }
    }

    private suspend fun acceptRevisionConflict(extension: JsonObject) {
        val commandId = extension.string("command_id") ?: return
        val expected = extension.long("expected_revision")?.takeIf { it >= 0 } ?: return
        val sequence = outbox.get(commandId)?.sequence ?: return
        ackTimeouts.remove(commandId)?.cancel()
        cancelScheduledCommandRecovery(commandId)
        val conflicted = outbox.recordRevisionConflict(commandId, sequence, expected) ?: return
        if (!retrySafeRevisionConflict(conflicted.commandId, "gateway")) {
            publishCommand(conflicted)
        }
    }

    private fun acceptCommandResult(event: MatrixDecryptedEvent, extension: JsonObject) {
        val commandId = extension.string("command_id") ?: return
        val sequence = extension.long("sequence")?.takeIf { it > 0 } ?: return
        val revision = extension.long("revision")?.takeIf { it >= 0 } ?: return
        val outcome = when (extension.string("outcome")) {
            "succeeded" -> DurableOutcome.SUCCEEDED
            "failed" -> DurableOutcome.FAILED
            "cancelled" -> DurableOutcome.CANCELLED
            else -> return
        }
        val errorText = extension.string("error")
        val completion = DurableCompletion(
            commandId = commandId,
            sequence = sequence,
            revision = revision,
            outcome = outcome,
            sessionId = extension.string("session_id"),
            result = extension["result"],
            error = errorText?.let {
                DurableError("gateway_failed", it.take(4_096), retryable = false)
            },
        )
        // Capture the operation before publishing the terminal command event.
        // A Web client may synchronously consume that event and release the
        // durable command before the completion callback runs.
        val operation = outbox.operation(commandId)
        val operationId = outbox.get(commandId)?.operationId
        val recorded = outbox.recordCompletion(completion)
        diagnostics.record(
            "command.completion.received",
            mapOf(
                "available" to recorded.toString(),
                "action" to (operation?.wireName ?: "unavailable"),
                "stage" to completion.outcome.wireName,
            ),
        )
        if (recorded) {
            ackTimeouts.remove(commandId)?.cancel()
            cancelScheduledCommandRecovery(commandId)
            operationId?.let(automaticRevisionRetryAttempts::remove)
            outbox.get(commandId)?.let(::publishCommand)
            runCatching {
                operation?.let { completedOperation ->
                    diagnostics.record(
                        "gateway.state.refresh.scheduled",
                        mapOf("action" to completedOperation.wireName),
                    )
                    // Command acknowledgements advance the durable revision,
                    // but session summaries live in Gateway state. Refresh it
                    // after every terminal command so the UI can consume a
                    // newly-created session and the next device sees current
                    // lifecycle state without waiting for reconnect.
                    startGatewayStateSync(recoverTransport = false)
                    onCommandCompletion(completedOperation, completion)
                }
            }.onFailure { error ->
                diagnostics.record(
                    "command.completion.callback_failed",
                    mapOf("error" to error.javaClass.simpleName.take(160)),
                )
            }
        }
        if (outcome == DurableOutcome.FAILED) {
            val sessionId = extension.string("session_id") ?: currentSessionId() ?: conversationId()
            eventHub.upsertMessage(
                sessionId,
                ClientMessage(
                    eventId = event.eventId,
                    sender = trust?.gatewayId ?: "gateway",
                    timestamp = event.timestamp,
                    encrypted = true,
                    kind = ClientMessageKind.ERROR,
                    format = ClientMessageFormat.PLAIN,
                    text = errorText ?: "The Gateway could not complete the command.",
                    sessionId = sessionId,
                    commandId = commandId,
                    revision = revision,
                    semantic = extension,
                ),
                refreshedSnapshot(),
            )
        }
    }

    private suspend fun resumePendingSafeRevisionConflict() {
        val pending = outbox.list()
            .asSequence()
            .filter { it.state == DurableState.NEEDS_REVIEW }
            .sortedBy { it.sequence }
            .firstOrNull { shouldAutomaticallyRetryRevisionConflict(outbox.operation(it.commandId)) }
            ?: return
        retrySafeRevisionConflict(pending.commandId, "startup")
    }

    private suspend fun retrySafeRevisionConflict(commandId: String, stage: String): Boolean {
        val current = outbox.get(commandId) ?: return false
        val operation = outbox.operation(commandId)
        if (!shouldAutomaticallyRetryRevisionConflict(operation)) return false
        val completedAttempts = automaticRevisionRetryAttempts[current.operationId] ?: 0
        if (completedAttempts >= MAX_AUTOMATIC_REVISION_RETRIES) {
            diagnostics.record(
                "command.revision_retry.exhausted",
                mapOf("action" to (operation?.wireName ?: "unknown")),
            )
            return false
        }
        automaticRevisionRetryAttempts[current.operationId] = completedAttempts + 1
        val receipt = outbox.resolveRevisionConflict(commandId, RevisionConflictAction.RETRY)
        val rebased = outbox.get(receipt.commandId) ?: error("Rebased command disappeared.")
        diagnostics.record(
            "command.revision_retry.automatic",
            mapOf(
                "action" to (operation?.wireName ?: "unknown"),
                "stage" to stage,
                "attempt" to (completedAttempts + 1).toString(),
            ),
        )
        publishCommand(rebased)
        launchCommandTransmission(rebased.commandId, recovery = false)
        return true
    }

    private fun parseMessage(
        event: MatrixDecryptedEvent,
        content: JsonObject,
        historical: Boolean = false,
    ): ClientMessage? {
        val replacement = content["m.new_content"] as? JsonObject
        val effective = replacement ?: content
        val extension = effective["io.codever"] as? JsonObject ?: return null
        val kind = extension.string("kind") ?: return null
        val logicalEventId = extension.string("logical_event_id") ?: event.eventId
        val sessionId = extension.string("session_id")
        val revision = extension.long("revision")
        val base = ClientMessage(
            eventId = logicalEventId,
            sender = trust?.gatewayId ?: event.sender,
            timestamp = event.timestamp,
            encrypted = true,
            kind = ClientMessageKind.NOTICE,
            format = ClientMessageFormat.PLAIN,
            sessionId = sessionId,
            historical = historical.takeIf { it },
            operationId = extension.string("operation_id"),
            replacesEventId = extension.string("replaces_logical_event_id"),
            revision = revision,
            activeDeviceCount = extension.int("active_device_count"),
            attachments = (extension["attachments"] as? JsonArray)?.mapNotNull { candidate ->
                runCatching { PublicClientJson.decodeAttachment(candidate) }.getOrNull()
            }?.takeIf(List<*>::isNotEmpty),
            semantic = extension,
        )
        return when (kind) {
            "collaboration_command" -> {
                if (extension.string("operation") != "prompt") return null
                base.copy(
                    kind = ClientMessageKind.USER,
                    text = extension.string("text") ?: "",
                    commandId = extension.string("command_id"),
                    originDeviceId = extension.string("origin_device_id"),
                    originDeviceName = extension.string("origin_device_name"),
                )
            }
            "message" -> base.copy(
                kind = ClientMessageKind.AGENT,
                text = effective.string("body") ?: "",
                format = when (extension.string("format")) {
                    "markdown" -> ClientMessageFormat.MARKDOWN
                    "html" -> ClientMessageFormat.HTML
                    else -> ClientMessageFormat.PLAIN
                },
            )
            "decision_request" -> base.copy(
                kind = ClientMessageKind.PERMISSION,
                text = extension.string("title") ?: effective.string("body") ?: "Permission required",
                requestId = extension.string("decision_id"),
            )
            "status" -> base.copy(
                text = effective.string("body") ?: "Gateway status updated.",
            )
            "signed_event" -> {
                val signed = extension["signed_event"] as? JsonObject ?: return null
                val signedEvent = signed["event"] as? JsonObject ?: return null
                val payload = signedEvent["payload"] as? JsonObject ?: return null
                when (payload.string("type")) {
                    "agent.text.delta", "agent.text.completed" -> base.copy(
                        kind = ClientMessageKind.AGENT,
                        format = ClientMessageFormat.MARKDOWN,
                        text = payload.string("text") ?: "",
                        streamId = payload.string("streamId"),
                        semantic = payload,
                    )
                    "agent.permission.requested" -> base.copy(
                        kind = ClientMessageKind.PERMISSION,
                        text = payload.string("title") ?: "Permission required",
                        requestId = payload.string("requestId"),
                        semantic = payload,
                    )
                    "agent.error" -> base.copy(
                        kind = ClientMessageKind.ERROR,
                        text = payload.string("message") ?: "The agent reported an error.",
                        semantic = payload,
                    )
                    "agent.tool.started", "agent.tool.completed" -> base.copy(
                        kind = ClientMessageKind.TOOL,
                        text = payload.string("name") ?: "Agent tool",
                        toolCallId = payload.string("toolCallId"),
                        semantic = payload,
                    )
                    else -> base.copy(
                        text = payload.string("type") ?: "Codever event",
                        semantic = payload,
                    )
                }
            }
            else -> null
        }
    }

    private fun incomingBindings(activeTrust: GatewayTrust) = SecureEnvelopeBindings(
        gatewayId = activeTrust.gatewayId,
        conversationId = conversationId(),
        direction = SecureEnvelopeDirection.GATEWAY_TO_DEVICE,
        senderDeviceId = activeTrust.certificate.gatewayId,
        recipientDeviceId = activeTrust.certificate.deviceId,
        senderKeyId = activeTrust.gatewayKey.keyId,
        recipientKeyId = deviceId,
    )

    private fun pairingRequestContent(request: SignedPairingRequest): JsonObject = buildJsonObject {
        put("msgtype", "m.notice")
        put("body", "Codever pairing request")
        put("io.codever", buildJsonObject {
            put("version", 1)
            put("kind", "pairing_request")
            put("pairing_request", request.toJson())
        })
    }

    private fun assertOfferRoute(offer: SignedPairingOffer) {
        val session = matrix.publicSession()
            ?: throw IllegalStateException("A native Matrix session is required before pairing.")
        val binding = session.roomBinding
        val route = offer.offer.gatewayTransport
        require(offer.offer.gatewayId == binding.gatewayId)
        require(MatrixIdentifiers.normalizeHomeserver(route.homeserver) ==
            MatrixIdentifiers.normalizeHomeserver(session.homeserver))
        require(route.roomId == binding.roomId)
        require(route.userId == binding.gatewayUserId)
        require(route.deviceId == binding.gatewayDeviceId)
        require(route.ed25519 == binding.gatewayDeviceEd25519)
    }

    private fun verificationCode(offer: SignedPairingOffer): String {
        val digest = CodeverCrypto.sha256(CanonicalJson.bytes(buildJsonObject {
            put("offerId", offer.offer.offerId)
            put("challenge", offer.offer.challenge)
            put("gatewayKeyId", offer.offer.gatewayKey.keyId)
        }))
        val number = (((digest[0].toInt() and 0xff) shl 16) or
            ((digest[1].toInt() and 0xff) shl 8) or
            (digest[2].toInt() and 0xff)) % 1_000_000
        return number.toString().padStart(6, '0').let { "${it.take(3)} ${it.drop(3)}" }
    }

    private fun refreshSnapshot(publishLifecycle: Boolean) {
        val next = refreshedSnapshot()
        eventHub.updateSnapshot(next)
        val lifecycle = next.lifecycle.phase to next.lifecycle.detailCode
        if (publishLifecycle && lifecycle != lastLifecycle) {
            lastLifecycle = lifecycle
            publishStatus(lifecycle.first, lifecycle.second)
        }
    }

    private fun refreshedSnapshot(): ClientSnapshot {
        val previous = runCatching { eventHub.snapshot() }.getOrNull()
        val (active, notificationVisible) = foregroundState()
        val lifecycle = lifecycle()
        return ClientSnapshot(
            deviceId = deviceId,
            cursor = previous?.cursor ?: "initial",
            generatedAt = now(),
            lifecycle = lifecycle,
            foregroundService = ForegroundServiceState(
                active = active,
                notificationVisible = notificationVisible,
            ),
            trust = publicTrust(),
            gatewayState = gatewayState,
            commands = snapshotCommands(),
            pairing = pendingPairing?.offer?.let {
                buildJsonObject {
                    put("pairingId", it.offer.offerId)
                    put("expiresAt", it.offer.expiresAt)
                }
            },
        )
    }

    private fun initialSnapshot(): ClientSnapshot {
        val (active, visible) = foregroundState()
        return ClientSnapshot(
            deviceId = deviceId,
            cursor = "initial",
            generatedAt = now(),
            lifecycle = lifecycle(),
            foregroundService = ForegroundServiceState(active = active, notificationVisible = visible),
            trust = publicTrust(),
            commands = snapshotCommands(),
        )
    }

    private fun snapshotCommands(): List<CommandView> =
        compactSnapshotCommands(outbox.list().map(::publicCommand))

    private fun lifecycle(): ClientLifecycle {
        val status = matrix.status
        if (trustStorageBlocked) {
            return ClientLifecycle(
                LifecyclePhase.BLOCKED,
                status.since,
                "gateway_trust_unreadable",
            )
        }
        val activeTrust = trust
        val phase = when {
            status.phase == MatrixRuntimePhase.STOPPED -> LifecyclePhase.STOPPED
            status.phase == MatrixRuntimePhase.WAITING_FOR_SESSION -> LifecyclePhase.UNPAIRED
            status.phase == MatrixRuntimePhase.BOOTSTRAPPING -> LifecyclePhase.STARTING
            status.phase == MatrixRuntimePhase.RESTORING -> LifecyclePhase.SECURING
            status.phase == MatrixRuntimePhase.CONNECTING -> LifecyclePhase.CONNECTING
            status.phase == MatrixRuntimePhase.OFFLINE -> LifecyclePhase.OFFLINE
            status.phase == MatrixRuntimePhase.RETRY_WAIT -> LifecyclePhase.RECONNECTING
            status.phase == MatrixRuntimePhase.BLOCKED -> LifecyclePhase.BLOCKED
            activeTrust == null -> LifecyclePhase.UNPAIRED
            else -> LifecyclePhase.READY
        }
        return ClientLifecycle(phase, status.since, status.detailCode)
    }

    private fun publishStatus(phase: LifecyclePhase, detail: String?) {
        eventHub.publish(
            ClientEventType.STATUS_CHANGED,
            buildJsonObject {
                put("phase", phase.wireValue)
                detail?.let { put("detail", it) }
            },
            refreshedSnapshot(),
        )
    }

    private fun publishCommand(command: DurableView) {
        val public = publicCommand(command)
        eventHub.publish(
            ClientEventType.COMMAND_CHANGED,
            PublicClientJson.encodeCommand(public),
            refreshedSnapshot(),
        )
    }

    private fun publicTrust(): PublicTrustState {
        if (trustStorageBlocked) return PublicTrustState.Blocked("gateway_trust_unreadable")
        pendingPairing?.let {
            return PublicTrustState.Pairing(it.offer.offer.offerId, it.offer.offer.expiresAt)
        }
        val active = trust ?: return PublicTrustState.Unpaired
        return PublicTrustState.Trusted(
            gatewayId = active.gatewayId,
            gatewayName = active.offer.offer.gatewayName,
            certificateId = active.certificate.certificateId,
            pairedAt = active.certificate.issuedAt,
            activeDeviceCount = active.response.response.activeDeviceCount,
        )
    }

    private fun publicCommand(value: DurableView) = CommandView(
        operationId = value.operationId,
        commandId = value.commandId,
        idempotencyKey = value.idempotencyKey,
        state = CommandState.valueOf(value.state.name),
        submittedAt = value.submittedAt,
        updatedAt = value.updatedAt,
        sessionId = value.sessionId,
        sequence = value.sequence,
        revision = value.revision,
        cancelRequested = value.cancelRequested.takeIf { it },
        completion = value.completion?.let { completion ->
            CommandCompletion(
                commandId = completion.commandId,
                sequence = completion.sequence,
                revision = completion.revision,
                outcome = CommandOutcome.valueOf(completion.outcome.name),
                sessionId = completion.sessionId,
                result = completion.result,
                error = completion.error?.let {
                    PublicCommandError(it.code, it.message, it.retryable)
                },
            )
        },
    )

    private fun publicReceipt(value: DurableView) = DurableReceipt(
        operationId = value.operationId,
        commandId = value.commandId,
        idempotencyKey = value.idempotencyKey,
        state = value.state,
        submittedAt = value.submittedAt,
        updatedAt = value.updatedAt,
        sessionId = value.sessionId,
        sequence = value.sequence,
        revision = value.revision,
    )

    private fun NativePairingPreview.toJson(): JsonObject = buildJsonObject {
        put("pairingId", pairingId)
        put("gatewayId", gatewayId)
        put("gatewayName", gatewayName)
        put("verificationCode", verificationCode)
        put("expiresAt", expiresAt)
        put("requiresNativeConfirmation", true)
    }

    private fun conversationId(): String = matrix.publicSession()?.roomBinding?.conversationId
        ?: throw IllegalStateException("Matrix room binding is unavailable.")

    private fun currentSessionId(): String? = gatewayState?.string("current_session_id")

    private fun randomNonce(): String = Base64Url.encode(ByteArray(24).also(SecureRandom()::nextBytes))

    private fun JsonObject.string(key: String): String? = get(key)?.let { value ->
        runCatching { value.jsonPrimitive.takeIf { it.isString }?.contentOrNull }.getOrNull()
    }

    private fun JsonObject.long(key: String): Long? = get(key)?.jsonPrimitive?.longOrNull
    private fun JsonObject.int(key: String): Int? = get(key)?.jsonPrimitive?.intOrNull
    private fun JsonObject.objectValue(key: String): JsonObject = get(key) as? JsonObject
        ?: throw IllegalArgumentException("$key must be an object.")

    private companion object {
        const val PAIRING_REQUEST_MS = 2 * 60_000L
        const val PAIRING_RESPONSE_TIMEOUT_MS = 60_000L
        const val GATEWAY_TRANSPORT_PROFILE_FIELD = "io.codever.gateway_transport"
        const val COMMAND_LIFETIME_MS = 5 * 60_000L
        const val COMMAND_ACK_TIMEOUT_MS = 30_000L
        const val MAX_AUTOMATIC_REVISION_RETRIES = 3
        const val MAX_NATIVE_TIMELINE_BACKFILL_PAGES = 100
    }
}

internal fun shouldAutomaticallyRetryRevisionConflict(operation: CommandOperation?): Boolean =
    when (operation) {
        CommandOperation.SESSION_CREATE,
        CommandOperation.SESSION_ARCHIVE,
        CommandOperation.SESSION_RESTORE,
        CommandOperation.SESSION_DELETE,
        -> true
        else -> false
    }

internal fun gatewayStateRetryDelayMs(completedAttempts: Int): Long {
    require(completedAttempts >= 0)
    return when (completedAttempts) {
        0 -> 5_000L
        1 -> 15_000L
        2 -> 30_000L
        else -> 60_000L
    }
}

internal fun commandRecoveryDelayMs(completedAttempts: Int): Long {
    require(completedAttempts >= 0)
    return when (completedAttempts) {
        0 -> 5_000L
        1 -> 15_000L
        2 -> 30_000L
        else -> 60_000L
    }
}

internal fun recoverableCommandIds(commands: List<DurableView>): List<String> =
    commands
        .asSequence()
        .filter { it.state == DurableState.RECOVERY_REQUIRED }
        .sortedBy(DurableView::sequence)
        .map(DurableView::commandId)
        .toList()

internal data class MatrixTimelineBackfillResult(
    val pages: Int,
    val reachedStart: Boolean,
)

internal fun matrixRoomHistoryHasMore(reachedStart: Boolean): Boolean = !reachedStart

internal suspend fun paginateMatrixTimelineToStart(
    maxPages: Int,
    paginate: suspend () -> Boolean,
): MatrixTimelineBackfillResult {
    require(maxPages > 0)
    repeat(maxPages) { index ->
        if (paginate()) {
            return MatrixTimelineBackfillResult(pages = index + 1, reachedStart = true)
        }
    }
    return MatrixTimelineBackfillResult(pages = maxPages, reachedStart = false)
}
