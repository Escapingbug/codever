package id.my.anciety.codever.matrix

import java.nio.file.Files
import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MatrixAccountWiperTest {
    @Test
    fun `native cache preparation preserves crypto data`() {
        val accountRoot = Files.createTempDirectory("codever-matrix-cache-migration").toFile()
        try {
            val data = accountRoot.resolve("data").apply { mkdirs() }
            data.resolve("crypto.db").writeText("preserve-device-identity")
            val prepared = MatrixAccountCache.prepare(accountRoot)

            assertEquals(accountRoot.resolve("cache").canonicalFile, prepared)
            assertTrue(prepared.isDirectory)
            assertEquals("preserve-device-identity", data.resolve("crypto.db").readText())
        } finally {
            accountRoot.deleteRecursively()
        }
    }

    @Test
    fun `native cache preparation is idempotent`() {
        val accountRoot = Files.createTempDirectory("codever-matrix-cache-current").toFile()
        try {
            val first = MatrixAccountCache.prepare(accountRoot)
            first.resolve("current-cache.db").writeText("keep")
            val second = MatrixAccountCache.prepare(accountRoot)

            assertEquals(accountRoot.resolve("cache").canonicalFile, second)
            assertEquals("keep", second.resolve("current-cache.db").readText())
        } finally {
            accountRoot.deleteRecursively()
        }
    }

    @Test
    fun `revoke wipe deletes only the validated account sdk directory`() {
        val root = Files.createTempDirectory("codever-matrix-wipe").toFile()
        try {
            val sdkRoot = root.resolve("sdk").apply { mkdirs() }
            val targetScope = "a".repeat(64)
            val otherScope = "b".repeat(64)
            val target = sdkRoot.resolve(targetScope).apply { mkdirs() }
            target.resolve("crypto.db").writeText("encrypted")
            val other = sdkRoot.resolve(otherScope).apply { mkdirs() }
            other.resolve("crypto.db").writeText("keep")

            MatrixAccountWiper.deleteSdkAccountRoot(sdkRoot, targetScope)

            assertFalse(target.exists())
            assertTrue(other.resolve("crypto.db").exists())
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `revoke wipe rejects path traversal before deleting anything`() {
        val root = Files.createTempDirectory("codever-matrix-wipe-boundary").toFile()
        try {
            val sdkRoot = root.resolve("sdk").apply { mkdirs() }
            val outside = root.resolve("outside").apply { writeText("keep") }

            val error = runCatching {
                MatrixAccountWiper.deleteSdkAccountRoot(sdkRoot, "../outside")
            }.exceptionOrNull()

            assertTrue(error is IllegalArgumentException)
            assertTrue(outside.exists())
        } finally {
            root.deleteRecursively()
        }
    }
}
