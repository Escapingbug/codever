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
import id.my.anciety.codever.client.events.ToolGroupPresentation
import id.my.anciety.codever.client.events.compactSnapshotCommands
import id.my.anciety.codever.diagnostics.NativeDiagnosticLog
import id.my.anciety.codever.matrix.MatrixBootstrap
import id.my.anciety.codever.matrix.CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE
import id.my.anciety.codever.matrix.CODEVER_MATRIX_SESSION_STATE_EVENT_TYPE
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
import id.my.anciety.codever.security.codever.MatrixStateBindings
import id.my.anciety.codever.security.codever.MatrixStateEnvelopeCodec
import id.my.anciety.codever.security.codever.MatrixStateEnvelopes
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
import id.my.anciety.codever.security.codever.ReplayStore
import id.my.anciety.codever.security.codever.SignedPairingOffer
import id.my.anciety.codever.security.codever.SignedPairingRequest
import id.my.anciety.codever.security.codever.SignedPairingResponse
import java.security.SecureRandom
import java.util.ArrayDeque
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

class NativePairingRejectedException(
    message: String,
    val retryable: Boolean = true,
) : IllegalStateException(message)
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
        var receivedResponse: SignedPairingResponse? = null,
        var response: CompletableDeferred<SignedPairingResponse>? = null,
        val repairingSession: Boolean = false,
    )

    private data class ActivePairingCompletion(
        val pairingId: String,
        val result: CompletableDeferred<Pair<PublicTrustState.Trusted, ClientSnapshot>>,
        val job: Job,
    )

    val deviceId: String = identity.publicIdentity.keyId
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mutex = Mutex()
    private val historyMutex = Mutex()
    private val diagnostics = NativeDiagnosticLog.get(context)
    private val files = NativeRuntimeFiles(context, deviceId)
    private val replayStore = AtomicEncryptedReplayStore(files.replay, cipher, deviceId)
    private val pairingStore = AtomicEncryptedPairingTransactionStore(
        files.pairing,
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
    private val outbox = DurableCommandOutbox.encrypted(files.commands, cipher, deviceId) { migration ->
        diagnostics.record(
            "command.outbox.migrated",
            mapOf(
                "schema" to migration.fromSchemaVersion.toString(),
                "quarantined" to migration.quarantinedCommandCount.toString(),
            ),
        )
    }
    private val transfers = AttachmentTransferManager(files.transfers, matrix, cipher, now)
    private val ackTimeouts = ConcurrentHashMap<String, Job>()
    private val commandRecoveryJobs = ConcurrentHashMap<String, Job>()
    private val commandRecoveryAttempts = ConcurrentHashMap<String, Int>()
    private val automaticRevisionRetryAttempts = ConcurrentHashMap<String, Int>()
    private val json = Json { isLenient = false; allowSpecialFloatingPointValues = false }
    private val nativeProjection = MatrixNativeProjection()
    private val restoredTrust = runCatching { trustStore.load() }
    private val restoredPairing: Result<PersistedPairingTransaction?> = runCatching {
        pairingStore.load()?.let(::validateRestoredPairingTransaction)?.let transaction@{ transaction ->
            restoredTrust.getOrNull()?.let { activeTrust ->
                if (
                    transaction.response?.response?.certificate?.certificate?.certificateId ==
                    activeTrust.certificate.certificateId
                ) {
                    pairingStore.clear()
                    diagnostics.record("pairing.transaction.stale_cleanup")
                    return@transaction null
                }
                MatrixSessionRepairPolicy.requirePinnedOffer(activeTrust, transaction.offer)
            }
            transaction
        }
    }
    @Volatile private var transportIdentity: MatrixTransportIdentity? = null
    @Volatile private var trust: GatewayTrust? = restoredTrust.getOrNull()
    @Volatile private var trustStorageBlocked = restoredTrust.isFailure
    @Volatile private var pairingStorageBlocked = restoredPairing.isFailure
    @Volatile private var gatewayState: JsonObject? = null
    @Volatile private var gatewayStateSynchronized = false
    @Volatile private var authoritativeStateRefreshJob: Job? = null
    @Volatile private var gatewayConvergenceFallbackJob: Job? = null
    @Volatile private var gatewayConvergenceMinimumRevision: Long? = null
    @Volatile private var pendingPairing: PendingPairing? = restoredPairing.getOrNull()?.let {
        PendingPairing(
            it.offer,
            it.request,
            it.response,
            repairingSession = restoredTrust.getOrNull() != null,
        )
    }
    @Volatile private var activePairingCompletion: ActivePairingCompletion? = null
    @Volatile private var pairingAutoResumeJob: Job? = null
    private val preTrustEvents = ArrayDeque<MatrixDecryptedEvent>()
    private val initializedHistoryRelations = mutableSetOf<String>()
    private val historyRelationTokens = mutableMapOf<String, String>()
    @Volatile private var lastLifecycle: Pair<LifecyclePhase, String?>? = null

    private val eventHub = ClientEventHub(
        EncryptedAtomicClientEventPersistence(files.events, cipher, deviceId),
        initialSnapshot(),
        // Matrix and the per-session history cache remain authoritative. This
        // window only bridges short WebView detach/reattach gaps.
        maxReplayEvents = BRIDGE_REPLAY_EVENT_LIMIT,
    )

    init {
        gatewayState = eventHub.snapshot().gatewayState
        if (gatewayState != null) {
            diagnostics.record("gateway.state.cache.restored")
        }
        matrix.setObserver(this)
        refreshSnapshot(publishLifecycle = false)
        scope.launch {
            while (isActive) {
                delay(1_000)
                runCatching {
                    mutex.withLock {
                        expirePendingPairingIfNeeded()
                        refreshSnapshot(publishLifecycle = true)
                    }
                }
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
        return try {
            historyMutex.withLock {
                diagnostics.record("history.page.requested")
                val online = matrix.status.phase == MatrixRuntimePhase.SYNCING
                val initialized = sessionId in initializedHistoryRelations
                val externalHasMore = online && (
                    !initialized || historyRelationTokens.containsKey(sessionId)
                )
                var local = eventHub.historyPage(
                    sessionId,
                    before,
                    limit,
                    externalHasMore = externalHasMore,
                )
                val needsRecentReconciliation = before == null
                val needsOlderPage = before != null && local.messages.isEmpty() && externalHasMore
                if (!online || (!needsRecentReconciliation && !needsOlderPage)) {
                    diagnostics.record("history.page.local")
                    return@withLock local
                }

                val threadRoot = nativeProjection.threadRootEventId(sessionId)
                    ?: throw IllegalArgumentException("The session has no Matrix thread root.")
                var from = if (needsOlderPage) historyRelationTokens[sessionId] else null
                var imported = 0
                val visitedTokens = mutableSetOf<String?>()
                repeat(MAX_HISTORY_RELATION_PAGES_PER_REQUEST) {
                    check(visitedTokens.add(from)) {
                        "Matrix thread history repeated a pagination token."
                    }
                    val remote = matrix.loadThreadHistory(threadRoot, from, maxOf(30, limit))
                    val historicalMessages = mutableListOf<ClientMessage>()
                    mutex.withLock {
                        for (event in remote.events) {
                            decodeHistoricalMessage(event, sessionId)?.let(historicalMessages::add)
                        }
                        eventHub.upsertMessages(
                            sessionId,
                            historicalMessages,
                            refreshedSnapshot(),
                        )
                    }
                    imported += historicalMessages.size
                    initializedHistoryRelations += sessionId
                    if (!initialized || needsOlderPage) {
                        if (remote.nextBatch == null) historyRelationTokens.remove(sessionId)
                        else historyRelationTokens[sessionId] = remote.nextBatch
                    }
                    local = eventHub.historyPage(
                        sessionId,
                        before,
                        limit,
                        externalHasMore = online && historyRelationTokens.containsKey(sessionId),
                    )
                    if (local.messages.isNotEmpty() || remote.nextBatch == null) {
                        diagnostics.record(
                            "history.page.completed",
                            mapOf("received" to imported.toString()),
                        )
                        return@withLock local
                    }
                    from = remote.nextBatch
                }
                throw IllegalStateException(
                    "Matrix thread history exceeded the bounded pagination window.",
                )
            }
        } catch (error: TimeoutCancellationException) {
            diagnostics.record(
                "history.page.failed",
                mapOf(
                    "type" to error::class.java.simpleName,
                ),
            )
            throw error
        } catch (error: CancellationException) {
            diagnostics.record("history.page.cancelled")
            throw error
        } catch (error: Exception) {
            diagnostics.record(
                "history.page.failed",
                mapOf(
                    "type" to error::class.java.simpleName,
                ),
            )
            throw error
        }
    }

    suspend fun inspectPairing(link: String): NativePairingPreview = mutex.withLock {
        val offer = PairingCodec.decodePairingLink(link)
        PairingSecurity.verifyOffer(offer, now = now())
        assertOfferRoute(offer)
        val activeTrust = trust
        val repairingSession = activeTrust != null
        if (activeTrust != null) {
            check(MatrixSessionRepairPolicy.required(activeTrust, matrix.publicSession())) {
                "Disconnect the current Gateway before pairing another one."
            }
            MatrixSessionRepairPolicy.requirePinnedOffer(activeTrust, offer)
        }
        pendingPairing?.let { current ->
            if (current.offer == offer) {
                pairingStorageBlocked = false
                return@withLock previewFor(current.offer)
            }
            check(current.request == null) {
                "Finish or cancel the confirmed pairing transaction before scanning another invitation."
            }
        }
        pairingStore.save(PersistedPairingTransaction(offer, null, null))
        clearPreTrustEvents()
        pendingPairing = PendingPairing(offer, repairingSession = repairingSession)
        pairingStorageBlocked = false
        val preview = NativePairingPreview(
            pairingId = offer.offer.offerId,
            gatewayId = offer.offer.gatewayId,
            gatewayName = offer.offer.gatewayName,
            verificationCode = verificationCode(offer),
            expiresAt = offer.offer.expiresAt,
        )
        eventHub.publish(ClientEventType.PAIRING_CHANGED, preview.toJson(), refreshedSnapshot())
        preview
    }

    suspend fun pairingConfirmation(pairingId: String): Pair<NativePairingPreview, Boolean>? =
        mutex.withLock {
            pendingPairing
                ?.takeIf { it.offer.offer.offerId == pairingId }
                ?.let { previewFor(it.offer) to (it.request != null) }
        }

    suspend fun completePairing(
        pairingId: String,
        deviceName: String,
    ): Pair<PublicTrustState.Trusted, ClientSnapshot> {
        diagnostics.record("pairing.transaction.completion_requested")
        val result = mutex.withLock {
            val pending = pendingPairing?.takeIf { it.offer.offer.offerId == pairingId }
                ?: throw IllegalArgumentException("The pairing preview is no longer available.")
            activePairingCompletion?.let { active ->
                check(active.pairingId == pairingId) {
                    "Another pairing transaction is already active."
                }
                return@withLock active.result
            }
            val deferred = CompletableDeferred<Pair<PublicTrustState.Trusted, ClientSnapshot>>()
            val job = scope.launch {
                try {
                    deferred.complete(executePairing(pending, deviceName))
                } catch (error: CancellationException) {
                    deferred.cancel(error)
                    throw error
                } catch (error: Exception) {
                    if (error is NativePairingRejectedException && !error.retryable) {
                        abandonPairing(pending, error.message ?: "Pairing was rejected.")
                    }
                    deferred.completeExceptionally(error)
                } finally {
                    mutex.withLock {
                        if (activePairingCompletion?.result === deferred) {
                            activePairingCompletion = null
                        }
                    }
                    if (
                        (trust == null || pending.repairingSession) &&
                        pendingPairing === pending &&
                        pending.request != null
                    ) {
                        pairingAutoResumeJob?.cancel()
                        pairingAutoResumeJob = scope.launch {
                            delay(PAIRING_AUTO_RESUME_DELAY_MS)
                            pairingAutoResumeJob = null
                            resumeConfirmedPairing()
                        }
                    }
                }
            }
            activePairingCompletion = ActivePairingCompletion(pairingId, deferred, job)
            deferred
        }
        return result.await()
    }

    private suspend fun executePairing(
        expectedPending: PendingPairing,
        deviceName: String,
    ): Pair<PublicTrustState.Trusted, ClientSnapshot> {
        val (pending, signedRequest, response) = mutex.withLock {
            val pending = pendingPairing?.takeIf { it === expectedPending }
                ?: throw IllegalStateException("The pairing transaction is no longer active.")
            val existingRequest = pending.request
            if (existingRequest == null) {
                check(now() < pending.offer.offer.expiresAt) { "The pairing offer has expired." }
            } else {
                check(now() < pairingTransactionExpiresAt(pending)) {
                    "The approved pairing recovery window expired. Scan a new invitation."
                }
            }
            val session = matrix.publicSession()
                ?: throw IllegalStateException("A native Matrix session is required before pairing.")
            val transport = transportIdentity
                ?: throw IllegalStateException("Matrix encryption keys are not ready yet.")
            assertOfferRoute(pending.offer)
            trust?.takeIf { pending.repairingSession }?.let { activeTrust ->
                MatrixSessionRepairPolicy.requirePinnedOffer(activeTrust, pending.offer)
                MatrixSessionRepairPolicy.requireReplacement(
                    activeTrust,
                    MatrixTransportBinding(
                        homeserver = session.homeserver,
                        roomId = session.roomBinding.roomId,
                        userId = session.userId,
                        deviceId = transport.deviceId,
                        ed25519 = transport.ed25519,
                    ),
                )
            }
            val signedRequest = existingRequest ?: run {
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
                PairingSecurity.signRequest(request, pending.offer, identity)
            }
            assertPairingRequestRoute(pending.offer, signedRequest, session, transport)
            pairingStore.save(PersistedPairingTransaction(
                pending.offer,
                signedRequest,
                pending.receivedResponse,
            ))
            diagnostics.record("pairing.transaction.request_persisted")
            val response = CompletableDeferred<SignedPairingResponse>()
            pending.request = signedRequest
            pending.response = response
            pending.receivedResponse?.let(response::complete)
            Triple(pending, signedRequest, response)
        }
        // Matrix I/O never runs under the domain-state mutex. A slow homeserver
        // must not starve pairing cancellation, process-death persistence, or
        // unrelated command recovery.
        if (response.isActive) {
            try {
                matrix.sendPairingMessage(pairingRequestContent(signedRequest).toString())
            } catch (error: Exception) {
                runCatching { matrix.closePairingChannel() }
                    .onFailure { closeError ->
                        diagnostics.record(
                            "matrix.pairing_channel.close_failure",
                            mapOf("error" to diagnosticErrorName(closeError)),
                        )
                    }
                throw error
            }
        }
        // A Gateway persists approval before provisioning current Room State.
        // If that publication or its response is interrupted, resending the
        // exact signed request resumes the same transaction without creating a
        // second identity, certificate, or approval.
        val retryJob = scope.launch {
            var completedRetries = 0
            while (isActive && response.isActive) {
                delay(pairingRequestRetryDelayMs(completedRetries))
                if (!response.isActive) break
                runCatching {
                    matrix.sendPairingMessage(pairingRequestContent(signedRequest).toString())
                }.onSuccess {
                    diagnostics.record(
                        "matrix.pairing_request.retried",
                        mapOf("attempt" to completedRetries.toString()),
                    )
                }.onFailure { error ->
                    diagnostics.record(
                        "matrix.pairing_request.retry_failure",
                        mapOf("error" to diagnosticErrorName(error)),
                    )
                }
                completedRetries += 1
            }
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
            retryJob.cancel()
            mutex.withLock {
                if (pendingPairing === pending && pending.response === response) {
                    pending.response = null
                }
            }
            runCatching { matrix.closePairingChannel() }
                .onFailure { error ->
                    diagnostics.record(
                        "matrix.pairing_channel.close_failure",
                        mapOf("error" to diagnosticErrorName(error)),
                    )
                }
        }
        val public = mutex.withLock {
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
            gatewayStateSynchronized = false
            pendingPairing = null
            runCatching { pairingStore.clear() }
                .onFailure { error ->
                    // Trust is the authoritative commit. If the process stops
                    // here, startup ignores and retries deletion of the stale
                    // pre-trust transaction instead of rolling trust back.
                    diagnostics.record(
                        "pairing.transaction.cleanup_failure",
                        mapOf("error" to diagnosticErrorName(error)),
                    )
                }
            pairingStorageBlocked = false
            replayPreTrustEvents()
            val public = publicTrust() as PublicTrustState.Trusted
            val nextSnapshot = refreshedSnapshot()
            eventHub.publish(ClientEventType.TRUST_CHANGED, PublicClientJson.encodeTrust(public), nextSnapshot)
            public
        }
        // Pairing commits trust before state convergence. The Gateway publishes
        // a key bundle addressed to this device before acknowledging a new
        // pairing, but Matrix delivery and a retry of an already accepted
        // request may still race. Keep the service-owned connection converging
        // until one complete authenticated /state batch is committed; never
        // make the WebView stay foreground merely to wait for that round trip.
        startAuthoritativeStateRefresh(
            recoverTransport = false,
            invalidateCurrentState = false,
        )
        return mutex.withLock { public to snapshot() }
    }

    suspend fun cancelPairing(pairingId: String): Boolean = mutex.withLock {
        val pending = pendingPairing?.takeIf { it.offer.offer.offerId == pairingId } ?: return false
        pairingStore.clear()
        pending.response?.completeExceptionally(NativePairingRejectedException("Pairing was cancelled."))
        activePairingCompletion?.takeIf { it.pairingId == pairingId }?.job?.cancel()
        activePairingCompletion = null
        pairingAutoResumeJob?.cancel()
        pairingAutoResumeJob = null
        pendingPairing = null
        pairingStorageBlocked = false
        clearPreTrustEvents()
        eventHub.publish(
            ClientEventType.PAIRING_CHANGED,
            buildJsonObject { put("pairingId", pairingId); put("cancelled", true) },
            refreshedSnapshot(),
        )
        true
    }

    suspend fun sendCommand(idempotencyKey: String, payload: JsonObject): DurableReceipt =
        mutex.withLock {
            val activeTrust = trust
                ?: throw NativeTrustRequiredException("Pair the Gateway before sending commands.")
            check(
                gatewayState != null &&
                gatewayStateSynchronized &&
                matrix.commandTransportReady
            ) { "Gateway command transport is not synchronized yet." }
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
        authoritativeStateRefreshJob?.cancel()
        authoritativeStateRefreshJob = null
        cancelGatewayConvergenceFallback()
        gatewayStateSynchronized = false
        if (revoke) {
            trustStore.clear()
            replayStore.clear()
            timelineKeys.clear()
            pairingStore.clear()
            outbox.clear()
            transfers.clear()
            trust = null
            trustStorageBlocked = false
            pairingStorageBlocked = false
            gatewayState = null
            pendingPairing = null
            pairingAutoResumeJob?.cancel()
            pairingAutoResumeJob = null
            clearPreTrustEvents()
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
        authoritativeStateRefreshJob?.cancel()
        authoritativeStateRefreshJob = null
        cancelGatewayConvergenceFallback()
        transfers.clear()
        matrix.close()
        scope.cancel()
    }

    override fun onPairingTransportReady(identity: MatrixTransportIdentity) {
        transportIdentity = identity
        diagnostics.record("matrix.pairing_transport.ready")
        if (
            (trust == null || pendingPairing?.repairingSession == true) &&
            !pairingStorageBlocked &&
            pendingPairing?.request != null
        ) {
            resumeConfirmedPairing()
        }
    }

    override fun onTransportReady(identity: MatrixTransportIdentity) {
        transportIdentity = identity
        // Cached state is available for offline reading only. The transport is
        // writable only after a fresh complete Matrix Room State batch has
        // authenticated the current Gateway entity for this connection.
        gatewayStateSynchronized = false
        refreshSnapshot(publishLifecycle = true)
        if (trust != null) {
            startAuthoritativeStateRefresh(
                recoverTransport = true,
                invalidateCurrentState = false,
            )
        } else if (
            pendingPairing?.repairingSession == true &&
            !pairingStorageBlocked &&
            pendingPairing?.request != null
        ) {
            resumeConfirmedPairing()
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
        if (trust == null || authoritativeStateRefreshJob?.isActive == true) return
        startAuthoritativeStateRefresh(recoverTransport = false)
    }

    override suspend fun onDecryptedEvent(event: MatrixDecryptedEvent) {
        mutex.withLock {
            try {
                processMatrixEvent(event)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                diagnostics.record(
                    "matrix.native_event.rejected",
                    mapOf(
                        "error" to diagnosticErrorName(error),
                        "code" to if (error is CodeverSecurityException) {
                            error.code.name
                        } else {
                            "NONE"
                        },
                    ),
                )
                if (error !is CodeverSecurityException) {
                    publishStatus(lifecycle().phase, "native_event_rejected")
                    throw error
                }
            }
        }
    }

    override suspend fun onAuthoritativeRoomState(events: List<MatrixDecryptedEvent>) {
        mutex.withLock {
            try {
                val decoded = mutableListOf<JsonObject>()
                for (event in events) {
                    decodeMatrixRoomStateEvent(event)?.let(decoded::add)
                }
                val snapshot = nativeProjection.applyRoomStateBatch(decoded)
                decoded.forEach(::acceptCanonicalCommandCompletion)
                if (
                    snapshot != null &&
                    authoritativeRoomStateReady(decoded.mapNotNull { it.string("kind") })
                ) {
                    acceptGatewayState(snapshot, authoritative = true)
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                diagnostics.record(
                    "matrix.native_state_batch.rejected",
                    mapOf(
                        "error" to diagnosticErrorName(error),
                        "code" to if (error is CodeverSecurityException) {
                            error.code.name
                        } else {
                            "NONE"
                        },
                    ),
                )
                if (error !is CodeverSecurityException) {
                    publishStatus(lifecycle().phase, "native_state_batch_rejected")
                }
                throw error
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
                "codever.command.${transmission.commandId}.${randomNonce()}",
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
        // These fields define the durable command fingerprint and must never
        // change across recovery attempts. The outbox assigns issuedAt once,
        // before the first send can leave the device.
        val commandIssuedAt = transmission.issuedAt
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
            put("issuedAt", commandIssuedAt)
            put("expiresAt", commandIssuedAt + COMMAND_LIFETIME_MS)
            put("nonce", transmission.nonce)
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
        // Matrix redelivery is a new transport attempt around the exact same
        // authenticated command. A fresh outer envelope lets the Gateway open
        // the event and reach its durable command-result ledger even when the
        // homeserver no longer remembers the original transaction ID.
        val envelopeIssuedAt = now()
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
            envelopeId = "codever.${transmission.commandId}.${randomNonce()}",
            now = envelopeIssuedAt,
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

    private fun startAuthoritativeStateRefresh(
        recoverTransport: Boolean,
        invalidateCurrentState: Boolean = false,
    ) {
        if (invalidateCurrentState) {
            gatewayStateSynchronized = false
            refreshSnapshot(publishLifecycle = true)
        }
        authoritativeStateRefreshJob?.cancel()
        authoritativeStateRefreshJob = scope.launch {
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
            var completedAttempts = 0
            do {
                if (trust == null) break
                var attempted = false
                if (matrix.status.phase == MatrixRuntimePhase.SYNCING) {
                    attempted = true
                    runCatching { matrix.refreshApplicationRoomState() }
                        .onSuccess {
                            diagnostics.record("matrix.application_state.refresh_completed")
                        }
                        .onFailure { error ->
                            diagnostics.record(
                                "matrix.application_state.refresh_failure",
                                mapOf("error" to diagnosticErrorName(error)),
                            )
                        }
                }
                if (gatewayStateSynchronized || trust == null) break
                val delayMs = authoritativeStateRefreshDelayMs(completedAttempts)
                diagnostics.record(
                    "matrix.application_state.refresh_retry_scheduled",
                    mapOf(
                        "attempt" to completedAttempts.toString(),
                        "transport_ready" to attempted.toString(),
                    ),
                )
                completedAttempts += 1
                delay(delayMs)
            } while (isActive)
            if (gatewayStateSynchronized) {
                diagnostics.record("matrix.application_state.converged")
            }
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
        val eventType = root.string("type") ?: return
        if (
            eventType == CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE ||
            eventType == CODEVER_MATRIX_SESSION_STATE_EVENT_TYPE
        ) {
            val plaintext = decodeMatrixRoomState(event, root, content, eventType) ?: return
            acceptCanonicalCommandCompletion(plaintext)
            nativeProjection.applyRoomState(plaintext)?.let { acceptGatewayState(it) }
            return
        }
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
                NativePairingRejectedException(rejection.message, rejection.retryable),
            )
            return
        }
        val activeTrust = trust ?: run {
            val pending = pendingPairing
            if (pending != null && event.sender == pending.offer.offer.gatewayTransport.userId) {
                bufferPreTrustEvent(event)
            }
            return
        }
        if (kind == "gateway_device_rotation") {
            acceptGatewayDeviceRotation(event, extension)
            return
        }
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
                openTimelineContent(
                    event = event,
                    matrixContent = content,
                    extension = extension,
                    activeTrust = activeTrust,
                    keyGrantReplayStore = replayStore,
                ) ?: return
            }
            else -> return
        }
        val decryptedContent = plaintext as? JsonObject ?: return
        processAuthenticatedContent(event, decryptedContent)
    }

    private suspend fun decodeHistoricalMessage(
        event: MatrixDecryptedEvent,
        expectedSessionId: String,
    ): ClientMessage? {
        if (event.roomId != matrix.publicSession()?.roomBinding?.roomId) return null
        val root = json.parseToJsonElement(event.rawJson).jsonObject
        val content = root["content"] as? JsonObject ?: return null
        val eventType = root.string("type") ?: return null
        if (eventType != "m.room.message") return null
        val extension = content["io.codever"] as? JsonObject ?: return null
        if (extension.string("kind") != "timeline_envelope") return null
        val activeTrust = trust ?: return null
        if (event.sender != activeTrust.transportTrust.currentTransport.userId) return null
        val decryptedContent = openTimelineContent(
            event = event,
            matrixContent = content,
            extension = extension,
            activeTrust = activeTrust,
            keyGrantReplayStore = ReplayStore { _, _ -> true },
            expectedSessionId = expectedSessionId,
        ) ?: return null
        return parseMessage(event, decryptedContent, historical = true)
            ?.takeIf { it.sessionId == expectedSessionId }
    }

    private fun openTimelineContent(
        event: MatrixDecryptedEvent,
        matrixContent: JsonObject,
        extension: JsonObject,
        activeTrust: GatewayTrust,
        keyGrantReplayStore: ReplayStore,
        expectedSessionId: String? = null,
    ): JsonObject? {
        val signed = MatrixTimelineEnvelopeCodec.parse(
            extension.objectValue("timeline_envelope").toString(),
        )
        if (expectedSessionId != null && signed.envelope.sessionId != expectedSessionId) return null
        var key = timelineKeys.key(signed.envelope.epochId)
        if (key == null) {
            val keyBundleValue = extension["timeline_key_ring_bundle"] as? JsonObject ?: return null
            val keyBundle = SecureEnvelopeBundleCodec.parse(keyBundleValue.toString())
            if (keyBundle.bundle.recipients.none {
                    it.recipientDeviceId == deviceId && it.recipientKeyId == deviceId
                }
            ) return null
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
                keyGrantReplayStore,
                keyBundle.bundle.issuedAt,
            ).plaintext as? JsonObject ?: return null
            acceptTimelineKeyRingValue(grant)
            key = timelineKeys.key(signed.envelope.epochId) ?: return null
        }
        val plaintext = try {
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
        val decryptedContent = plaintext as? JsonObject ?: return null
        require(
            CanonicalJson.encode(matrixContent["m.relates_to"] ?: JsonNull) ==
                CanonicalJson.encode(decryptedContent["m.relates_to"] ?: JsonNull),
        ) { "The Matrix homeserver changed a signed timeline relation." }
        val decryptedExtension = decryptedContent["io.codever"] as? JsonObject ?: return null
        require(decryptedExtension.string("session_id") == signed.envelope.sessionId)
        val relation = decryptedContent["m.relates_to"] as? JsonObject
        val contentRoot = if (relation?.string("rel_type") == "m.thread") {
            relation.string("event_id")
        } else {
            decryptedExtension.string("thread_root_event_id")
        }
        require(contentRoot == signed.envelope.threadRootEventId)
        return decryptedContent
    }

    private suspend fun decodeMatrixRoomStateEvent(
        event: MatrixDecryptedEvent,
    ): JsonObject? {
        if (event.roomId != matrix.publicSession()?.roomBinding?.roomId) return null
        val root = json.parseToJsonElement(event.rawJson).jsonObject
        val content = root["content"] as? JsonObject ?: return null
        val eventType = root.string("type") ?: return null
        if (
            eventType != CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE &&
            eventType != CODEVER_MATRIX_SESSION_STATE_EVENT_TYPE
        ) return null
        return decodeMatrixRoomState(event, root, content, eventType)
    }

    private suspend fun decodeMatrixRoomState(
        event: MatrixDecryptedEvent,
        root: JsonObject,
        content: JsonObject,
        eventType: String,
    ): JsonObject? {
        val activeTrust = trust ?: run {
            val pending = pendingPairing
            if (pending != null && event.sender == pending.offer.offer.gatewayTransport.userId) {
                bufferPreTrustEvent(event)
            }
            return null
        }
        if (event.sender != activeTrust.transportTrust.currentTransport.userId) return null
        val stateKey = root.string("state_key")?.takeIf { it.isNotBlank() } ?: return null
        if (
            eventType == CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE &&
            stateKey != activeTrust.gatewayId
        ) return null
        require(content.long("version") == 2L && content.string("kind") == "state_envelope")
        val signed = MatrixStateEnvelopeCodec.parse(
            content.objectValue("state_envelope").toString(),
        )
        var key = timelineKeys.key(signed.envelope.epochId)
        if (key == null) {
            val keyBundleValue = content["timeline_key_ring_bundle"] as? JsonObject
                ?: return null
            val keyBundle = SecureEnvelopeBundleCodec.parse(keyBundleValue.toString())
            if (keyBundle.bundle.recipients.none {
                    it.recipientDeviceId == deviceId && it.recipientKeyId == deviceId
                }
            ) return null
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
                ReplayStore { _, _ -> true },
                keyBundle.bundle.issuedAt,
            ).plaintext as? JsonObject ?: return null
            acceptTimelineKeyRingValue(grant)
            key = timelineKeys.key(signed.envelope.epochId) ?: return null
        }
        val plaintext = try {
            MatrixStateEnvelopes.open(
                signed,
                key,
                activeTrust.gatewayKey,
                MatrixStateBindings(
                    gatewayId = activeTrust.gatewayId,
                    conversationId = conversationId(),
                    roomId = event.roomId,
                    eventType = eventType,
                    stateKey = stateKey,
                    epochId = signed.envelope.epochId,
                    stateVersion = signed.envelope.stateVersion,
                ),
            )
        } finally {
            key.fill(0)
        }
        require(plaintext.long("state_version") == signed.envelope.stateVersion)
        when (plaintext.string("kind")) {
            "gateway_state" -> require(
                eventType == CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE &&
                    plaintext.string("gateway_id") == stateKey,
            )
            "session_state" -> require(
                eventType == CODEVER_MATRIX_SESSION_STATE_EVENT_TYPE &&
                    plaintext.string("session_id") == stateKey,
            )
            else -> error("Unsupported Codever Matrix Room State payload.")
        }
        return plaintext
    }

    private fun acceptPairingResponse(event: MatrixDecryptedEvent, extension: JsonObject) {
        val pending = pendingPairing ?: return
        if (event.sender != pending.offer.offer.gatewayTransport.userId) return
        val request = pending.request ?: return
        val signed = PairingCodec.parseResponse(extension.objectValue("pairing_response").toString())
        if (signed.response.requestId != request.request.requestId) return
        PairingSecurity.verifyResponse(
            signed,
            pending.offer,
            request,
            pending.offer.offer.gatewayKey,
            now(),
        )
        pairingStore.save(PersistedPairingTransaction(pending.offer, request, signed))
        pending.receivedResponse = signed
        diagnostics.record("pairing.transaction.response_persisted")
        pending.response?.complete(signed)
    }

    private fun bufferPreTrustEvent(event: MatrixDecryptedEvent) {
        synchronized(preTrustEvents) {
            if (preTrustEvents.size >= MAX_PRE_TRUST_EVENTS) {
                preTrustEvents.removeFirst()
                diagnostics.record("matrix.pretrust_event.evicted")
            }
            preTrustEvents.addLast(event)
        }
    }

    private suspend fun replayPreTrustEvents() {
        val buffered = synchronized(preTrustEvents) {
            preTrustEvents.toList().also { preTrustEvents.clear() }
        }
        if (buffered.isEmpty()) return
        diagnostics.record(
            "matrix.pretrust_events.replaying",
            mapOf("count" to buffered.size.toString()),
        )
        buffered.forEach { event ->
            runCatching { processMatrixEvent(event) }
                .onFailure { error ->
                    diagnostics.record(
                        "matrix.pretrust_event.rejected",
                        mapOf("error" to diagnosticErrorName(error)),
                    )
                }
        }
    }

    private fun clearPreTrustEvents() {
        synchronized(preTrustEvents) { preTrustEvents.clear() }
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

    private suspend fun processAuthenticatedContent(
        event: MatrixDecryptedEvent,
        content: JsonObject,
    ) {
        val extension = content["io.codever"] as? JsonObject ?: return
        when (extension.string("kind")) {
            "timeline_key_ring_grant" -> acceptTimelineKeyRing(extension)
            "session_root", "session_update", "session_lifecycle", "gateway_revision" -> {
                val projectedState = nativeProjection.applyTimeline(extension)
                // Persist the command's terminal state before publishing the
                // corresponding inventory change. A process may be stopped as
                // soon as the UI observes that change.
                acceptCanonicalCommandCompletion(extension)
                projectedState?.let { acceptGatewayState(it) }
            }
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
            diagnostics.record("gateway.revision.current_state_required")
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
        if (changed) diagnostics.record("matrix.timeline_keys.updated")
    }

    private suspend fun acceptGatewayState(
        extension: JsonObject,
        authoritative: Boolean = false,
    ) {
        if (extension.toString().toByteArray(Charsets.UTF_8).size > MAX_BRIDGE_EVENT_PAYLOAD_BYTES) return
        val revision = extension.long("revision")?.takeIf { it >= 0 } ?: return
        val revisionEpoch = extension.string("revision_epoch") ?: return
        if (revisionEpoch.isBlank()) return
        val changed = gatewayState != extension
        gatewayState = extension
        if (authoritative) {
            outbox.updateKnownSequence(authoritativeDeviceSequence(extension))
        }
        outbox.updateKnownRevision(revision)
        if (authoritative) gatewayStateSynchronized = true
        val convergenceRevision = gatewayConvergenceMinimumRevision
        if (convergenceRevision != null && revision >= convergenceRevision) {
            cancelGatewayConvergenceFallback()
            diagnostics.record(
                "gateway.state.timeline_converged",
                mapOf("stage" to "native"),
            )
        }
        if (changed) {
            try {
                eventHub.publish(
                    ClientEventType.GATEWAY_STATE_CHANGED,
                    extension,
                    refreshedSnapshot(),
                )
            } catch (error: Exception) {
                gatewayStateSynchronized = false
                throw error
            }
        }
        diagnostics.record(
            if (changed) "gateway.room_state.accepted" else "gateway.room_state.duplicate",
        )
        resumePendingSafeRevisionConflict()
        schedulePendingCommandRecoveries(immediate = true)
        refreshSnapshot(publishLifecycle = true)
    }

    private fun authoritativeDeviceSequence(state: JsonObject): Long {
        val sequenceEpoch = trust?.certificate?.certificateId
            ?: throw NativeTrustRequiredException("Gateway trust is unavailable.")
        val entries = state["command_sequences"] as? JsonArray
            ?: throw IllegalArgumentException("Gateway command sequences are unavailable.")
        val matches = entries.mapNotNull { it as? JsonObject }.filter { entry ->
            entry.string("device_id") == deviceId &&
                entry.string("sequence_epoch") == sequenceEpoch
        }
        require(matches.size == 1) {
            "Gateway state does not contain exactly one command sequence for this device."
        }
        return matches.single().long("sequence")?.takeIf { it >= 0 }
            ?: throw IllegalArgumentException("Gateway command sequence is invalid.")
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
        recordCommandCompletion(
            completion,
            diagnosticEvent = "command.completion.received",
            scheduleConvergenceFallback = true,
        )
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

    /**
     * A signed Matrix-native state event is the authoritative result of a
     * desired-state session command. Complete the matching durable command as
     * soon as that state is visible instead of waiting for a later per-device
     * command_result copy from the homeserver.
     */
    private fun acceptCanonicalCommandCompletion(extension: JsonObject) {
        val commandId = extension.string("source_command_id") ?: return
        val command = outbox.get(commandId) ?: return
        val operation = outbox.operation(commandId) ?: return
        val kind = extension.string("kind") ?: return
        val state = extension.string("state")
        if (!canonicalStateCompletesCommand(operation, kind, state)) return
        val revision = extension.long("revision")?.takeIf { it >= 0 } ?: return
        val eventSessionId = extension.string("session_id") ?: return
        if (command.sessionId != null && command.sessionId != eventSessionId) return
        recordCommandCompletion(
            DurableCompletion(
                commandId = commandId,
                sequence = command.sequence,
                revision = revision,
                outcome = DurableOutcome.SUCCEEDED,
                sessionId = eventSessionId,
            ),
            diagnosticEvent = "command.completion.inferred",
            scheduleConvergenceFallback = false,
        )
    }

    private fun recordCommandCompletion(
        completion: DurableCompletion,
        diagnosticEvent: String,
        scheduleConvergenceFallback: Boolean,
    ) {
        // Capture metadata before publishing the terminal event. A Web client
        // may synchronously consume it and release the durable command.
        val operation = outbox.operation(completion.commandId)
        val operationId = outbox.get(completion.commandId)?.operationId
        val recorded = outbox.recordCompletion(completion)
        diagnostics.record(
            diagnosticEvent,
            mapOf(
                "available" to recorded.toString(),
                "action" to (operation?.wireName ?: "unavailable"),
                "stage" to completion.outcome.wireName,
            ),
        )
        if (!recorded) return
        ackTimeouts.remove(completion.commandId)?.cancel()
        cancelScheduledCommandRecovery(completion.commandId)
        operationId?.let(automaticRevisionRetryAttempts::remove)
        outbox.get(completion.commandId)?.let(::publishCommand)
        runCatching {
            operation?.let { completedOperation ->
                if (scheduleConvergenceFallback) {
                    scheduleGatewayConvergenceFallback(
                        completion.revision,
                        completedOperation,
                    )
                }
                onCommandCompletion(completedOperation, completion)
            }
        }.onFailure { error ->
            diagnostics.record(
                "command.completion.callback_failed",
                mapOf("error" to error.javaClass.simpleName.take(160)),
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
            "message" -> {
                val toolGroup = decodeMatrixToolGroup(extension)
                if (extension["ui"] != null && toolGroup == null) return null
                base.copy(
                    kind = if (toolGroup == null) ClientMessageKind.AGENT else ClientMessageKind.TOOL,
                    text = effective.string("body") ?: "",
                    format = when (extension.string("format")) {
                        "markdown" -> ClientMessageFormat.MARKDOWN
                        "html" -> ClientMessageFormat.HTML
                        else -> ClientMessageFormat.PLAIN
                    },
                    toolGroup = toolGroup,
                )
            }
            "decision_request" -> base.copy(
                kind = ClientMessageKind.PERMISSION,
                text = extension.string("title") ?: effective.string("body") ?: "Permission required",
                requestId = extension.string("decision_id"),
            )
            "status" -> base.copy(
                text = effective.string("body") ?: "Gateway status updated.",
            )
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

    private fun assertPairingRequestRoute(
        offer: SignedPairingOffer,
        request: SignedPairingRequest,
        session: PublicMatrixSession,
        transport: MatrixTransportIdentity,
    ) {
        PairingSecurity.verifyRequest(request, offer, now = request.request.issuedAt)
        val document = request.request
        require(document.deviceId == deviceId)
        require(document.deviceKey == identity.publicIdentity)
        require(document.deviceTransport == MatrixTransportBinding(
            homeserver = session.homeserver,
            roomId = session.roomBinding.roomId,
            userId = session.userId,
            deviceId = transport.deviceId,
            ed25519 = transport.ed25519,
        )) { "The pairing request no longer matches this Matrix device." }
        require(transport.userId == session.userId) {
            "The active Matrix transport does not match its restored session."
        }
    }

    private fun resumeConfirmedPairing() {
        val pending = pendingPairing ?: return
        val request = pending.request ?: return
        if (activePairingCompletion?.job?.isActive == true) return
        pairingAutoResumeJob?.cancel()
        pairingAutoResumeJob = null
        scope.launch {
            diagnostics.record("pairing.transaction.auto_resume")
            runCatching {
                completePairing(pending.offer.offer.offerId, request.request.deviceName)
            }.onFailure { error ->
                if (error !is CancellationException) {
                    diagnostics.record(
                        "pairing.transaction.auto_resume_failure",
                        mapOf("error" to diagnosticErrorName(error)),
                    )
                    refreshSnapshot(publishLifecycle = true)
                }
            }
        }
    }

    private suspend fun abandonPairing(pending: PendingPairing, reason: String) {
        mutex.withLock {
            if (
                pendingPairing !== pending ||
                (trust != null && !pending.repairingSession)
            ) return
            pairingStore.clear()
            pendingPairing = null
            pairingStorageBlocked = false
            clearPreTrustEvents()
            diagnostics.record("pairing.transaction.rejected")
            eventHub.publish(
                ClientEventType.PAIRING_CHANGED,
                buildJsonObject {
                    put("pairingId", pending.offer.offer.offerId)
                    put("rejected", true)
                    put("reason", reason.take(256))
                },
                refreshedSnapshot(),
            )
        }
    }

    private fun expirePendingPairingIfNeeded() {
        val pending = pendingPairing ?: return
        val expiresAt = pairingTransactionExpiresAt(pending)
        if (expiresAt > now()) return
        pairingStore.clear()
        pending.response?.completeExceptionally(
            NativePairingRejectedException("The pairing transaction expired."),
        )
        activePairingCompletion?.job?.cancel()
        activePairingCompletion = null
        pairingAutoResumeJob?.cancel()
        pairingAutoResumeJob = null
        pendingPairing = null
        clearPreTrustEvents()
        diagnostics.record("pairing.transaction.expired")
        eventHub.publish(
            ClientEventType.PAIRING_CHANGED,
            buildJsonObject {
                put("pairingId", pending.offer.offer.offerId)
                put("expired", true)
            },
            refreshedSnapshot(),
        )
    }

    private fun validateRestoredPairingTransaction(
        transaction: PersistedPairingTransaction,
    ): PersistedPairingTransaction? {
        // Verify cryptographic integrity at the documents' issuance times so
        // an approved exact request remains recoverable after its short
        // admission window. The invitation lifetime still bounds the local
        // transaction as a whole.
        PairingSecurity.verifyOffer(
            transaction.offer,
            now = transaction.offer.offer.issuedAt,
        )
        transaction.request?.let { request ->
            PairingSecurity.verifyRequest(request, transaction.offer, request.request.issuedAt)
            require(request.request.deviceId == deviceId)
            require(request.request.deviceKey == identity.publicIdentity)
            transaction.response?.let { response ->
                PairingSecurity.verifyResponse(
                    response,
                    transaction.offer,
                    request,
                    transaction.offer.offer.gatewayKey,
                    now(),
                )
            }
        }
        val expiresAt = transaction.response?.response?.expiresAt
            ?: transaction.request?.let(::pairingRecoveryExpiresAt)
            ?: transaction.offer.offer.expiresAt
        if (expiresAt <= now()) {
            pairingStore.clear()
            diagnostics.record("pairing.transaction.expired")
            return null
        }
        diagnostics.record(
            "pairing.transaction.restored",
            mapOf("request" to (transaction.request != null).toString()),
        )
        return transaction
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

    private fun previewFor(offer: SignedPairingOffer): NativePairingPreview =
        NativePairingPreview(
            pairingId = offer.offer.offerId,
            gatewayId = offer.offer.gatewayId,
            gatewayName = offer.offer.gatewayName,
            verificationCode = verificationCode(offer),
            expiresAt = offer.offer.expiresAt,
        )

    private fun pairingTransactionExpiresAt(pending: PendingPairing): Long =
        pending.receivedResponse?.response?.expiresAt
            ?: pending.request?.let(::pairingRecoveryExpiresAt)
            ?: pending.offer.offer.expiresAt

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
            pairing = pendingPairing?.let {
                buildJsonObject {
                    put("pairingId", it.offer.offer.offerId)
                    put("expiresAt", pairingTransactionExpiresAt(it))
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
            pairing = pendingPairing?.let {
                buildJsonObject {
                    put("pairingId", it.offer.offer.offerId)
                    put("expiresAt", pairingTransactionExpiresAt(it))
                }
            },
        )
    }

    private fun snapshotCommands(): List<CommandView> =
        compactSnapshotCommands(outbox.list().map(::publicCommand))

    private fun lifecycle(): ClientLifecycle {
        val status = matrix.status
        if (trustStorageBlocked || pairingStorageBlocked) {
            return ClientLifecycle(
                LifecyclePhase.BLOCKED,
                status.since,
                if (trustStorageBlocked) {
                    "gateway_trust_unreadable"
                } else {
                    "pairing_transaction_unreadable"
                },
            )
        }
        val activeTrust = trust
        val phase = when {
            status.phase == MatrixRuntimePhase.STOPPED -> LifecyclePhase.STOPPED
            status.phase == MatrixRuntimePhase.WAITING_FOR_SESSION && activeTrust != null ->
                LifecyclePhase.BLOCKED
            status.phase == MatrixRuntimePhase.WAITING_FOR_SESSION -> LifecyclePhase.UNPAIRED
            status.phase == MatrixRuntimePhase.BOOTSTRAPPING -> LifecyclePhase.STARTING
            status.phase == MatrixRuntimePhase.RESTORING -> LifecyclePhase.SECURING
            status.phase == MatrixRuntimePhase.CONNECTING -> LifecyclePhase.CONNECTING
            status.phase == MatrixRuntimePhase.OFFLINE -> LifecyclePhase.OFFLINE
            status.phase == MatrixRuntimePhase.RETRY_WAIT -> LifecyclePhase.RECONNECTING
            status.phase == MatrixRuntimePhase.BLOCKED -> LifecyclePhase.BLOCKED
            activeTrust == null -> LifecyclePhase.UNPAIRED
            !matrix.commandTransportReady || !gatewayStateSynchronized -> LifecyclePhase.CONNECTING
            else -> LifecyclePhase.READY
        }
        val detail = if (
            phase == LifecyclePhase.BLOCKED &&
            status.phase == MatrixRuntimePhase.WAITING_FOR_SESSION &&
            activeTrust != null
        ) {
            "matrix_session_repair_required"
        } else if (
            phase == LifecyclePhase.CONNECTING &&
            status.phase == MatrixRuntimePhase.SYNCING &&
            activeTrust != null &&
            (!matrix.commandTransportReady || !gatewayStateSynchronized)
        ) {
            "matrix_gateway_state_syncing"
        } else {
            status.detailCode
        }
        return ClientLifecycle(phase, status.since, detail)
    }

    private fun publishStatus(phase: LifecyclePhase, detail: String?) {
        eventHub.publishTransient(
            ClientEventType.STATUS_CHANGED,
            buildJsonObject {
                put("phase", phase.wireValue)
                detail?.let { put("detail", it) }
            },
            refreshedSnapshot(),
        )
    }

    private fun scheduleGatewayConvergenceFallback(
        expectedRevision: Long,
        operation: CommandOperation,
    ) {
        val currentRevision = gatewayState?.long("revision")
        if (!requiresGatewayConvergence(currentRevision, expectedRevision)) {
            diagnostics.record(
                "gateway.state.timeline_converged",
                mapOf("action" to operation.wireName, "stage" to "completion"),
            )
            return
        }
        cancelGatewayConvergenceFallback()
        gatewayConvergenceMinimumRevision = expectedRevision
        diagnostics.record(
            "gateway.state.fallback_scheduled",
            mapOf("action" to operation.wireName),
        )
        gatewayConvergenceFallbackJob = scope.launch {
            delay(GATEWAY_CONVERGENCE_GRACE_MS)
            val shouldBackfill = mutex.withLock {
                val stillBehind = requiresGatewayConvergence(
                    gatewayState?.long("revision"),
                    expectedRevision,
                )
                if (gatewayConvergenceMinimumRevision == expectedRevision) {
                    gatewayConvergenceMinimumRevision = null
                    gatewayConvergenceFallbackJob = null
                }
                stillBehind && trust != null
            }
            if (shouldBackfill) {
                diagnostics.record(
                    "gateway.state.fallback_requested",
                    mapOf("action" to operation.wireName),
                )
                startAuthoritativeStateRefresh(recoverTransport = false)
            }
        }
    }

    private fun cancelGatewayConvergenceFallback() {
        gatewayConvergenceFallbackJob?.cancel()
        gatewayConvergenceFallbackJob = null
        gatewayConvergenceMinimumRevision = null
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
        if (pairingStorageBlocked) return PublicTrustState.Blocked("pairing_transaction_unreadable")
        pendingPairing?.let {
            return PublicTrustState.Pairing(
                it.offer.offer.offerId,
                pairingTransactionExpiresAt(it),
            )
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
        const val BRIDGE_REPLAY_EVENT_LIMIT = 100
        const val MAX_HISTORY_RELATION_PAGES_PER_REQUEST = 20
        const val MAX_PRE_TRUST_EVENTS = 256
        const val PAIRING_REQUEST_MS = 2 * 60_000L
        const val PAIRING_RESPONSE_TIMEOUT_MS = 60_000L
        const val PAIRING_AUTO_RESUME_DELAY_MS = 30_000L
        const val GATEWAY_TRANSPORT_PROFILE_FIELD = "io.codever.gateway_transport"
        const val COMMAND_LIFETIME_MS = 5 * 60_000L
        const val COMMAND_ACK_TIMEOUT_MS = 30_000L
        const val GATEWAY_CONVERGENCE_GRACE_MS = 3_000L
        const val MAX_AUTOMATIC_REVISION_RETRIES = 3
    }
}

internal fun decodeMatrixToolGroup(extension: JsonObject): ToolGroupPresentation? {
    val ui = extension["ui"] ?: return null
    return runCatching { PublicClientJson.decodeToolGroup(ui) }.getOrNull()
}

internal fun requiresGatewayConvergence(
    currentRevision: Long?,
    expectedRevision: Long,
): Boolean {
    require(expectedRevision >= 0)
    return currentRevision == null || currentRevision < expectedRevision
}

internal fun authoritativeRoomStateReady(kinds: List<String>): Boolean =
    kinds.count { it == "gateway_state" } == 1

internal fun canonicalStateCompletesCommand(
    operation: CommandOperation,
    eventKind: String,
    lifecycleState: String?,
): Boolean = when (operation) {
    CommandOperation.SESSION_CREATE ->
        eventKind == "session_root" ||
            (eventKind == "session_state" && lifecycleState == "active")
    CommandOperation.SESSION_SETTINGS ->
        eventKind == "session_update" ||
            (eventKind == "session_state" && lifecycleState in setOf("active", "archived"))
    CommandOperation.SESSION_ARCHIVE ->
        eventKind in setOf("session_lifecycle", "session_state") && lifecycleState == "archived"
    CommandOperation.SESSION_RESTORE ->
        (eventKind == "session_lifecycle" && lifecycleState == "idle") ||
            (eventKind == "session_state" && lifecycleState == "active")
    CommandOperation.SESSION_DELETE ->
        eventKind in setOf("session_lifecycle", "session_state") && lifecycleState == "deleted"
    else -> false
}

internal fun shouldAutomaticallyRetryRevisionConflict(operation: CommandOperation?): Boolean =
    when (operation) {
        // Current Gateways linearize stale prompts directly. Keep this client
        // fallback so an updated APK also hands conversations off cleanly
        // while a previously deployed Gateway is still being upgraded.
        CommandOperation.PROMPT,
        CommandOperation.SESSION_CREATE,
        CommandOperation.SESSION_ARCHIVE,
        CommandOperation.SESSION_RESTORE,
        CommandOperation.SESSION_DELETE,
        -> true
        else -> false
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

internal fun authoritativeStateRefreshDelayMs(completedAttempts: Int): Long {
    require(completedAttempts >= 0)
    return when (completedAttempts) {
        0 -> 1_000L
        1 -> 2_000L
        2 -> 5_000L
        3 -> 10_000L
        else -> 30_000L
    }
}

internal fun pairingRequestRetryDelayMs(completedRetries: Int): Long {
    require(completedRetries >= 0)
    return when (completedRetries) {
        0 -> 2_000L
        1 -> 5_000L
        else -> 10_000L
    }
}

internal fun pairingRecoveryExpiresAt(request: SignedPairingRequest): Long =
    Math.addExact(request.request.issuedAt, PAIRING_RECOVERY_WINDOW_MS)

private const val PAIRING_RECOVERY_WINDOW_MS = 366L * 24 * 60 * 60_000

internal fun recoverableCommandIds(commands: List<DurableView>): List<String> =
    commands
        .asSequence()
        .filter { it.state == DurableState.RECOVERY_REQUIRED }
        .sortedBy(DurableView::sequence)
        .map(DurableView::commandId)
        .toList()
