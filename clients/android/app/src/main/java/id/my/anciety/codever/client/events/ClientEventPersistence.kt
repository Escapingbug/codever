package id.my.anciety.codever.client.events

import android.util.AtomicFile
import id.my.anciety.codever.security.SecretCipher
import id.my.anciety.codever.security.SecretEnvelope
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * Injectable plaintext state persistence boundary. Implementations must copy
 * input/output bytes because the caller wipes its buffers after every call.
 */
interface ClientEventPersistence {
    fun load(): ByteArray?

    fun save(plaintext: ByteArray)

    fun clear()
}

class InMemoryClientEventPersistence(initial: ByteArray? = null) : ClientEventPersistence {
    private var bytes = initial?.copyOf()

    @Synchronized
    override fun load(): ByteArray? = bytes?.copyOf()

    @Synchronized
    override fun save(plaintext: ByteArray) {
        bytes = plaintext.copyOf()
    }

    @Synchronized
    override fun clear() {
        bytes?.fill(0)
        bytes = null
    }
}

/** Android AtomicFile + reusable Keystore-backed SecretCipher implementation. */
class EncryptedAtomicClientEventPersistence(
    file: File,
    private val cipher: SecretCipher,
    accountScope: String,
    private val maxPlaintextBytes: Int = 3 * 1024 * 1024,
) : ClientEventPersistence {
    private val atomicFile = AtomicFile(file)
    private val associatedData =
        "codever.client.events.v1\u0000$accountScope".toByteArray(Charsets.UTF_8)

    init {
        require(accountScope.length in 1..512)
        require(maxPlaintextBytes in 16 * 1024..3 * 1024 * 1024)
    }

    @Synchronized
    override fun load(): ByteArray? {
        if (!atomicFile.baseFile.exists()) return null
        val encrypted = atomicFile.readFully()
        return try {
            val payload = SecretEnvelope.decode(encrypted)
            try {
                cipher.decrypt(payload, associatedData).also {
                    require(it.size <= maxPlaintextBytes) { "Client event state is too large." }
                }
            } finally {
                payload.iv.fill(0)
                payload.ciphertext.fill(0)
            }
        } finally {
            encrypted.fill(0)
        }
    }

    @Synchronized
    override fun save(plaintext: ByteArray) {
        require(plaintext.size <= maxPlaintextBytes) { "Client event state is too large." }
        val payload = cipher.encrypt(plaintext, associatedData)
        val encrypted = try {
            SecretEnvelope.encode(payload)
        } finally {
            payload.iv.fill(0)
            payload.ciphertext.fill(0)
        }
        val output = atomicFile.startWrite()
        try {
            output.write(encrypted)
            output.fd.sync()
            atomicFile.finishWrite(output)
        } catch (error: Exception) {
            atomicFile.failWrite(output)
            throw error
        } finally {
            encrypted.fill(0)
        }
    }

    @Synchronized
    override fun clear() = atomicFile.delete()
}

internal data class StoredClientEvent(val sequence: Long, val event: ClientEvent)

internal data class StoredHistoryMessage(
    val sequence: Long,
    val cursor: String,
    val sessionId: String,
    val message: ClientMessage,
)

internal data class PersistedClientEventState(
    val headSequence: Long,
    val headCursor: String,
    val historySequence: Long,
    val events: List<StoredClientEvent>,
    val history: List<StoredHistoryMessage>,
    val snapshot: ClientSnapshot,
)

internal object ClientEventStateCodec {
    fun encode(state: PersistedClientEventState): ByteArray = buildJsonObject {
        put("schemaVersion", 1)
        put("headSequence", state.headSequence)
        put("headCursor", state.headCursor)
        put("historySequence", state.historySequence)
        put("events", buildJsonArray {
            state.events.forEach { stored ->
                add(buildJsonObject {
                    put("sequence", stored.sequence)
                    put("event", PublicClientJson.encodeEvent(stored.event))
                })
            }
        })
        put("history", buildJsonArray {
            state.history.forEach { stored ->
                add(buildJsonObject {
                    put("sequence", stored.sequence)
                    put("cursor", stored.cursor)
                    put("sessionId", stored.sessionId)
                    put("message", PublicClientJson.encodeMessage(stored.message))
                })
            }
        })
        put("snapshot", PublicClientJson.encodeSnapshot(state.snapshot))
    }.toString().toByteArray(Charsets.UTF_8)

