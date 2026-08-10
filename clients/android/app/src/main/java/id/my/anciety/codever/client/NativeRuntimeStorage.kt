package id.my.anciety.codever.client

import android.content.Context
import android.util.AtomicFile
import id.my.anciety.codever.security.SecretCipher
import id.my.anciety.codever.security.SecretEnvelope
import id.my.anciety.codever.security.codever.EncryptedTrustBlobStore
import id.my.anciety.codever.security.codever.Base64Url
import id.my.anciety.codever.security.codever.ReplayClaim
import id.my.anciety.codever.security.codever.ReplayStore
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonArray
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
    val timelineKeys = File(root, "matrix-timeline-keys.enc")
    val transfers = File(root, "transfers").apply {
        check(isDirectory || mkdirs()) { "Native transfer storage could not be created." }
    }

    fun clearAccountState() {
        listOf(
            events,
            commands,
            trust,
            replay,
            timelineKeys,
            // Remove data written by pre-release builds that used Gateway RPC history.
            File(root, "history-checkpoints.enc"),
        ).forEach { file ->
            AtomicFile(file).delete()
        }
        transfers.listFiles().orEmpty().forEach(File::delete)
    }
}

class AtomicEncryptedTimelineKeyStore(
    file: File,
    private val cipher: SecretCipher,
    scope: String,
) {
    private val atomic = AtomicFile(file)
    private val associatedData =
        "codever.matrix-timeline-keys.v2\u0000$scope".toByteArray(Charsets.UTF_8)
    private var grant: JsonObject? = load()

    @Synchronized
    fun save(value: JsonObject): Boolean {
        validate(value)
        if (grant == value) return false
        grant = value
        val plaintext = value.toString().toByteArray(Charsets.UTF_8)
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
        return true
    }

    @Synchronized
    fun key(epochId: String): ByteArray? {
        val epochs = grant?.get("epochs") as? JsonArray ?: return null
        val encoded = epochs.asSequence()
            .mapNotNull { it as? JsonObject }
            .firstOrNull { it["epoch_id"]?.jsonPrimitive?.contentOrNull == epochId }
            ?.get("key")?.jsonPrimitive?.contentOrNull
            ?: return null
        return Base64Url.decode(encoded).also { require(it.size == 32) }
    }

    @Synchronized
    fun clear() {
        grant = null
        atomic.delete()
    }

    private fun load(): JsonObject? {
        if (!atomic.baseFile.exists()) return null
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
            Json.parseToJsonElement(plaintext.toString(Charsets.UTF_8)).jsonObject.also(::validate)
        } finally {
            plaintext.fill(0)
        }
    }

    private fun validate(value: JsonObject) {
        require(value["version"]?.jsonPrimitive?.longOrNull == 2L)
        require(value["kind"]?.jsonPrimitive?.contentOrNull == "timeline_key_ring_grant")
        val epochs = value["epochs"] as? JsonArray
            ?: throw IllegalArgumentException("Matrix timeline key ring has no epochs.")
        require(epochs.size in 1..64)
        epochs.forEach { item ->
            val epoch = item as? JsonObject
                ?: throw IllegalArgumentException("Matrix timeline key epoch is invalid.")
            val key = epoch["key"]?.jsonPrimitive?.contentOrNull
                ?: throw IllegalArgumentException("Matrix timeline key is missing.")
            require(Base64Url.decode(key).size == 32)
        }
    }

    private companion object {
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
