package id.my.anciety.codever.client.command

import id.my.anciety.codever.security.EncryptedPayload
import id.my.anciety.codever.security.SecretCipher
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class EncryptedCommandOutboxStoreTest {
    @Test
    fun `encrypted store atomically round trips outbox without plaintext leakage`() {
        val blob = MemoryBlobStore()
        val cipher = JvmAesGcmCipher()
        val store = EncryptedAtomicCommandOutboxStore(blob, cipher, "account-a")
        val outbox = DurableCommandOutbox(store, IncrementingClock(), IncrementingIds())
        val receipt = outbox.enqueue(
            java.util.UUID.randomUUID().toString(),
            buildJsonObject {
                put("operation", "prompt")
                put("sessionId", "session-1")
                put("text", "highly secret prompt")
            },
        )
        val transmission = outbox.claimForTransmission(receipt.commandId)!!

        val bytes = blob.value!!
        assertFalse(bytes.toString(Charsets.UTF_8).contains("highly secret prompt"))
        val persisted = checkNotNull(store.load()).commands.single()
        assertEquals(transmission.issuedAt, persisted.authenticationIssuedAt)
        assertEquals(transmission.nonce, persisted.authenticationNonce)
        val restored = DurableCommandOutbox(store, IncrementingClock(), IncrementingIds())
        assertEquals(CommandState.RECOVERY_REQUIRED, restored.get(receipt.commandId)?.state)
    }

    @Test
    fun `encrypted store binds ciphertext to account scope`() {
        val blob = MemoryBlobStore()
        val cipher = JvmAesGcmCipher()
        val first = EncryptedAtomicCommandOutboxStore(blob, cipher, "account-a")
        first.save(CommandOutboxSnapshot())

        val other = EncryptedAtomicCommandOutboxStore(blob, cipher, "account-b")
        assertThrows(Exception::class.java) { other.load() }
        assertTrue(blob.value != null)
    }

    @Test
    fun `legacy submitted command without authentication is quarantined without replay`() {
        val store = InMemoryCommandOutboxStore()
        val ids = IncrementingIds()
        val outbox = DurableCommandOutbox(store, IncrementingClock(), ids)
        val receipt = outbox.enqueue(
            java.util.UUID.randomUUID().toString(),
            buildJsonObject { put("operation", "session.create") },
        )
        outbox.claimForTransmission(receipt.commandId)
        val current = CommandOutboxCodec.encode(checkNotNull(store.load()))
            .toString(Charsets.UTF_8)
        val legacy = downgradeOutboxSchema(current, 2)
            .replace(Regex("\"authenticationIssuedAt\":[0-9]+"), "\"authenticationIssuedAt\":null")
            .replace(Regex("\"authenticationNonce\":\"[^\"]+\""), "\"authenticationNonce\":null")
            .toByteArray(Charsets.UTF_8)

        val migrated = CommandOutboxCodec.decode(legacy)

        assertTrue(migrated.commands.isEmpty())
        assertEquals(0, migrated.lastAcknowledgedSequence)
        assertEquals(1, migrated.released.size)
        assertEquals(receipt.commandId, migrated.released.single().commandId)
        assertEquals(receipt.idempotencyKey, migrated.released.single().idempotencyKey)
    }

    @Test
    fun `legacy quarantine waits for authoritative Gateway sequence before allocating the next command`() {
        val store = InMemoryCommandOutboxStore()
        val ids = IncrementingIds()
        val outbox = DurableCommandOutbox(store, IncrementingClock(), ids)
        val receipt = outbox.enqueue(
            java.util.UUID.randomUUID().toString(),
            buildJsonObject { put("operation", "session.create") },
        )
        outbox.claimForTransmission(receipt.commandId)
        val legacy = CommandOutboxCodec.encode(checkNotNull(store.load()))
            .toString(Charsets.UTF_8)
            .let { downgradeOutboxSchema(it, 2) }
            .replace(Regex("\"authenticationIssuedAt\":[0-9]+"), "\"authenticationIssuedAt\":null")
            .replace(Regex("\"authenticationNonce\":\"[^\"]+\""), "\"authenticationNonce\":null")
            .toByteArray(Charsets.UTF_8)
        val migratedStore = InMemoryCommandOutboxStore(CommandOutboxCodec.decode(legacy))
        val restored = DurableCommandOutbox(migratedStore, IncrementingClock(), ids)

        restored.reconcileGatewayScope("epoch-current", 1, receipt.sequence, 0)
        val next = restored.enqueue(
            java.util.UUID.randomUUID().toString(),
            buildJsonObject { put("operation", "session.create") },
        )

        assertEquals(receipt.sequence + 1, next.sequence)
    }

    @Test
    fun `legacy queued command is preserved because it was never submitted`() {
        val store = InMemoryCommandOutboxStore()
        val outbox = DurableCommandOutbox(store, IncrementingClock(), IncrementingIds())
        val receipt = outbox.enqueue(
            java.util.UUID.randomUUID().toString(),
            buildJsonObject { put("operation", "session.create") },
        )
        val legacy = CommandOutboxCodec.encode(checkNotNull(store.load()))
            .toString(Charsets.UTF_8)
            .let { downgradeOutboxSchema(it, 1) }
            .replace(",\"authenticationIssuedAt\":null", "")
            .replace(",\"authenticationNonce\":null", "")
            .toByteArray(Charsets.UTF_8)

        val migrated = CommandOutboxCodec.decode(legacy)
        val restored = DurableCommandOutbox(
            InMemoryCommandOutboxStore(migrated),
            IncrementingClock(),
            IncrementingIds(),
        )

        assertEquals(CommandState.QUEUED, restored.get(receipt.commandId)?.state)
        val transmission = checkNotNull(restored.claimForTransmission(receipt.commandId))
        assertTrue(transmission.nonce.length >= 16)
        assertTrue(transmission.issuedAt >= receipt.updatedAt)
    }

    @Test
    fun `current schema still rejects submitted command with missing authentication`() {
        val store = InMemoryCommandOutboxStore()
        val outbox = DurableCommandOutbox(store, IncrementingClock(), IncrementingIds())
        val receipt = outbox.enqueue(
            java.util.UUID.randomUUID().toString(),
            buildJsonObject { put("operation", "session.create") },
        )
        outbox.claimForTransmission(receipt.commandId)
        val corrupted = CommandOutboxCodec.encode(checkNotNull(store.load()))
            .toString(Charsets.UTF_8)
            .replace(Regex("\"authenticationIssuedAt\":[0-9]+"), "\"authenticationIssuedAt\":null")
            .replace(Regex("\"authenticationNonce\":\"[^\"]+\""), "\"authenticationNonce\":null")
            .toByteArray(Charsets.UTF_8)

        assertThrows(IllegalArgumentException::class.java) {
            CommandOutboxCodec.decode(corrupted)
        }
    }

    @Test
    fun `schema three authenticated command retains its lease for epoch reconciliation`() {
        val sourceStore = InMemoryCommandOutboxStore()
        val ids = IncrementingIds()
        val source = DurableCommandOutbox(sourceStore, IncrementingClock(), ids)
        val receipt = source.enqueue(
            java.util.UUID.randomUUID().toString(),
            buildJsonObject { put("operation", "session.create") },
        )
        val lease = source.claimForTransmission(receipt.commandId)!!
        val schemaThree = CommandOutboxCodec.encode(checkNotNull(sourceStore.load()))
            .toString(Charsets.UTF_8)
            .let { downgradeOutboxSchema(it, 3) }
            .toByteArray(Charsets.UTF_8)

        val decoded = CommandOutboxCodec.decode(schemaThree)
        val decodedCommand = decoded.commands.single()
        assertEquals(lease.issuedAt, decodedCommand.authenticationIssuedAt)
        assertEquals(lease.nonce, decodedCommand.authenticationNonce)
        assertNull(decodedCommand.revisionEpoch)
        assertNull(decoded.revisionEpoch)

        val restoredStore = InMemoryCommandOutboxStore(decoded)
        val restored = DurableCommandOutbox(restoredStore, IncrementingClock(), ids)
        val reconciliation = restored.reconcileGatewayScope("epoch-current", 2, 0, 0)
        assertEquals(receipt.commandId, reconciliation.migratedCommands.single().previousCommandId)
    }

    @Test
    fun `encrypted store atomically rewrites legacy quarantine to current schema`() {
        val blob = MemoryBlobStore()
        val cipher = JvmAesGcmCipher()
        val scope = "account-a"
        val store = EncryptedAtomicCommandOutboxStore(blob, cipher, scope)
        val outbox = DurableCommandOutbox(store, IncrementingClock(), IncrementingIds())
        val receipt = outbox.enqueue(
            java.util.UUID.randomUUID().toString(),
            buildJsonObject { put("operation", "session.delete"); put("sessionId", "session-1") },
        )
        outbox.claimForTransmission(receipt.commandId)
        val legacy = decryptOutbox(checkNotNull(blob.value), cipher, scope)
            .toString(Charsets.UTF_8)
            .let { downgradeOutboxSchema(it, 2) }
            .replace(Regex("\"authenticationIssuedAt\":[0-9]+"), "\"authenticationIssuedAt\":null")
            .replace(Regex("\"authenticationNonce\":\"[^\"]+\""), "\"authenticationNonce\":null")
            .toByteArray(Charsets.UTF_8)
        blob.value = encryptOutbox(legacy, cipher, scope)
        val migrations = mutableListOf<CommandOutboxMigration>()

        val migrated = EncryptedAtomicCommandOutboxStore(blob, cipher, scope, migrations::add).load()

        assertTrue(checkNotNull(migrated).commands.isEmpty())
        assertEquals(1, migrated.released.size)
        assertEquals(CommandOutboxMigration(2, 1), migrations.single())
        val rewritten = decryptOutbox(checkNotNull(blob.value), cipher, scope)
        assertTrue(rewritten.toString(Charsets.UTF_8).contains("\"schemaVersion\":4"))
        assertTrue(CommandOutboxCodec.decode(rewritten).commands.isEmpty())
    }

    @Test
    fun `failed atomic migration keeps the complete legacy blob for retry`() {
        val blob = MemoryBlobStore()
        val cipher = JvmAesGcmCipher()
        val scope = "account-a"
        val store = EncryptedAtomicCommandOutboxStore(blob, cipher, scope)
        val outbox = DurableCommandOutbox(store, IncrementingClock(), IncrementingIds())
        val receipt = outbox.enqueue(
            java.util.UUID.randomUUID().toString(),
            buildJsonObject { put("operation", "session.create") },
        )
        outbox.claimForTransmission(receipt.commandId)
        val legacy = decryptOutbox(checkNotNull(blob.value), cipher, scope)
            .toString(Charsets.UTF_8)
            .let { downgradeOutboxSchema(it, 2) }
            .replace(Regex("\"authenticationIssuedAt\":[0-9]+"), "\"authenticationIssuedAt\":null")
            .replace(Regex("\"authenticationNonce\":\"[^\"]+\""), "\"authenticationNonce\":null")
            .toByteArray(Charsets.UTF_8)
        val original = encryptOutbox(legacy, cipher, scope)
        blob.value = original.copyOf()
        blob.failNextWrite = true

        assertThrows(IllegalStateException::class.java) {
            EncryptedAtomicCommandOutboxStore(blob, cipher, scope).load()
        }
        assertArrayEquals(original, blob.value)
    }

    private fun downgradeOutboxSchema(value: String, targetVersion: Int): String = value
        .replace("\"schemaVersion\":4", "\"schemaVersion\":$targetVersion")
        .replace(",\"revisionEpoch\":null", "")
        .replace(",\"revisionEpochGeneration\":null", "")

    private class MemoryBlobStore : CommandOutboxBlobStore {
        var value: ByteArray? = null
        var failNextWrite = false

        override fun exists(): Boolean = value != null

        override fun read(): ByteArray = checkNotNull(value).copyOf()

        override fun write(bytes: ByteArray) {
            if (failNextWrite) {
                failNextWrite = false
                throw IllegalStateException("simulated atomic write failure")
            }
            value = bytes.copyOf()
        }

        override fun delete() {
            value = null
        }
    }

    private fun encryptOutbox(plaintext: ByteArray, cipher: SecretCipher, scope: String): ByteArray {
        val associatedData = "codever.command.outbox.v1\u0000$scope".toByteArray(Charsets.UTF_8)
        val encrypted = cipher.encrypt(plaintext, associatedData)
        return try {
            id.my.anciety.codever.security.SecretEnvelope.encode(encrypted)
        } finally {
            encrypted.iv.fill(0)
            encrypted.ciphertext.fill(0)
        }
    }

    private fun decryptOutbox(encrypted: ByteArray, cipher: SecretCipher, scope: String): ByteArray {
        val associatedData = "codever.command.outbox.v1\u0000$scope".toByteArray(Charsets.UTF_8)
        val envelope = id.my.anciety.codever.security.SecretEnvelope.decode(encrypted)
        return try {
            cipher.decrypt(envelope, associatedData)
        } finally {
            envelope.iv.fill(0)
            envelope.ciphertext.fill(0)
        }
    }

    private class JvmAesGcmCipher : SecretCipher {
        private val key: SecretKey = KeyGenerator.getInstance("AES").run {
            init(256, SecureRandom())
            generateKey()
        }

        override fun encrypt(plaintext: ByteArray, associatedData: ByteArray): EncryptedPayload {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key)
            cipher.updateAAD(associatedData)
            return EncryptedPayload(cipher.iv, cipher.doFinal(plaintext))
        }

        override fun decrypt(payload: EncryptedPayload, associatedData: ByteArray): ByteArray {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, payload.iv))
            cipher.updateAAD(associatedData)
            return cipher.doFinal(payload.ciphertext)
        }
    }

    private class IncrementingClock : CommandClock {
        private var value = 1L
        override fun now(): Long = value++
    }

    private class IncrementingIds : CommandIdFactory {
        private var value = 1
        override fun newId(): String = "id-${value++}"
    }
}
