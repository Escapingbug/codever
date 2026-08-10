package id.my.anciety.codever.client

import android.content.Context
import android.util.AtomicFile
import id.my.anciety.codever.security.SecretCipher
import id.my.anciety.codever.security.SecretEnvelope
import id.my.anciety.codever.security.codever.EncryptedTrustBlobStore
import id.my.anciety.codever.security.codever.ReplayClaim
import id.my.anciety.codever.security.codever.ReplayStore
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

class NativeRuntimeFiles(context: Context, deviceScope: String) {
    val root = File(context.noBackupFilesDir, "codever-client-v1/$deviceScope").apply {
        check(isDirectory || mkdirs()) { "Native client storage could not be created." }
    }
    val events = File(root, "events.enc")
    val commands = File(root, "commands.enc")
    val trust = File(root, "gateway-trust.enc")
    val replay = File(root, "replay.enc")
    val historyCheckpoints = File(root, "history-checkpoints.enc")
    val transfers = File(root, "transfers").apply {
        check(isDirectory || mkdirs()) { "Native transfer storage could not be created." }
    }

    fun clearAccountState() {
        listOf(events, commands, trust, replay, historyCheckpoints).forEach { file ->
            AtomicFile(file).delete()
        }
        transfers.listFiles().orEmpty().forEach(File::delete)
    }
}

/**
 * Persists the last Gateway history head that was fully reconciled for each
 * session. A live Matrix event is never allowed to advance this checkpoint;
 * only a paginated Gateway history response can do so.
 */
class AtomicEncryptedGatewayHistoryCheckpointStore(
    file: File,
    private val cipher: SecretCipher,
    scope: String,
) {
    private val atomic = AtomicFile(file)
    private val associatedData =
        "codever.gateway.history-checkpoints.v1\u0000$scope".toByteArray(Charsets.UTF_8)
    // A corrupt checkpoint cannot safely be treated as a first synchronization:
    // doing so could bless an existing, gapped local cache as complete.
    private var heads = load()

    @Synchronized
    fun head(sessionId: String): String? = heads[sessionId]

    @Synchronized
    fun update(sessionId: String, headEventId: String) {
        requireCheckpoint(sessionId, headEventId)
        if (heads[sessionId] == headEventId) return
        require(heads.size < MAX_SESSIONS || sessionId in heads) {
            "The Gateway history checkpoint store is full."
        }
        heads = heads + (sessionId to headEventId)
        save()
    }

    @Synchronized
    fun retainSessionIds(sessionIds: Set<String>) {
        val retained = heads.filterKeys(sessionIds::contains)
        if (retained == heads) return
        heads = retained
        if (heads.isEmpty()) atomic.delete() else save()
    }

    @Synchronized
    fun clear() {
        heads = emptyMap()
        atomic.delete()
    }

    private fun load(): Map<String, String> {
        if (!atomic.baseFile.exists()) return emptyMap()
        val encrypted = atomic.readFully()
        val plaintext = try {
            val envelope = SecretEnvelope.decode(encrypted)
            try {
                cipher.decrypt(envelope, associatedData)
            } finally {
                envelope.iv.fill(0)
                envelope.ciphertext.fill(0)
            }
        } finally {
            encrypted.fill(0)
        }
        return try {
            require(plaintext.size <= MAX_BYTES)
            val root = Json.parseToJsonElement(plaintext.toString(Charsets.UTF_8)).jsonObject
            require(root.keys == setOf("schemaVersion", "heads"))
            require(root.getValue("schemaVersion").jsonPrimitive.longOrNull == 1L)
            val values = root.getValue("heads").jsonObject
            require(values.size <= MAX_SESSIONS)
            values.mapValues { (sessionId, value) ->
                val headEventId = value.jsonPrimitive.contentOrNull
                    ?: throw IllegalArgumentException("Gateway history checkpoint is invalid.")
                requireCheckpoint(sessionId, headEventId)
                headEventId
            }
        } finally {
            plaintext.fill(0)
        }
    }

    private fun save() {
        val plaintext = buildJsonObject {
            put("schemaVersion", 1)
            put("heads", JsonObject(heads.toSortedMap().mapValues { (_, value) ->
                kotlinx.serialization.json.JsonPrimitive(value)
            }))
        }.toString().toByteArray(Charsets.UTF_8)
        require(plaintext.size <= MAX_BYTES)
        val encrypted = try {
            val envelope = cipher.encrypt(plaintext, associatedData)
            try {
                SecretEnvelope.encode(envelope)
            } finally {
                envelope.iv.fill(0)
                envelope.ciphertext.fill(0)
            }
        } finally {
            plaintext.fill(0)
        }
        try {
            atomic.writeExactly(encrypted)
        } finally {
            encrypted.fill(0)
        }
    }

    private fun requireCheckpoint(sessionId: String, headEventId: String) {
        require(sessionId.isNotBlank() && sessionId.length <= 512 && sessionId.none(Char::isISOControl))
        require(HISTORY_EVENT_ID.matches(headEventId))
    }

    private companion object {
        val HISTORY_EVENT_ID = Regex("^[A-Za-z0-9_-]{43}$")
        const val MAX_SESSIONS = 5_000
        const val MAX_BYTES = 1024 * 1024
    }
}

