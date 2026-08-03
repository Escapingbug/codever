package id.my.anciety.codever.security

import java.nio.ByteBuffer

data class EncryptedPayload(
    val iv: ByteArray,
    val ciphertext: ByteArray,
)

interface SecretCipher {
    fun encrypt(plaintext: ByteArray, associatedData: ByteArray): EncryptedPayload

    fun decrypt(payload: EncryptedPayload, associatedData: ByteArray): ByteArray
}

object SecretEnvelope {
    private val magic = byteArrayOf(0x43, 0x56, 0x53, 0x45) // CVSE
    private const val VERSION: Byte = 1
    private const val HEADER_BYTES = 10
    private const val MAX_IV_BYTES = 32
    private const val MAX_CIPHERTEXT_BYTES = 4 * 1024 * 1024

    fun encode(payload: EncryptedPayload): ByteArray {
        require(payload.iv.size in 12..MAX_IV_BYTES) { "Invalid encrypted envelope IV." }
        require(payload.ciphertext.size in 16..MAX_CIPHERTEXT_BYTES) {
            "Invalid encrypted envelope payload."
        }
        return ByteBuffer.allocate(HEADER_BYTES + payload.iv.size + payload.ciphertext.size)
            .put(magic)
            .put(VERSION)
            .put(payload.iv.size.toByte())
            .putInt(payload.ciphertext.size)
            .put(payload.iv)
            .put(payload.ciphertext)
            .array()
    }

    fun decode(bytes: ByteArray): EncryptedPayload {
        require(bytes.size >= HEADER_BYTES + 12 + 16) { "Encrypted envelope is truncated." }
        val buffer = ByteBuffer.wrap(bytes)
        val actualMagic = ByteArray(magic.size).also(buffer::get)
        require(actualMagic.contentEquals(magic)) { "Encrypted envelope magic is invalid." }
        require(buffer.get() == VERSION) { "Encrypted envelope version is unsupported." }
        val ivLength = buffer.get().toInt() and 0xff
        val ciphertextLength = buffer.int
        require(ivLength in 12..MAX_IV_BYTES) { "Encrypted envelope IV is invalid." }
        require(ciphertextLength in 16..MAX_CIPHERTEXT_BYTES) {
            "Encrypted envelope payload is invalid."
        }
        require(buffer.remaining() == ivLength + ciphertextLength) {
            "Encrypted envelope length is invalid."
        }
        return EncryptedPayload(
            iv = ByteArray(ivLength).also(buffer::get),
            ciphertext = ByteArray(ciphertextLength).also(buffer::get),
        )
    }
}
