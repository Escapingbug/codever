package id.my.anciety.codever.client

import id.my.anciety.codever.matrix.JvmAesGcmCipher
import id.my.anciety.codever.matrix.MatrixDecryptedEvent
import id.my.anciety.codever.security.codever.MatrixV3ProjectKey
import id.my.anciety.codever.security.codever.MatrixV3ProjectKeyGrant
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MatrixV3NativeStorageTest {
    @Test
    fun `prepared command retry reuses the exact first signed ciphertext after restart`() {
        val blob = MemoryMatrixV3BlobStore()
        val first = buildJsonObject {
            put("msgtype", "m.notice")
            put("signature", "first-nondeterministic-signature")
            put("ciphertext", "first-ciphertext")
        }
        val replacement = buildJsonObject {
            put("msgtype", "m.notice")
            put("signature", "different-signature")
            put("ciphertext", "different-ciphertext")
        }
        val store = AtomicEncryptedMatrixV3CommandContentStore(blob, JvmAesGcmCipher(), "account-a")

        assertEquals(first, store.putIfAbsent("command-1", first))
        assertEquals(first, store.putIfAbsent("command-1", replacement))

        val restored = AtomicEncryptedMatrixV3CommandContentStore(blob, JvmAesGcmCipher(), "account-a")
        assertEquals(first, restored.get("command-1"))
        assertFalse(blob.bytes!!.toString(Charsets.UTF_8).contains("first-ciphertext"))
        restored.remove("command-1")
        assertNull(restored.get("command-1"))
    }

    @Test
    fun `poison event is quarantined without blocking later raw events`() {
        val blob = MemoryMatrixV3BlobStore()
        val store = AtomicEncryptedMatrixV3InboxStore(blob, JvmAesGcmCipher(), "account-a")
        val poison = event("\$poison", "not-json")
        val valid = event("\$valid", "{\"type\":\"m.room.message\"}")

        assertTrue(store.put(poison))
        assertTrue(store.put(valid))
        assertFalse(store.put(valid))
        store.quarantine(poison.eventId, IllegalArgumentException("secret must not persist"))
        assertEquals(listOf(valid.eventId), store.pending().map { it.event.eventId })

        store.projected(valid.eventId)
        assertTrue(store.pending().isEmpty())
        AtomicEncryptedMatrixV3InboxStore(blob, JvmAesGcmCipher(), "account-a")
            .validateStoredState()
        assertFalse(blob.bytes!!.toString(Charsets.UTF_8).contains("secret must not persist"))
    }

    @Test
    fun `a later key grant unlocks an earlier deferred event`() = runBlocking {
        val blob = MemoryMatrixV3BlobStore()
        val store = AtomicEncryptedMatrixV3InboxStore(blob, JvmAesGcmCipher(), "account-a")
        val dependent = event("\$dependent", "{\"kind\":\"event\"}")
        val grant = event("\$grant", "{\"kind\":\"key_grant\"}")
        store.put(dependent)
        store.put(grant)
        var keyReady = false
        val attempts = mutableListOf<String>()

        drainMatrixV3Inbox(store) { record ->
            attempts += record.event.eventId
            when (record.event.eventId) {
                grant.eventId -> {
                    keyReady = true
                    store.projected(record.event.eventId)
                    MatrixV3InboxProjectionStep.ADVANCED
                }
                dependent.eventId -> if (keyReady) {
                    store.projected(record.event.eventId)
                    MatrixV3InboxProjectionStep.ADVANCED
                } else {
                    MatrixV3InboxProjectionStep.DEFERRED
                }
                else -> error("Unexpected event")
            }
        }

        assertEquals(listOf("\$dependent", "\$grant", "\$dependent"), attempts)
        assertTrue(store.pending().isEmpty())
    }

    @Test
    fun `project keys and projection survive encrypted restart with account binding`() {
        val keyBlob = MemoryMatrixV3BlobStore()
        val projectionBlob = MemoryMatrixV3BlobStore()
        val grant = MatrixV3ProjectKeyGrant(
            workspaceId = "workspace-1",
            projectId = "project-1",
            roomId = "!room:example.org",
            deviceId = "device-1",
            certificateId = "certificate-1",
            activeKeyId = "key-1",
            keys = listOf(MatrixV3ProjectKey("key-1", ByteArray(32) { it.toByte() }, 1234)),
        )
        val projection = buildJsonObject {
            put("schemaVersion", 1)
            put("marker", "durable-view")
        }
        AtomicEncryptedMatrixV3ProjectKeyStore(keyBlob, JvmAesGcmCipher(), "account-a").save(grant)
        AtomicEncryptedMatrixV3ProjectionStore(
            projectionBlob,
            JvmAesGcmCipher(),
            "account-a",
        ).save(projection)

        val restoredGrant = AtomicEncryptedMatrixV3ProjectKeyStore(
            keyBlob,
            JvmAesGcmCipher(),
            "account-a",
        ).value()!!
        assertEquals(grant.activeKeyId, restoredGrant.activeKeyId)
        assertArrayEquals(grant.activeKey().key, restoredGrant.activeKey().key)
        assertEquals(
            projection,
            AtomicEncryptedMatrixV3ProjectionStore(
                projectionBlob,
                JvmAesGcmCipher(),
                "account-a",
            ).load(),
        )
    }

    private fun event(eventId: String, rawJson: String) = MatrixDecryptedEvent(
        roomId = "!room:example.org",
        eventId = eventId,
        sender = "@gateway:example.org",
        timestamp = 1234,
        rawJson = rawJson,
    )

    private class MemoryMatrixV3BlobStore : MatrixV3BlobStore {
        var bytes: ByteArray? = null

        override fun read(): ByteArray? = bytes?.copyOf()

        override fun write(bytes: ByteArray) {
            this.bytes = bytes.copyOf()
        }

        override fun delete() {
            bytes = null
        }
    }
}