class AtomicEncryptedTrustBlobStore(file: File) : EncryptedTrustBlobStore {
    private val atomic = AtomicFile(file)

    @Synchronized
    override fun read(): ByteArray? = atomic.baseFile.takeIf(File::exists)?.let { atomic.readFully() }

    @Synchronized
    override fun write(bytes: ByteArray) = atomic.writeExactly(bytes)

    @Synchronized
    override fun clear() = atomic.delete()
}

/** Durable replay claims are security state, not a best-effort cache. */
class AtomicEncryptedReplayStore(
    file: File,
    private val cipher: SecretCipher,
    scope: String,
) : ReplayStore {
    private val atomic = AtomicFile(file)
    private val associatedData = "codever.replay.v1\u0000$scope".toByteArray(Charsets.UTF_8)

    @Synchronized
    override fun claimAll(claims: List<ReplayClaim>, now: Long): Boolean {
        require(claims.isNotEmpty() && claims.size <= 32)
        require(claims.map(ReplayClaim::key).distinct().size == claims.size)
        val current = load().filterValues { it > now }.toMutableMap()
        if (claims.any { it.key in current }) return false
        claims.forEach { claim ->
            require(claim.key.length in 1..2_048 && claim.expiresAt > now)
            current[claim.key] = claim.expiresAt
        }
        require(current.size <= MAX_CLAIMS) { "The native replay ledger is full." }
        save(current)
        return true
    }

    @Synchronized
    fun clear() = atomic.delete()

    private fun load(): Map<String, Long> {
        if (!atomic.baseFile.exists()) return emptyMap()
        val encrypted = atomic.readFully()
        val plaintext = try {
            val envelope = SecretEnvelope.decode(encrypted)
            try {
                cipher.decrypt(envelope, associatedData)
            } finally {
                envelope.iv.fill(0)
                envelope.ciphertext.fill(0)
            }
        } finally {
            encrypted.fill(0)
        }
        return try {
            require(plaintext.size <= MAX_BYTES)
            val root = Json.parseToJsonElement(plaintext.toString(Charsets.UTF_8)).jsonObject
            require(root.keys == setOf("schemaVersion", "claims"))
            require(root.getValue("schemaVersion").jsonPrimitive.longOrNull == 1L)
            val values = root.getValue("claims").jsonObject
            require(values.size <= MAX_CLAIMS)
            values.mapValues { (key, value) ->
                require(key.length in 1..2_048)
                value.jsonPrimitive.longOrNull?.also { require(it >= 0) }
                    ?: throw IllegalArgumentException("Replay expiry is invalid.")
            }
        } finally {
            plaintext.fill(0)
        }
    }

    private fun save(claims: Map<String, Long>) {
        val plaintext = buildJsonObject {
            put("schemaVersion", 1)
            put("claims", JsonObject(claims.toSortedMap().mapValues { (_, value) ->
                kotlinx.serialization.json.JsonPrimitive(value)
            }))
        }.toString().toByteArray(Charsets.UTF_8)
        require(plaintext.size <= MAX_BYTES)
        val encrypted = try {
            val envelope = cipher.encrypt(plaintext, associatedData)
            try {
                SecretEnvelope.encode(envelope)
            } finally {
                envelope.iv.fill(0)
                envelope.ciphertext.fill(0)
            }
        } finally {
            plaintext.fill(0)
        }
        try {
            atomic.writeExactly(encrypted)
        } finally {
            encrypted.fill(0)
        }
    }

    private companion object {
        const val MAX_CLAIMS = 20_000
        const val MAX_BYTES = 3 * 1024 * 1024
    }
}

private fun AtomicFile.writeExactly(bytes: ByteArray) {
    val output = startWrite()
    try {
        output.write(bytes)
        output.fd.sync()
        finishWrite(output)
    } catch (error: Exception) {
        failWrite(output)
        throw error
    }
}
