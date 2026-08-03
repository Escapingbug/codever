package id.my.anciety.codever.client.command

import android.util.AtomicFile
import id.my.anciety.codever.security.SecretCipher
import id.my.anciety.codever.security.SecretEnvelope
import java.io.File

internal data class PersistedCommand(
    val operationId: String,
    val commandId: String,
    val retiredCommandIds: List<String>,
    val idempotencyKey: String,
    val requestFingerprint: String,
    val state: CommandState,
    val submittedAt: Long,
    val updatedAt: Long,
    val sessionId: String?,
    val sequence: Long,
    val baseRevision: Long,
    val revision: Long?,
    val cancelRequested: Boolean,
    val completion: CommandCompletion?,
    val expectedRevision: Long?,
    val payload: kotlinx.serialization.json.JsonObject,
) {
    override fun toString(): String =
        "PersistedCommand(operationId=$operationId, commandId=$commandId, " +
            "retiredCommandIds=$retiredCommandIds, idempotencyKey=$idempotencyKey, " +
            "requestFingerprint=$requestFingerprint, state=$state, submittedAt=$submittedAt, " +
            "updatedAt=$updatedAt, sessionId=$sessionId, sequence=$sequence, " +
            "baseRevision=$baseRevision, revision=$revision, cancelRequested=$cancelRequested, " +
            "completion=$completion, expectedRevision=$expectedRevision, payload=<redacted>)"
}

internal data class ReleasedCommandTombstone(
    val operationId: String,
    val commandId: String,
    val idempotencyKey: String,
    val requestFingerprint: String,
    val releasedAt: Long,
)

internal data class CommandOutboxSnapshot(
    val lastAcknowledgedSequence: Long = 0,
    val lastRevision: Long = 0,
    val commands: List<PersistedCommand> = emptyList(),
    val released: List<ReleasedCommandTombstone> = emptyList(),
)

/**
 * Persistence boundary for the outbox. Implementations must replace the full
 * snapshot atomically or throw without changing the previously durable value.
 */
internal interface CommandOutboxStore {
    fun load(): CommandOutboxSnapshot?

    fun save(snapshot: CommandOutboxSnapshot)

    fun clear()
}

internal interface CommandOutboxBlobStore {
    fun exists(): Boolean

    fun read(): ByteArray

    fun write(bytes: ByteArray)

    fun delete()
}

internal class AtomicCommandOutboxBlobStore(file: File) : CommandOutboxBlobStore {
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

internal class EncryptedAtomicCommandOutboxStore(
    private val blobStore: CommandOutboxBlobStore,
    private val cipher: SecretCipher,
    accountScope: String,
) : CommandOutboxStore {
    private val associatedData: ByteArray

    init {
        require(accountScope.isNotBlank() && accountScope.length <= 1_024) {
            "Command outbox account scope is invalid."
        }
        associatedData = "codever.command.outbox.v1\u0000$accountScope".toByteArray(Charsets.UTF_8)
    }

    constructor(file: File, cipher: SecretCipher, accountScope: String) : this(
        AtomicCommandOutboxBlobStore(file),
        cipher,
        accountScope,
    )

    @Synchronized
    override fun load(): CommandOutboxSnapshot? {
        if (!blobStore.exists()) return null
        val encrypted = blobStore.read()
        val envelope = try {
            SecretEnvelope.decode(encrypted)
        } finally {
            encrypted.fill(0)
        }
        val plaintext = try {
            cipher.decrypt(envelope, associatedData)
        } finally {
            envelope.iv.fill(0)
            envelope.ciphertext.fill(0)
        }
        return try {
            CommandOutboxCodec.decode(plaintext)
        } finally {
            plaintext.fill(0)
        }
    }

    @Synchronized
    override fun save(snapshot: CommandOutboxSnapshot) {
        val plaintext = CommandOutboxCodec.encode(snapshot)
        val encrypted = try {
            val payload = cipher.encrypt(plaintext, associatedData)
            try {
                SecretEnvelope.encode(payload)
            } finally {
                payload.iv.fill(0)
                payload.ciphertext.fill(0)
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
}

internal class InMemoryCommandOutboxStore(
    initial: CommandOutboxSnapshot? = null,
) : CommandOutboxStore {
    private var value = initial

    @Synchronized
    override fun load(): CommandOutboxSnapshot? = value

    @Synchronized
    override fun save(snapshot: CommandOutboxSnapshot) {
        value = snapshot
    }

    @Synchronized
    override fun clear() {
        value = null
    }
}
