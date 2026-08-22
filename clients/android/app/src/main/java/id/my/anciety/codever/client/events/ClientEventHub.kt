package id.my.anciety.codever.client.events

import java.security.SecureRandom
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

fun interface OpaqueCursorGenerator {
    fun next(): String
}

class SecureOpaqueCursorGenerator(
    private val random: SecureRandom = SecureRandom(),
) : OpaqueCursorGenerator {
    override fun next(): String = ByteArray(18).let { bytes ->
        random.nextBytes(bytes)
        try {
            buildString(3 + bytes.size * 2) {
                append("c1.")
                bytes.forEach { byte -> append("%02x".format(byte.toInt() and 0xff)) }
            }
        } finally {
            bytes.fill(0)
        }
    }
}

interface ClientEventListener {
    fun onEvents(events: List<ClientEvent>)

    /** The subscriber must discard its cursor and subscribe again. */
    fun onCursorExpired(snapshot: ClientSnapshot)
}

sealed interface SubscriptionBootstrap {
    val subscriptionId: String
    val barrierCursor: String

    data class Replay(
        override val subscriptionId: String,
        override val barrierCursor: String,
        val events: List<ClientEvent>,
    ) : SubscriptionBootstrap

    data class Snapshot(
        override val subscriptionId: String,
        override val barrierCursor: String,
        val snapshot: ClientSnapshot,
    ) : SubscriptionBootstrap
}

data class SubscriptionCursorResult(
    val subscriptionId: String,
    val throughCursor: String,
)

data class HistoryPage(
    val sessionId: String,
    val messages: List<ClientMessage>,
    val nextBefore: String?,
    val hasMore: Boolean,
    val asOfCursor: String,
)

class UnknownSubscriptionException : IllegalArgumentException("Unknown client event subscription.")

class InvalidSubscriptionCursorException :
    IllegalArgumentException("The cursor does not belong to this subscription lifecycle.")

class HistoryCursorInvalidException : IllegalArgumentException("The history cursor is invalid.")

/**
 * Thread-safe durable event and history coordinator.
 *
 * Subscribe creates an inactive barrier. Events published after that barrier
 * are persisted but never delivered until activate(), closing the classic gap
 * between a subscribe response and WebView listener installation.
 */
