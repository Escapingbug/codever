package id.my.anciety.codever.matrix

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test

class MatrixSyncGapStoreTest {
    @Test
    fun `gap queue and page cursor survive a new encrypted store instance`() {
        val blob = InMemoryGapBlobStore()
        val cipher = JvmAesGcmCipher()
        val scope = "c".repeat(64)
        EncryptedMatrixSyncGapStore(blob, cipher, scope).save(listOf(
            MatrixSyncGap("s-before", "s-gap-end", "s-page-2"),
            MatrixSyncGap("s-later", "s-later-end"),
        ))

        assertEquals(
            listOf(
                MatrixSyncGap("s-before", "s-gap-end", "s-page-2"),
                MatrixSyncGap("s-later", "s-later-end"),
            ),
            EncryptedMatrixSyncGapStore(blob, cipher, scope).load(),
        )
        assertFalse(blob.value!!.toString(Charsets.UTF_8).contains("s-before"))
    }

    @Test
    fun `empty and invalid gap queues cannot be persisted`() {
        val blob = InMemoryGapBlobStore()
        val store = EncryptedMatrixSyncGapStore(blob, JvmAesGcmCipher(), "d".repeat(64))

        assertThrows(IllegalArgumentException::class.java) {
            store.save(listOf(MatrixSyncGap("same", "same")))
        }
        store.save(listOf(MatrixSyncGap("from", "to")))
        store.save(emptyList())
        assertEquals(emptyList<MatrixSyncGap>(), store.load())
    }

    private class InMemoryGapBlobStore : MatrixSyncGapBlobStore {
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
