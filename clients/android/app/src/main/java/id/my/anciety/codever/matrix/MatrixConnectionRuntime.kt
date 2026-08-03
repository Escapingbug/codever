package id.my.anciety.codever.matrix

import android.content.Context
import id.my.anciety.codever.security.AndroidKeystoreSecretCipher
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

fun interface MatrixSdkDriverFactory {
    fun create(scope: CoroutineScope): MatrixSdkDriver
}

class MatrixOfflineException(message: String = "The native Matrix connection is offline.") :
    IllegalStateException(message)

class MatrixConnectionRuntime(
    context: Context,
    private val loginClient: MatrixTokenLoginClient = MatrixTokenLoginClient(),
    private val profileClient: MatrixProfileClient = MatrixProfileClient(),
    private val networkMonitor: NetworkMonitor = AndroidNetworkMonitor(context),
    private val accountStorage: MatrixAccountStorage = MatrixAccountStorage(
        context,
        AndroidKeystoreSecretCipher(),
    ),
    private val driverFactory: MatrixSdkDriverFactory = MatrixSdkDriverFactory(::OfficialMatrixSdkDriver),
    private val stateMachine: MatrixRuntimeStateMachine = MatrixRuntimeStateMachine(),
    private val retryDelayMs: Long = 5_000,
    private val onTransportReady: (MatrixTransportIdentity) -> Unit = {},
    private val onDecryptedEvent: (MatrixDecryptedEvent) -> Unit = {},
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mutex = Mutex()
    private val started = AtomicBoolean(false)
    private var networkAvailable = networkMonitor.isAvailable()
    @Volatile
    private var files: MatrixAccountFiles? = null
    @Volatile
    private var secrets: PersistedMatrixSecrets? = null
    private var driver: MatrixSdkDriver? = null
    private var driverGeneration = 0L
    @Volatile
    private var latestJournalCursor = 0L
    private var retryJob: Job? = null
    private var watchdogJob: Job? = null

    val status: MatrixRuntimeStatus
        get() = stateMachine.status

    fun start() {
        if (!started.compareAndSet(false, true)) return
        stateMachine.accept(MatrixRuntimeEvent.Start(hasSession = true, networkAvailable))
        networkMonitor.start(::onNetworkChanged)
        scope.launch {
            try {
                mutex.withLock {
                    restorePersistedSessionLocked()
                    stateMachine.accept(MatrixRuntimeEvent.Start(secrets != null, networkAvailable))
                    if (secrets != null && networkAvailable) runCatching { connectLocked() }
                }
            } catch (_: Exception) {
                stateMachine.accept(
                    MatrixRuntimeEvent.Failed("matrix_recovery_blocked", blocked = true),
                )
            }
        }
        watchdogJob = scope.launch {
            while (isActive) {
                delay(WATCHDOG_INTERVAL_MS)
                mutex.withLock {
                    val running = runCatching { driver?.isSyncRunning() == true }.getOrDefault(false)
                    if (started.get() && networkAvailable && secrets != null && !running
                    ) {
                        stateMachine.accept(MatrixRuntimeEvent.RetryScheduled)
                        scheduleRetryLocked()
                    }
                }
            }
        }
    }

    suspend fun bootstrap(input: MatrixBootstrap): PublicMatrixSession = scope.async {
        mutex.withLock { bootstrapLocked(input) }
    }.await()

    suspend fun sendRoomMessage(contentJson: String, rotateRoomKey: Boolean = false) = scope.async {
        mutex.withLock {
            check(started.get()) { "The native Matrix runtime is stopped." }
            if (!networkAvailable) throw MatrixOfflineException()
            val current = driver ?: throw IllegalStateException("The native Matrix connection is not ready.")
            current.sendRoomMessage(contentJson, rotateRoomKey)
        }
    }.await()

    suspend fun uploadMedia(mimeType: String, bytes: ByteArray): String = scope.async {
        mutex.withLock {
            check(started.get()) { "The native Matrix runtime is stopped." }
            if (!networkAvailable) throw MatrixOfflineException()
            val current = driver ?: throw IllegalStateException("The native Matrix connection is not ready.")
            current.uploadMedia(mimeType, bytes)
        }
    }.await()

    suspend fun downloadMedia(url: String): ByteArray = scope.async {
        mutex.withLock {
            check(started.get()) { "The native Matrix runtime is stopped." }
            if (!networkAvailable) throw MatrixOfflineException()
            val current = driver ?: throw IllegalStateException("The native Matrix connection is not ready.")
            current.downloadMedia(url)
        }
    }.await()

    suspend fun profileProperty(userId: String, key: String) = scope.async {
        mutex.withLock {
            check(started.get()) { "The native Matrix runtime is stopped." }
            if (!networkAvailable) throw MatrixOfflineException()
            val session = secrets?.session
                ?: throw IllegalStateException("The native Matrix session is unavailable.")
            profileClient.get(session, userId, key)
        }
    }.await()

    suspend fun revokeSession() = scope.async {
        mutex.withLock {
            check(started.get()) { "The native Matrix runtime is stopped." }
            if (!networkAvailable) {
                throw MatrixOfflineException("The native Matrix session must be online before revocation.")
            }
            val current = driver
                ?: throw IllegalStateException("The native Matrix session is not ready for revocation.")
            // Preserve recoverable local credentials until the homeserver
            // confirms logout. Offline revocation must remain retryable.
            current.logout()
            retryJob?.cancel()
            retryJob = null
            watchdogJob?.cancel()
            watchdogJob = null
            networkMonitor.stop()
            runCatching { current.stop() }
            driver = null
            driverGeneration += 1
            files?.let(accountStorage::clear)
            secrets?.sdkStoreKey?.fill(0)
            secrets = null
            files = null
            latestJournalCursor = 0
            started.set(false)
            stateMachine.accept(MatrixRuntimeEvent.Stop)
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

        stateMachine.accept(MatrixRuntimeEvent.BootstrapStarted)
        val session = try {
            loginClient.exchange(input)
        } catch (error: Exception) {
            stateMachine.accept(
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
        accountStorage.clear(candidateFiles)
        val nextFiles = accountStorage.forSession(session)
        val nextSecrets = PersistedMatrixSecrets(
            sdkStoreKey = EncryptedMatrixSessionStore.newStoreKey(),
            session = session,
        )
        nextFiles.sessionStore.save(nextSecrets)
        files = nextFiles
        secrets = nextSecrets
        stateMachine.accept(MatrixRuntimeEvent.SessionReady(networkAvailable))
        if (networkAvailable) connectLocked()
        return session.toPublic()
    }

    fun publicSession(): PublicMatrixSession? = secrets?.session?.toPublic()

    fun journalCursor(): Long = latestJournalCursor

    suspend fun stop(clearSession: Boolean) = mutex.withLock {
        if (!started.compareAndSet(true, false)) return@withLock
        retryJob?.cancel()
        retryJob = null
        watchdogJob?.cancel()
        watchdogJob = null
        networkMonitor.stop()
        driver?.stop()
        driver = null
        driverGeneration += 1
        if (clearSession) {
            files?.let(accountStorage::clear)
            secrets?.sdkStoreKey?.fill(0)
            secrets = null
            files = null
            latestJournalCursor = 0
        }
        stateMachine.accept(MatrixRuntimeEvent.Stop)
    }

    suspend fun close() {
        stop(clearSession = false)
        secrets?.sdkStoreKey?.fill(0)
        scope.cancel()
    }

    private fun onNetworkChanged(available: Boolean) {
        scope.launch {
            mutex.withLock {
                networkAvailable = available
                if (!available) {
                    stateMachine.accept(MatrixRuntimeEvent.NetworkLost)
                    runCatching { driver?.setNetworkAvailable(false) }
                    return@withLock
                }
                stateMachine.accept(MatrixRuntimeEvent.NetworkAvailable)
                val currentDriver = driver
                val sendQueueResumed = runCatching {
                    currentDriver?.setNetworkAvailable(true)
                }.isSuccess
                if (!sendQueueResumed && currentDriver != null) {
                    stateMachine.accept(
                        MatrixRuntimeEvent.Failed(
                            "matrix_send_queue_resume_failed",
                            blocked = false,
                        ),
                    )
                    runCatching { currentDriver.stop() }
                    if (driver === currentDriver) {
                        driver = null
                        driverGeneration += 1
                    }
                    scheduleRetryLocked()
                    return@withLock
                }
                val running = runCatching { driver?.isSyncRunning() == true }.getOrDefault(false)
                if (started.get() && secrets != null && !running) {
                    runCatching { connectLocked() }
                }
            }
        }
    }

    private fun restorePersistedSessionLocked() {
        if (secrets != null) return
        val currentFiles = accountStorage.findCurrent() ?: return
        val loaded = currentFiles.sessionStore.load() ?: return
        check(
            MatrixIdentifiers.accountStoreName(
                loaded.session.homeserverUrl,
                loaded.session.userId,
            ) == currentFiles.accountScope,
        ) { "Encrypted Matrix session is bound to a different account scope." }
        files = currentFiles
        secrets = loaded
        latestJournalCursor = currentFiles.journal.latestCursor()
    }

    private suspend fun connectLocked() {
        val currentSecrets = secrets ?: return
        val currentFiles = files ?: return
        if (!networkAvailable || !started.get()) return
        retryJob?.cancel()
        retryJob = null
        driver?.stop()
        driver = null
        driverGeneration += 1
        val generation = driverGeneration
        val nextDriver = try {
            driverFactory.create(scope)
        } catch (error: Exception) {
            stateMachine.accept(
                MatrixRuntimeEvent.Failed("matrix_driver_create_failed", blocked = false),
            )
            scheduleRetryLocked()
            throw error
        }
        driver = nextDriver
        stateMachine.accept(MatrixRuntimeEvent.SessionReady(networkAvailable = true))
        try {
            nextDriver.start(
                secrets = currentSecrets,
                files = currentFiles,
                onSyncUpdate = {
                    scope.launch {
                        mutex.withLock {
                            if (driver === nextDriver && driverGeneration == generation) {
                                stateMachine.accept(MatrixRuntimeEvent.SyncUpdated)
                            }
                        }
                    }
                },
                onSessionUpdated = { updated ->
                    scope.launch {
                        mutex.withLock {
                            if (driver === nextDriver && driverGeneration == generation) {
                                secrets = PersistedMatrixSecrets(currentSecrets.sdkStoreKey, updated)
                            }
                        }
                    }
                },
                onJournalAdvanced = { cursor ->
                    scope.launch {
                        mutex.withLock {
                            if (driver === nextDriver && driverGeneration == generation) {
                                latestJournalCursor = cursor
                            }
                        }
                    }
                },
                onTransportReady = onTransportReady,
                onDecryptedEvent = onDecryptedEvent,
                onRuntimeFailure = {
                    scope.launch {
                        mutex.withLock {
                            if (driver === nextDriver && driverGeneration == generation) {
                                stateMachine.accept(
                                    MatrixRuntimeEvent.Failed("matrix_runtime_failed", blocked = false),
                                )
                                runCatching { nextDriver.stop() }
                                driver = null
                                driverGeneration += 1
                                scheduleRetryLocked()
                            }
                        }
                    }
                },
            )
            stateMachine.accept(MatrixRuntimeEvent.SyncStarted)
        } catch (error: Exception) {
            runCatching { nextDriver.stop() }
            if (driver === nextDriver && driverGeneration == generation) {
                driver = null
                driverGeneration += 1
            }
            stateMachine.accept(
                MatrixRuntimeEvent.Failed("matrix_restore_or_sync_failed", blocked = false),
            )
            scheduleRetryLocked()
            throw error
        }
    }

    private fun scheduleRetryLocked() {
        if (retryJob?.isActive == true || !networkAvailable || secrets == null || !started.get()) return
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

    private fun StoredMatrixSession.toPublic() = PublicMatrixSession(
        homeserver = homeserverUrl,
        userId = userId,
        matrixDeviceId = deviceId,
        roomBinding = roomBinding,
    )

    private companion object {
        const val WATCHDOG_INTERVAL_MS = 10_000L
    }
}
