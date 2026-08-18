package id.my.anciety.codever.matrix

import android.content.Context
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
    private val applicationRoomStateClient: MatrixApplicationRoomStateClient =
        MatrixApplicationRoomStateClient(),
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
    private val onPairingTransportReady: (MatrixTransportIdentity) -> Unit = {},
    private val onTransportReady: (MatrixTransportIdentity) -> Unit = {},
    private val onConvergenceRequired: (String) -> Unit = {},
    private val onDecryptedEvent: suspend (MatrixDecryptedEvent) -> Unit = {},
    private val onAuthoritativeRoomState: suspend (List<MatrixDecryptedEvent>) -> Unit = {
        events -> for (event in events) onDecryptedEvent(event)
    },
) {
    private data class ApplicationControlSendContext(
        val session: StoredMatrixSession,
        val generation: Long,
        val ready: CompletableDeferred<Unit>,
    )

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mutex = Mutex()
    private val networkTransitionMutex = Mutex()
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
    private var applicationControlReady = CompletableDeferred<Unit>()
    @Volatile
    private var applicationControlReceiverReady = false
    @Volatile
    private var applicationControlSince: String? = null

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

    suspend fun sendApplicationControlEvent(contentJson: String, transactionId: String): Unit = scope.async {
        val context = mutex.withLock {
            check(started.get()) { "The native Matrix runtime is stopped." }
            if (!networkAvailable) throw MatrixOfflineException()
            if (driver == null) {
                throw IllegalStateException("The native Matrix connection is not ready.")
            }
            ApplicationControlSendContext(
                session = secrets?.session
                    ?: throw IllegalStateException("The native Matrix session is unavailable."),
                generation = driverGeneration,
                ready = applicationControlReady,
            )
        }
        withTimeout(SEND_OPERATION_TIMEOUT_MS) {
            context.ready.await()
            mutex.withLock {
                check(
                    driver != null &&
                        driverGeneration == context.generation &&
                        applicationControlReady === context.ready,
                ) { "The native Matrix connection changed before the control request was sent." }
            }
            applicationControlClient.send(context.session, contentJson, transactionId)
            Unit
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

    suspend fun refreshApplicationRoomState() {
        val session = secrets?.session
            ?: throw MatrixOfflineException("The Matrix session is unavailable.")
        val state = applicationRoomStateClient.current(session)
        diagnostics.record(
            "matrix.application_state.refreshed",
            mapOf("accepted" to state.events.size.toString()),
        )
        onAuthoritativeRoomState(state.events)
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
        val ready = applicationControlReady
        diagnostics.record("matrix.application_control.receiver_starting")
        applicationControlReceiverJob = scope.launch {
            var since = applicationControlSince
            var consecutiveFailures = 0
            while (isActive) {
                try {
                    val currentState = applicationRoomStateClient.current(session)
                    diagnostics.record(
                        "matrix.application_state.current_received",
                        mapOf(
                            "candidates" to currentState.candidateEventCount.toString(),
                            "accepted" to currentState.events.size.toString(),
                        ),
                    )
                    // Current Room State is a projection baseline, not an
                    // append-only journal replay. Always reprocess it after a
                    // native reconnect, even when its event IDs are unchanged.
                    onAuthoritativeRoomState(currentState.events)
                    break
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
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
                    val cursorResetReason = applicationControlCursorResetReason(error, since)
                    if (cursorResetReason != null) {
                        currentFiles.applicationControlCursor.clear()
                        since = null
                        applicationControlSince = null
                        diagnostics.record(
                            "matrix.application_control.cursor_reset",
                            mapOf("reason" to cursorResetReason),
                        )
                        onConvergenceRequired("application_control_cursor_reset")
                        consecutiveFailures = 0
                        continue
                    }
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
                                "reason" to "baseline_response_too_large",
                            ),
                        )
                        ready.completeExceptionally(error)
                        scope.launch {
                            mutex.withLock {
                                if (driverGeneration == generation) {
                                    accept(
                                        MatrixRuntimeEvent.Failed(
                                            "matrix_application_control_baseline_too_large",
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
                if (!started.get() || driverGeneration != generation) return@launch
                consecutiveFailures = 0
                val establishingCursor = since == null
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
                for (event in batch.events) {
                    onDecryptedEvent(event)
                    diagnostics.record(
                        "matrix.application_control.event_committed",
                        mapOf("kind" to codeverApplicationEventKind(event.rawJson)),
                    )
                }
                // Commit the Matrix cursor only after every accepted event has
                // completed its authenticated local state/history transition.
                // A process exit before this point makes Matrix redeliver the
                // batch; projection and history stores deduplicate it.
                since = batch.nextBatch
                currentFiles.applicationControlCursor.save(since)
                applicationControlSince = since
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

    private fun stopApplicationControlReceiverLocked() {
        applicationControlReceiverReady = false
        applicationControlReceiverJob?.cancel()
        applicationControlReceiverJob = null
        applicationControlReady.cancel()
        applicationControlReady = CompletableDeferred()
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

    private fun errorAttributes(error: Throwable): Map<String, String> = mapOf(
        "error" to error.javaClass.simpleName.replace(Regex("[^A-Za-z0-9._:+/-]"), "_").take(160),
    )

    private fun StoredMatrixSession.toPublic() = PublicMatrixSession(
        homeserver = homeserverUrl,
        userId = userId,
        matrixDeviceId = deviceId,
        roomBinding = roomBinding,
    )

    private companion object {
        const val WATCHDOG_INTERVAL_MS = 5_000L
        const val DRIVER_START_TIMEOUT_MS = 30_000L
        const val DRIVER_STOP_TIMEOUT_MS = 10_000L
        const val NETWORK_CONTROL_TIMEOUT_MS = 10_000L
        const val SEND_OPERATION_TIMEOUT_MS = 45_000L
        const val PROFILE_OPERATION_TIMEOUT_MS = 45_000L
        const val LOGIN_TOKEN_OPERATION_TIMEOUT_MS = 45_000L
        const val HISTORY_OPERATION_TIMEOUT_MS = 45_000L
        const val MEDIA_OPERATION_TIMEOUT_MS = 120_000L
        const val LOGOUT_OPERATION_TIMEOUT_MS = 45_000L
        const val APPLICATION_CONTROL_RETRY_BASE_MS = 1_000L
        const val APPLICATION_CONTROL_MAX_RETRY_MULTIPLIER = 15
    }
}
