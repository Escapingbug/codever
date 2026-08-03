package id.my.anciety.codever.matrix

import android.util.AtomicFile
import id.my.anciety.codever.security.SecretCipher
import id.my.anciety.codever.security.SecretEnvelope
import java.io.File
import java.security.SecureRandom

interface MatrixSessionStore {
    fun load(): PersistedMatrixSecrets?

    fun save(value: PersistedMatrixSecrets)

    fun clear()
}

class EncryptedMatrixSessionStore(
    file: File,
    private val cipher: SecretCipher,
    accountScope: String,
) : MatrixSessionStore {
    private val atomicFile = AtomicFile(file)
    private val associatedData = "codever.matrix.session.v1\u0000$accountScope".toByteArray(Charsets.UTF_8)

    @Synchronized
    override fun load(): PersistedMatrixSecrets? {
        if (!atomicFile.baseFile.exists()) return null
        val encrypted = atomicFile.readFully()
        val plaintext = cipher.decrypt(SecretEnvelope.decode(encrypted), associatedData)
        return try {
            MatrixSecretCodec.decode(plaintext)
        } finally {
            plaintext.fill(0)
        }
    }

    @Synchronized
    override fun save(value: PersistedMatrixSecrets) {
        val plaintext = MatrixSecretCodec.encode(value)
        val encrypted = try {
            SecretEnvelope.encode(cipher.encrypt(plaintext, associatedData))
        } finally {
            plaintext.fill(0)
        }
        val output = atomicFile.startWrite()
        try {
            output.write(encrypted)
            output.fd.sync()
            atomicFile.finishWrite(output)
        } catch (error: Exception) {
            atomicFile.failWrite(output)
            throw error
        } finally {
            encrypted.fill(0)
        }
    }

    @Synchronized
    override fun clear() {
        atomicFile.delete()
    }

    companion object {
        fun newStoreKey(random: SecureRandom = SecureRandom()): ByteArray =
            ByteArray(32).also(random::nextBytes)
    }
}

class InMemoryMatrixSessionStore(
    initial: PersistedMatrixSecrets? = null,
) : MatrixSessionStore {
    private var value = initial

    @Synchronized
    override fun load(): PersistedMatrixSecrets? = value

    @Synchronized
    override fun save(value: PersistedMatrixSecrets) {
        this.value = value
    }

    @Synchronized
    override fun clear() {
        value = null
    }
}
