package id.my.anciety.codever.matrix

import android.content.Context
import android.os.SystemClock
import id.my.anciety.codever.BuildConfig
import id.my.anciety.codever.diagnostics.DiagnosticRecorder
import id.my.anciety.codever.security.AndroidKeystoreSecretCipher
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout

fun interface MatrixSdkDriverFactory {
    fun create(scope: CoroutineScope): MatrixSdkDriver
}

class MatrixOfflineException(message: String = "The native Matrix connection is offline.") :
    IllegalStateException(message)

class MatrixConnectionRuntime(
    context: Context,
    private val loginClient: MatrixTokenLoginClient = MatrixTokenLoginClient(),
    private val loginTokenIssueClient: MatrixLoginTokenIssueClient = MatrixLoginTokenIssueClient(),
    private val profileClient: MatrixProfileClient = MatrixProfileClient(),
    private val applicationControlClient: MatrixApplicationControlClient =
        MatrixApplicationControlClient(),
    private val applicationControlSyncClient: MatrixApplicationControlSyncClient =
        MatrixApplicationControlSyncClient(),
    private val applicationTimelineClient: MatrixApplicationTimelineClient =
        MatrixApplicationTimelineClient(),
    private val threadDirectoryClient: MatrixThreadDirectoryClient =
        MatrixThreadDirectoryClient(),
    private val applicationEventClient: MatrixApplicationEventClient =
        MatrixApplicationEventClient(),
    private val threadHistoryClient: MatrixThreadHistoryClient = MatrixThreadHistoryClient(),
    private val networkMonitor: NetworkMonitor = AndroidNetworkMonitor(context),
    private val accountStorage: MatrixAccountStorage = MatrixAccountStorage(
        context,
        AndroidKeystoreSecretCipher(),
    ),
    private val diagnostics: DiagnosticRecorder = DiagnosticRecorder.None,
    private val driverFactory: MatrixSdkDriverFactory = MatrixSdkDriverFactory { scope ->
        OfficialMatrixSdkDriver(scope, diagnostics = diagnostics)
    },
    private val stateMachine: MatrixRuntimeStateMachine = MatrixRuntimeStateMachine(),
    private val liveness: MatrixSyncLiveness = MatrixSyncLiveness(
        firstSyncTimeoutMs = BuildConfig.MATRIX_FIRST_SYNC_TIMEOUT_MS,
    ),
    private val retryDelayMs: Long = 5_000,
    private val elapsedRealtime: () -> Long = SystemClock::elapsedRealtime,
    private val onPairingTransportReady: (MatrixTransportIdentity) -> Unit = {},
    private val onTransportReady: (MatrixTransportIdentity) -> Unit = {},
    private val onConvergenceRequired: (String) -> Unit = {},
    private val onDecryptedEvent: suspend (MatrixDecryptedEvent) -> Unit = {},
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mutex = Mutex()
    private val networkTransitionMutex = Mutex()
    private val applicationControlGapStoreMutex = Mutex()
    private val threadDirectoryMutex = Mutex()
    private val networkTransitionGeneration = AtomicLong(0)
    private val started = AtomicBoolean(false)
    private var networkAvailable = networkMonitor.isAvailable()
    @Volatile
    private var files: MatrixAccountFiles? = null
    @Volatile
    private var secrets: PersistedMatrixSecrets? = null
    private var driver: MatrixSdkDriver? = null
    @Volatile
    private var driverGeneration = 0L
    private var retryJob: Job? = null
    private var watchdogJob: Job? = null
    private var applicationControlReceiverJob: Job? = null
    private var applicationControlGapJob: Job? = null
    private var applicationControlReady = CompletableDeferred<Unit>()
    @Volatile
    private var applicationControlTransportIdentity: MatrixTransportIdentity? = null
    @Volatile
    private var applicationControlReceiverReady = false
    @Volatile
    private var applicationControlSince: String? = null
    @Volatile
    private var applicationControlLastProgressAt = 0L

    val status: MatrixRuntimeStatus
        get() = stateMachine.status

    val commandTransportReady: Boolean
        get() = applicationControlReceiverReady

    fun start() {
        if (!started.compareAndSet(false, true)) return
        diagnostics.record("matrix.runtime.start")
        accept(MatrixRuntimeEvent.Start(hasSession = true, networkAvailable))
        networkMonitor.start(::onNetworkChanged)
        scope.launch {
            try {
                mutex.withLock {
                    restorePersistedSessionLocked()
                    accept(MatrixRuntimeEvent.Start(secrets != null, networkAvailable))
                    if (secrets != null && networkAvailable) runCatching { connectLocked() }
                }
            } catch (error: Exception) {
                diagnostics.record("matrix.recovery.failure", errorAttributes(error))
                accept(
                    MatrixRuntimeEvent.Failed("matrix_recovery_blocked", blocked = true),
                )
            }
        }
        watchdogJob = scope.launch {
            while (isActive) {
                delay(WATCHDOG_INTERVAL_MS)
                mutex.withLock {
                    val currentDriver = driver
                    if (
                        started.get() &&
                        networkAvailable &&
                        secrets != null &&
                        applicationControlReceiverIsStale(
                            lastProgressAt = applicationControlLastProgressAt,
                            now = elapsedRealtime(),
                            timeoutMs = APPLICATION_CONTROL_STALE_TIMEOUT_MS,
                        )
                    ) {
                        diagnostics.record(
                            "matrix.application_control.watchdog_stale",
                            mapOf("stage" to if (applicationControlReceiverReady) "ready" else "starting"),
                        )
                        if (!restartApplicationControlReceiverLocked("watchdog_stale")) {
                            restartTransportLocked("matrix_application_control_stale")
                        }
                        return@withLock
                    }
                    val running = runCatching {
                        currentDriver?.isSyncRunning() == true
                    }.getOrDefault(false)
                    val reason = if (started.get() && networkAvailable && secrets != null) {
                        liveness.restartReason(
                            running,
                            stateMachine.status.phase,
                            internallySupervised = currentDriver?.hasInternalSyncSupervision() == true,
                        )
                    } else {
                        null
                    }
                    if (reason != null) {
                        val decision = MatrixSyncRestartPolicy.decide(reason)
                        diagnostics.record(
                            "matrix.watchdog.failure",
                            mapOf(
                                "reason" to reason.name,
                                "running" to running.toString(),
                            ),
                        )
                        accept(MatrixRuntimeEvent.Failed(decision.detailCode, decision.blocked))
                        val staleDriver = driver
                        stopApplicationControlReceiverLocked()
                        driver = null
                        driverGeneration += 1
                        applicationControlTransportIdentity = null
                        if (staleDriver != null) stopDriver(staleDriver)
                        if (!decision.blocked) scheduleRetryLocked()
                    }
                }
            }
        }
    }

    internal fun injectNetworkAvailabilityForE2e(available: Boolean) {
        check(BuildConfig.ALLOW_INSECURE_E2E_LOOPBACK) {
            "Synthetic network transitions are available only in E2E builds."
        }
        diagnostics.record(
            "matrix.network.e2e_injected",
            mapOf("available" to available.toString()),
        )
        onNetworkChanged(available)
    }

    fun onSystemWake(reason: String) {
        val safeReason = reason
            .replace(Regex("[^A-Za-z0-9._:+/-]"), "_")
            .take(160)
            .ifBlank { "unspecified" }
        scope.launch {
            val requestConvergence = mutex.withLock {
                if (!started.get() || !networkAvailable || secrets == null) return@withLock false
                val stale = applicationControlReceiverIsStale(
                    lastProgressAt = applicationControlLastProgressAt,
                    now = elapsedRealtime(),
                    timeoutMs = APPLICATION_CONTROL_STALE_TIMEOUT_MS,
                )
                diagnostics.record(
                    "matrix.system_wake",
                    mapOf(
                        "reason" to safeReason,
                        "stage" to if (stale) "restart" else "converge",
                    ),
                )
                if (stale) {
                    if (restartApplicationControlReceiverLocked("system_wake_$safeReason")) {
                        true
                    } else {
                        restartTransportLocked("matrix_system_wake_recovery")
                        false
                    }
                } else {
                    true
                }
            }
            if (requestConvergence) onConvergenceRequired("system_wake_$safeReason")
        }
    }

    suspend fun bootstrap(input: MatrixBootstrap): PublicMatrixSession = scope.async {
        mutex.withLock { bootstrapLocked(input) }
    }.await()

    suspend fun issueLoginToken(password: String?): MatrixLoginTokenIssueResult = scope.async {
        val session = mutex.withLock {
            check(started.get()) { "The native Matrix runtime is stopped." }
            if (!networkAvailable) throw MatrixOfflineException()
            secrets?.session
                ?: throw IllegalStateException("The native Matrix session is unavailable.")
        }
        withTimeout(LOGIN_TOKEN_OPERATION_TIMEOUT_MS) {
            loginTokenIssueClient.issue(session, password)
        }
    }.await()

    suspend fun sendPairingMessage(contentJson: String) = scope.async {
        val current = mutex.withLock {
            check(started.get()) { "The native Matrix runtime is stopped." }
            if (!networkAvailable) throw MatrixOfflineException()
            driver ?: throw IllegalStateException("The native Matrix connection is not ready.")
        }
        withTimeout(SEND_OPERATION_TIMEOUT_MS) {
            current.sendPairingMessage(contentJson)
        }
    }.await()

    suspend fun closePairingChannel() = scope.async {
        val current = mutex.withLock { driver } ?: return@async
        withTimeout(SEND_OPERATION_TIMEOUT_MS) {
            current.closePairingChannel()
        }
    }.await()

    suspend fun sendApplicationControlEvent(contentJson: String, transactionId: String): String = scope.async {
        val session = mutex.withLock {
            check(started.get()) { "The native Matrix runtime is stopped." }
            if (!networkAvailable) throw MatrixOfflineException()
            secrets?.session
                ?: throw IllegalStateException("The native Matrix session is unavailable.")
        }
        // Application-control commands are signed by Codever and sent through
        // an independent Matrix HTTP client. Do not couple this durable outbound
        // lane to the inbound SDK sync driver's current generation: a stalled
        // /sync may restart that driver while the homeserver's send endpoint is
        // still healthy. New commands are already gated on an authenticated,
        // synchronized Gateway state by NativeClientRuntime; persisted recovery
        // commands must remain able to retry during an inbound-sync restart.
        withTimeout(SEND_OPERATION_TIMEOUT_MS) {
            applicationControlClient.send(session, contentJson, transactionId)
        }
    }.await()

    suspend fun uploadMedia(mimeType: String, bytes: ByteArray): String = scope.async {
        val current = mutex.withLock {
            check(started.get()) { "The native Matrix runtime is stopped." }
            if (!networkAvailable) throw MatrixOfflineException()
            driver ?: throw IllegalStateException("The native Matrix connection is not ready.")
        }
        withTimeout(MEDIA_OPERATION_TIMEOUT_MS) {
            current.uploadMedia(mimeType, bytes)
        }
    }.await()

    suspend fun downloadMedia(url: String): ByteArray = scope.async {
        val current = mutex.withLock {
            check(started.get()) { "The native Matrix runtime is stopped." }
            if (!networkAvailable) throw MatrixOfflineException()
            driver ?: throw IllegalStateException("The native Matrix connection is not ready.")
        }
        withTimeout(MEDIA_OPERATION_TIMEOUT_MS) {
            current.downloadMedia(url)
        }
    }.await()

    suspend fun profileProperty(userId: String, key: String) = scope.async {
        val session = mutex.withLock {
            check(started.get()) { "The native Matrix runtime is stopped." }
            if (!networkAvailable) throw MatrixOfflineException()
            secrets?.session
                ?: throw IllegalStateException("The native Matrix session is unavailable.")
        }
        withTimeout(PROFILE_OPERATION_TIMEOUT_MS) {
            profileClient.get(session, userId, key)
        }
    }.await()

    suspend fun revokeSession() = scope.async {
        val current = mutex.withLock {
            check(started.get()) { "The native Matrix runtime is stopped." }
            if (!networkAvailable) {
                throw MatrixOfflineException("The native Matrix session must be online before revocation.")
            }
            driver
                ?: throw IllegalStateException("The native Matrix session is not ready for revocation.")
        }
        // Preserve recoverable local credentials until the homeserver confirms
        // logout. The network operation must not hold the lifecycle mutex.
        withTimeout(LOGOUT_OPERATION_TIMEOUT_MS) {
            current.logout()
        }
        mutex.withLock {
            check(driver === current) { "The Matrix connection changed while revocation was in progress." }
            retryJob?.cancel()
            retryJob = null
            watchdogJob?.cancel()
            watchdogJob = null
            networkMonitor.stop()
            stopApplicationControlReceiverLocked()
            stopDriver(current)
            driver = null
            driverGeneration += 1
            applicationControlTransportIdentity = null
            files?.let(accountStorage::clear)
            secrets?.sdkStoreKey?.fill(0)
            secrets = null
            files = null
            liveness.reset()
            started.set(false)
            accept(MatrixRuntimeEvent.Stop)
        }
    }.await()

    private suspend fun bootstrapLocked(input: MatrixBootstrap): PublicMatrixSession {
        check(started.get()) { "The persistent native runtime must be started before bootstrap." }
        MatrixIdentifiers.validateBootstrap(input)
        restorePersistedSessionLocked()
        secrets?.session?.let { existing ->
            require(
                MatrixIdentifiers.normalizeHomeserver(existing.homeserverUrl) ==
                    MatrixIdentifiers.normalizeHomeserver(input.homeserver) &&
                    existing.userId == input.expectedUserId &&
                    existing.roomBinding == input.roomBinding,
            ) { "A different Matrix session is already active." }
            return existing.toPublic()
        }

        accept(MatrixRuntimeEvent.BootstrapStarted)
        val session = try {
            loginClient.exchange(input)
        } catch (error: Exception) {
            accept(
                MatrixRuntimeEvent.Failed(
                    detailCode = if ((error as? MatrixLoginException)?.retryable == true) {
                        "matrix_login_retryable"
                    } else {
                        "matrix_login_rejected"
                    },
                    blocked = (error as? MatrixLoginException)?.retryable != true,
                ),
            )
            throw error
        }
        val candidateFiles = accountStorage.forSession(session)
        // Never delete the only durable login before its atomic replacement is
        // ready. A process death in this window previously left Gateway trust
        // intact but made the Matrix session impossible to restore.
        accountStorage.prepareForBootstrap(candidateFiles)
        applicationControlSince = null
        val nextFiles = accountStorage.forSession(session)
        val nextSecrets = PersistedMatrixSecrets(
            sdkStoreKey = EncryptedMatrixSessionStore.newStoreKey(),
            session = session,
        )
        nextFiles.sessionStore.save(nextSecrets)
        files = nextFiles
        secrets = nextSecrets
        accept(MatrixRuntimeEvent.SessionReady(networkAvailable))
        if (networkAvailable) connectLocked()
        return session.toPublic()
    }

    fun publicSession(): PublicMatrixSession? = secrets?.session?.toPublic()

    suspend fun refreshApplicationProjection() {
        val session = secrets?.session
            ?: throw MatrixOfflineException("The Matrix session is unavailable.")
        val accepted = refreshApplicationProjectionBaseline(session)
        val threads = refreshThreadDirectory(session)
        diagnostics.record(
            "matrix.application_state.refreshed",
            mapOf(
                "accepted" to accepted.toString(),
                "threads" to threads.toString(),
            ),
        )
    }

    suspend fun refreshThreadDirectory(): Int {
        val session = mutex.withLock {
            check(started.get()) { "The native Matrix runtime is stopped." }
            if (!networkAvailable) throw MatrixOfflineException()
            secrets?.session ?: throw MatrixOfflineException("The Matrix session is unavailable.")
        }
        return refreshThreadDirectory(session)
    }

    suspend fun fetchApplicationEvent(eventId: String): MatrixDecryptedEvent {
        val session = mutex.withLock {
            check(started.get()) { "The native Matrix runtime is stopped." }
            if (!networkAvailable) throw MatrixOfflineException()
            secrets?.session ?: throw MatrixOfflineException("The Matrix session is unavailable.")
        }
        return withTimeout(HISTORY_OPERATION_TIMEOUT_MS) {
            applicationEventClient.event(session, eventId)
        }
    }

    suspend fun loadThreadHistory(
        threadRootEventId: String,
        from: String?,
        limit: Int,
    ): MatrixThreadHistoryBatch {
        val session = mutex.withLock {
            check(started.get()) { "The native Matrix runtime is stopped." }
            if (!networkAvailable) throw MatrixOfflineException()
            secrets?.session ?: throw MatrixOfflineException("The Matrix session is unavailable.")
        }
        diagnostics.record(
            "matrix.thread_history.requested",
            mapOf("paged" to (from != null).toString(), "limit" to limit.toString()),
        )
        return try {
            withTimeout(HISTORY_OPERATION_TIMEOUT_MS) {
                threadHistoryClient.page(session, threadRootEventId, from, limit)
            }.also { batch ->
                diagnostics.record(
                    "matrix.thread_history.received",
                    mapOf(
                        "events" to batch.events.size.toString(),
                        "has_more" to (batch.nextBatch != null).toString(),
                    ),
                )
            }
        } catch (error: TimeoutCancellationException) {
            diagnostics.record(
                "matrix.thread_history.failed",
                mapOf("type" to error::class.java.simpleName),
            )
            throw error
        } catch (error: CancellationException) {
            diagnostics.record("matrix.thread_history.cancelled")
            throw error
        } catch (error: Exception) {
            diagnostics.record(
                "matrix.thread_history.failed",
                mapOf("type" to error::class.java.simpleName),
            )
            throw error
        }
    }

    suspend fun stop(clearSession: Boolean) = mutex.withLock {
        if (!started.compareAndSet(true, false)) return@withLock
        retryJob?.cancel()
        retryJob = null
        watchdogJob?.cancel()
        watchdogJob = null
        networkMonitor.stop()
        stopApplicationControlReceiverLocked()
        driver?.let { stopDriver(it) }
        driver = null
        driverGeneration += 1
        applicationControlTransportIdentity = null
        if (clearSession) {
            files?.let(accountStorage::clear)
            secrets?.sdkStoreKey?.fill(0)
            secrets = null
            files = null
            applicationControlSince = null
        }
        liveness.reset()
        accept(MatrixRuntimeEvent.Stop)
    }

    suspend fun close() {
        stop(clearSession = false)
        secrets?.sdkStoreKey?.fill(0)
        scope.cancel()
    }

    private fun onNetworkChanged(available: Boolean) {
        val transitionGeneration = networkTransitionGeneration.incrementAndGet()
        scope.launch {
            // ConnectivityManager may emit a rapid false/true burst when a
            // validated network changes capabilities. Serialize the matching
            // SDK controls so an older pause cannot finish after a newer
            // resume and leave native transport state inverted.
            networkTransitionMutex.withLock networkTransition@{
                if (transitionGeneration != networkTransitionGeneration.get()) {
                    diagnostics.record(
                        "matrix.network.coalesced",
                        mapOf("available" to available.toString()),
                    )
                    return@networkTransition
                }
                val currentDriver = mutex.withLock {
                    networkAvailable = available
                    diagnostics.record(
                        "matrix.network.changed",
                        mapOf("available" to available.toString()),
                    )
                    if (!available) accept(MatrixRuntimeEvent.NetworkLost)
                    driver
                }
                if (transitionGeneration != networkTransitionGeneration.get()) {
                    return@networkTransition
                }
                if (!available) {
                    try {
                        withTimeout(NETWORK_CONTROL_TIMEOUT_MS) {
                            currentDriver?.setNetworkAvailable(false)
                        }
                    } catch (error: CancellationException) {
                        throw error
                    } catch (error: Exception) {
                        diagnostics.record("matrix.network.pause_failure", errorAttributes(error))
                    }
                    return@networkTransition
                }
                val resumeError = try {
                    withTimeout(NETWORK_CONTROL_TIMEOUT_MS) {
                        currentDriver?.setNetworkAvailable(true)
                    }
                    null
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    error
                }
                if (transitionGeneration != networkTransitionGeneration.get()) {
                    return@networkTransition
                }
                val recovered = mutex.withLock runtimeState@{
                    if (transitionGeneration != networkTransitionGeneration.get()) {
                        return@runtimeState false
                    }
                    if (!started.get() || !networkAvailable) return@runtimeState false
                    if (currentDriver != null && driver !== currentDriver) {
                        return@runtimeState false
                    }
                    if (resumeError != null && currentDriver != null) {
                        diagnostics.record(
                            "matrix.network.resume_failure",
                            errorAttributes(resumeError),
                        )
                        accept(
                            MatrixRuntimeEvent.Failed(
                                "matrix_send_queue_resume_failed",
                                blocked = false,
                            ),
                        )
                        stopApplicationControlReceiverLocked()
                        stopDriver(currentDriver)
                        if (driver === currentDriver) {
                            driver = null
                            driverGeneration += 1
                            applicationControlTransportIdentity = null
                        }
                        scheduleRetryLocked()
                        return@runtimeState false
                    }
                    val running = runCatching {
                        driver?.isSyncRunning() == true
                    }.getOrDefault(false)
                    accept(MatrixRuntimeEvent.NetworkAvailable(syncRunning = running))
                    if (running) {
                        liveness.syncUpdated()
                    } else if (started.get() && secrets != null) {
                        runCatching { connectLocked() }
                    }
                    true
                }
                if (!recovered || transitionGeneration != networkTransitionGeneration.get()) {
                    return@networkTransition
                }
                if (resumeError == null && currentDriver != null) {
                    onConvergenceRequired("network_recovered")
                }
            }
        }
    }

    private fun restorePersistedSessionLocked() {
        if (secrets != null) return
        val currentFiles = accountStorage.findCurrent()
        if (currentFiles == null) {
            diagnostics.record("matrix.session.restore", mapOf("stage" to "missing"))
            return
        }
        val loaded = currentFiles.sessionStore.load()
        if (loaded == null) {
            diagnostics.record("matrix.session.restore", mapOf("stage" to "missing"))
            return
        }
        check(
            MatrixIdentifiers.accountStoreName(
                loaded.session.homeserverUrl,
                loaded.session.userId,
            ) == currentFiles.accountScope,
        ) { "Encrypted Matrix session is bound to a different account scope." }
        check(loaded.session.slidingSyncVersion == org.matrix.rustcomponents.sdk.SlidingSyncVersion.NATIVE) {
            "The stored Matrix session uses an unsupported sync format. Pair this APK again."
        }
        files = currentFiles
        secrets = loaded
        applicationControlSince = currentFiles.applicationControlCursor.load()
        // Validate the encrypted recovery queue before any receiver coroutine
        // can fail out-of-band. Corruption must become a visible blocked state,
        // never an unexplained permanent "Syncing conversations" screen.
        currentFiles.applicationControlGaps.load()
        diagnostics.record("matrix.session.restore", mapOf("stage" to "restored"))
    }

    private suspend fun connectLocked() {
        val currentSecrets = secrets ?: return
        val currentFiles = files ?: return
        if (!networkAvailable || !started.get()) return
        retryJob?.cancel()
        retryJob = null
        stopApplicationControlReceiverLocked()
        driver?.let { stopDriver(it) }
        driver = null
        driverGeneration += 1
        applicationControlTransportIdentity = null
        val generation = driverGeneration
        val nextDriver = try {
            driverFactory.create(scope)
        } catch (error: Exception) {
            accept(
                MatrixRuntimeEvent.Failed("matrix_driver_create_failed", blocked = false),
            )
            scheduleRetryLocked()
            throw error
        }
        driver = nextDriver
        applicationControlLastProgressAt = elapsedRealtime()
        liveness.connectionStarted()
        accept(MatrixRuntimeEvent.SessionReady(networkAvailable = true))
        try {
            withTimeout(DRIVER_START_TIMEOUT_MS) {
                nextDriver.start(
                    secrets = currentSecrets,
                    files = currentFiles,
                    onSyncUpdate = {
                        scope.launch {
                            mutex.withLock {
                                if (driver === nextDriver && driverGeneration == generation) {
                                    liveness.syncUpdated()
                                    retryJob?.cancel()
                                    retryJob = null
                                    accept(MatrixRuntimeEvent.SyncUpdated)
                                }
                            }
                        }
                    },
                    onSessionUpdated = { updated ->
                        scope.launch {
                            mutex.withLock {
                                if (driver === nextDriver && driverGeneration == generation) {
                                    val updatedSecrets = PersistedMatrixSecrets(
                                        currentSecrets.sdkStoreKey,
                                        updated,
                                    )
                                    currentFiles.sessionStore.save(updatedSecrets)
                                    secrets = updatedSecrets
                                }
                            }
                        }
                    },
                    onTransportReady = { identity ->
                        scope.launch {
                            val current = mutex.withLock {
                                if (driver === nextDriver && driverGeneration == generation) {
                                    applicationControlTransportIdentity = identity
                                    startApplicationControlReceiverLocked(
                                        currentSecrets.session,
                                        currentFiles,
                                        generation,
                                        identity,
                                    )
                                    true
                                } else {
                                    false
                                }
                            }
                            // Pairing uses the SDK's encrypted room timeline and
                            // must not wait for the separate application-control
                            // /sync cursor used by already trusted commands.
                            if (current) onPairingTransportReady(identity)
                        }
                    },
                    onPairingEvent = onDecryptedEvent,
                    onRuntimeFailure = { error ->
                        diagnostics.record("matrix.driver.runtime_failure", errorAttributes(error))
                        scope.launch {
                            mutex.withLock {
                                if (driver === nextDriver && driverGeneration == generation) {
                                    val decision = MatrixRuntimeFailurePolicy.decide(error)
                                    accept(
                                        MatrixRuntimeEvent.Failed(
                                            decision.detailCode,
                                            blocked = decision.blocked,
                                        ),
                                    )
                                    stopApplicationControlReceiverLocked()
                                    stopDriver(nextDriver)
                                    driver = null
                                    driverGeneration += 1
                                    applicationControlTransportIdentity = null
                                    if (!decision.blocked) scheduleRetryLocked()
                                }
                            }
                        }
                    },
                )
            }
            accept(MatrixRuntimeEvent.SyncStarted)
        } catch (error: Exception) {
            diagnostics.record("matrix.driver.start_failure", errorAttributes(error))
            stopApplicationControlReceiverLocked()
            stopDriver(nextDriver)
            if (driver === nextDriver && driverGeneration == generation) {
                driver = null
                driverGeneration += 1
                applicationControlTransportIdentity = null
            }
            val decision = if (error is TimeoutCancellationException) {
                MatrixRuntimeFailureDecision("matrix_driver_start_timeout", blocked = false)
            } else {
                MatrixRuntimeFailurePolicy.decide(error).let {
                    if (it.blocked) it else it.copy(detailCode = "matrix_restore_or_sync_failed")
                }
            }
            accept(MatrixRuntimeEvent.Failed(decision.detailCode, decision.blocked))
            if (!decision.blocked) scheduleRetryLocked()
            throw error
        }
    }

    private fun startApplicationControlReceiverLocked(
        session: StoredMatrixSession,
        currentFiles: MatrixAccountFiles,
        generation: Long,
        identity: MatrixTransportIdentity,
    ) {
        if (applicationControlReceiverJob?.isActive == true) return
        applicationControlReceiverReady = false
        applicationControlLastProgressAt = elapsedRealtime()
        val ready = applicationControlReady
        diagnostics.record("matrix.application_control.receiver_starting")
        applicationControlReceiverJob = scope.launch {
            var since = applicationControlSince
            var consecutiveFailures = 0
            while (isActive) {
                try {
                    val accepted = refreshApplicationProjectionBaseline(session)
                    val threads = refreshThreadDirectory(session)
                    applicationControlLastProgressAt = elapsedRealtime()
                    diagnostics.record(
                        "matrix.application_state.current_received",
                        mapOf(
                            "candidates" to accepted.toString(),
                            "accepted" to accepted.toString(),
                            "threads" to threads.toString(),
                        ),
                    )
                    break
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    applicationControlLastProgressAt = elapsedRealtime()
                    val cursorRebuildReason = applicationControlCursorResetReason(error, since)
                    if (cursorRebuildReason != null) {
                        applicationControlGapStoreMutex.withLock {
                            currentFiles.applicationControlCursor.clear()
                            currentFiles.applicationControlGaps.clear()
                            since = null
                            applicationControlSince = null
                        }
                        diagnostics.record(
                            "matrix.application_control.cursor_rebuilt",
                            mapOf("reason" to cursorRebuildReason),
                        )
                        onConvergenceRequired("application_control_cursor_rebuilt")
                        consecutiveFailures = 0
                        continue
                    }
                    if (error is MatrixApplicationControlPayloadException) {
                        diagnostics.record(
                            "matrix.application_state.current_rejected",
                            errorAttributes(error),
                        )
                        ready.completeExceptionally(error)
                        scope.launch {
                            mutex.withLock {
                                if (driverGeneration == generation) {
                                    accept(MatrixRuntimeEvent.Failed(
                                        "matrix_application_state_malformed",
                                        blocked = true,
                                    ))
                                }
                            }
                        }
                        return@launch
                    }
                    if (error is MatrixApplicationControlSyncException && error.fatal) {
                        ready.completeExceptionally(error)
                        scope.launch {
                            mutex.withLock {
                                if (driverGeneration == generation) {
                                    accept(MatrixRuntimeEvent.Failed(
                                        "matrix_application_state_rejected",
                                        blocked = true,
                                    ))
                                }
                            }
                        }
                        return@launch
                    }
                    consecutiveFailures += 1
                    diagnostics.record(
                        "matrix.application_state.current_retry",
                        errorAttributes(error),
                    )
                    delay(
                        (error as? MatrixApplicationControlSyncException)?.retryAfterMs
                            ?: APPLICATION_CONTROL_RETRY_BASE_MS *
                                consecutiveFailures.coerceAtMost(
                                    APPLICATION_CONTROL_MAX_RETRY_MULTIPLIER,
                                ),
                    )
                }
            }
            consecutiveFailures = 0
            startApplicationControlGapRecovery(
                session = session,
                currentFiles = currentFiles,
                generation = generation,
            )
            while (isActive) {
                val batch = try {
                    // A persisted cursor makes this a live sync, but readiness must not
                    // wait for an empty long poll. Confirm the cursor immediately, then
                    // use long polling only after the receiver is ready.
                    applicationControlSyncClient.sync(
                        session,
                        since,
                        longPoll = ready.isCompleted,
                    )
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    applicationControlLastProgressAt = elapsedRealtime()
                    if (error is MatrixApplicationControlPayloadException) {
                        diagnostics.record(
                            "matrix.application_control.receiver_rejected",
                            errorAttributes(error),
                        )
                        ready.completeExceptionally(error)
                        scope.launch {
                            mutex.withLock {
                                if (driverGeneration == generation) {
                                    accept(MatrixRuntimeEvent.Failed(
                                        "matrix_application_control_malformed",
                                        blocked = true,
                                    ))
                                }
                            }
                        }
                        return@launch
                    }
                    if (
                        error is MatrixApplicationControlSyncException &&
                        error.fatal
                    ) {
                        diagnostics.record(
                            "matrix.application_control.receiver_rejected",
                            errorAttributes(error),
                        )
                        ready.completeExceptionally(error)
                        scope.launch {
                            mutex.withLock {
                                if (driverGeneration == generation) {
                                    accept(
                                        MatrixRuntimeEvent.Failed(
                                            "matrix_application_control_sync_rejected",
                                            blocked = true,
                                        ),
                                    )
                                }
                            }
                        }
                        return@launch
                    }
                    if (error is MatrixApplicationControlResponseTooLargeException) {
                        diagnostics.record(
                            "matrix.application_control.receiver_rejected",
                            mapOf(
                                "error" to error.javaClass.simpleName,
                                "reason" to if (since == null) {
                                    "baseline_response_too_large"
                                } else {
                                    "incremental_response_too_large"
                                },
                            ),
                        )
                        ready.completeExceptionally(error)
                        scope.launch {
                            mutex.withLock {
                                if (driverGeneration == generation) {
                                    accept(
                                        MatrixRuntimeEvent.Failed(
                                            if (since == null) {
                                                "matrix_application_control_baseline_too_large"
                                            } else {
                                                "matrix_application_control_incremental_too_large"
                                            },
                                            blocked = true,
                                        ),
                                    )
                                }
                            }
                        }
                        return@launch
                    }
                    consecutiveFailures += 1
                    diagnostics.record(
                        "matrix.application_control.receiver_retry",
                        errorAttributes(error),
                    )
                    val requestedDelay =
                        (error as? MatrixApplicationControlSyncException)?.retryAfterMs
                    delay(
                        requestedDelay ?: (
                            APPLICATION_CONTROL_RETRY_BASE_MS *
                                consecutiveFailures.coerceAtMost(
                                    APPLICATION_CONTROL_MAX_RETRY_MULTIPLIER,
                                )
                            ),
                    )
                    continue
                }
                applicationControlLastProgressAt = elapsedRealtime()
                if (!started.get() || driverGeneration != generation) return@launch
                consecutiveFailures = 0
                val establishingCursor = since == null
                if (batch.limited && since != null) {
                    val boundary = checkNotNull(batch.prevBatch) {
                        "Limited Matrix control sync has no previous-batch boundary."
                    }
                    enqueueApplicationControlGap(
                        currentFiles.applicationControlGaps,
                        MatrixSyncGap(from = since, to = boundary),
                    )
                    diagnostics.record("matrix.application_control.gap_persisted")
                    startApplicationControlGapRecovery(
                        session = session,
                        currentFiles = currentFiles,
                        generation = generation,
                    )
                }
                if (batch.events.isNotEmpty()) {
                    diagnostics.record(
                        if (establishingCursor) {
                            "matrix.application_control.catchup_received"
                        } else {
                            "matrix.application_control.batch_received"
                        },
                        mapOf(
                            "candidates" to batch.candidateEventCount.toString(),
                            "accepted" to batch.events.size.toString(),
                        ),
                    )
                }
                val processed = processMatrixApplicationEventBatch(
                    events = batch.events,
                    onEvent = onDecryptedEvent,
                    onCommitted = { event ->
                        diagnostics.record(
                            "matrix.application_control.event_committed",
                            mapOf("kind" to codeverApplicationEventKind(event.rawJson)),
                        )
                    },
                    onQuarantined = { event, error ->
                        diagnostics.record(
                            "matrix.application_control.event_quarantined",
                            mapOf(
                                "kind" to codeverApplicationEventKind(event.rawJson),
                                "error" to error.javaClass.simpleName.take(160),
                                "fingerprint" to matrixApplicationEventFingerprint(event),
                            ),
                        )
                    },
                )
                // Commit the Matrix cursor only after every accepted event has
                // either completed its authenticated local transition or been
                // identified as poison after an ordering retry. A process exit
                // before this point makes Matrix redeliver the batch; projection and
                // history stores deduplicate it.
                since = batch.nextBatch
                currentFiles.applicationControlCursor.save(since)
                applicationControlSince = since
                if (processed.quarantined > 0) {
                    diagnostics.record(
                        "matrix.application_control.batch_quarantined",
                        mapOf(
                            "accepted" to processed.committed.toString(),
                            "quarantined" to processed.quarantined.toString(),
                        ),
                    )
                    onConvergenceRequired("application_control_event_quarantined")
                }
                if (batch.limited) {
                    diagnostics.record("matrix.application_control.gap_detected")
                    onConvergenceRequired("application_control_limited")
                }
                if (ready.complete(Unit)) {
                    applicationControlReceiverReady = true
                    diagnostics.record("matrix.application_control.receiver_ready")
                    onTransportReady(identity)
                }
            }
        }
    }

    private suspend fun refreshApplicationProjectionBaseline(session: StoredMatrixSession): Int {
        // A cursor-independent baseline recovers current CVP/3 key/discovery
        // state plus the latest bounded timeline window. It does not publish a
        // synthetic checkpoint and never advances the durable live cursor.
        val batch = applicationControlSyncClient.sync(session, since = null, longPoll = false)
        val processed = processMatrixApplicationEventBatch(
            events = batch.events,
            onEvent = onDecryptedEvent,
            onQuarantined = { event, error ->
                diagnostics.record(
                    "matrix.v3_baseline.event_quarantined",
                    mapOf(
                        "kind" to codeverApplicationEventKind(event.rawJson),
                        "error" to error.javaClass.simpleName.take(160),
                    ),
                )
            },
        )
        if (processed.quarantined > 0) onConvergenceRequired("v3_baseline_event_quarantined")
        return processed.committed
    }

    private suspend fun refreshThreadDirectory(session: StoredMatrixSession): Int =
        threadDirectoryMutex.withLock {
            withTimeout(THREAD_DIRECTORY_OPERATION_TIMEOUT_MS) {
                var from: String? = null
                val seenTokens = mutableSetOf<String>()
                var accepted = 0
                repeat(MAX_THREAD_DIRECTORY_PAGES) {
                    val page = threadDirectoryClient.page(session, from)
                    val processed = processMatrixApplicationEventBatch(
                        events = page.latestEvents,
                        onEvent = onDecryptedEvent,
                        onQuarantined = { event, error ->
                            diagnostics.record(
                                "matrix.thread_directory.event_quarantined",
                                mapOf(
                                    "kind" to codeverApplicationEventKind(event.rawJson),
                                    "error" to error.javaClass.simpleName.take(160),
                                ),
                            )
                        },
                    )
                    accepted += processed.committed
                    val next = page.nextBatch ?: return@withTimeout accepted
                    require(seenTokens.add(next)) {
                        "The Matrix thread directory repeated a pagination token."
                    }
                    from = next
                }
                throw MatrixApplicationControlPayloadException(
                    "The Matrix thread directory exceeded the session safety limit.",
                )
            }
        }

    private fun stopApplicationControlReceiverLocked() {
        applicationControlReceiverReady = false
        applicationControlLastProgressAt = 0L
        applicationControlReceiverJob?.cancel()
        applicationControlReceiverJob = null
        applicationControlGapJob?.cancel()
        applicationControlGapJob = null
        applicationControlReady.cancel()
        applicationControlReady = CompletableDeferred()
    }

    private fun startApplicationControlGapRecovery(
        session: StoredMatrixSession,
        currentFiles: MatrixAccountFiles,
        generation: Long,
    ) {
        if (applicationControlGapJob?.isActive == true) return
        if (currentFiles.applicationControlGaps.load().isEmpty()) return
        applicationControlGapJob = scope.launch {
            var consecutiveFailures = 0
            while (isActive && started.get() && driverGeneration == generation) {
                val gap = currentFiles.applicationControlGaps.load().firstOrNull() ?: break
                try {
                    val page = applicationTimelineClient.page(
                        session = session,
                        from = gap.cursor,
                        to = gap.to,
                    )
                    applicationControlLastProgressAt = elapsedRealtime()
                    diagnostics.record(
                        "matrix.application_control.gap_page_received",
                        mapOf(
                            "candidates" to page.candidateEventCount.toString(),
                            "accepted" to page.events.size.toString(),
                        ),
                    )
                    val processed = processMatrixApplicationEventBatch(
                        events = page.events,
                        onEvent = onDecryptedEvent,
                        onCommitted = { event ->
                            diagnostics.record(
                                "matrix.application_control.gap_event_committed",
                                mapOf("kind" to codeverApplicationEventKind(event.rawJson)),
                            )
                        },
                        onQuarantined = { event, error ->
                            diagnostics.record(
                                "matrix.application_control.gap_event_quarantined",
                                mapOf(
                                    "kind" to codeverApplicationEventKind(event.rawJson),
                                    "error" to error.javaClass.simpleName.take(160),
                                    "fingerprint" to matrixApplicationEventFingerprint(event),
                                ),
                            )
                        },
                    )
                    applicationControlGapStoreMutex.withLock {
                        val queue = currentFiles.applicationControlGaps.load()
                        val currentIndex = queue.indexOfFirst {
                            it.from == gap.from && it.to == gap.to
                        }
                        if (currentIndex >= 0) {
                            val next = queue.toMutableList()
                            if (page.nextFrom == null) {
                                next.removeAt(currentIndex)
                                diagnostics.record("matrix.application_control.gap_closed")
                            } else {
                                next[currentIndex] = gap.copy(cursor = page.nextFrom)
                                diagnostics.record("matrix.application_control.gap_cursor_committed")
                            }
                            currentFiles.applicationControlGaps.save(next)
                        }
                    }
                    if (processed.quarantined > 0) {
                        diagnostics.record(
                            "matrix.application_control.gap_quarantined",
                            mapOf(
                                "accepted" to processed.committed.toString(),
                                "quarantined" to processed.quarantined.toString(),
                            ),
                        )
                        onConvergenceRequired("application_control_gap_event_quarantined")
                    }
                    consecutiveFailures = 0
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    applicationControlLastProgressAt = elapsedRealtime()
                    consecutiveFailures += 1
                    diagnostics.record(
                        "matrix.application_control.gap_retry",
                        errorAttributes(error),
                    )
                    delay(
                        (error as? MatrixApplicationControlSyncException)?.retryAfterMs
                            ?: APPLICATION_CONTROL_RETRY_BASE_MS *
                                consecutiveFailures.coerceAtMost(
                                    APPLICATION_CONTROL_MAX_RETRY_MULTIPLIER,
                                ),
                    )
                }
            }
        }
    }

    private suspend fun enqueueApplicationControlGap(
        store: MatrixSyncGapStore,
        gap: MatrixSyncGap,
    ) {
        while (true) {
            val committed = applicationControlGapStoreMutex.withLock {
                val current = store.load()
                if (current.any { it.from == gap.from && it.to == gap.to }) return@withLock true
                if (current.size >= MAX_APPLICATION_CONTROL_GAPS) return@withLock false
                store.save(current + gap)
                true
            }
            if (committed) return
            diagnostics.record("matrix.application_control.gap_backpressure")
            delay(250)
        }
    }

    private fun scheduleRetryLocked() {
        if (retryJob?.isActive == true || !networkAvailable || secrets == null || !started.get()) return
        diagnostics.record("matrix.retry.scheduled")
        retryJob = scope.launch {
            delay(retryDelayMs)
            mutex.withLock {
                retryJob = null
                if (networkAvailable && secrets != null && started.get()) {
                    runCatching { connectLocked() }
                }
            }
        }
    }

    /**
     * Android can strand the independent HTTP long poll while the Matrix SDK,
     * encryption store, and room subscription remain healthy. Resume only the
     * cursor-owned receiver. Reopening the complete SDK here turns an ordinary
     * screen-on into an unnecessary cold connection.
     */
    private fun restartApplicationControlReceiverLocked(reason: String): Boolean {
        val currentDriver = driver ?: return false
        val currentSecrets = secrets ?: return false
        val currentFiles = files ?: return false
        val identity = applicationControlTransportIdentity ?: return false
        if (!runCatching { currentDriver.isSyncRunning() }.getOrDefault(false)) return false

        diagnostics.record(
            "matrix.application_control.receiver_warm_restart",
            mapOf("reason" to reason.take(160)),
        )
        stopApplicationControlReceiverLocked()
        startApplicationControlReceiverLocked(
            currentSecrets.session,
            currentFiles,
            driverGeneration,
            identity,
        )
        liveness.syncUpdated()
        accept(MatrixRuntimeEvent.NetworkAvailable(syncRunning = true))
        return true
    }

    private suspend fun restartTransportLocked(detailCode: String) {
        accept(MatrixRuntimeEvent.Failed(detailCode, blocked = false))
        retryJob?.cancel()
        retryJob = null
        val staleDriver = driver
        stopApplicationControlReceiverLocked()
        driver = null
        driverGeneration += 1
        applicationControlTransportIdentity = null
        if (staleDriver != null) stopDriver(staleDriver)
        if (started.get() && networkAvailable && secrets != null) {
            runCatching { connectLocked() }
        }
    }

    private fun accept(event: MatrixRuntimeEvent): MatrixRuntimeStatus {
        val previous = stateMachine.status
        val next = stateMachine.accept(event)
        if (next != previous) {
            diagnostics.record(
                "matrix.state",
                mapOf(
                    "phase" to next.phase.name,
                    "detail" to next.detailCode,
                ),
            )
        }
        return next
    }

    private suspend fun stopDriver(current: MatrixSdkDriver) {
        try {
            withTimeout(DRIVER_STOP_TIMEOUT_MS) { current.stop() }
        } catch (_: TimeoutCancellationException) {
            diagnostics.record("matrix.driver.stop_timeout")
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            diagnostics.record("matrix.driver.stop_failure", errorAttributes(error))
        }
    }

    private fun errorAttributes(error: Throwable): Map<String, String> = buildMap {
        put(
            "error",
            error.javaClass.simpleName.replace(Regex("[^A-Za-z0-9._:+/-]"), "_").take(160),
        )
        if (error is MatrixApplicationControlSyncException) {
            put("status", error.status.toString())
            error.retryAfterMs?.let { put("retry_after_ms", it.toString()) }
        }
    }

    private fun StoredMatrixSession.toPublic() = PublicMatrixSession(
        homeserver = homeserverUrl,
        userId = userId,
        matrixDeviceId = deviceId,
        roomBinding = roomBinding,
    )

    private companion object {
        const val MAX_APPLICATION_CONTROL_GAPS = 64
        const val MAX_DIRECTORY_STABILITY_ATTEMPTS = 8
        const val WATCHDOG_INTERVAL_MS = 5_000L
        const val DRIVER_START_TIMEOUT_MS = 30_000L
        const val DRIVER_STOP_TIMEOUT_MS = 10_000L
        const val NETWORK_CONTROL_TIMEOUT_MS = 10_000L
        const val SEND_OPERATION_TIMEOUT_MS = 45_000L
        const val PROFILE_OPERATION_TIMEOUT_MS = 45_000L
        const val LOGIN_TOKEN_OPERATION_TIMEOUT_MS = 45_000L
        const val HISTORY_OPERATION_TIMEOUT_MS = 45_000L
        const val THREAD_DIRECTORY_OPERATION_TIMEOUT_MS = 120_000L
        const val MEDIA_OPERATION_TIMEOUT_MS = 120_000L
        const val LOGOUT_OPERATION_TIMEOUT_MS = 45_000L
        const val APPLICATION_CONTROL_RETRY_BASE_MS = 1_000L
        const val APPLICATION_CONTROL_MAX_RETRY_MULTIPLIER = 15
        const val APPLICATION_CONTROL_STALE_TIMEOUT_MS = 90_000L
        const val MAX_THREAD_DIRECTORY_PAGES = 1_000
    }
}

internal fun applicationControlReceiverIsStale(
    lastProgressAt: Long,
    now: Long,
    timeoutMs: Long,
): Boolean {
    if (lastProgressAt <= 0L) return false
    return now - lastProgressAt >= timeoutMs
}
