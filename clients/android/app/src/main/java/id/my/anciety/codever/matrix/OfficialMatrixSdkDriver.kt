package id.my.anciety.codever.matrix

import id.my.anciety.codever.diagnostics.DiagnosticRecorder
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import org.matrix.rustcomponents.sdk.Client
import org.matrix.rustcomponents.sdk.ClientBuilder
import org.matrix.rustcomponents.sdk.ClientSessionDelegate
import org.matrix.rustcomponents.sdk.CrossProcessLockConfig
import org.matrix.rustcomponents.sdk.EventOrTransactionId
import org.matrix.rustcomponents.sdk.MsgLikeKind
import org.matrix.rustcomponents.sdk.MediaSource
import org.matrix.rustcomponents.sdk.Room
import org.matrix.rustcomponents.sdk.RoomListService
import org.matrix.rustcomponents.sdk.RoomListServiceState
import org.matrix.rustcomponents.sdk.RoomListServiceStateListener
import org.matrix.rustcomponents.sdk.SqliteStoreBuilder
import org.matrix.rustcomponents.sdk.SlidingSyncVersionBuilder
import org.matrix.rustcomponents.sdk.SyncService
import org.matrix.rustcomponents.sdk.SyncServiceState
import org.matrix.rustcomponents.sdk.SyncServiceStateObserver
import org.matrix.rustcomponents.sdk.TaskHandle
import org.matrix.rustcomponents.sdk.Timeline
import org.matrix.rustcomponents.sdk.TimelineDiff
import org.matrix.rustcomponents.sdk.TimelineItem
import org.matrix.rustcomponents.sdk.TimelineItemContent
import org.matrix.rustcomponents.sdk.TimelineListener

interface MatrixSdkDriver {
    suspend fun start(
        secrets: PersistedMatrixSecrets,
        files: MatrixAccountFiles,
        onSyncUpdate: () -> Unit,
        onSessionUpdated: (StoredMatrixSession) -> Unit,
        onJournalAdvanced: (Long) -> Unit,
        onTransportReady: (MatrixTransportIdentity) -> Unit,
        onTimelineGap: () -> Unit,
        onDecryptedEvent: (MatrixDecryptedEvent) -> Unit,
        onRuntimeFailure: (Throwable) -> Unit,
    )

    fun isSyncRunning(): Boolean

    fun hasInternalSyncSupervision(): Boolean = false

    suspend fun setNetworkAvailable(available: Boolean)

    suspend fun sendRoomMessage(contentJson: String, rotateRoomKey: Boolean = false)

    suspend fun paginateRoomHistory(limit: Int): Boolean

    suspend fun uploadMedia(mimeType: String, bytes: ByteArray): String

    suspend fun downloadMedia(url: String): ByteArray

    suspend fun logout()

    suspend fun stop()
}

data class MatrixTransportIdentity(
    val userId: String,
    val deviceId: String,
    val ed25519: String,
)

data class MatrixDecryptedEvent(
    val roomId: String,
    val eventId: String,
    val sender: String,
    val timestamp: Long,
    /** Complete decrypted Matrix event JSON. It never crosses the Web bridge. */
    val rawJson: String,
)

