package id.my.anciety.codever.matrix

import java.nio.file.Files
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MatrixAccountWiperTest {
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
