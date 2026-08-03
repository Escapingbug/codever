package id.my.anciety.codever.matrix

import android.util.AtomicFile
import id.my.anciety.codever.security.SecretCipher
import id.my.anciety.codever.security.SecretEnvelope
import java.io.File
import java.security.MessageDigest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

data class DecryptedMatrixEvent(
    val cursor: Long,
    val roomId: String,
    val eventId: String,
    val receivedAt: Long,
    val rawJson: String,
)

data class JournalReadResult(
    val events: List<DecryptedMatrixEvent>,
    val cursorExpired: Boolean,
    val oldestAvailableCursor: Long?,
    val latestCursor: Long,
)

interface DecryptedEventJournal {
    fun append(roomId: String, eventId: String, receivedAt: Long, rawJson: String): Long?

    fun latestCursor(): Long

    fun readAfter(cursor: Long?, limit: Int): JournalReadResult

    fun clear()
}

interface JournalBlobStore {
    fun exists(): Boolean

    fun read(): ByteArray

    fun write(bytes: ByteArray)

    fun delete()
}

class AtomicJournalBlobStore(file: File) : JournalBlobStore {
    private val atomicFile = AtomicFile(file)

    override fun exists(): Boolean = atomicFile.baseFile.exists()

    override fun read(): ByteArray = atomicFile.readFully()

    override fun write(bytes: ByteArray) {
        val output = atomicFile.startWrite()
        try {
            output.write(bytes)
            output.fd.sync()
            atomicFile.finishWrite(output)
        } catch (error: Exception) {
            atomicFile.failWrite(output)
            throw error
        }
    }

    override fun delete() = atomicFile.delete()
}