class OfficialMatrixSdkDriver(
    private val callbackScope: CoroutineScope,
    private val now: () -> Long = System::currentTimeMillis,
    private val diagnostics: DiagnosticRecorder = DiagnosticRecorder.None,
) : MatrixSdkDriver {
    private var client: Client? = null
    private var syncService: SyncService? = null
    private var syncServiceStateTask: TaskHandle? = null
    private var roomListService: RoomListService? = null
    private var roomListStateTask: TaskHandle? = null
    private var syncLifecycle: MatrixSyncServiceLifecycle? = null
    private var timeline: Timeline? = null
    private var timelineTask: TaskHandle? = null
    private var syncedBoundRoomReady = CompletableDeferred<Unit>()
    private val active = AtomicBoolean(false)
    private val timelineStarting = AtomicBoolean(false)
    private val firstSyncFinalizing = AtomicBoolean(false)
    private val firstSyncWorkScheduled = AtomicBoolean(false)
    private val transportReadyPublished = AtomicBoolean(false)
    private lateinit var activeSession: StoredMatrixSession
    private lateinit var activeFiles: MatrixAccountFiles
    private var runtimeFailure: (Throwable) -> Unit = {}
    private var journalAdvanced: (Long) -> Unit = {}
    private var timelineGap: () -> Unit = {}
    private var decryptedEvent: (MatrixDecryptedEvent) -> Unit = {}

    override suspend fun start(
        secrets: PersistedMatrixSecrets,
        files: MatrixAccountFiles,
        onSyncUpdate: () -> Unit,
        onSessionUpdated: (StoredMatrixSession) -> Unit,
        onJournalAdvanced: (Long) -> Unit,
        onTransportReady: (MatrixTransportIdentity) -> Unit,
        onTimelineGap: () -> Unit,
        onDecryptedEvent: (MatrixDecryptedEvent) -> Unit,
        onRuntimeFailure: (Throwable) -> Unit,
    ) {
        check(client == null) { "Matrix SDK driver is already started." }
        check(active.compareAndSet(false, true)) { "Matrix SDK driver is already active." }
        diagnostics.record("matrix.driver.start")
        syncedBoundRoomReady = CompletableDeferred()
        firstSyncFinalizing.set(false)
        firstSyncWorkScheduled.set(false)
        transportReadyPublished.set(false)
        activeSession = secrets.session.forNativeSlidingSync()
        activeFiles = files
        runtimeFailure = onRuntimeFailure
        journalAdvanced = onJournalAdvanced
        timelineGap = onTimelineGap
        decryptedEvent = onDecryptedEvent
        val delegate = object : ClientSessionDelegate {
            override fun retrieveSessionFromKeychain(userId: String) = files.sessionStore.load()
                ?.session
                ?.takeIf { it.userId == userId }
                ?.forNativeSlidingSync()
                ?.toSdkSession()
                ?: throw IllegalStateException("The encrypted Matrix session is unavailable.")

            override fun saveSessionInKeychain(session: org.matrix.rustcomponents.sdk.Session) {
                if (!active.get()) return
                val updated = StoredMatrixSession.fromSdkSession(session, activeSession.roomBinding)
                files.sessionStore.save(PersistedMatrixSecrets(secrets.sdkStoreKey, updated))
                activeSession = updated
                onSessionUpdated(updated)
            }
        }
        val storeKey = secrets.sdkStoreKey.copyOf()
        val built = try {
            diagnostics.record("matrix.driver.store_opening")
            val sqliteStore = SqliteStoreBuilder(files.sdkDataPath, files.sdkCachePath)
                .key(storeKey)
            ClientBuilder()
                .homeserverUrl(activeSession.homeserverUrl)
                .slidingSyncVersionBuilder(SlidingSyncVersionBuilder.NATIVE)
                .crossProcessLockConfig(CrossProcessLockConfig.SingleProcess)
                .sqliteStore(sqliteStore)
                .setSessionDelegate(delegate)
                .build()
                .also { diagnostics.record("matrix.driver.store_opened") }
        } catch (error: Exception) {
            active.set(false)
            diagnostics.record("matrix.driver.store_failure", errorAttributes(error))
            throw error
        } finally {
            storeKey.fill(0)
        }
        try {
            diagnostics.record("matrix.driver.session_restoring")
            built.restoreSession(activeSession.toSdkSession())
            diagnostics.record("matrix.driver.session_restored")
            client = built
            diagnostics.record(
                "matrix.driver.client_ready",
                mapOf("stage" to "NATIVE_SINGLE_PROCESS"),
            )
            val ownEd25519 = built.encryption().ed25519Key()
                ?: throw IllegalStateException("Matrix did not publish this device's Ed25519 key.")
            val transportIdentity = MatrixTransportIdentity(
                userId = activeSession.userId,
                deviceId = activeSession.deviceId,
                ed25519 = ownEd25519,
            )
            diagnostics.record("matrix.driver.sync_service_building")
            val service = try {
                built.syncService()
                    .withSharePos(true)
                    .withRoomListTimelineLimit(ROOM_LIST_TIMELINE_LIMIT)
                    .finish()
            } catch (error: Exception) {
                diagnostics.record(
                    "matrix.driver.sync_service_build_failure",
                    errorAttributes(error),
                )
                throw MatrixSyncServiceBuildException(error)
            }
            val roomList = service.roomListService()
            roomList.subscribeToRooms(listOf(activeSession.roomBinding.roomId))
            diagnostics.record("matrix.driver.room_subscription_ready")
            val lifecycle = MatrixSyncServiceLifecycle(
                onRoomListProgress = {
                    if (active.get() && client === built) {
                        diagnostics.record("matrix.driver.sync_update")
                        onSyncUpdate()
                        scheduleInitialSyncFinalization(
                            built,
                            transportIdentity,
                            onTransportReady,
                        )
                    }
                },
                onFailure = { failure ->
                    if (active.get() && client === built) {
                        diagnostics.record(
                            "matrix.driver.sync_failure",
                            errorAttributes(failure) + ("stage" to failure.stage),
                        )
                        runtimeFailure(failure)
                    }
                },
            )
            lifecycle.activate()
            syncService = service
            roomListService = roomList
            syncLifecycle = lifecycle
            syncServiceStateTask = service.state(object : SyncServiceStateObserver {
                override fun onUpdate(state: SyncServiceState) {
                    if (!active.get() || client !== built) return
                    diagnostics.record(
                        "matrix.driver.sync_service_state",
                        mapOf("stage" to state.name),
                    )
                    lifecycle.onServiceState(state)
                }
            })
            roomListStateTask = roomList.state(object : RoomListServiceStateListener {
                override fun onUpdate(state: RoomListServiceState) {
                    if (!active.get() || client !== built) return
                    diagnostics.record(
                        "matrix.driver.room_list_state",
                        mapOf("stage" to state.name),
                    )
                    lifecycle.onRoomListState(state)
                }
            })
            diagnostics.record("matrix.driver.sync_starting")
            service.start()
            lifecycle.markStarted()
            diagnostics.record("matrix.driver.sync_started")
        } catch (error: Exception) {
            active.set(false)
            diagnostics.record("matrix.driver.start_failure", errorAttributes(error))
            runCatching { syncService?.stop() }.onFailure { cleanupError ->
                diagnostics.record("matrix.driver.stop_failure", errorAttributes(cleanupError))
            }
            closeSyncServiceResources()?.let { cleanupError ->
                diagnostics.record("matrix.driver.stop_failure", errorAttributes(cleanupError))
            }
            runCatching { built.close() }.onFailure { cleanupError ->
                diagnostics.record("matrix.driver.stop_failure", errorAttributes(cleanupError))
            }
            client = null
            throw error
        }
    }

    override fun isSyncRunning(): Boolean = syncLifecycle?.isRunning() == true

    override fun hasInternalSyncSupervision(): Boolean = true

    override suspend fun setNetworkAvailable(available: Boolean) {
        client?.enableAllSendQueues(available)
    }

    override suspend fun sendRoomMessage(contentJson: String, rotateRoomKey: Boolean) {
        val room = awaitBoundRoom()
        check(room.isEncrypted()) { "Refusing to send Codever data to an unencrypted Matrix room." }
        if (rotateRoomKey) room.discardRoomKey()
        room.sendRaw("m.room.message", contentJson)
    }

    override suspend fun paginateRoomHistory(limit: Int): Boolean {
        require(limit in 1..100)
        ensureTimeline()
        return timeline?.paginateBackwards(limit.toUShort()) ?: false
    }

    override suspend fun uploadMedia(mimeType: String, bytes: ByteArray): String {
        require(bytes.isNotEmpty()) { "Cannot upload empty Matrix media." }
        return client?.uploadMedia(mimeType, bytes, null)
            ?: throw IllegalStateException("The Matrix client is unavailable.")
    }

    override suspend fun downloadMedia(url: String): ByteArray {
        val source = MediaSource.fromUrl(url)
        return try {
            client?.getMediaContent(source)
                ?: throw IllegalStateException("The Matrix client is unavailable.")
        } finally {
            source.close()
        }
    }

    override suspend fun logout() {
        client?.logout()
    }

    override suspend fun stop() {
        diagnostics.record("matrix.driver.stop")
        active.set(false)
        syncLifecycle?.deactivate()
        val service = syncService
        var stopFailure: Throwable? = null
        if (service != null) {
            runCatching { service.stop() }.onFailure { stopFailure = it }
        }
        val closeFailure = closeSyncServiceResources()
        if (stopFailure == null) stopFailure = closeFailure
        timelineTask.cancelAndClose()
        timelineTask = null
        timeline?.close()
        timeline = null
        client?.close()
        client = null
        timelineStarting.set(false)
        firstSyncFinalizing.set(false)
        firstSyncWorkScheduled.set(false)
        transportReadyPublished.set(false)
        stopFailure?.let { throw it }
    }

    private fun closeSyncServiceResources(): Throwable? {
        var failure: Throwable? = null
        syncServiceStateTask.cancelAndClose()
        syncServiceStateTask = null
        roomListStateTask.cancelAndClose()
        roomListStateTask = null
        runCatching { roomListService?.close() }.onFailure {
            if (failure == null) failure = it
        }
        roomListService = null
        runCatching { syncService?.close() }.onFailure {
            if (failure == null) failure = it
        }
        syncService = null
        syncLifecycle?.deactivate()
        syncLifecycle = null
        return failure
    }

    private suspend fun ensureTimeline() {
        if (timeline != null || !timelineStarting.compareAndSet(false, true)) return
        diagnostics.record("matrix.timeline.preparing")
        try {
            val room = client?.getRoom(activeSession.roomBinding.roomId)
            if (room == null) {
                diagnostics.record("matrix.timeline.room_unavailable")
                return
            }
            val created = room.timeline()
            val listener = created.addListener(object : TimelineListener {
                override fun onUpdate(diff: List<TimelineDiff>) {
                    if (!active.get()) return
                    runCatching { processTimelineDiffs(diff) }.onFailure(runtimeFailure)
                }
            })
            timeline = created
            timelineTask = listener
            diagnostics.record("matrix.timeline.ready")
        } catch (error: Exception) {
            diagnostics.record("matrix.timeline.failure", errorAttributes(error))
            throw error
        } finally {
            timelineStarting.set(false)
        }
    }

    private fun processTimelineDiffs(diffs: List<TimelineDiff>) {
        if (diffs.any { it is TimelineDiff.Reset }) {
            diagnostics.record("matrix.timeline.gap_detected")
            timelineGap()
        }
        val items = diffs.flatMap(::timelineItems)
        if (items.isNotEmpty()) {
            diagnostics.record(
                "matrix.timeline.batch_received",
                mapOf(
                    "diffs" to diffs.size.toString(),
                    "items" to items.size.toString(),
                ),
            )
        }
        items.forEach(::captureDecryptedEvent)
    }

    private fun timelineItems(diff: TimelineDiff): List<TimelineItem> = when (diff) {
        is TimelineDiff.Append -> diff.values
        is TimelineDiff.Insert -> listOf(diff.value)
        is TimelineDiff.PushBack -> listOf(diff.value)
        is TimelineDiff.PushFront -> listOf(diff.value)
        is TimelineDiff.Reset -> diff.values
        is TimelineDiff.Set -> listOf(diff.value)
        TimelineDiff.Clear,
        TimelineDiff.PopBack,
        TimelineDiff.PopFront,
        is TimelineDiff.Remove,
        is TimelineDiff.Truncate,
        -> emptyList()
    }

    private fun captureDecryptedEvent(item: TimelineItem) {
        val event = item.asEvent() ?: return
        if (!event.isRemote) return
        val content = event.content as? TimelineItemContent.MsgLike ?: return
        val kind = content.content.kind
        if (kind !is MsgLikeKind.Message && kind !is MsgLikeKind.Other) return
        val eventId = (event.eventOrTransactionId as? EventOrTransactionId.EventId)?.eventId ?: return
        val rawJson = event.lazyProvider.latestJson() ?: return
        activeFiles.journal.append(
            roomId = activeSession.roomBinding.roomId,
            eventId = eventId,
            receivedAt = now(),
            rawJson = rawJson,
        )?.let(journalAdvanced)
        decryptedEvent(
            MatrixDecryptedEvent(
                roomId = activeSession.roomBinding.roomId,
                eventId = eventId,
                sender = event.sender,
                timestamp = event.timestamp.toLong(),
                rawJson = rawJson,
            ),
        )
    }

    private fun scheduleInitialSyncFinalization(
        expectedClient: Client,
        identity: MatrixTransportIdentity,
        onTransportReady: (MatrixTransportIdentity) -> Unit,
    ) {
        if (transportReadyPublished.get() || !firstSyncWorkScheduled.compareAndSet(false, true)) return
        callbackScope.launch {
            try {
                if (!finalizeInitialSync(expectedClient)) {
                    firstSyncWorkScheduled.set(false)
                    return@launch
                }
                ensureTimeline()
                if (timeline == null) {
                    firstSyncWorkScheduled.set(false)
                    return@launch
                }
                if (
                    active.get() &&
                    client === expectedClient &&
                    transportReadyPublished.compareAndSet(false, true)
                ) {
                    diagnostics.record("matrix.transport.ready")
                    onTransportReady(identity)
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                diagnostics.record("matrix.driver.initialization_failure", errorAttributes(error))
                if (active.get() && client === expectedClient) runtimeFailure(error)
            }
        }
    }

    private suspend fun finalizeInitialSync(expectedClient: Client): Boolean {
        if (syncedBoundRoomReady.isCompleted) return true
        if (!firstSyncFinalizing.compareAndSet(false, true)) return false
        try {
            diagnostics.record("matrix.encryption.initializing")
            try {
                withTimeout(E2EE_INITIALIZATION_TIMEOUT_MS) {
                    expectedClient.encryption().waitForE2eeInitializationTasks()
                }
            } catch (_: TimeoutCancellationException) {
                throw IllegalStateException(
                    "Matrix E2EE initialization did not finish after native sliding sync.",
                )
            }
            if (!active.get() || client !== expectedClient) return false
            diagnostics.record("matrix.encryption.ready")
            try {
                withTimeout(BOUND_ROOM_READY_TIMEOUT_MS) {
                    while (
                        active.get() &&
                        client === expectedClient &&
                        expectedClient.getRoom(activeSession.roomBinding.roomId) == null
                    ) {
                        delay(BOUND_ROOM_POLL_INTERVAL_MS)
                    }
                }
            } catch (_: TimeoutCancellationException) {
                throw IllegalStateException(
                    "The bound Matrix room was unavailable after native sliding sync.",
                )
            }
            if (active.get() && client === expectedClient) {
                syncedBoundRoomReady.complete(Unit)
                diagnostics.record("matrix.bound_room.ready")
            }
            return syncedBoundRoomReady.isCompleted
        } finally {
            firstSyncFinalizing.set(false)
        }
    }

    private suspend fun awaitBoundRoom(): Room {
        try {
            withTimeout(BOUND_ROOM_READY_TIMEOUT_MS) { syncedBoundRoomReady.await() }
        } catch (_: TimeoutCancellationException) {
            throw IllegalStateException(
                "The bound Matrix room and encryption state did not become ready after initial sync.",
            )
        }
        return client?.getRoom(activeSession.roomBinding.roomId)
            ?: throw IllegalStateException(
                "The bound Matrix room disappeared after initial sync.",
            )
    }

    private fun TaskHandle?.cancelAndClose() {
        this ?: return
        runCatching { cancel() }
        runCatching { close() }
    }

    private fun errorAttributes(error: Throwable): Map<String, String> = mapOf(
        "error" to error.javaClass.simpleName.replace(Regex("[^A-Za-z0-9._:+/-]"), "_").take(160),
    )

    private companion object {
        const val ROOM_LIST_TIMELINE_LIMIT = 100u
        const val E2EE_INITIALIZATION_TIMEOUT_MS = 45_000L
        const val BOUND_ROOM_READY_TIMEOUT_MS = 30_000L
        const val BOUND_ROOM_POLL_INTERVAL_MS = 100L
    }
}
