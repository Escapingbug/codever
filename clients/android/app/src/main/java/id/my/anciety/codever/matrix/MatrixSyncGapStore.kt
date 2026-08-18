package id.my.anciety.codever.matrix

import android.util.AtomicFile
import id.my.anciety.codever.security.SecretCipher
import id.my.anciety.codever.security.SecretEnvelope
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

data class MatrixSyncGap(
    val from: String,
    val to: String,
    val cursor: String = from,
)

interface MatrixSyncGapStore {
    fun load(): List<MatrixSyncGap>

    fun save(value: List<MatrixSyncGap>)

    fun clear()
}

interface MatrixSyncGapBlobStore {
    fun exists(): Boolean

    fun read(): ByteArray

    fun write(bytes: ByteArray)

    fun delete()
}

class AtomicMatrixSyncGapBlobStore(file: File) : MatrixSyncGapBlobStore {
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

/**
 * Durable queue of Matrix timeline gaps. A gap is written before the live
 * `/sync` cursor advances, and its page cursor is advanced only after every
 * accepted event has completed its local transition. Process death therefore
 * causes harmless redelivery instead of silently losing the omitted range.
 */
class EncryptedMatrixSyncGapStore(
    private val blobStore: MatrixSyncGapBlobStore,
    private val cipher: SecretCipher,
    accountScope: String,
) : MatrixSyncGapStore {
    private val associatedData =
        "codever.matrix.control-sync-gaps.v1\u0000$accountScope".toByteArray(Charsets.UTF_8)

    constructor(file: File, cipher: SecretCipher, accountScope: String) : this(
        AtomicMatrixSyncGapBlobStore(file),
        cipher,
        accountScope,
    )

    @Synchronized
    override fun load(): List<MatrixSyncGap> {
        if (!blobStore.exists()) return emptyList()
        val encrypted = blobStore.read()
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
            require(plaintext.size <= MAX_PLAINTEXT_BYTES) { "Matrix sync gap state is too large." }
            decode(plaintext.toString(Charsets.UTF_8))
        } finally {
            plaintext.fill(0)
        }
    }

    @Synchronized
    override fun save(value: List<MatrixSyncGap>) {
        val validated = validate(value)
        if (validated.isEmpty()) {
            clear()
            return
        }
        val plaintext = buildJsonObject {
            put("version", 1)
            put("gaps", buildJsonArray {
                validated.forEach { gap ->
                    add(buildJsonObject {
                        put("from", gap.from)
                        put("to", gap.to)
                        put("cursor", gap.cursor)
                    })
                }
            })
        }.toString().toByteArray(Charsets.UTF_8)
        require(plaintext.size <= MAX_PLAINTEXT_BYTES) { "Matrix sync gap state is too large." }
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
            blobStore.write(encrypted)
        } finally {
            encrypted.fill(0)
        }
    }

    @Synchronized
    override fun clear() = blobStore.delete()

    private fun decode(raw: String): List<MatrixSyncGap> {
        val root = Json.parseToJsonElement(raw) as? JsonObject
            ?: throw IllegalArgumentException("Matrix sync gap state is invalid.")
        require(root.keys == setOf("version", "gaps")) { "Matrix sync gap state is invalid." }
        require(root["version"]?.jsonPrimitive?.intOrNull == 1) {
            "Unsupported Matrix sync gap state version."
        }
        val gaps = root["gaps"] as? JsonArray
            ?: throw IllegalArgumentException("Matrix sync gap queue is invalid.")
        return validate(gaps.map { element ->
            val value = element as? JsonObject
                ?: throw IllegalArgumentException("Matrix sync gap is invalid.")
            require(value.keys == setOf("from", "to", "cursor")) {
                "Matrix sync gap is invalid."
            }
            MatrixSyncGap(
                from = value.token("from"),
                to = value.token("to"),
                cursor = value.token("cursor"),
            )
        })
    }

    private fun validate(value: List<MatrixSyncGap>): List<MatrixSyncGap> {
        require(value.size <= MAX_GAPS) { "Matrix sync gap queue is too large." }
        val identities = mutableSetOf<Pair<String, String>>()
        value.forEach { gap ->
            validateToken(gap.from)
            validateToken(gap.to)
            validateToken(gap.cursor)
            require(gap.from != gap.to) { "Matrix sync gap is empty." }
            require(identities.add(gap.from to gap.to)) { "Matrix sync gap is duplicated." }
        }
        return value.toList()
    }

    private fun JsonObject.token(key: String): String =
        this[key]?.jsonPrimitive?.contentOrNull?.also(::validateToken)
            ?: throw IllegalArgumentException("Matrix sync gap token is invalid.")

    private fun validateToken(value: String) {
        require(value.isNotBlank() && value.length <= MAX_TOKEN_LENGTH) {
            "Matrix sync gap token is invalid."
        }
    }

    private companion object {
        const val MAX_TOKEN_LENGTH = 4_096
        const val MAX_GAPS = 64
        const val MAX_PLAINTEXT_BYTES = 1024 * 1024
    }
}

class InMemoryMatrixSyncGapStore(initial: List<MatrixSyncGap> = emptyList()) : MatrixSyncGapStore {
    private var value = initial.toList()

    @Synchronized
    override fun load(): List<MatrixSyncGap> = value.toList()

    @Synchronized
    override fun save(value: List<MatrixSyncGap>) {
        this.value = value.toList()
    }

    @Synchronized
    override fun clear() {
        value = emptyList()
    }
}
