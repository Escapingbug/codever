package id.my.anciety.codever.matrix

import android.util.AtomicFile
import id.my.anciety.codever.security.SecretCipher
import id.my.anciety.codever.security.SecretEnvelope
import java.io.File

interface MatrixSyncCursorStore {
    fun load(): String?

    fun save(value: String)

    fun clear()
}

interface MatrixSyncCursorBlobStore {
    fun exists(): Boolean

    fun read(): ByteArray

    fun write(bytes: ByteArray)

    fun delete()
}

class AtomicMatrixSyncCursorBlobStore(file: File) : MatrixSyncCursorBlobStore {
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

class EncryptedMatrixSyncCursorStore(
    private val blobStore: MatrixSyncCursorBlobStore,
    private val cipher: SecretCipher,
    accountScope: String,
) : MatrixSyncCursorStore {
    private val associatedData =
        "codever.matrix.control-sync-cursor.v1\u0000$accountScope".toByteArray(Charsets.UTF_8)

    constructor(file: File, cipher: SecretCipher, accountScope: String) : this(
        AtomicMatrixSyncCursorBlobStore(file),
        cipher,
        accountScope,
    )

    @Synchronized
    override fun load(): String? {
        if (!blobStore.exists()) return null
        val plaintext = cipher.decrypt(SecretEnvelope.decode(blobStore.read()), associatedData)
        return try {
            validate(plaintext.toString(Charsets.UTF_8))
        } finally {
            plaintext.fill(0)
        }
    }

    @Synchronized
    override fun save(value: String) {
        val plaintext = validate(value).toByteArray(Charsets.UTF_8)
        val encrypted = try {
            SecretEnvelope.encode(cipher.encrypt(plaintext, associatedData))
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

    private fun validate(value: String): String {
        require(value.isNotBlank() && value.length <= MAX_CURSOR_LENGTH) {
            "Matrix control sync token is invalid."
        }
        return value
    }

    private companion object {
        const val MAX_CURSOR_LENGTH = 4_096
    }
}

class InMemoryMatrixSyncCursorStore(initial: String? = null) : MatrixSyncCursorStore {
    private var value = initial

    @Synchronized
    override fun load(): String? = value

    @Synchronized
    override fun save(value: String) {
        require(value.isNotBlank() && value.length <= 4_096)
        this.value = value
    }

    @Synchronized
    override fun clear() {
        value = null
    }
}
