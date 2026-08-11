package id.my.anciety.codever.matrix

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class MatrixSyncCursorStoreTest {
    @Test
    fun `cursor survives a new encrypted store instance`() {
        val blob = InMemoryCursorBlobStore()
        val cipher = JvmAesGcmCipher()
        val scope = "a".repeat(64)
        EncryptedMatrixSyncCursorStore(blob, cipher, scope).save("s725_947_0_1_1_1_1_1")

        assertEquals(
            "s725_947_0_1_1_1_1_1",
            EncryptedMatrixSyncCursorStore(blob, cipher, scope).load(),
        )
        assertFalse(blob.value!!.toString(Charsets.UTF_8).contains("s725_947"))
    }

    @Test
    fun `clear removes the cursor and invalid values are rejected`() {
        val blob = InMemoryCursorBlobStore()
        val store = EncryptedMatrixSyncCursorStore(blob, JvmAesGcmCipher(), "b".repeat(64))
        assertThrows(IllegalArgumentException::class.java) { store.save(" ") }
        store.save("next")
        store.clear()
        assertNull(store.load())
    }

    private class InMemoryCursorBlobStore : MatrixSyncCursorBlobStore {
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
}