class EncryptedBoundedEventJournal(
    private val blobStore: JournalBlobStore,
    private val cipher: SecretCipher,
    accountScope: String,
    private val maxEvents: Int = 1_000,
    private val maxPlaintextBytes: Int = 2 * 1024 * 1024,
) : DecryptedEventJournal {
    private val associatedData =
        "codever.matrix.decrypted-journal.v1\u0000$accountScope".toByteArray(Charsets.UTF_8)
    private var loaded = false
    private var cursor = 0L
    private val entries = ArrayDeque<DecryptedMatrixEvent>()
    private val latestFingerprintByEventId = linkedMapOf<String, String>()

    init {
        require(maxEvents in 1..10_000)
        require(maxPlaintextBytes in 16 * 1024..3 * 1024 * 1024)
    }

    constructor(
        file: File,
        cipher: SecretCipher,
        accountScope: String,
        maxEvents: Int = 1_000,
        maxPlaintextBytes: Int = 2 * 1024 * 1024,
    ) : this(
        AtomicJournalBlobStore(file),
        cipher,
        accountScope,
        maxEvents,
        maxPlaintextBytes,
    )

    @Synchronized
    override fun append(roomId: String, eventId: String, receivedAt: Long, rawJson: String): Long? {
        ensureLoaded()
        require(roomId.length in 1..512 && eventId.length in 1..512) { "Matrix event identity is invalid." }
        require(rawJson.toByteArray(Charsets.UTF_8).size <= MAX_EVENT_BYTES) {
            "Matrix event is too large for the native journal."
        }
        val parsed = Json.parseToJsonElement(rawJson).jsonObject
        val rawEventId = parsed["event_id"]?.jsonPrimitive?.contentOrNull
        require(rawEventId == null || rawEventId == eventId) { "Matrix event id does not match its JSON." }
        val fingerprint = fingerprint(rawJson)
        if (latestFingerprintByEventId[eventId] == fingerprint) return null

        val previousEntries = ArrayDeque(entries)
        val previousFingerprints = LinkedHashMap(latestFingerprintByEventId)
        val previousCursor = cursor
        return try {
            val next = Math.addExact(cursor, 1L)
            entries.addLast(DecryptedMatrixEvent(next, roomId, eventId, receivedAt, rawJson))
            cursor = next
            latestFingerprintByEventId[eventId] = fingerprint
            trimAndPersist()
            next
        } catch (error: Exception) {
            entries.clear()
            entries.addAll(previousEntries)
            latestFingerprintByEventId.clear()
            latestFingerprintByEventId.putAll(previousFingerprints)
            cursor = previousCursor
            throw error
        }
    }

    @Synchronized
    override fun latestCursor(): Long {
        ensureLoaded()
        return cursor
    }

    @Synchronized
    override fun readAfter(cursor: Long?, limit: Int): JournalReadResult {
        ensureLoaded()
        require(limit in 1..maxEvents)
        val after = cursor ?: Long.MIN_VALUE
        val oldest = entries.firstOrNull()?.cursor
        val expired = cursor != null && oldest != null && cursor < oldest - 1
        return JournalReadResult(
            events = if (expired) emptyList() else {
                entries.asSequence().filter { it.cursor > after }.take(limit).toList()
            },
            cursorExpired = expired,
            oldestAvailableCursor = oldest,
            latestCursor = this.cursor,
        )
    }

    @Synchronized
    override fun clear() {
        entries.clear()
        latestFingerprintByEventId.clear()
        cursor = 0
        loaded = true
        blobStore.delete()
    }

    private fun ensureLoaded() {
        if (loaded) return
        if (!blobStore.exists()) {
            loaded = true
            return
        }
        val plaintext = cipher.decrypt(
            SecretEnvelope.decode(blobStore.read()),
            associatedData,
        )
        try {
            decode(plaintext)
        } finally {
            plaintext.fill(0)
        }
        loaded = true
    }

    private fun trimAndPersist() {
        while (entries.size > maxEvents || encodedSize() > maxPlaintextBytes) {
            check(entries.size > 1) { "A single Matrix event exceeds the journal capacity." }
            entries.removeFirst()
            rebuildFingerprints()
        }
        val plaintext = encode()
        val encrypted = try {
            SecretEnvelope.encode(cipher.encrypt(plaintext, associatedData))
        } finally {
            plaintext.fill(0)
        }
        try {
            blobStore.write(encrypted)
        } finally {
            encrypted.fill(0)
        }
    }

    private fun encodedSize(): Int = encode().let { encoded ->
        try {
            encoded.size
        } finally {
            encoded.fill(0)
        }
    }

    private fun encode(): ByteArray = buildJsonObject {
        put("schemaVersion", 1)
        put("cursor", cursor)
        put("events", buildJsonArray {
            entries.forEach { event ->
                add(buildJsonObject {
                    put("cursor", event.cursor)
                    put("roomId", event.roomId)
                    put("eventId", event.eventId)
                    put("receivedAt", event.receivedAt)
                    put("raw", Json.parseToJsonElement(event.rawJson))
                })
            }
        })
    }.toString().toByteArray(Charsets.UTF_8)

    private fun decode(bytes: ByteArray) {
        require(bytes.size <= maxPlaintextBytes) { "Matrix journal is too large." }
        val root = Json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject
        require(root.keys == setOf("schemaVersion", "cursor", "events")) {
            "Matrix journal shape is invalid."
        }
        require(root.requiredLong("schemaVersion") == 1L) { "Matrix journal version is unsupported." }
        val storedCursor = root.requiredLong("cursor")
        require(storedCursor >= 0) { "Matrix journal cursor is invalid." }
        val decoded = root.getValue("events").jsonArray.map(::decodeEvent)
        require(decoded.size <= maxEvents && decoded.zipWithNext().all { (a, b) -> a.cursor < b.cursor }) {
            "Matrix journal ordering is invalid."
        }
        require(
            (decoded.isEmpty() && storedCursor == 0L) || decoded.lastOrNull()?.cursor == storedCursor,
        ) { "Matrix journal cursor is inconsistent." }
        entries.clear()
        entries.addAll(decoded)
        cursor = storedCursor
        rebuildFingerprints()
    }

    private fun decodeEvent(element: kotlinx.serialization.json.JsonElement): DecryptedMatrixEvent {
        val value = element.jsonObject
        require(value.keys == setOf("cursor", "roomId", "eventId", "receivedAt", "raw")) {
            "Matrix journal event shape is invalid."
        }
        val raw = value.getValue("raw").toString()
        require(raw.toByteArray(Charsets.UTF_8).size <= MAX_EVENT_BYTES) {
            "Matrix journal event is too large."
        }
        return DecryptedMatrixEvent(
            cursor = value.requiredLong("cursor").also { require(it > 0) },
            roomId = value.requiredString("roomId", 512),
            eventId = value.requiredString("eventId", 512),
            receivedAt = value.requiredLong("receivedAt").also { require(it >= 0) },
            rawJson = raw,
        )
    }

    private fun rebuildFingerprints() {
        latestFingerprintByEventId.clear()
        entries.forEach { latestFingerprintByEventId[it.eventId] = fingerprint(it.rawJson) }
    }

    private fun fingerprint(value: String): String = Hex.encode(
        MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)),
    )

    private fun JsonObject.requiredLong(key: String): Long = get(key)
        ?.jsonPrimitive
        ?.longOrNull
        ?: throw IllegalArgumentException("Matrix journal field $key is invalid.")

    private fun JsonObject.requiredString(key: String, maxLength: Int): String = get(key)
        ?.jsonPrimitive
        ?.takeIf { it.isString }
        ?.contentOrNull
        ?.takeIf { it.isNotEmpty() && it.length <= maxLength }
        ?: throw IllegalArgumentException("Matrix journal field $key is invalid.")

    private companion object {
        const val MAX_EVENT_BYTES = 512 * 1024
    }
}

