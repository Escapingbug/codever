package id.my.anciety.codever.client

import id.my.anciety.codever.matrix.JvmAesGcmCipher
import id.my.anciety.codever.matrix.MatrixBootstrap
import id.my.anciety.codever.matrix.MatrixLoginTokenIssueResult
import id.my.anciety.codever.matrix.MatrixRuntimePhase
import id.my.anciety.codever.matrix.MatrixRuntimeStatus
import id.my.anciety.codever.matrix.PublicMatrixSession
import id.my.anciety.codever.security.codever.Base64Url
import id.my.anciety.codever.security.codever.CodeverCrypto
import java.io.ByteArrayOutputStream
import java.io.File
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class AttachmentTransferManagerTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun `upload and download temporary files are encrypted at rest`() = runBlocking {
        val matrix = FakeMatrixPort()
        val root = temporary.newFolder("transfers")
        val manager = AttachmentTransferManager(root, matrix, JvmAesGcmCipher())
        val plaintext = ("private-attachment-marker-".repeat(20_000)).toByteArray()
        val digest = CodeverCrypto.sha256Base64Url(plaintext)
        val upload = manager.openUpload("private.txt", "text/plain", plaintext.size.toLong(), digest)

        var index = 0
        var offset = 0
        while (offset < plaintext.size) {
            val end = minOf(offset + upload.chunkBytes, plaintext.size)
            val chunk = plaintext.copyOfRange(offset, end)
            manager.writeUploadChunk(
                upload.transferId,
                index,
                Base64Url.encode(chunk),
                CodeverCrypto.sha256Base64Url(chunk),
            )
            chunk.fill(0)
            offset = end
            index += 1
        }
        assertNoPlaintextMarker(root)

        val attachment = manager.finishUpload(upload.transferId)
        assertFalse(root.listFiles().orEmpty().any { it.name.startsWith("upload-") })
        val download = manager.openDownload(attachment)
        assertNoPlaintextMarker(root)
        val restored = ByteArrayOutputStream()
        repeat(download.chunkCount) { chunkIndex ->
            val chunk = manager.readDownload(download.transferId, chunkIndex)
            restored.write(Base64Url.decode(chunk.dataBase64Url))
        }
        assertArrayEquals(plaintext, restored.toByteArray())
        assertTrue(manager.closeDownload(download.transferId))
    }

    @Test
    fun `Matrix upload failure retains encrypted transfer for retry`() = runBlocking {
        val matrix = FakeMatrixPort().apply { failUpload = true }
        val root = temporary.newFolder("retry")
        val manager = AttachmentTransferManager(root, matrix, JvmAesGcmCipher())
        val plaintext = "retry-secret-marker".toByteArray()
        val upload = manager.openUpload(
            "retry.txt",
            "text/plain",
            plaintext.size.toLong(),
            CodeverCrypto.sha256Base64Url(plaintext),
        )
        manager.writeUploadChunk(
            upload.transferId,
            0,
            Base64Url.encode(plaintext),
            CodeverCrypto.sha256Base64Url(plaintext),
        )

        assertThrows(IllegalStateException::class.java) {
            runBlocking { manager.finishUpload(upload.transferId) }
        }
        assertNoPlaintextMarker(root, "retry-secret-marker")
        matrix.failUpload = false
        assertTrue(manager.finishUpload(upload.transferId).media.url.startsWith("mxc://"))
    }

    private fun assertNoPlaintextMarker(root: File, marker: String = "private-attachment-marker") {
        root.listFiles().orEmpty().forEach { file ->
            assertFalse(file.readBytes().toString(Charsets.ISO_8859_1).contains(marker))
        }
    }

    private class FakeMatrixPort : NativeMatrixPort {
        var failUpload = false
        private var media = ByteArray(0)
        override val status = MatrixRuntimeStatus(MatrixRuntimePhase.SYNCING, 1, "test")
        override val commandTransportReady = true
        override fun setObserver(observer: NativeMatrixObserver?) = Unit
        override fun start() = Unit
        override fun publicSession(): PublicMatrixSession? = null
        override suspend fun bootstrap(input: MatrixBootstrap): PublicMatrixSession = error("unused")
        override suspend fun issueLoginToken(password: String?): MatrixLoginTokenIssueResult =
            error("unused")
        override suspend fun sendPairingMessage(contentJson: String) = Unit
        override suspend fun closePairingChannel() = Unit
        override suspend fun loadThreadHistory(
            threadRootEventId: String,
            from: String?,
            limit: Int,
        ) = throw UnsupportedOperationException()
        override suspend fun sendApplicationControlEvent(contentJson: String, transactionId: String) = Unit
        override suspend fun refreshApplicationRoomState() = Unit
        override suspend fun uploadMedia(mimeType: String, bytes: ByteArray): String {
            if (failUpload) throw IllegalStateException("upload unavailable")
            media = bytes.copyOf()
            return "mxc://matrix.example.org/media"
        }
        override suspend fun downloadMedia(url: String): ByteArray = media.copyOf()
        override suspend fun profileProperty(userId: String, key: String): JsonObject? = null
        override suspend fun stop(clearSession: Boolean) = Unit
        override suspend fun revokeSession() = Unit
        override suspend fun close() = Unit
    }
}
