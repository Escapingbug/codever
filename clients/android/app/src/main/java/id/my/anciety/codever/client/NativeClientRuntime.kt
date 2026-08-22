package id.my.anciety.codever.client

import android.content.Context
import id.my.anciety.codever.BuildConfig
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
import id.my.anciety.codever.client.command.UnknownCommandException
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
import id.my.anciety.codever.client.events.ClientEventStateCodec
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
import id.my.anciety.codever.security.codever.CVP3_MATRIX_KEY_GRANT_EVENT_TYPE
import id.my.anciety.codever.security.codever.CVP3_MATRIX_PROJECT_POINTER_EVENT_TYPE
import id.my.anciety.codever.security.codever.CVP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE
import id.my.anciety.codever.security.codever.MatrixCvp3Protocol
import id.my.anciety.codever.security.codever.PairingCodec
import id.my.anciety.codever.security.codever.PairingRequest
import id.my.anciety.codever.security.codever.PairingSecurity
import id.my.anciety.codever.security.codever.SignedPairingOffer
import id.my.anciety.codever.security.codever.SignedPairingRequest
import id.my.anciety.codever.security.codever.SignedPairingResponse
import java.security.SecureRandom
import java.security.MessageDigest
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
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
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
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
private class MatrixCvp3EventDeferredException(message: String) : IllegalStateException(message)

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
    internal fun injectNetworkAvailabilityForE2e(available: Boolean) {
        matrix.injectNetworkAvailabilityForE2e(available)
    }

    fun onSystemWake(reason: String) {
        matrix.onSystemWake(reason)
    }

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
    // History pagination is an explicit, per-conversation user action. Never
    // serialize unrelated sessions behind one slow Matrix relation page.
    private val historyMutexes = ConcurrentHashMap<String, Mutex>()
    private val diagnostics = NativeDiagnosticLog.get(context)
    private val files = NativeRuntimeFiles(context, deviceId)
    private val stateUpgrade = NativeStateUpgradeCoordinator(
        files.stateManifest,
        diagnostics,
        now,
    ).begin(BuildConfig.NATIVE_BUILD_ID)
    private val eventPersistence = EncryptedAtomicClientEventPersistence(
        files.events,
        cipher,
        deviceId,
    ).also { persistence ->
        stateUpgrade.recoverRebuildable(
            "client-event-projection",
            validate = {
                persistence.load()?.let { bytes ->
                    try {
                        ClientEventStateCodec.decode(bytes)
                    } finally {
                        bytes.fill(0)
                    }
                }
            },
            reset = persistence::clear,
        )
    }
    private val replayStore = AtomicEncryptedReplayStore(files.replay, cipher, deviceId).also {
        stateUpgrade.recoverPreserved("replay-ledger", validate = it::validateStoredState)
    }
    private val pairingStore = AtomicEncryptedPairingTransactionStore(
        files.pairing,
        cipher,
        deviceId,
    )
    private val timelineKeys = AtomicEncryptedTimelineKeyStore(
        files.timelineKeys,
        cipher,
        deviceId,
    ).also {
        stateUpgrade.recoverPreserved("timeline-key-ring", validate = it::validateStoredState)
    }
    private val matrixCvp3ProjectKeys = AtomicEncryptedMatrixCvp3ProjectKeyStore(
        files.matrixCvp3ProjectKeys,
        cipher,
        deviceId,
    ).also {
        stateUpgrade.recoverPreserved("matrix-v3-project-keys", validate = it::validateStoredState)
    }
    private val matrixCvp3Inbox = AtomicEncryptedMatrixCvp3InboxStore(
        files.matrixCvp3Inbox,
        cipher,
        deviceId,
    ).also {
        stateUpgrade.recoverPreserved("matrix-v3-raw-inbox", validate = it::validateStoredState)
    }
    private val matrixCvp3ProjectionStore = AtomicEncryptedMatrixCvp3ProjectionStore(
        files.matrixCvp3Projection,
        cipher,
        deviceId,
    ).also {
        stateUpgrade.recoverRebuildable(
            "matrix-v3-projection",
            validate = it::validateStoredState,
            reset = it::clear,
        )
    }
    private val matrixCvp3CommandContent = AtomicEncryptedMatrixCvp3CommandContentStore(
        files.matrixCvp3CommandContent,
        cipher,
        deviceId,
    ).also {
        stateUpgrade.recoverPreserved(
            "matrix-v3-command-content",
            validate = it::validateStoredState,
        )
    }
    private val trustStore = EncryptedGatewayTrustStore(
        AtomicEncryptedTrustBlobStore(files.trust),
        cipher,
        now,
    )
    private val outbox = DurableCommandOutbox.encrypted(files.matrixCvp3Commands, cipher, deviceId) { migration ->
        diagnostics.record(
            "command.outbox.migrated",
            mapOf(
                "schema" to migration.fromSchemaVersion.toString(),
                "quarantined" to migration.quarantinedCommandCount.toString(),
            ),
        )
    }.also {
        // The owning codec performs and atomically rewrites supported legacy
        // schemas during construction. Replaying these coordinator steps is
        // harmless because opening the current codec is idempotent.
        stateUpgrade.recoverPreserved(
            "command-outbox",
            migrate = { _, _ -> it.list() },
            validate = { it.list() },
        )
    }
    private val transfers = AttachmentTransferManager(files.transfers, matrix, cipher, now).also {
        stateUpgrade.recoverRebuildable(
            "attachment-transfer-scratch",
            validate = files::validateTransferScratch,
            reset = files::clearTransferScratch,
        )
    }
    private val ackTimeouts = ConcurrentHashMap<String, Job>()
    private val commandTransmissionJobs = ConcurrentHashMap<String, Job>()
    private val commandRecoveryJobs = ConcurrentHashMap<String, Job>()
    private val commandRecoveryAttempts = ConcurrentHashMap<String, Int>()
    private val automaticRevisionRetryAttempts = ConcurrentHashMap<String, Int>()
    private val json = Json { isLenient = false; allowSpecialFloatingPointValues = false }
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
    private val matrixCvp3Projection = MatrixCvp3NativeProjection(
        gatewayId = { trust?.gatewayId ?: "gateway" },
        activeDeviceCount = { trust?.response?.response?.activeDeviceCount ?: 1 },
        initialState = matrixCvp3ProjectionStore.load(),
    )

    private val eventHub = ClientEventHub(
        eventPersistence,
        initialSnapshot(),
        // Matrix and the per-session history cache remain authoritative. This
        // window only bridges short WebView detach/reattach gaps.
        maxReplayEvents = BRIDGE_REPLAY_EVENT_LIMIT,
    )

    init {
        if (restoredTrust.isFailure) {
            stateUpgrade.blockPreserved("gateway-trust")
        } else {
            stateUpgrade.recoverPreserved("gateway-trust", validate = { restoredTrust.getOrThrow() })
        }
        if (restoredPairing.isFailure) {
            stateUpgrade.blockPreserved("pairing-transaction")
        } else {
            stateUpgrade.recoverPreserved(
                "pairing-transaction",
                validate = { restoredPairing.getOrThrow() },
            )
        }
        stateUpgrade.complete()
        gatewayState = matrixCvp3Projection.snapshot() ?: eventHub.snapshot().gatewayState
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

    suspend fun historyPage(
        sessionId: String,
        before: String?,
        limit: Int,
        allowRemote: Boolean,
    ): HistoryPage {
        return try {
            // The Web bridge gives history.page 60 seconds. Bound the complete
            // native operation, including lock wait, pagination, verification,
            // and persistence, so a timed-out RPC cannot continue occupying a
            // hidden queue after the WebView has stopped waiting.
            withTimeout(HISTORY_PAGE_TOTAL_TIMEOUT_MS) {
                historyMutexes.computeIfAbsent(sessionId) { Mutex() }.withLock {
                    diagnostics.record("history.page.requested")
                val online = matrix.status.phase == MatrixRuntimePhase.SYNCING
                val initialized = sessionId in initializedHistoryRelations
                val externalHasMore = allowRemote && online && (
                    !initialized || historyRelationTokens.containsKey(sessionId)
                )
                var local = eventHub.historyPage(
                    sessionId,
                    before,
                    limit,
                    externalHasMore = externalHasMore,
                )
                val needsInitialRemotePage = before == null
                val needsOlderPage = before != null && local.messages.isEmpty() && externalHasMore
                if (!allowRemote || !online || (!needsInitialRemotePage && !needsOlderPage)) {
                    diagnostics.record("history.page.local")
                    return@withLock local
                }

                val threadRoot = matrixCvp3Projection.threadRootEventId(sessionId)
                if (threadRoot == null) {
                    // A newly-created session has no Matrix thread until its
                    // first prompt. Match the browser client: this is a valid
                    // empty history, not a restoration failure.
                    initializedHistoryRelations += sessionId
                    historyRelationTokens.remove(sessionId)
                    local = eventHub.historyPage(
                        sessionId,
                        before,
                        limit,
                        externalHasMore = false,
                    )
                    diagnostics.record(
                        "history.page.completed",
                        mapOf("received" to "0"),
                    )
                    return@withLock local
                }
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
            val synchronizedBeforeTrustCommit = gatewayStateSynchronized
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
            gatewayStateSynchronized = MatrixSessionRepairPolicy.retainSynchronizedGatewayState(
                repairingSession = pending.repairingSession,
                synchronizedBeforeTrustCommit = synchronizedBeforeTrustCommit,
            )
            diagnostics.record(
                "pairing.transaction.trust_committed",
                mapOf(
                    "repair" to pending.repairingSession.toString(),
                    "state_synchronized" to gatewayStateSynchronized.toString(),
                ),
            )
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
            replayMatrixCvp3InboxLocked()
            val public = publicTrust() as PublicTrustState.Trusted
            val nextSnapshot = refreshedSnapshot()
            eventHub.publish(ClientEventType.TRUST_CHANGED, PublicClientJson.encodeTrust(public), nextSnapshot)
            public
        }
        // Pairing commits trust before state convergence. The Gateway publishes
        // a key bundle addressed to this device before acknowledging a new
        // pairing, but Matrix delivery and a retry of an already accepted
        // request may still race. Keep the service-owned connection converging
        // until one complete authenticated CVP/3 projection is committed; never
        // make the WebView stay foreground merely to wait for that round trip.
        startMatrixCvp3ProjectionRefresh(recoverTransport = false)
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
        val current = outbox.resolveCurrent(commandId)
            ?: throw UnknownCommandException("Command was not found.")
        diagnostics.record(
            "command.recovery.requested",
            mapOf(
                "action" to (outbox.operation(current.commandId)?.wireName ?: "unknown"),
                "stage" to current.state.wireName,
            ),
        )
        when (current.state) {
            DurableState.QUEUED -> launchCommandTransmission(current.commandId, recovery = false)
            DurableState.RECOVERY_REQUIRED -> {
                cancelScheduledCommandRecovery(current.commandId, resetAttempts = false)
                launchCommandTransmission(current.commandId, recovery = true)
            }
            DurableState.ACCEPTED, DurableState.RUNNING -> {
                // An acknowledgement proves only that the Gateway durably
                // claimed the command. If the Gateway or WebView stopped
                // before the terminal event arrived, replay the exact signed
                // identity so the Gateway can return its durable result (or
                // safely terminalize a pre-result crash) without re-executing
                // the logical action.
                launchCommandTransmission(
                    current.commandId,
                    recovery = true,
                    completionProbe = true,
                )
            }
            else -> Unit
        }
        return publicReceipt(outbox.get(current.commandId) ?: current)
    }

    fun command(commandId: String): CommandView = outbox.resolveCurrent(commandId)?.let(::publicCommand)
        ?: throw UnknownCommandException("Command was not found.")

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
        cancelCommandTransmission(commandId)
        cancelScheduledCommandRecovery(commandId)
        outbox.get(commandId)?.operationId?.let(automaticRevisionRetryAttempts::remove)
        val released = outbox.release(commandId)
        if (released) matrixCvp3CommandContent.remove(commandId)
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
        cancelAllCommandTransmissions()
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
            matrixCvp3ProjectKeys.clear()
            matrixCvp3Inbox.clear()
            matrixCvp3Projection.clear()
            matrixCvp3ProjectionStore.clear()
            matrixCvp3CommandContent.clear()
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
        cancelAllCommandTransmissions()
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
        gatewayStateSynchronized = trust != null &&
            matrixCvp3ProjectKeys.value() != null &&
            matrixCvp3Projection.snapshot() != null
        refreshSnapshot(publishLifecycle = true)
        if (trust != null) {
            scope.launch {
                runCatching { matrix.refreshThreadDirectory() }
                    .onFailure { error ->
                        diagnostics.record(
                            "matrix.thread_directory.refresh_failure",
                            mapOf("error" to diagnosticErrorName(error)),
                        )
                    }
                mutex.withLock {
                    runCatching { recoverGatewayTransportSnapshotLocked() }
                        .onFailure { error ->
                            diagnostics.record(
                                "gateway.transport.recovery.failure",
                                mapOf("error" to diagnosticErrorName(error)),
                            )
                        }
                    replayMatrixCvp3InboxLocked()
                    matrixCvp3Projection.snapshot()?.let(::acceptMatrixCvp3GatewayState)
                }
            }
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
        startMatrixCvp3ProjectionRefresh(recoverTransport = false)
    }

    override suspend fun onDecryptedEvent(event: MatrixDecryptedEvent) {
        mutex.withLock {
            val isV3 = isMatrixCvp3RawEvent(event.rawJson)
            if (isV3) matrixCvp3Inbox.put(event)
            try {
                processMatrixEvent(event)
                if (isV3) matrixCvp3Inbox.projected(event.eventId)
            } catch (error: MatrixCvp3EventDeferredException) {
                diagnostics.record(
                    "matrix.v3_event.deferred",
                    mapOf("reason" to diagnosticErrorName(error)),
                )
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
                if (isV3) {
                    matrixCvp3Inbox.quarantine(event.eventId, error)
                    publishStatus(lifecycle().phase, "matrix_v3_event_quarantined")
                    return@withLock
                }
                if (error !is CodeverSecurityException) {
                    publishStatus(lifecycle().phase, "native_event_rejected")
                    throw error
                }
            }
        }
    }

    private fun launchCommandTransmission(
        commandId: String,
        recovery: Boolean,
        completionProbe: Boolean = false,
    ) {
        synchronized(commandTransmissionJobs) {
            if (commandTransmissionJobs[commandId]?.isActive == true) return
            val job = scope.launch(start = CoroutineStart.LAZY) {
                try {
                    transmit(commandId, recovery, completionProbe)
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    diagnostics.record(
                        "command.transmission.failure",
                        mapOf(
                            "action" to (outbox.operation(commandId)?.wireName ?: "unknown"),
                            "stage" to when {
                                completionProbe -> "completion_probe"
                                recovery -> "recovery"
                                else -> "initial"
                            },
                            "error" to diagnosticErrorName(error),
                        ),
                    )
                } finally {
                    val currentJob = coroutineContext[Job]
                    if (currentJob != null) commandTransmissionJobs.remove(commandId, currentJob)
                }
            }
            commandTransmissionJobs[commandId] = job
            job.start()
        }
    }

    private fun cancelCommandTransmission(commandId: String) {
        commandTransmissionJobs.remove(commandId)?.cancel()
    }

    private fun cancelAllCommandTransmissions() {
        commandTransmissionJobs.values.forEach(Job::cancel)
        commandTransmissionJobs.clear()
    }

    /**
     * Command Matrix I/O must never run while [mutex] is held. Bridge mutations
     * only commit durable command state synchronously; delivery continues in a
     * background task so a slow Matrix send cannot starve local recovery RPCs.
     */
    private suspend fun transmit(
        commandId: String,
        recovery: Boolean,
        completionProbe: Boolean = false,
    ) {
        val transmission = mutex.withLock {
            val claimed = when {
                completionProbe -> outbox.claimCompletionRecovery(commandId)
                recovery -> outbox.claimRecovery(commandId)
                else -> outbox.claimForTransmission(commandId)
            } ?: return@withLock null
            publishCommand(outbox.get(commandId) ?: return@withLock null)
            claimed
        } ?: return
        try {
            val content = signedCommandContent(transmission)
            val matrixEventId = sendTrustedControlMessage(
                content.toString(),
                "codever.v3.command.${transmission.commandId}",
            )
            mutex.withLock {
                applyOwnMatrixCvp3Command(content, matrixEventId, transmission.issuedAt)
            }
        } catch (error: Exception) {
            val remainsCurrent = mutex.withLock {
                val current = outbox.get(commandId)
                if (current == null || current.state.isTerminal) return@withLock false
                if (completionProbe) return@withLock true
                outbox.markAcknowledgementTimedOut(commandId)?.let(::publishCommand)
                scheduleCommandRecovery(commandId)
                true
            }
            if (!remainsCurrent) {
                diagnostics.record(
                    "command.transmission.superseded",
                    mapOf("action" to (transmission.payload.string("operation") ?: "unknown")),
                )
                return
            }
            throw error
        }
        if (completionProbe) return
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
        val commands = outbox.list()
        queuedCommandIds(commands).forEach { commandId ->
            launchCommandTransmission(commandId, recovery = false)
        }
        recoverableCommandIds(commands).forEach { commandId ->
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
        matrixCvp3CommandContent.get(transmission.commandId)?.let { return it }
        val activeTrust = trust ?: throw NativeTrustRequiredException("Pair the Gateway before sending commands.")
        val roomId = matrix.publicSession()?.roomBinding?.roomId
            ?: throw IllegalStateException("Matrix room binding is unavailable.")
        val keys = matrixCvp3ProjectKeys.value()
            ?: throw IllegalStateException("The CVP/3 project key grant is unavailable.")
        val raw = transmission.payload
        val operation = raw.string("operation")
            ?: throw IllegalArgumentException("Command operation is invalid.")
        val sessionId = raw.string("sessionId")
        val v3Operation: String
        val v3Payload: JsonObject
        val v3SessionId: String?
        when (operation) {
            "session.create" -> {
                v3Operation = "session.create"
                v3SessionId = transmission.commandId
                v3Payload = buildJsonObject {
                    put("operation", v3Operation)
                    raw.string("scope")?.let { put("scope", it) }
                    raw.string("provider")?.let { put("provider", it) }
                    raw.string("providerSessionId")?.let { put("providerSessionId", it) }
                    raw.string("title")?.let { put("title", it) }
                    raw.string("model")?.let { put("model", it) }
                    raw.string("reasoningEffort")?.let { put("reasoningEffort", it) }
                    raw.string("permissionMode")?.let { put("permissionMode", it) }
                    raw["extensions"]?.let { put("extensions", it) }
                    raw.string("initialPrompt")?.let { prompt ->
                        put("initialPrompt", buildJsonObject { put("text", prompt) })
                    }
                }
            }
            "prompt" -> {
                v3Operation = "prompt.submit"
                v3SessionId = sessionId ?: throw IllegalArgumentException("Prompt session is missing.")
                v3Payload = buildJsonObject {
                    put("operation", v3Operation)
                    put("text", raw.string("text") ?: "")
                    raw["attachments"]?.let { put("attachments", it) }
                }
            }
            "cancel" -> {
                v3Operation = "turn.cancel"
                v3SessionId = sessionId ?: throw IllegalArgumentException("Cancel session is missing.")
                v3Payload = buildJsonObject {
                    put("operation", v3Operation)
                    put(
                        "turnId",
                        raw.string("targetCommandId")
                            ?: throw IllegalArgumentException("The active turn ID is required to cancel."),
                    )
                }
            }
            "decision" -> {
                v3Operation = "decision.answer"
                v3SessionId = sessionId ?: throw IllegalArgumentException("Decision session is missing.")
                v3Payload = buildJsonObject {
                    put("operation", v3Operation)
                    put("requestId", raw.string("requestId")!!)
                    put("decision", raw.string("decision")!!)
                    raw.string("totp")?.let { put("totp", it) }
                }
            }
            "session.settings" -> {
                v3Operation = "session.update"
                v3SessionId = sessionId ?: throw IllegalArgumentException("Settings session is missing.")
                val patch = buildJsonObject {
                    raw.string("model")?.let { put("model", it) }
                    raw.string("reasoningEffort")?.let { put("reasoningEffort", it) }
                    raw.string("permissionMode")?.let { put("permissionMode", it) }
                }
                require(patch.isNotEmpty()) {
                    "Project directory changes belong to a Matrix project room in CVP/3."
                }
                v3Payload = buildJsonObject {
                    put("operation", v3Operation)
                    put("patch", patch)
                }
            }
            "project.settings" -> {
                v3Operation = "project.update"
                v3SessionId = null
                v3Payload = buildJsonObject {
                    put("operation", v3Operation)
                    put("patch", buildJsonObject {
                        raw["model"]?.let { put("model", it) }
                        raw["reasoningEffort"]?.let { put("reasoningEffort", it) }
                    })
                }
            }
            "provider.sessions.list" -> {
                v3Operation = "provider.sessions.list"
                v3SessionId = null
                v3Payload = buildJsonObject {
                    put("operation", v3Operation)
                    put("provider", raw.string("provider")!!)
                    raw.string("cursor")?.let { put("cursor", it) }
                }
            }
            "provider.session.inspect" -> {
                v3Operation = "provider.session.inspect"
                v3SessionId = null
                v3Payload = buildJsonObject {
                    put("operation", v3Operation)
                    put("provider", raw.string("provider")!!)
                    put("providerSessionId", raw.string("providerSessionId")!!)
                }
            }
            "session.archive", "session.restore", "session.delete" -> {
                v3Operation = "session.set_lifecycle"
                v3SessionId = sessionId ?: throw IllegalArgumentException("Session lifecycle target is missing.")
                v3Payload = buildJsonObject {
                    put("operation", v3Operation)
                    put("state", when (operation) {
                        "session.archive", "session.delete" -> "archived"
                        "session.restore" -> "active"
                        else -> "archived"
                    })
                }
            }
            "device.invite" -> {
                v3Operation = "device.invitation.create"
                v3SessionId = null
                v3Payload = buildJsonObject {
                    put("operation", v3Operation)
                    raw.long("lifetimeMs")?.let { put("lifetimeMs", it) }
                }
            }
            else -> throw IllegalArgumentException("Unsupported CVP/3 command operation.")
        }
        val command = buildJsonObject {
            put("kind", "codever.command")
            put("version", 3)
            put("commandId", transmission.commandId)
            put("workspaceId", activeTrust.gatewayId)
            put("projectId", keys.projectId)
            v3SessionId?.let { put("sessionId", it) }
            put("deviceId", deviceId)
            put("certificateId", activeTrust.certificate.certificateId)
            put("createdAt", transmission.issuedAt)
            put("operation", v3Operation)
            put("payload", v3Payload)
        }
        val nonce = MessageDigest.getInstance("SHA-256")
            .digest("codever-v3-command-nonce\u0000${transmission.commandId}".toByteArray())
            .copyOfRange(0, 12)
        val activeKey = keys.activeKey()
        val envelope = try {
            MatrixCvp3Protocol.sealSignedCommand(
                command,
                identity,
                roomId,
                keys.projectId,
                activeKey,
                nonce,
            )
        } finally {
            nonce.fill(0)
            keys.wipe()
        }
        val threadRoot = v3SessionId?.let(matrixCvp3Projection::threadRootEventId)
        val content = buildJsonObject {
            put("msgtype", "m.notice")
            put("body", "Encrypted Codever command")
            if (threadRoot != null && v3Operation != "session.create") {
                put("m.relates_to", buildJsonObject {
                    put("rel_type", "m.thread")
                    put("event_id", threadRoot)
                    put("is_falling_back", true)
                    put("m.in_reply_to", buildJsonObject { put("event_id", threadRoot) })
                })
            }
            put("io.codever", buildJsonObject {
                put("version", 3)
                put("envelope", envelope)
            })
        }
        return matrixCvp3CommandContent.putIfAbsent(transmission.commandId, content)
    }

    private fun startMatrixCvp3ProjectionRefresh(
        recoverTransport: Boolean,
    ) {
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
                var refreshed = false
                runCatching { matrix.refreshApplicationProjection() }
                    .onSuccess {
                        refreshed = true
                        diagnostics.record("matrix.v3_projection.refresh_completed")
                    }
                    .onFailure { error ->
                        diagnostics.record(
                            "matrix.v3_projection.refresh_failure",
                            mapOf("error" to diagnosticErrorName(error)),
                        )
                    }
                if (
                    (gatewayStateSynchronized && refreshed) ||
                    trust == null
                ) break
                val delayMs = authoritativeStateRefreshDelayMs(completedAttempts)
                diagnostics.record(
                    "matrix.v3_projection.refresh_retry_scheduled",
                    mapOf(
                        "attempt" to completedAttempts.toString(),
                        "transport_ready" to matrix.commandTransportReady.toString(),
                    ),
                )
                completedAttempts += 1
                delay(delayMs)
            } while (isActive)
            if (gatewayStateSynchronized) {
                diagnostics.record("matrix.v3_projection.converged")
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
    private suspend fun sendTrustedControlMessage(contentJson: String, transactionId: String): String {
        val eventId = matrix.sendApplicationControlEvent(contentJson, transactionId)
        diagnostics.record("matrix.application_control.sent")
        return eventId
    }

    private suspend fun processMatrixEvent(event: MatrixDecryptedEvent) {
        if (event.roomId != matrix.publicSession()?.roomBinding?.roomId) return
        val root = json.parseToJsonElement(event.rawJson).jsonObject
        val content = (root["content"] as? JsonObject) ?: return
        val eventType = root.string("type") ?: return
        if (processMatrixCvp3Event(event, root, content, eventType)) return
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
        if (trust == null) return
        if (kind == "gateway_device_rotation") {
            acceptGatewayDeviceRotation(event, extension)
        }
    }

    private suspend fun processMatrixCvp3Event(
        event: MatrixDecryptedEvent,
        root: JsonObject,
        content: JsonObject,
        eventType: String,
    ): Boolean {
        if (
            eventType != CVP3_MATRIX_KEY_GRANT_EVENT_TYPE &&
            eventType != CVP3_MATRIX_PROJECT_POINTER_EVENT_TYPE &&
            eventType != CVP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE &&
            !(eventType == "m.room.message" &&
                (content["io.codever"] as? JsonObject)?.long("version") == 3L)
        ) return false
        val activeTrust = trust ?: throw MatrixCvp3EventDeferredException("gateway_trust_pending")
        if (event.sender != activeTrust.transportTrust.currentTransport.userId) {
            // The application /sync lane accepts Gateway output only. A local
            // command is projected optimistically at the durable send boundary.
            return true
        }
        val roomId = matrix.publicSession()?.roomBinding?.roomId
            ?: throw MatrixCvp3EventDeferredException("matrix_room_pending")
        if (eventType == CVP3_MATRIX_KEY_GRANT_EVENT_TYPE) {
            // Key grants are directly addressed Room State. Matrix sync sends
            // every state key in the room, including grants for other paired
            // devices; those are ordinary irrelevant state, not poison input.
            if (content.string("deviceId") != identity.publicIdentity.keyId) return true
            val grant = MatrixCvp3Protocol.openProjectKeyGrant(
                state = content,
                identity = identity,
                gatewayKey = activeTrust.gatewayKey,
                expectedWorkspaceId = activeTrust.gatewayId,
                expectedRoomId = roomId,
                expectedCertificateId = activeTrust.certificate.certificateId,
            )
            matrixCvp3ProjectKeys.save(grant)
            grant.wipe()
            diagnostics.record("matrix.v3_project_keys.accepted")
            matrixCvp3Projection.snapshot()?.let(::acceptMatrixCvp3GatewayState)
            scope.launch {
                runCatching { matrix.refreshThreadDirectory() }
                    .onFailure { error ->
                        diagnostics.record(
                            "matrix.thread_directory.refresh_failure",
                            mapOf("error" to diagnosticErrorName(error)),
                        )
                    }
                mutex.withLock { replayMatrixCvp3InboxLocked() }
            }
            return true
        }
        if (
            eventType == CVP3_MATRIX_PROJECT_POINTER_EVENT_TYPE ||
            eventType == CVP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE
        ) {
            val pointer = if (
                eventType == CVP3_MATRIX_PROJECT_POINTER_EVENT_TYPE
            ) {
                MatrixCvp3Protocol.verifyProjectPointer(
                    content,
                    activeTrust.gatewayKey,
                    activeTrust.gatewayId,
                    roomId,
                )
            } else {
                MatrixCvp3Protocol.verifyWorkspacePointer(
                    content,
                    activeTrust.gatewayKey,
                    activeTrust.gatewayId,
                    roomId,
                )
            }
            val keys = matrixCvp3ProjectKeys.value()
                ?: throw MatrixCvp3EventDeferredException("project_key_grant_pending")
            try {
                require(pointer.string("projectId") == keys.projectId) {
                    "The CVP/3 project pointer targets another project."
                }
            } finally {
                keys.wipe()
            }
            val snapshotEvent = matrix.fetchApplicationEvent(
                pointer.string("eventId")
                    ?: throw IllegalArgumentException("The CVP/3 pointer event ID is missing."),
            )
            val inserted = matrixCvp3Inbox.put(snapshotEvent)
            if (inserted) {
                try {
                    processMatrixEvent(snapshotEvent)
                    matrixCvp3Inbox.projected(snapshotEvent.eventId)
                } catch (error: MatrixCvp3EventDeferredException) {
                    throw error
                } catch (error: Exception) {
                    matrixCvp3Inbox.quarantine(snapshotEvent.eventId, error)
                    throw error
                }
            }
            return true
        }
        val keys = matrixCvp3ProjectKeys.value()
            ?: throw MatrixCvp3EventDeferredException("project_key_grant_pending")
        val extension = content["io.codever"] as? JsonObject
            ?: throw IllegalArgumentException("The CVP/3 extension is missing.")
        val opened = try {
            MatrixCvp3Protocol.openContent(extension, roomId, keys.projectId, keys)
        } finally {
            keys.wipe()
        }
        val kind = opened.plaintext.string("kind")
        if (kind != "signed_event") return true
        val signed = opened.plaintext.objectValue("value")
        val protocolEvent = MatrixCvp3Protocol.verifyGatewayEvent(
            signed,
            activeTrust.gatewayKey,
            activeTrust.gatewayId,
            opened.projectId,
        )
        val protocolPayload = protocolEvent.objectValue("payload")
        if (protocolPayload.string("type") == "workspace.snapshot") {
            require(protocolPayload.string("gatewayKeyId") == activeTrust.gatewayKey.keyId) {
                "The CVP/3 workspace snapshot names another Gateway key."
            }
        }
        require(opened.logicalEventId == protocolEvent.string("eventId")) {
            "The CVP/3 event envelope logical ID is invalid."
        }
        val relation = content["m.relates_to"] as? JsonObject
        val threadRootHint = relation
            ?.takeIf { it.string("rel_type") == "m.thread" }
            ?.string("event_id")
        val result = matrixCvp3Projection.applyGatewayEvent(
            protocolEvent,
            event.eventId,
            threadRootHint,
        )
        result.messages.forEach { message ->
            val sessionId = message.sessionId ?: return@forEach
            eventHub.upsertMessage(sessionId, message, refreshedSnapshot())
        }
        result.acknowledgedCommandId?.let { commandId ->
            val command = outbox.get(commandId)
            if (command != null && !command.state.isTerminal) {
                if (outbox.recordAcknowledgement(commandId, command.sequence, 0)) {
                    ackTimeouts.remove(commandId)?.cancel()
                    cancelScheduledCommandRecovery(commandId)
                    outbox.get(commandId)?.let(::publishCommand)
                }
            }
        }
        result.terminal?.let(::recordMatrixCvp3Terminal)
        matrixCvp3Projection.snapshot()?.let(::acceptMatrixCvp3GatewayState)
        // Projection persistence follows ClientEventHub persistence. If the
        // process stops between them, replay is harmless and history upsert
        // IDs deduplicate; the inverse order could lose a public message.
        matrixCvp3ProjectionStore.save(matrixCvp3Projection.durableState())
        return true
    }

    private suspend fun applyOwnMatrixCvp3Command(
        content: JsonObject,
        matrixEventId: String,
        timestamp: Long,
    ) {
        val activeTrust = trust ?: return
        val roomId = matrix.publicSession()?.roomBinding?.roomId ?: return
        val keys = matrixCvp3ProjectKeys.value() ?: return
        val opened = try {
            MatrixCvp3Protocol.openContent(
                content.objectValue("io.codever"),
                roomId,
                keys.projectId,
                keys,
            )
        } finally {
            keys.wipe()
        }
        if (opened.plaintext.string("kind") != "signed_command") return
        val command = MatrixCvp3Protocol.verifyDeviceCommand(
            opened.plaintext.objectValue("value"),
            identity.publicIdentity,
            activeTrust.gatewayId,
            opened.projectId,
            activeTrust.certificate.certificateId,
        )
        require(opened.logicalEventId == command.string("commandId")) {
            "The CVP/3 command envelope logical ID is invalid."
        }
        val result = matrixCvp3Projection.applyOwnCommand(command, matrixEventId, timestamp)
        result.messages.forEach { message ->
            val sessionId = message.sessionId ?: return@forEach
            eventHub.upsertMessage(sessionId, message, refreshedSnapshot())
        }
        matrixCvp3Projection.snapshot()?.let(::acceptMatrixCvp3GatewayState)
        matrixCvp3ProjectionStore.save(matrixCvp3Projection.durableState())
    }

    private fun recordMatrixCvp3Terminal(terminal: MatrixCvp3NativeTerminal) {
        val current = outbox.get(terminal.commandId) ?: return
        val outcome = when (terminal.outcome) {
            "succeeded" -> DurableOutcome.SUCCEEDED
            "cancelled" -> DurableOutcome.CANCELLED
            else -> DurableOutcome.FAILED
        }
        recordCommandCompletion(
            DurableCompletion(
                commandId = terminal.commandId,
                sequence = current.sequence,
                revision = 0,
                outcome = outcome,
                sessionId = terminal.sessionId,
                result = terminal.result,
                error = terminal.errorMessage?.let {
                    DurableError(
                        terminal.errorCode ?: "gateway_failed",
                        it.take(4_096),
                        terminal.retryable,
                    )
                },
            ),
            diagnosticEvent = "command.v3_completion.received",
            scheduleConvergenceFallback = false,
        )
    }

    private fun acceptMatrixCvp3GatewayState(snapshot: JsonObject) {
        if (snapshot.toString().toByteArray().size > MAX_BRIDGE_EVENT_PAYLOAD_BYTES) return
        val changed = gatewayState != snapshot
        gatewayState = snapshot
        gatewayStateSynchronized = trust != null && matrixCvp3ProjectKeys.value() != null
        if (changed) {
            eventHub.publish(
                ClientEventType.GATEWAY_STATE_CHANGED,
                snapshot,
                refreshedSnapshot(),
            )
        }
        schedulePendingCommandRecoveries(immediate = true)
        refreshSnapshot(publishLifecycle = true)
    }

    private suspend fun replayMatrixCvp3InboxLocked() {
        drainMatrixCvp3Inbox(matrixCvp3Inbox) { record ->
            try {
                processMatrixEvent(record.event)
                matrixCvp3Inbox.projected(record.event.eventId)
                MatrixCvp3InboxProjectionStep.ADVANCED
            } catch (_: MatrixCvp3EventDeferredException) {
                MatrixCvp3InboxProjectionStep.DEFERRED
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                matrixCvp3Inbox.quarantine(record.event.eventId, error)
                diagnostics.record(
                    "matrix.v3_event.quarantined",
                    mapOf("error" to diagnosticErrorName(error)),
                )
                MatrixCvp3InboxProjectionStep.ADVANCED
            }
        }
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
        if (extension.long("version") == 3L) {
            val activeTrust = trust ?: return null
            if (event.sender != activeTrust.transportTrust.currentTransport.userId) return null
            val keys = matrixCvp3ProjectKeys.value() ?: return null
            val opened = try {
                MatrixCvp3Protocol.openContent(extension, event.roomId, keys.projectId, keys)
            } finally {
                keys.wipe()
            }
            if (opened.plaintext.string("kind") != "signed_event") return null
            val protocolEvent = MatrixCvp3Protocol.verifyGatewayEvent(
                opened.plaintext.objectValue("value"),
                activeTrust.gatewayKey,
                activeTrust.gatewayId,
                opened.projectId,
            )
            require(opened.logicalEventId == protocolEvent.string("eventId")) {
                "The CVP/3 historical event envelope logical ID is invalid."
            }
            if (protocolEvent.string("sessionId") != expectedSessionId) return null
            val relation = content["m.relates_to"] as? JsonObject
            val threadRootHint = relation
                ?.takeIf { it.string("rel_type") == "m.thread" }
                ?.string("event_id")
            val projected = matrixCvp3Projection.applyGatewayEvent(
                protocolEvent,
                event.eventId,
                threadRootHint,
            )
            projected.acknowledgedCommandId?.let { commandId ->
                val command = outbox.get(commandId)
                if (command != null) outbox.recordAcknowledgement(commandId, command.sequence, 0)
            }
            projected.terminal?.let(::recordMatrixCvp3Terminal)
            matrixCvp3Projection.snapshot()?.let(::acceptMatrixCvp3GatewayState)
            matrixCvp3ProjectionStore.save(matrixCvp3Projection.durableState())
            return projected.messages.singleOrNull()?.copy(historical = true)
        }
        return null
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
        // Matrix can deliver the authenticated result through /sync before
        // the SDK call which sent that same event has returned. Once the
        // command is terminal, its transmission lease has no remaining work;
        // cancelling it prevents the late sender from observing a rotated
        // Gateway scope and reporting a spurious transmission failure.
        cancelCommandTransmission(completion.commandId)
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

    /**
     * Matrix restoration and bridge startup run on different dispatchers. Keep
     * snapshot replacement and lifecycle publication in one critical section
     * so an older RESTORING observation cannot be emitted after a newer
     * WAITING_FOR_SESSION/repair observation.
     */
    @Synchronized
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
                startMatrixCvp3ProjectionRefresh(recoverTransport = false)
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
        const val HISTORY_PAGE_TOTAL_TIMEOUT_MS = 50_000L
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

private fun isMatrixCvp3RawEvent(rawJson: String): Boolean = runCatching {
    val root = Json.parseToJsonElement(rawJson).jsonObject
    when (root["type"]?.jsonPrimitive?.contentOrNull) {
        CVP3_MATRIX_KEY_GRANT_EVENT_TYPE,
        CVP3_MATRIX_PROJECT_POINTER_EVENT_TYPE,
        CVP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE,
        -> true
        "m.room.message" ->
            (root["content"] as? JsonObject)
                ?.get("io.codever")
                ?.jsonObject
                ?.get("version")
                ?.jsonPrimitive
                ?.longOrNull == 3L
        else -> false
    }
}.getOrDefault(false)

internal fun requiresGatewayConvergence(
    currentRevision: Long?,
    expectedRevision: Long,
): Boolean {
    require(expectedRevision >= 0)
    return currentRevision == null || currentRevision < expectedRevision
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

internal fun queuedCommandIds(commands: List<DurableView>): List<String> =
    commands
        .asSequence()
        .filter { it.state == DurableState.QUEUED }
        .sortedBy(DurableView::sequence)
        .map(DurableView::commandId)
        .toList()