class InMemoryBoundedEventJournal(
    private val maxEvents: Int = 1_000,
) : DecryptedEventJournal {
    private val entries = ArrayDeque<DecryptedMatrixEvent>()
    private val fingerprints = mutableMapOf<String, String>()
    private var cursor = 0L

    @Synchronized
    override fun append(roomId: String, eventId: String, receivedAt: Long, rawJson: String): Long? {
        val fingerprint = Hex.encode(
            MessageDigest.getInstance("SHA-256").digest(rawJson.toByteArray(Charsets.UTF_8)),
        )
        if (fingerprints[eventId] == fingerprint) return null
        cursor += 1
        entries.addLast(DecryptedMatrixEvent(cursor, roomId, eventId, receivedAt, rawJson))
        fingerprints[eventId] = fingerprint
        var trimmed = false
        while (entries.size > maxEvents) {
            entries.removeFirst()
            trimmed = true
        }
        if (trimmed) {
            fingerprints.clear()
            entries.forEach { event ->
                fingerprints[event.eventId] = Hex.encode(
                    MessageDigest.getInstance("SHA-256")
                        .digest(event.rawJson.toByteArray(Charsets.UTF_8)),
                )
            }
        }
        return cursor
    }

    @Synchronized
    override fun latestCursor(): Long = cursor

    @Synchronized
    override fun readAfter(cursor: Long?, limit: Int): JournalReadResult {
        require(limit in 1..maxEvents)
        val oldest = entries.firstOrNull()?.cursor
        val expired = cursor != null && oldest != null && cursor < oldest - 1
        return JournalReadResult(
            events = if (expired) emptyList() else {
                entries.filter { it.cursor > (cursor ?: Long.MIN_VALUE) }.take(limit)
            },
            cursorExpired = expired,
            oldestAvailableCursor = oldest,
            latestCursor = this.cursor,
        )
    }

    @Synchronized
    override fun clear() {
        entries.clear()
        fingerprints.clear()
        cursor = 0
    }
}
