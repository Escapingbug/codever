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
import org.junit.Assert.assertFalse
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
    fun `pre-release schema one outbox is rejected instead of inventing authentication metadata`() {
        val store = InMemoryCommandOutboxStore()
        val outbox = DurableCommandOutbox(store, IncrementingClock(), IncrementingIds())
        outbox.enqueue(
            java.util.UUID.randomUUID().toString(),
            buildJsonObject { put("operation", "session.create") },
        )
        val current = CommandOutboxCodec.encode(checkNotNull(store.load()))
            .toString(Charsets.UTF_8)
        val legacy = current
            .replace("\"schemaVersion\":2", "\"schemaVersion\":1")
            .replace(",\"authenticationIssuedAt\":null", "")
            .replace(",\"authenticationNonce\":null", "")
            .toByteArray(Charsets.UTF_8)

        assertThrows(IllegalArgumentException::class.java) {
            CommandOutboxCodec.decode(legacy)
        }
    }

    private class MemoryBlobStore : CommandOutboxBlobStore {
        var value: ByteArray? = null

        override fun exists(): Boolean = value != null

        override fun read(): ByteArray = checkNotNull(value).copyOf()

        override fun write(bytes: ByteArray) {
            value = bytes.copyOf()
        }

        override fun delete() {
            value = null
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
