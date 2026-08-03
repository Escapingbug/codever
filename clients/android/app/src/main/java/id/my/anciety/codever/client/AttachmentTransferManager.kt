package id.my.anciety.codever.client

import id.my.anciety.codever.client.events.CodeverAttachment
import id.my.anciety.codever.client.events.EncryptedMedia
import id.my.anciety.codever.security.EncryptedPayload
import id.my.anciety.codever.security.SecretCipher
import id.my.anciety.codever.security.SecretEnvelope
import id.my.anciety.codever.security.codever.Base64Url
import id.my.anciety.codever.security.codever.CodeverCrypto
import java.io.File
import java.io.RandomAccessFile
import java.security.SecureRandom
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

data class UploadTransfer(
    val transferId: String,
    val chunkBytes: Int,
    val nextIndex: Int,
    val expiresAt: Long,
)

data class UploadChunkReceipt(
    val transferId: String,
    val index: Int,
    val receivedBytes: Long,
    val nextIndex: Int,
)

data class DownloadTransfer(
    val transferId: String,
    val size: Long,
    val sha256: String,
    val chunkBytes: Int,
    val chunkCount: Int,
)

data class DownloadChunk(
    val transferId: String,
    val index: Int,
    val dataBase64Url: String,
    val chunkSha256: String,
    val eof: Boolean,
)

class AttachmentTransferNotFoundException(message: String) : IllegalArgumentException(message)
class AttachmentChunkConflictException(message: String) : IllegalArgumentException(message)
class AttachmentHashMismatchException(message: String) : IllegalArgumentException(message)
class AttachmentTooLargeException(message: String) : IllegalArgumentException(message)

