package id.my.anciety.codever.matrix

import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import org.matrix.rustcomponents.sdk.Client
import org.matrix.rustcomponents.sdk.ClientBuilder
import org.matrix.rustcomponents.sdk.ClientSessionDelegate
import org.matrix.rustcomponents.sdk.EventOrTransactionId
import org.matrix.rustcomponents.sdk.MsgLikeKind
import org.matrix.rustcomponents.sdk.MediaSource
import org.matrix.rustcomponents.sdk.Room
import org.matrix.rustcomponents.sdk.SqliteStoreBuilder
import org.matrix.rustcomponents.sdk.SyncListenerV2
import org.matrix.rustcomponents.sdk.SyncResponseV2
import org.matrix.rustcomponents.sdk.SyncSettingsV2
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
        onDecryptedEvent: (MatrixDecryptedEvent) -> Unit,
        onRuntimeFailure: (Throwable) -> Unit,
    )

    fun isSyncRunning(): Boolean

    suspend fun setNetworkAvailable(available: Boolean)

    suspend fun sendRoomMessage(contentJson: String, rotateRoomKey: Boolean = false)

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
) : MatrixSdkDriver {
    private var client: Client? = null
    private var syncTask: TaskHandle? = null
    private var timeline: Timeline? = null
    private var timelineTask: TaskHandle? = null
    private var syncedBoundRoomReady = CompletableDeferred<Unit>()
    private val active = AtomicBoolean(false)
    private val timelineStarting = AtomicBoolean(false)
    private val firstSyncFinalizing = AtomicBoolean(false)
    private lateinit var activeSession: StoredMatrixSession
    private lateinit var activeFiles: MatrixAccountFiles
    private var runtimeFailure: (Throwable) -> Unit = {}
    private var journalAdvanced: (Long) -> Unit = {}
    private var decryptedEvent: (MatrixDecryptedEvent) -> Unit = {}

    override suspend fun start(
        secrets: PersistedMatrixSecrets,
        files: MatrixAccountFiles,
        onSyncUpdate: () -> Unit,
        onSessionUpdated: (StoredMatrixSession) -> Unit,
        onJournalAdvanced: (Long) -> Unit,
        onTransportReady: (MatrixTransportIdentity) -> Unit,
        onDecryptedEvent: (MatrixDecryptedEvent) -> Unit,
        onRuntimeFailure: (Throwable) -> Unit,
    ) {
        check(client == null) { "Matrix SDK driver is already started." }
        check(active.compareAndSet(false, true)) { "Matrix SDK driver is already active." }
        syncedBoundRoomReady = CompletableDeferred()
        firstSyncFinalizing.set(false)
        activeSession = secrets.session
        activeFiles = files
        runtimeFailure = onRuntimeFailure
        journalAdvanced = onJournalAdvanced
        decryptedEvent = onDecryptedEvent
        val delegate = object : ClientSessionDelegate {
            override fun retrieveSessionFromKeychain(userId: String) = files.sessionStore.load()
                ?.session
                ?.takeIf { it.userId == userId }
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
            val sqliteStore = SqliteStoreBuilder(files.sdkDataPath, files.sdkCachePath)
                .key(storeKey)
            ClientBuilder()
                .homeserverUrl(activeSession.homeserverUrl)
                .sqliteStore(sqliteStore)
                .setSessionDelegate(delegate)
                .build()
        } catch (error: Exception) {
            active.set(false)
            throw error
        } finally {
            storeKey.fill(0)
        }
        try {
            built.restoreSession(activeSession.toSdkSession())
            client = built
            val ownEd25519 = built.encryption().ed25519Key()
                ?: throw IllegalStateException("Matrix did not publish this device's Ed25519 key.")
            onTransportReady(
                MatrixTransportIdentity(
                    userId = activeSession.userId,
                    deviceId = activeSession.deviceId,
                    ed25519 = ownEd25519,
                ),
            )
            ensureTimeline()
            syncTask = built.syncV2(
                SyncSettingsV2(timeoutMs = 30_000uL, fullState = false),
                object : SyncListenerV2 {
                    override fun onUpdate(response: SyncResponseV2) {
                        if (!active.get()) return
                        onSyncUpdate()
                        callbackScope.launch {
                            runCatching {
                                finalizeInitialSync(built)
                                ensureTimeline()
                            }.onFailure(onRuntimeFailure)
                        }
                    }
                },
            )
        } catch (error: Exception) {
            active.set(false)
            built.close()
            throw error
        }
    }

    override fun isSyncRunning(): Boolean = syncTask?.isFinished() == false

    override suspend fun setNetworkAvailable(available: Boolean) {
        client?.enableAllSendQueues(available)
    }

    override suspend fun sendRoomMessage(contentJson: String, rotateRoomKey: Boolean) {
        val room = awaitBoundRoom()
        check(room.isEncrypted()) { "Refusing to send Codever data to an unencrypted Matrix room." }
        if (rotateRoomKey) room.discardRoomKey()
        room.sendRaw("m.room.message", contentJson)
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
        active.set(false)
        timelineTask.cancelAndClose()
        timelineTask = null
        timeline?.close()
        timeline = null
        syncTask.cancelAndClose()
        syncTask = null
        client?.close()
        client = null
        timelineStarting.set(false)
        firstSyncFinalizing.set(false)
    }

    private suspend fun ensureTimeline() {
        if (timeline != null || !timelineStarting.compareAndSet(false, true)) return
        try {
            val room = client?.getRoom(activeSession.roomBinding.roomId) ?: return
            val created = room.timeline()
            val listener = created.addListener(object : TimelineListener {
                override fun onUpdate(diff: List<TimelineDiff>) {
                    if (!active.get()) return
                    runCatching { processTimelineDiffs(diff) }.onFailure(runtimeFailure)
                }
            })
            timeline = created
            timelineTask = listener
        } finally {
            timelineStarting.set(false)
        }
    }

    private fun processTimelineDiffs(diffs: List<TimelineDiff>) {
        diffs.forEach { diff ->
            timelineItems(diff).forEach(::captureDecryptedEvent)
        }
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

    private suspend fun finalizeInitialSync(expectedClient: Client) {
        if (syncedBoundRoomReady.isCompleted || !firstSyncFinalizing.compareAndSet(false, true)) {
            return
        }
        try {
            expectedClient.encryption().waitForE2eeInitializationTasks()
            if (client === expectedClient) signalSyncedBoundRoomReady()
        } finally {
            firstSyncFinalizing.set(false)
        }
    }

    private fun signalSyncedBoundRoomReady() {
        if (client?.getRoom(activeSession.roomBinding.roomId) != null) {
            syncedBoundRoomReady.complete(Unit)
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

    private companion object {
        const val BOUND_ROOM_READY_TIMEOUT_MS = 30_000L
    }
}