    fun decode(bytes: ByteArray): PersistedClientEventState {
        require(bytes.size <= MAX_STATE_BYTES) { "Client event state is too large." }
        val root = Json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).strictObject(
            "client event state",
            setOf(
                "schemaVersion", "headSequence", "headCursor", "historySequence",
                "events", "history", "snapshot",
            ),
        )
        require(root.requiredInt("schemaVersion") == 1) { "Unsupported client event state version." }
        val headSequence = root.requiredLong("headSequence").also { require(it >= 0) }
        val headCursor = root.requiredString("headCursor", 512)
        val historySequence = root.requiredLong("historySequence").also { require(it >= 0) }
        val events = root.getValue("events").strictArray("stored client events", MAX_EVENTS)
            .map { item ->
                val value = item.strictObject("stored client event", setOf("sequence", "event"))
                StoredClientEvent(
                    value.requiredLong("sequence").also { require(it > 0) },
                    PublicClientJson.decodeEvent(value.getValue("event")),
                )
            }
        val history = root.getValue("history").strictArray("stored client history", MAX_HISTORY)
            .map { item ->
                val value = item.strictObject(
                    "stored history message",
                    setOf("sequence", "cursor", "sessionId", "message"),
                )
                StoredHistoryMessage(
                    sequence = value.requiredLong("sequence").also { require(it > 0) },
                    cursor = value.requiredString("cursor", 512),
                    sessionId = value.requiredString("sessionId", 512),
                    message = PublicClientJson.decodeMessage(value.getValue("message")),
                )
            }
        val snapshot = PublicClientJson.decodeSnapshot(root.getValue("snapshot"))
        require(events.zipWithNext().all { (first, second) -> first.sequence < second.sequence }) {
            "Stored client events are not ordered."
        }
        require(events.lastOrNull()?.sequence?.let { it == headSequence } ?: (headSequence >= 0L)) {
            "Stored client event head is inconsistent."
        }
        require(
            events.all { it.event.cursor.isNotEmpty() } &&
                history.all { it.sequence <= historySequence } &&
                history.map { it.sequence }.distinct().size == history.size,
        ) { "Stored client history sequence is invalid." }
        require(snapshot.cursor == headCursor) { "Stored snapshot cursor is inconsistent." }
        require(events.lastOrNull()?.event?.cursor?.let { it == headCursor } ?: true) {
            "Stored client cursor is inconsistent."
        }
        require(history.groupBy { it.sessionId }.values.all { messages ->
            messages.map { it.message.eventId }.distinct().size == messages.size
        }) { "Stored client history contains duplicate event ids." }
        return PersistedClientEventState(
            headSequence,
            headCursor,
            historySequence,
            events,
            history,
            snapshot,
        )
    }

    private fun JsonElement.strictObject(label: String, keys: Set<String>): JsonObject =
        (this as? JsonObject)?.also { require(it.keys == keys) { "$label shape is invalid." } }
            ?: throw IllegalArgumentException("$label must be an object.")

    private fun JsonElement.strictArray(label: String, maxSize: Int): JsonArray =
        (this as? JsonArray)?.also { require(it.size <= maxSize) { "$label is too large." } }
            ?: throw IllegalArgumentException("$label must be an array.")

    private fun JsonObject.requiredString(key: String, maxLength: Int): String = get(key)
        ?.jsonPrimitive
        ?.takeIf { it.isString }
        ?.contentOrNull
        ?.takeIf { it.length in 1..maxLength }
        ?: throw IllegalArgumentException("$key is invalid.")

    private fun JsonObject.requiredLong(key: String): Long = get(key)?.jsonPrimitive?.longOrNull
        ?: throw IllegalArgumentException("$key is invalid.")

    private fun JsonObject.requiredInt(key: String): Int = get(key)?.jsonPrimitive?.intOrNull
        ?: throw IllegalArgumentException("$key is invalid.")

    private const val MAX_STATE_BYTES = 3 * 1024 * 1024
    private const val MAX_EVENTS = 10_000
    private const val MAX_HISTORY = 20_000
}