class ClientEventHub(
    private val persistence: ClientEventPersistence,
    private val initialSnapshot: ClientSnapshot,
    private val maxReplayEvents: Int = 1_000,
    private val maxSubscriptionReplayEvents: Int = 1_000,
    private val maxHistoryMessages: Int = 5_000,
    private val maxHistoryMessagesPerSession: Int = 1_000,
    private val maxPersistedStateBytes: Int = 3 * 1024 * 1024,
    private val deliveryBatchSize: Int = 100,
    private val cursorGenerator: OpaqueCursorGenerator = SecureOpaqueCursorGenerator(),
    private val now: () -> Long = System::currentTimeMillis,
) {
    private data class Subscription(
        val id: String,
        val barrierSequence: Long,
        val barrierCursor: String,
        val listener: ClientEventListener,
        var active: Boolean = false,
        var delivering: Boolean = false,
        var lastDeliveredSequence: Long,
        var lastDeliveredCursor: String,
        var acknowledgedSequence: Long,
        var acknowledgedCursor: String,
        val deliveredCursors: LinkedHashMap<String, Long>,
    )

    private val lock = Any()
    private val subscriptions = linkedMapOf<String, Subscription>()
    private var state: PersistedClientEventState

    init {
        require(maxReplayEvents in 1..10_000)
        require(maxSubscriptionReplayEvents in 1..10_000)
        require(maxHistoryMessages in 1..20_000)
        require(maxHistoryMessagesPerSession in 1..maxHistoryMessages)
        require(maxPersistedStateBytes in 4 * 1024..3 * 1024 * 1024)
        require(deliveryBatchSize in 1..100)
        val bytes = persistence.load()
        state = if (bytes == null) {
            val cursor = nextUniqueCursor(emptySet())
            persist(
                PersistedClientEventState(
                    headSequence = 0,
                    headCursor = cursor,
                    historySequence = 0,
                    events = emptyList(),
                    history = emptyList(),
                    snapshot = initialSnapshot.copy(cursor = cursor, generatedAt = now()),
                ),
            )
        } else {
            try {
                normalize(ClientEventStateCodec.decode(bytes))
            } finally {
                bytes.fill(0)
            }
        }
    }

    fun snapshot(): ClientSnapshot = synchronized(lock) { currentSnapshot() }

    /** Updates public snapshot state without clearing or advancing the event journal. */
    fun updateSnapshot(snapshot: ClientSnapshot): ClientSnapshot = synchronized(lock) {
        val updated = state.copy(snapshot = snapshotAtHead(snapshot))
        // Trust, commands, pairing and lifecycle each have their own durable
        // source and are reconstructed at startup. Gateway state is the only
        // snapshot payload cached here for offline startup.
        state = if (updated.snapshot.gatewayState != state.snapshot.gatewayState) {
            persist(updated)
        } else {
            updated
        }
        currentSnapshot()
    }

    fun publish(
        type: ClientEventType,
        payload: JsonElement,
        snapshot: ClientSnapshot? = null,
        occurredAt: Long = now(),
    ): ClientEvent = publishInternal(type, payload, snapshot, occurredAt, durable = true)

    /**
     * Delivers a process-lifecycle event without rewriting durable history.
     * After a process restart its cursor intentionally resolves to a snapshot.
     */
    fun publishTransient(
        type: ClientEventType,
        payload: JsonElement,
        snapshot: ClientSnapshot? = null,
        occurredAt: Long = now(),
    ): ClientEvent = publishInternal(type, payload, snapshot, occurredAt, durable = false)

    private fun publishInternal(
        type: ClientEventType,
        payload: JsonElement,
        snapshot: ClientSnapshot?,
        occurredAt: Long,
        durable: Boolean,
    ): ClientEvent {
        val event: ClientEvent
        val targets: List<String>
        synchronized(lock) {
            val nextSequence = Math.addExact(state.headSequence, 1L)
            val cursor = nextUniqueCursor(state.events.mapTo(mutableSetOf()) { it.event.cursor } + state.headCursor)
            event = ClientEvent(
                eventId = "evt.${cursor.removePrefix("c1.")}",
                cursor = cursor,
                occurredAt = occurredAt,
                type = type,
                payload = payload,
            )
            val events = (state.events + StoredClientEvent(nextSequence, event))
                .takeLast(maxReplayEvents)
            val baseSnapshot = snapshot ?: state.snapshot
            val updated = state.copy(
                headSequence = nextSequence,
                headCursor = cursor,
                events = events,
                snapshot = baseSnapshot.copy(cursor = cursor, generatedAt = now()),
            )
            state = if (durable) persist(updated) else updated
            targets = subscriptions.values.filter { it.active }.map { it.id }
        }
        targets.forEach(::deliverAvailable)
        return event
    }

    /** Atomically deduplicates history and emits message.upserted when changed. */
    fun upsertMessage(
        sessionId: String,
        message: ClientMessage,
        snapshot: ClientSnapshot? = null,
        occurredAt: Long = now(),
    ): ClientEvent? = upsertMessages(
        sessionId = sessionId,
        messages = listOf(message),
        snapshot = snapshot,
        occurredAt = occurredAt,
    ).singleOrNull()

    /**
     * Atomically deduplicates a history page, persists it once, and then
     * delivers the corresponding message.upserted events in cursor order.
     */
    fun upsertMessages(
        sessionId: String,
        messages: List<ClientMessage>,
        snapshot: ClientSnapshot? = null,
        occurredAt: Long = now(),
    ): List<ClientEvent> {
        requireOpaqueId(sessionId, "sessionId")
        messages.forEach { message ->
            require(message.sessionId == null || message.sessionId == sessionId) {
                "Message session id does not match its history partition."
            }
        }
        if (messages.isEmpty()) return emptyList()

        val emitted: List<ClientEvent>
        val targets: List<String>
        synchronized(lock) {
            val mutableHistory = state.history.toMutableList()
            val historyIndex = mutableMapOf<String, Int>()
            mutableHistory.forEachIndexed { index, stored ->
                if (stored.sessionId == sessionId) historyIndex[stored.message.eventId] = index
            }
            val historyCursors = mutableHistory.mapTo(mutableSetOf()) { it.cursor }
            historyCursors += state.headCursor
            val eventCursors = state.events.mapTo(mutableSetOf()) { it.event.cursor }
            eventCursors += state.headCursor

            var nextHistorySequence = state.historySequence
            var nextEventSequence = state.headSequence
            var headCursor = state.headCursor
            val storedEvents = mutableListOf<StoredClientEvent>()
            val events = mutableListOf<ClientEvent>()
            messages.forEach { message ->
                val existingIndex = historyIndex[message.eventId]
                val acceptedMessage = existingIndex?.let { index ->
                    preferLiveMessage(mutableHistory[index].message, message)
                } ?: message
                if (existingIndex != null && mutableHistory[existingIndex].message == acceptedMessage) {
                    return@forEach
                }
                if (existingIndex != null) {
                    mutableHistory[existingIndex] =
                        mutableHistory[existingIndex].copy(message = acceptedMessage)
                } else {
                    nextHistorySequence = Math.addExact(nextHistorySequence, 1L)
                    val historyCursor = nextUniqueCursor(historyCursors).also(historyCursors::add)
                    historyIndex[message.eventId] = mutableHistory.size
                    mutableHistory += StoredHistoryMessage(
                        sequence = nextHistorySequence,
                        cursor = historyCursor,
                        sessionId = sessionId,
                        message = acceptedMessage,
                    )
                }

                nextEventSequence = Math.addExact(nextEventSequence, 1L)
                headCursor = nextUniqueCursor(eventCursors).also(eventCursors::add)
                val event = ClientEvent(
                    eventId = "evt.${headCursor.removePrefix("c1.")}",
                    cursor = headCursor,
                    occurredAt = occurredAt,
                    type = ClientEventType.MESSAGE_UPSERTED,
                    payload = PublicClientJson.encodeMessage(acceptedMessage),
                )
                events += event
                storedEvents += StoredClientEvent(nextEventSequence, event)
            }
            if (events.isEmpty()) return emptyList()

            val baseSnapshot = snapshot ?: state.snapshot
            val updated = state.copy(
                headSequence = nextEventSequence,
                headCursor = headCursor,
                historySequence = nextHistorySequence,
                events = (state.events + storedEvents).takeLast(maxReplayEvents),
                history = boundHistory(mutableHistory),
                snapshot = baseSnapshot.copy(cursor = headCursor, generatedAt = now()),
            )
            state = persist(updated)
            emitted = events
            targets = subscriptions.values.filter { it.active }.map { it.id }
        }
        targets.forEach(::deliverAvailable)
        return emitted
    }

    /** A paginated copy can fill a gap, but it cannot downgrade a live action to read-only history. */
    private fun preferLiveMessage(existing: ClientMessage, incoming: ClientMessage): ClientMessage {
        val preferred = when {
            existing.historical == true && incoming.historical != true -> incoming
            existing.historical != true && incoming.historical == true -> existing
            else -> incoming
        }
        val isStreamedOutput = existing.kind in STREAMED_OUTPUT_KINDS &&
            incoming.kind in STREAMED_OUTPUT_KINDS
        // Streamed Agent/tool upserts change one logical bubble, not its
        // position in the turn. Other message types retain their existing
        // authority rules, including canonical user-echo clock correction.
        return if (!isStreamedOutput || preferred.timestamp == existing.timestamp) preferred
        else preferred.copy(timestamp = existing.timestamp)
    }

    fun removeMessage(
        sessionId: String,
        eventId: String,
        snapshot: ClientSnapshot? = null,
        occurredAt: Long = now(),
    ): ClientEvent? {
        requireOpaqueId(sessionId, "sessionId")
        requireOpaqueId(eventId, "eventId")
        val event: ClientEvent
        val targets: List<String>
        synchronized(lock) {
            if (state.history.none { it.sessionId == sessionId && it.message.eventId == eventId }) return null
            val updatedHistory = state.history.filterNot {
                it.sessionId == sessionId && it.message.eventId == eventId
            }
            val updatedSnapshot = snapshot ?: state.snapshot
            // Persist the history deletion and event as one state transition.
            val nextSequence = Math.addExact(state.headSequence, 1L)
            val cursor = nextUniqueCursor(state.events.mapTo(mutableSetOf()) { it.event.cursor } + state.headCursor)
            event = ClientEvent(
                eventId = "evt.${cursor.removePrefix("c1.")}",
                cursor = cursor,
                occurredAt = occurredAt,
                type = ClientEventType.MESSAGE_REMOVED,
                payload = buildJsonObject {
                    put("sessionId", sessionId)
                    put("eventId", eventId)
                },
            )
            val nextState = state.copy(
                headSequence = nextSequence,
                headCursor = cursor,
                events = (state.events + StoredClientEvent(nextSequence, event)).takeLast(maxReplayEvents),
                history = updatedHistory,
                snapshot = updatedSnapshot.copy(cursor = cursor, generatedAt = now()),
            )
            state = persist(nextState)
            targets = subscriptions.values.filter { it.active }.map { it.id }
        }
        targets.forEach(::deliverAvailable)
        return event
    }

    fun subscribe(
        afterCursor: String?,
        requestedMaxReplayEvents: Int = minOf(maxReplayEvents, maxSubscriptionReplayEvents),
        listener: ClientEventListener,
    ): SubscriptionBootstrap = synchronized(lock) {
        // The negotiated request limit and this process's retained replay
        // window are independent. A client may accept up to the protocol
        // maximum even when the service keeps a smaller journal; an expired
        // cursor then receives the normal snapshot fallback.
        require(requestedMaxReplayEvents in 1..maxSubscriptionReplayEvents)
        val id = nextSubscriptionId()
        val barrierSequence = state.headSequence
        val barrierCursor = state.headCursor
        val replay = afterCursor?.let(::replayAfter)
            ?.takeIf { it.size <= requestedMaxReplayEvents }
        val subscription = Subscription(
            id = id,
            barrierSequence = barrierSequence,
            barrierCursor = barrierCursor,
            listener = listener,
            lastDeliveredSequence = barrierSequence,
            lastDeliveredCursor = barrierCursor,
            acknowledgedSequence = sequenceForCursor(afterCursor) ?: barrierSequence,
            acknowledgedCursor = afterCursor ?: barrierCursor,
            deliveredCursors = linkedMapOf(barrierCursor to barrierSequence),
        )
        subscriptions[id] = subscription
        if (afterCursor != null && replay != null) {
            SubscriptionBootstrap.Replay(id, barrierCursor, replay.map(StoredClientEvent::event))
        } else {
            SubscriptionBootstrap.Snapshot(id, barrierCursor, currentSnapshot())
        }
    }

    /** Activates only the exact subscribe barrier; later/foreign cursors are rejected. */
    fun activate(subscriptionId: String, throughCursor: String): SubscriptionCursorResult {
        synchronized(lock) {
            val subscription = subscriptions[subscriptionId] ?: throw UnknownSubscriptionException()
            if (throughCursor != subscription.barrierCursor) throw InvalidSubscriptionCursorException()
            subscription.active = true
        }
        deliverAvailable(subscriptionId)
        return SubscriptionCursorResult(subscriptionId, throughCursor)
    }

    fun acknowledge(subscriptionId: String, throughCursor: String): SubscriptionCursorResult =
        synchronized(lock) {
            val subscription = subscriptions[subscriptionId] ?: throw UnknownSubscriptionException()
            val sequence = subscription.deliveredCursors[throughCursor]
                ?: throw InvalidSubscriptionCursorException()
            require(sequence >= subscription.acknowledgedSequence) { "Acknowledgements cannot move backwards." }
            require(sequence <= subscription.lastDeliveredSequence) { "Cannot acknowledge an undelivered cursor." }
            subscription.acknowledgedSequence = sequence
            subscription.acknowledgedCursor = throughCursor
            subscription.deliveredCursors.entries.removeAll { (_, deliveredSequence) ->
                deliveredSequence < sequence
            }
            SubscriptionCursorResult(subscriptionId, throughCursor)
        }

    fun unsubscribe(subscriptionId: String): Boolean = synchronized(lock) {
        subscriptions.remove(subscriptionId) != null
    }

    fun historyPage(
        sessionId: String,
        before: String? = null,
        limit: Int = 50,
        externalHasMore: Boolean = false,
    ): HistoryPage =
        synchronized(lock) {
            requireOpaqueId(sessionId, "sessionId")
            require(limit in 1..100)
            val messages = state.history.filter { it.sessionId == sessionId }
            val endExclusive = if (before == null) {
                messages.size
            } else {
                messages.indexOfFirst { it.cursor == before }
                    .takeIf { it >= 0 }
                    ?: throw HistoryCursorInvalidException()
            }
            val start = maxOf(0, endExclusive - limit)
            val selected = messages.subList(start, endExclusive)
            // externalHasMore keeps the oldest non-empty local page pageable,
            // while an empty page still terminates locally so the runtime can
            // perform the actual Gateway fetch instead of looping one cursor.
            val hasMore = start > 0 || (externalHasMore && selected.isNotEmpty())
            HistoryPage(
                sessionId = sessionId,
                messages = selected.map(StoredHistoryMessage::message),
                nextBefore = selected.firstOrNull()?.cursor?.takeIf { hasMore },
                hasMore = hasMore,
                asOfCursor = state.headCursor,
            )
        }

    fun subscriptionCount(): Int = synchronized(lock) { subscriptions.size }

    /** Wipes replay/history state and starts a new cursor epoch. */
    fun clear(): ClientSnapshot = synchronized(lock) {
        subscriptions.clear()
        persistence.clear()
        val cursor = nextUniqueCursor(emptySet())
        val cleared = PersistedClientEventState(
            headSequence = 0,
            headCursor = cursor,
            historySequence = 0,
            events = emptyList(),
            history = emptyList(),
            snapshot = initialSnapshot.copy(cursor = cursor, generatedAt = now()),
        )
        state = persist(cleared)
        currentSnapshot()
    }

    private fun deliverAvailable(subscriptionId: String) {
        synchronized(lock) {
            val subscription = subscriptions[subscriptionId] ?: return
            if (!subscription.active || subscription.delivering) return
            subscription.delivering = true
        }
        while (true) {
            val delivery = synchronized(lock) {
                val subscription = subscriptions[subscriptionId]
                    ?: return
                if (!subscription.active) {
                    subscription.delivering = false
                    return
                }
                val firstAvailable = state.events.firstOrNull()?.sequence
                if (
                    state.headSequence > subscription.lastDeliveredSequence &&
                    (firstAvailable == null || firstAvailable > subscription.lastDeliveredSequence + 1)
                ) {
                    subscription.active = false
                    subscription.delivering = false
                    return@synchronized Delivery.Expired(subscription.listener, currentSnapshot())
                }
                val batch = state.events.asSequence()
                    .filter { it.sequence > subscription.lastDeliveredSequence }
                    .take(deliveryBatchSize)
                    .toList()
                if (batch.isEmpty()) {
                    subscription.delivering = false
                    return
                }
                subscription.lastDeliveredSequence = batch.last().sequence
                subscription.lastDeliveredCursor = batch.last().event.cursor
                batch.forEach { subscription.deliveredCursors[it.event.cursor] = it.sequence }
                while (subscription.deliveredCursors.size > maxReplayEvents + 1) {
                    val oldest = subscription.deliveredCursors.entries.first()
                    subscription.deliveredCursors.remove(oldest.key)
                }
                Delivery.Events(subscription.listener, batch.map(StoredClientEvent::event))
            }
            try {
                when (delivery) {
                    is Delivery.Events -> delivery.listener.onEvents(delivery.events)
                    is Delivery.Expired -> {
                        delivery.listener.onCursorExpired(delivery.snapshot)
                        return
                    }
                }
            } catch (_: Exception) {
                // A destroyed WebView can make delivery fail. The journal remains
                // intact and the caller can unsubscribe/re-subscribe with its ack.
                synchronized(lock) {
                    subscriptions[subscriptionId]?.let {
                        it.active = false
                        it.delivering = false
                    }
                }
                return
            }
        }
    }

    private sealed interface Delivery {
        data class Events(val listener: ClientEventListener, val events: List<ClientEvent>) : Delivery
        data class Expired(val listener: ClientEventListener, val snapshot: ClientSnapshot) : Delivery
    }

    private fun replayAfter(cursor: String): List<StoredClientEvent>? {
        val sequence = sequenceForCursor(cursor) ?: return null
        val firstAvailable = state.events.firstOrNull()?.sequence
        if (
            state.headSequence > sequence &&
            (firstAvailable == null || firstAvailable > sequence + 1)
        ) return null
        return state.events.filter { it.sequence > sequence }
    }

    private fun sequenceForCursor(cursor: String?): Long? {
        if (cursor == null) return null
        if (cursor == state.headCursor) return state.headSequence
        return state.events.singleOrNull { it.event.cursor == cursor }?.sequence
    }

    private fun boundHistory(input: List<StoredHistoryMessage>): List<StoredHistoryMessage> {
        val keep = input.sortedWith(HISTORY_ORDER).toMutableList()
        keep.groupBy(StoredHistoryMessage::sessionId).values.forEach { sessionMessages ->
            val overflow = sessionMessages.size - maxHistoryMessagesPerSession
            if (overflow > 0) {
                val evict = sessionMessages.take(overflow).mapTo(mutableSetOf()) { it.sequence }
                keep.removeAll { it.sequence in evict }
            }
        }
        if (keep.size > maxHistoryMessages) {
            keep.subList(0, keep.size - maxHistoryMessages).clear()
        }
        return keep.sortedWith(HISTORY_ORDER)
    }

    private fun normalize(loaded: PersistedClientEventState): PersistedClientEventState {
        val normalized = loaded.copy(
            events = loaded.events.takeLast(maxReplayEvents),
            history = boundHistory(loaded.history),
            snapshot = loaded.snapshot.copy(cursor = loaded.headCursor),
        )
        return if (normalized != loaded || encodedSize(normalized) > maxPersistedStateBytes) {
            persist(normalized)
        } else {
            normalized
        }
    }

    private fun currentSnapshot(): ClientSnapshot = state.snapshot.copy(
        cursor = state.headCursor,
        generatedAt = now(),
    )

    private fun snapshotAtHead(snapshot: ClientSnapshot): ClientSnapshot = snapshot.copy(
        cursor = state.headCursor,
        generatedAt = now(),
    )

    private fun persist(value: PersistedClientEventState): PersistedClientEventState {
        var candidate = value.copy(history = value.history.sortedWith(HISTORY_ORDER))
        while (true) {
            val bytes = ClientEventStateCodec.encode(candidate)
            val fits = bytes.size <= maxPersistedStateBytes
            if (fits) {
                try {
                    persistence.save(bytes)
                } finally {
                    bytes.fill(0)
                }
                return candidate
            }
            bytes.fill(0)

            val oldestEvent = candidate.events.firstOrNull()
            val oldestHistory = candidate.history.firstOrNull()
            candidate = when {
                oldestEvent == null && oldestHistory == null -> throw IllegalArgumentException(
                    "Client snapshot exceeds the encrypted event-state byte budget.",
                )
                oldestHistory == null || (
                    oldestEvent != null && oldestEvent.event.occurredAt <= oldestHistory.message.timestamp
                ) -> candidate.copy(events = candidate.events.drop(1))
                else -> candidate.copy(history = candidate.history.drop(1))
            }
        }
    }

    private fun encodedSize(value: PersistedClientEventState): Int {
        val bytes = ClientEventStateCodec.encode(value)
        return try {
            bytes.size
        } finally {
            bytes.fill(0)
        }
    }

    private fun nextSubscriptionId(): String {
        while (true) {
            val candidate = "sub.${cursorGenerator.next()}"
            if (candidate !in subscriptions) return candidate
        }
    }

    private fun nextUniqueCursor(existing: Set<String>): String {
        repeat(100) {
            val candidate = cursorGenerator.next()
            requireOpaqueId(candidate, "generated cursor")
            if (candidate !in existing) return candidate
        }
        throw IllegalStateException("Opaque cursor generator repeatedly returned duplicates.")
    }

    private companion object {
        val STREAMED_OUTPUT_KINDS = setOf(ClientMessageKind.AGENT, ClientMessageKind.TOOL)
        val HISTORY_ORDER = compareBy<StoredHistoryMessage>(
            { it.message.timestamp },
            { it.sequence },
        )
    }
}
