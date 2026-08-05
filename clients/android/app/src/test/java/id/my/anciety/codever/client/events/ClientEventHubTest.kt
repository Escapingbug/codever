package id.my.anciety.codever.client.events

import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ClientEventHubTest {
    @Test
    fun `expired replay cursor returns snapshot at subscribe barrier`() {
        val hub = hub(maxReplayEvents = 3)
        val first = hub.publish(ClientEventType.STATUS_CHANGED, JsonPrimitive("one"))
        repeat(4) { index ->
            hub.publish(ClientEventType.STATUS_CHANGED, JsonPrimitive("event-$index"))
        }

        val result = hub.subscribe(first.cursor, listener = RecordingListener())

        assertTrue(result is SubscriptionBootstrap.Snapshot)
        result as SubscriptionBootstrap.Snapshot
        assertEquals(result.barrierCursor, result.snapshot.cursor)
        assertEquals(hub.snapshot().cursor, result.barrierCursor)
    }

    @Test
    fun `subscribe barrier retains events published before activation`() {
        val hub = hub()
        val anchor = hub.publish(ClientEventType.STATUS_CHANGED, JsonPrimitive("anchor"))
        val listener = RecordingListener()
        val subscription = hub.subscribe(anchor.cursor, listener = listener)
        assertTrue(subscription is SubscriptionBootstrap.Replay)

        val raced = hub.publish(ClientEventType.TRUST_CHANGED, JsonPrimitive("after-barrier"))
        assertTrue(listener.events.isEmpty())

        hub.activate(subscription.subscriptionId, subscription.barrierCursor)
        assertEquals(listOf(raced.cursor), listener.events.map(ClientEvent::cursor))
        assertEquals(
            raced.cursor,
            hub.acknowledge(subscription.subscriptionId, raced.cursor).throughCursor,
        )
    }

    @Test
    fun `concurrent publishers produce unique ordered events without delivery loss`() {
        val eventCount = 400
        val hub = hub(maxReplayEvents = eventCount + 1)
        val anchor = hub.publish(ClientEventType.STATUS_CHANGED, JsonPrimitive("anchor"))
        val listener = RecordingListener()
        val subscription = hub.subscribe(anchor.cursor, listener = listener)
        hub.activate(subscription.subscriptionId, subscription.barrierCursor)
        val workers = Executors.newFixedThreadPool(8)
        val start = CountDownLatch(1)
        repeat(eventCount) { index ->
            workers.submit {
                start.await()
                hub.publish(ClientEventType.COMMAND_CHANGED, JsonPrimitive(index))
            }
        }
        start.countDown()
        workers.shutdown()
        assertTrue(workers.awaitTermination(20, TimeUnit.SECONDS))

        assertEquals(eventCount, listener.events.size)
        assertEquals(eventCount, listener.events.map(ClientEvent::cursor).distinct().size)
        assertEquals(eventCount, listener.events.map(ClientEvent::eventId).distinct().size)
    }

    @Test
    fun `subscriptions are independent and detach never clears durable events`() {
        val hub = hub()
        val anchor = hub.publish(ClientEventType.STATUS_CHANGED, JsonPrimitive("anchor"))
        val first = RecordingListener()
        val second = RecordingListener()
        val firstSubscription = hub.subscribe(anchor.cursor, listener = first)
        val secondSubscription = hub.subscribe(anchor.cursor, listener = second)
        hub.activate(firstSubscription.subscriptionId, firstSubscription.barrierCursor)
        hub.activate(secondSubscription.subscriptionId, secondSubscription.barrierCursor)

        val deliveredToBoth = hub.publish(ClientEventType.GATEWAY_STATE_CHANGED, JsonPrimitive(1))
        assertEquals(listOf(deliveredToBoth), first.events)
        assertEquals(listOf(deliveredToBoth), second.events)
        assertTrue(hub.unsubscribe(firstSubscription.subscriptionId))

        val retained = hub.publish(ClientEventType.GATEWAY_STATE_CHANGED, JsonPrimitive(2))
        assertEquals(1, first.events.size)
        assertEquals(listOf(deliveredToBoth, retained), second.events)
        assertTrue(hub.unsubscribe(secondSubscription.subscriptionId))
        hub.publish(ClientEventType.GATEWAY_STATE_CHANGED, JsonPrimitive(3))

        val reattached = hub.subscribe(retained.cursor, listener = RecordingListener())
        assertTrue(reattached is SubscriptionBootstrap.Replay)
        assertEquals(1, (reattached as SubscriptionBootstrap.Replay).events.size)
    }

    @Test
    fun `restart restores replay head snapshot and history`() {
        val persistence = InMemoryClientEventPersistence()
        val generator = CountingCursorGenerator()
        val firstHub = hub(persistence = persistence, cursorGenerator = generator)
        val first = firstHub.publish(ClientEventType.STATUS_CHANGED, JsonPrimitive("first"))
        val second = firstHub.publish(ClientEventType.TRUST_CHANGED, JsonPrimitive("second"))
        firstHub.upsertMessage("session-1", message("message-1", 1))
        val cursorAtShutdown = firstHub.snapshot().cursor

        val restored = hub(persistence = persistence, cursorGenerator = generator)
        assertEquals(cursorAtShutdown, restored.snapshot().cursor)
        val replay = restored.subscribe(first.cursor, listener = RecordingListener())
        assertTrue(replay is SubscriptionBootstrap.Replay)
        replay as SubscriptionBootstrap.Replay
        assertEquals(second.cursor, replay.events.first().cursor)
        assertEquals(2, replay.events.size) // trust change + message upsert
        assertEquals(listOf("message-1"), restored.historyPage("session-1").messages.map { it.eventId })
    }

    @Test
    fun `history pages are stable and deduplicate message upserts`() {
        val hub = hub()
        repeat(5) { index ->
            hub.upsertMessage("session-1", message("event-$index", index.toLong()))
        }
        assertNull(hub.upsertMessage("session-1", message("event-2", 2)))
        hub.upsertMessage("session-1", message("event-2", 2, text = "updated"))
        hub.upsertMessage("other-session", message("other", 99, sessionId = "other-session"))

        val newest = hub.historyPage("session-1", limit = 2)
        assertEquals(listOf("event-3", "event-4"), newest.messages.map { it.eventId })
        assertTrue(newest.hasMore)
        assertNotEquals("", newest.nextBefore)
        val middle = hub.historyPage("session-1", before = newest.nextBefore, limit = 2)
        assertEquals(listOf("event-1", "event-2"), middle.messages.map { it.eventId })
        assertEquals("updated", middle.messages.last().text)
        val oldest = hub.historyPage("session-1", before = middle.nextBefore, limit = 2)
        assertEquals(listOf("event-0"), oldest.messages.map { it.eventId })
        assertFalse(oldest.hasMore)
        assertEquals(5, (newest.messages + middle.messages + oldest.messages).map { it.eventId }.distinct().size)
        assertThrows(HistoryCursorInvalidException::class.java) {
            hub.historyPage("session-1", before = "unknown-cursor")
        }
    }

    @Test
    fun `history batch persists once and delivers every changed message`() {
        val persistence = CountingPersistence()
        val hub = hub(persistence = persistence)
        val anchor = hub.publish(ClientEventType.STATUS_CHANGED, JsonPrimitive("anchor"))
        val listener = RecordingListener()
        val subscription = hub.subscribe(anchor.cursor, listener = listener)
        hub.activate(subscription.subscriptionId, subscription.barrierCursor)
        val savesBeforeBatch = persistence.saveCount

        val events = hub.upsertMessages(
            "session-1",
            listOf(
                message("event-1", 1),
                message("event-2", 2),
                message("event-3", 3),
            ),
        )

        assertEquals(savesBeforeBatch + 1, persistence.saveCount)
        assertEquals(listOf("event-1", "event-2", "event-3"),
            hub.historyPage("session-1", limit = 10).messages.map { it.eventId })
        assertEquals(events.map { it.cursor }, listener.events.map { it.cursor })
    }

    @Test
    fun `snapshot timestamp polling does not rewrite unchanged durable state`() {
        val persistence = CountingPersistence()
        val hub = hub(persistence = persistence)
        val savesBeforePoll = persistence.saveCount

        hub.updateSnapshot(snapshot().copy(generatedAt = 2_000L))

        assertEquals(savesBeforePoll, persistence.saveCount)
        hub.updateSnapshot(snapshot().copy(
            generatedAt = 3_000L,
            lifecycle = ClientLifecycle(LifecyclePhase.READY, 3_000L),
        ))
        assertEquals(savesBeforePoll + 1, persistence.saveCount)
    }

    @Test
    fun `late gateway history is ordered by timestamp with sequence tie break`() {
        val hub = hub()
        hub.upsertMessage("session-1", message("newest", 300), occurredAt = 300)
        hub.upsertMessage("session-1", message("oldest", 100), occurredAt = 100)
        hub.upsertMessage("session-1", message("same-time-first", 200), occurredAt = 200)
        hub.upsertMessage("session-1", message("same-time-second", 200), occurredAt = 200)

        assertEquals(
            listOf("oldest", "same-time-first", "same-time-second", "newest"),
            hub.historyPage("session-1", limit = 10).messages.map { it.eventId },
        )
    }

    @Test
    fun `local oldest history page exposes anchor while gateway has more`() {
        val hub = hub()
        repeat(3) { index -> hub.upsertMessage("session-1", message("event-$index", index.toLong())) }
        val newest = hub.historyPage("session-1", limit = 2, externalHasMore = true)
        val oldest = hub.historyPage(
            "session-1",
            before = newest.nextBefore,
            limit = 2,
            externalHasMore = true,
        )

        assertEquals(listOf("event-0"), oldest.messages.map { it.eventId })
        assertTrue(oldest.hasMore)
        assertNotNull(oldest.nextBefore)
        val exhausted = hub.historyPage(
            "session-1",
            before = oldest.nextBefore,
            limit = 2,
            externalHasMore = true,
        )
        assertTrue(exhausted.messages.isEmpty())
        assertFalse(exhausted.hasMore)
        assertNull(exhausted.nextBefore)
        val localOnly = hub.historyPage(
            "session-1",
            before = newest.nextBefore,
            limit = 2,
            externalHasMore = false,
        )
        assertFalse(localOnly.hasMore)
        assertNull(localOnly.nextBefore)
    }

    @Test
    fun `persisted byte budget compacts oldest events and history consistently`() {
        val maxBytes = 16 * 1024
        val persistence = BoundedPersistence(maxBytes)
        val generator = CountingCursorGenerator()
        val hub = hub(
            persistence = persistence,
            cursorGenerator = generator,
            maxPersistedStateBytes = maxBytes,
        )
        repeat(20) { index ->
            hub.upsertMessage(
                "session-1",
                message("event-$index", index.toLong(), text = "界".repeat(900)),
                occurredAt = index.toLong(),
            )
        }

        assertTrue(persistence.maxObservedBytes <= maxBytes)
        val persistedBytes = requireNotNull(persistence.load())
        val persisted = try {
            ClientEventStateCodec.decode(persistedBytes)
        } finally {
            persistedBytes.fill(0)
        }
        assertEquals(persisted.headCursor, hub.snapshot().cursor)
        assertEquals(
            persisted.history.filter { it.sessionId == "session-1" }.map { it.message.eventId },
            hub.historyPage("session-1", limit = 100).messages.map { it.eventId },
        )
        assertTrue(persisted.history.size < 20 || persisted.events.size < 20)
        assertTrue(persisted.history.none { it.message.eventId == "event-0" })

        val restored = hub(
            persistence = persistence,
            cursorGenerator = generator,
            maxPersistedStateBytes = maxBytes,
        )
        assertEquals(hub.snapshot().cursor, restored.snapshot().cursor)
        assertEquals(
            hub.historyPage("session-1", limit = 100).messages,
            restored.historyPage("session-1", limit = 100).messages,
        )
    }

    @Test
    fun `public event DTO limits use encoded UTF-8 bytes`() {
        val oversizedUnicode = "😀".repeat(70_000)
        assertThrows(IllegalArgumentException::class.java) {
            message("oversized", 1, text = oversizedUnicode)
        }
        assertThrows(IllegalArgumentException::class.java) {
            ClientEvent(
                eventId = "event-1",
                cursor = "cursor-1",
                occurredAt = 1,
                type = ClientEventType.COMMAND_CHANGED,
                payload = JsonPrimitive(oversizedUnicode),
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            CommandCompletion(
                commandId = "command-1",
                sequence = 1,
                revision = 0,
                outcome = CommandOutcome.SUCCEEDED,
                result = JsonPrimitive(oversizedUnicode),
            )
        }
        // This is well below the byte ceiling even though it uses multi-byte UTF-8.
        message("within-limit", 1, text = "界".repeat(50_000))
    }

    @Test
    fun `invalid activation cursor cannot skip barrier events`() {
        val hub = hub()
        val listener = RecordingListener()
        val subscription = hub.subscribe(null, listener = listener)
        hub.publish(ClientEventType.STATUS_CHANGED, JsonPrimitive("pending"))

        assertThrows(InvalidSubscriptionCursorException::class.java) {
            hub.activate(subscription.subscriptionId, hub.snapshot().cursor)
        }
        assertTrue(listener.events.isEmpty())
        hub.activate(subscription.subscriptionId, subscription.barrierCursor)
        assertEquals(1, listener.events.size)
    }

    @Test
    fun `slow active subscriber receives cursor expired snapshot after bounded journal rolls over`() {
        val hub = ClientEventHub(
            persistence = InMemoryClientEventPersistence(),
            initialSnapshot = snapshot(),
            maxReplayEvents = 3,
            deliveryBatchSize = 1,
            cursorGenerator = CountingCursorGenerator(),
            now = { 1_000L },
        )
        val anchor = hub.publish(ClientEventType.STATUS_CHANGED, JsonPrimitive("anchor"))
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val expired = CountDownLatch(1)
        val listener = object : ClientEventListener {
            override fun onEvents(events: List<ClientEvent>) {
                entered.countDown()
                release.await(10, TimeUnit.SECONDS)
            }

            override fun onCursorExpired(snapshot: ClientSnapshot) {
                assertEquals(hub.snapshot().cursor, snapshot.cursor)
                expired.countDown()
            }
        }
        val subscription = hub.subscribe(anchor.cursor, listener = listener)
        hub.activate(subscription.subscriptionId, subscription.barrierCursor)
        val publisher = Executors.newSingleThreadExecutor()
        publisher.submit { hub.publish(ClientEventType.COMMAND_CHANGED, JsonPrimitive("blocked")) }
        assertTrue(entered.await(10, TimeUnit.SECONDS))
        repeat(5) { hub.publish(ClientEventType.COMMAND_CHANGED, JsonPrimitive(it)) }
        release.countDown()
        publisher.shutdown()
        assertTrue(publisher.awaitTermination(10, TimeUnit.SECONDS))
        assertTrue(expired.await(10, TimeUnit.SECONDS))
    }

    @Test
    fun `failed persistence leaves journal head unchanged`() {
        val persistence = FailingPersistence()
        val hub = hub(persistence = persistence)
        val before = hub.snapshot().cursor
        persistence.failNext = true

        assertThrows(IllegalStateException::class.java) {
            hub.publish(ClientEventType.STATUS_CHANGED, JsonPrimitive("must-roll-back"))
        }
        assertEquals(before, hub.snapshot().cursor)
        val committed = hub.publish(ClientEventType.STATUS_CHANGED, JsonPrimitive("committed"))
        assertEquals(committed.cursor, hub.snapshot().cursor)
    }

    @Test
    fun `public codecs reject unknown fields and raw Matrix payload keys`() {
        val encoded = PublicClientJson.encodeMessage(message("safe", 1))
        assertEquals(message("safe", 1), PublicClientJson.decodeMessage(encoded))
        val withRaw = buildJsonObject {
            encoded.forEach { (key, value) -> put(key, value) }
            put("raw", buildJsonObject { put("access_token", "secret") })
        }
        assertThrows(IllegalArgumentException::class.java) {
            PublicClientJson.decodeMessage(withRaw)
        }
        val unknownSnapshot = Json.parseToJsonElement(
            PublicClientJson.encodeSnapshot(snapshot()).toString().dropLast(1) + ",\"accessToken\":\"secret\"}",
        )
        assertThrows(IllegalArgumentException::class.java) {
            PublicClientJson.decodeSnapshot(unknownSnapshot)
        }
    }

    private fun hub(
        persistence: ClientEventPersistence = InMemoryClientEventPersistence(),
        maxReplayEvents: Int = 1_000,
        cursorGenerator: OpaqueCursorGenerator = CountingCursorGenerator(),
        maxPersistedStateBytes: Int = 3 * 1024 * 1024,
    ) = ClientEventHub(
        persistence = persistence,
        initialSnapshot = snapshot(),
        maxReplayEvents = maxReplayEvents,
        maxPersistedStateBytes = maxPersistedStateBytes,
        cursorGenerator = cursorGenerator,
        now = { 1_000L },
    )

    private fun snapshot() = ClientSnapshot(
        deviceId = "device-1",
        cursor = "initial",
        generatedAt = 0,
        lifecycle = ClientLifecycle(LifecyclePhase.STOPPED, 0),
        foregroundService = ForegroundServiceState(active = false, notificationVisible = false),
        trust = PublicTrustState.Unpaired,
    )

    private fun message(
        eventId: String,
        timestamp: Long,
        text: String = eventId,
        sessionId: String = "session-1",
    ) = ClientMessage(
        eventId = eventId,
        sender = "sender-1",
        timestamp = timestamp,
        encrypted = true,
        kind = ClientMessageKind.AGENT,
        format = ClientMessageFormat.MARKDOWN,
        text = text,
        sessionId = sessionId,
    )

    private class CountingCursorGenerator : OpaqueCursorGenerator {
        private val next = AtomicLong()

        override fun next(): String = "cursor.${next.incrementAndGet()}"
    }

    private class RecordingListener : ClientEventListener {
        val events = Collections.synchronizedList(mutableListOf<ClientEvent>())
        val expiredSnapshots = Collections.synchronizedList(mutableListOf<ClientSnapshot>())

        override fun onEvents(events: List<ClientEvent>) {
            this.events += events
        }

        override fun onCursorExpired(snapshot: ClientSnapshot) {
            expiredSnapshots += snapshot
        }
    }

    private class FailingPersistence : ClientEventPersistence {
        private var bytes: ByteArray? = null
        var failNext = false

        override fun load(): ByteArray? = bytes?.copyOf()

        override fun save(plaintext: ByteArray) {
            if (failNext) {
                failNext = false
                throw IllegalStateException("injected persistence failure")
            }
            bytes = plaintext.copyOf()
        }

        override fun clear() {
            bytes = null
        }
    }

    private class CountingPersistence : ClientEventPersistence {
        private var bytes: ByteArray? = null
        var saveCount = 0

        override fun load(): ByteArray? = bytes?.copyOf()

        override fun save(plaintext: ByteArray) {
            saveCount += 1
            bytes = plaintext.copyOf()
        }

        override fun clear() {
            bytes = null
        }
    }

    private class BoundedPersistence(private val maxBytes: Int) : ClientEventPersistence {
        private var bytes: ByteArray? = null
        var maxObservedBytes = 0

        override fun load(): ByteArray? = bytes?.copyOf()

        override fun save(plaintext: ByteArray) {
            require(plaintext.size <= maxBytes) { "persistence byte budget exceeded" }
            maxObservedBytes = maxOf(maxObservedBytes, plaintext.size)
            bytes = plaintext.copyOf()
        }

        override fun clear() {
            bytes = null
        }
    }
}