class AttachmentTransferManager(
    private val root: File,
    private val matrix: NativeMatrixPort,
    private val storageCipher: SecretCipher,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private data class StoredChunk(
        val offset: Long,
        val encodedBytes: Int,
        val plaintextBytes: Int,
    )

    private data class Upload(
        val id: String,
        val file: File,
        val name: String,
        val mimeType: String,
        val size: Long,
        val sha256: String,
        val expiresAt: Long,
        val chunks: MutableList<StoredChunk> = mutableListOf(),
        var receivedBytes: Long = 0,
        var nextIndex: Int = 0,
    )

    private data class Download(
        val id: String,
        val file: File,
        val size: Long,
        val sha256: String,
        val expiresAt: Long,
        val chunks: List<StoredChunk>,
    )

    private val uploads = linkedMapOf<String, Upload>()
    private val downloads = linkedMapOf<String, Download>()
    private val random = SecureRandom()

    init {
        check(root.isDirectory || root.mkdirs()) { "Native transfer directory is unavailable." }
        root.listFiles().orEmpty().forEach(File::delete)
    }

    @Synchronized
    fun openUpload(name: String, mimeType: String, size: Long, sha256: String): UploadTransfer {
        cleanupExpired()
        require(name.length in 1..1_024 && mimeType.length in 1..256)
        if (size !in 0..MAX_ATTACHMENT_BYTES) {
            throw AttachmentTooLargeException("Attachment exceeds the native size limit.")
        }
        requireSha256(sha256)
        val id = UUID.randomUUID().toString()
        val upload = Upload(
            id = id,
            file = File(root, "upload-$id.bin"),
            name = name,
            mimeType = mimeType,
            size = size,
            sha256 = sha256,
            expiresAt = now() + TRANSFER_LIFETIME_MS,
        )
        check(upload.file.createNewFile()) { "Native upload file could not be created." }
        uploads[id] = upload
        return upload.public()
    }

    @Synchronized
    fun writeUploadChunk(
        transferId: String,
        index: Int,
        dataBase64Url: String,
        chunkSha256: String,
    ): UploadChunkReceipt {
        cleanupExpired()
        val upload = uploads[transferId]
            ?: throw AttachmentTransferNotFoundException("Upload transfer was not found.")
        if (index != upload.nextIndex) {
            throw AttachmentChunkConflictException("Attachment chunk index is out of order.")
        }
        val bytes = Base64Url.decode(dataBase64Url)
        try {
            if (bytes.size > CHUNK_BYTES || upload.receivedBytes + bytes.size > upload.size) {
                throw AttachmentChunkConflictException("Attachment chunk exceeds its declared size.")
            }
            if (CodeverCrypto.sha256Base64Url(bytes) != chunkSha256) {
                throw AttachmentHashMismatchException("Attachment chunk hash does not match.")
            }
            upload.chunks += appendEncryptedChunk(
                upload.file,
                "upload",
                upload.id,
                index,
                bytes,
            )
            upload.receivedBytes += bytes.size
            upload.nextIndex += 1
            return UploadChunkReceipt(upload.id, index, upload.receivedBytes, upload.nextIndex)
        } finally {
            bytes.fill(0)
        }
    }

    suspend fun finishUpload(transferId: String): CodeverAttachment {
        val upload = synchronized(this) {
            cleanupExpired()
            uploads[transferId]
                ?: throw AttachmentTransferNotFoundException("Upload transfer was not found.")
        }
        if (upload.receivedBytes != upload.size) {
            throw AttachmentChunkConflictException("Attachment upload is incomplete.")
        }
        val plaintext = ByteArray(upload.size.toInt())
        var completed = false
        try {
            var plaintextOffset = 0
            upload.chunks.forEachIndexed { index, chunk ->
                val bytes = readEncryptedChunk(upload.file, "upload", upload.id, index, chunk)
                try {
                    check(plaintextOffset + bytes.size <= plaintext.size) {
                        "Attachment upload chunks exceed the declared size."
                    }
                    bytes.copyInto(plaintext, plaintextOffset)
                    plaintextOffset += bytes.size
                } finally {
                    bytes.fill(0)
                }
            }
            check(plaintextOffset == plaintext.size) { "Attachment upload chunks are incomplete." }
            if (CodeverCrypto.sha256Base64Url(plaintext) != upload.sha256) {
                throw AttachmentHashMismatchException("Attachment plaintext hash does not match.")
            }
            val key = ByteArray(32).also(random::nextBytes)
            val iv = ByteArray(12).also(random::nextBytes)
            val ciphertext = try {
                Cipher.getInstance("AES/GCM/NoPadding").run {
                    init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
                    doFinal(plaintext)
                }
            } catch (error: Exception) {
                key.fill(0)
                throw error
            }
            try {
                val url = matrix.uploadMedia("application/octet-stream", ciphertext)
                check(url.startsWith("mxc://")) { "Matrix returned an invalid media URL." }
                val attachment = CodeverAttachment(
                    id = UUID.randomUUID().toString(),
                    name = upload.name,
                    mimeType = upload.mimeType,
                    size = upload.size,
                    sha256 = upload.sha256,
                    media = EncryptedMedia(
                        url = url,
                        key = Base64Url.encode(key),
                        iv = Base64Url.encode(iv),
                        sha256 = CodeverCrypto.sha256Base64Url(ciphertext),
                        size = ciphertext.size.toLong(),
                    ),
                )
                completed = true
                return attachment
            } finally {
                key.fill(0)
                iv.fill(0)
                ciphertext.fill(0)
            }
        } finally {
            plaintext.fill(0)
            if (completed) {
                synchronized(this) {
                    uploads.remove(transferId)
                    upload.file.delete()
                }
            }
        }
    }

    @Synchronized
    fun abortUpload(transferId: String): Boolean {
        val upload = uploads.remove(transferId) ?: return false
        upload.file.delete()
        return true
    }

    suspend fun openDownload(attachment: CodeverAttachment): DownloadTransfer {
        val ciphertext = matrix.downloadMedia(attachment.media.url)
        if (ciphertext.size.toLong() != attachment.media.size) {
            throw AttachmentHashMismatchException("Encrypted media size mismatch.")
        }
        if (CodeverCrypto.sha256Base64Url(ciphertext) != attachment.media.sha256) {
            throw AttachmentHashMismatchException("Encrypted media hash mismatch.")
        }
        val key = Base64Url.decode(attachment.media.key)
        val iv = Base64Url.decode(attachment.media.iv)
        require(key.size == 32 && iv.size == 12) { "Encrypted media key material is invalid." }
        val plaintext = try {
            Cipher.getInstance("AES/GCM/NoPadding").run {
                init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
                doFinal(ciphertext)
            }
        } finally {
            key.fill(0)
            iv.fill(0)
            ciphertext.fill(0)
        }
        try {
            if (plaintext.size.toLong() != attachment.size) {
                throw AttachmentHashMismatchException("Attachment size mismatch.")
            }
            if (CodeverCrypto.sha256Base64Url(plaintext) != attachment.sha256) {
                throw AttachmentHashMismatchException("Attachment hash mismatch.")
            }
            val id = UUID.randomUUID().toString()
            val file = File(root, "download-$id.bin")
            check(file.createNewFile()) { "Native download file could not be created." }
            val chunks = mutableListOf<StoredChunk>()
            if (plaintext.isEmpty()) {
                chunks += appendEncryptedChunk(file, "download", id, 0, plaintext)
            } else {
                var offset = 0
                var index = 0
                while (offset < plaintext.size) {
                    val end = minOf(offset + CHUNK_BYTES, plaintext.size)
                    val bytes = plaintext.copyOfRange(offset, end)
                    try {
                        chunks += appendEncryptedChunk(file, "download", id, index, bytes)
                    } finally {
                        bytes.fill(0)
                    }
                    offset = end
                    index += 1
                }
            }
            val download = Download(
                id,
                file,
                attachment.size,
                attachment.sha256,
                now() + TRANSFER_LIFETIME_MS,
                chunks,
            )
            synchronized(this) {
                cleanupExpired()
                downloads[id] = download
            }
            return download.public()
        } finally {
            plaintext.fill(0)
        }
    }

    @Synchronized
    fun readDownload(transferId: String, index: Int): DownloadChunk {
        cleanupExpired()
        val download = downloads[transferId]
            ?: throw AttachmentTransferNotFoundException("Download transfer was not found.")
        if (index !in download.chunks.indices) {
            throw AttachmentChunkConflictException("Attachment chunk index is invalid.")
        }
        val bytes = readEncryptedChunk(
            download.file,
            "download",
            download.id,
            index,
            download.chunks[index],
        )
        try {
            return DownloadChunk(
                transferId = transferId,
                index = index,
                dataBase64Url = Base64Url.encode(bytes),
                chunkSha256 = CodeverCrypto.sha256Base64Url(bytes),
                eof = index == download.chunks.lastIndex,
            )
        } finally {
            bytes.fill(0)
        }
    }

    @Synchronized
    fun closeDownload(transferId: String): Boolean {
        val download = downloads.remove(transferId) ?: return false
        download.file.delete()
        return true
    }

    @Synchronized
    fun clear() {
        uploads.values.forEach { it.file.delete() }
        downloads.values.forEach { it.file.delete() }
        uploads.clear()
        downloads.clear()
    }

    private fun Upload.public() = UploadTransfer(id, CHUNK_BYTES, nextIndex, expiresAt)

    private fun Download.public() = DownloadTransfer(
        id,
        size,
        sha256,
        CHUNK_BYTES,
        chunks.size,
    )

    private fun appendEncryptedChunk(
        file: File,
        direction: String,
        transferId: String,
        index: Int,
        plaintext: ByteArray,
    ): StoredChunk {
        val associatedData = transferAssociatedData(direction, transferId, index)
        val payload = storageCipher.encrypt(plaintext, associatedData)
        val encoded = try {
            SecretEnvelope.encode(payload)
        } finally {
            payload.iv.fill(0)
            payload.ciphertext.fill(0)
            associatedData.fill(0)
        }
        try {
            return RandomAccessFile(file, "rw").use { output ->
                val offset = output.length()
                output.seek(offset)
                output.write(encoded)
                output.fd.sync()
                StoredChunk(offset, encoded.size, plaintext.size)
            }
        } finally {
            encoded.fill(0)
        }
    }

    private fun readEncryptedChunk(
        file: File,
        direction: String,
        transferId: String,
        index: Int,
        chunk: StoredChunk,
    ): ByteArray {
        val encoded = ByteArray(chunk.encodedBytes)
        RandomAccessFile(file, "r").use { input ->
            check(chunk.offset + chunk.encodedBytes <= input.length()) {
                "Encrypted attachment chunk is truncated."
            }
            input.seek(chunk.offset)
            input.readFully(encoded)
        }
        val payload = try {
            SecretEnvelope.decode(encoded)
        } finally {
            encoded.fill(0)
        }
        val associatedData = transferAssociatedData(direction, transferId, index)
        return try {
            storageCipher.decrypt(
                EncryptedPayload(payload.iv, payload.ciphertext),
                associatedData,
            ).also { plaintext ->
                check(plaintext.size == chunk.plaintextBytes) {
                    "Encrypted attachment chunk length is invalid."
                }
            }
        } finally {
            payload.iv.fill(0)
            payload.ciphertext.fill(0)
            associatedData.fill(0)
        }
    }

    private fun transferAssociatedData(direction: String, transferId: String, index: Int): ByteArray =
        "codever.attachment-transfer.v1\u0000$direction\u0000$transferId\u0000$index"
            .toByteArray(Charsets.UTF_8)

    private fun cleanupExpired() {
        val timestamp = now()
        uploads.values.filter { it.expiresAt <= timestamp }.forEach { upload ->
            uploads.remove(upload.id)
            upload.file.delete()
        }
        downloads.values.filter { it.expiresAt <= timestamp }.forEach { download ->
            downloads.remove(download.id)
            download.file.delete()
        }
    }

    private fun requireSha256(value: String) {
        require(value.length == 43 && Base64Url.decode(value).size == 32) {
            "Attachment SHA-256 is invalid."
        }
    }

    private companion object {
        const val CHUNK_BYTES = 256 * 1024
        const val MAX_ATTACHMENT_BYTES = 50L * 1024 * 1024
        const val TRANSFER_LIFETIME_MS = 30 * 60_000L
    }
}
