package id.my.anciety.codever.matrix

import id.my.anciety.codever.security.EncryptedPayload
import id.my.anciety.codever.security.SecretCipher
import id.my.anciety.codever.security.SecretEnvelope
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.matrix.rustcomponents.sdk.SlidingSyncVersion

class MatrixSecurityTest {
    @Test
    fun `secret carriers redact every credential from toString`() {
        val bootstrap = bootstrap()
        val session = session()
        val secrets = PersistedMatrixSecrets(ByteArray(32) { 7 }, session)

        listOf(bootstrap.toString(), session.toString(), secrets.toString()).forEach { rendered ->
            assertFalse(rendered.contains(LOGIN_TOKEN))
            assertFalse(rendered.contains(ACCESS_TOKEN))
            assertFalse(rendered.contains(REFRESH_TOKEN))
            assertFalse(rendered.contains(OAUTH_DATA))
        }
        assertTrue(bootstrap.toString().contains("<redacted>"))
        assertTrue(secrets.toString().contains("<redacted>"))
    }

    @Test
    fun `session codec round trips and encrypted envelope contains no plaintext token`() {
        val source = PersistedMatrixSecrets(ByteArray(32) { it.toByte() }, session())
        val plaintext = MatrixSecretCodec.encode(source)
        val cipher = JvmAesGcmCipher()
        val aad = "account-and-purpose".toByteArray()
        val encrypted = SecretEnvelope.encode(cipher.encrypt(plaintext, aad))

        val renderedEnvelope = encrypted.toString(Charsets.ISO_8859_1)
        assertFalse(renderedEnvelope.contains(ACCESS_TOKEN))
        assertFalse(renderedEnvelope.contains(REFRESH_TOKEN))

        val decodedPayload = SecretEnvelope.decode(encrypted)
        val decrypted = cipher.decrypt(decodedPayload, aad)
        val restored = MatrixSecretCodec.decode(decrypted)
        assertEquals(ACCESS_TOKEN, restored.session.accessToken)
        assertEquals(REFRESH_TOKEN, restored.session.refreshToken)
        assertEquals("!room:example.org", restored.session.roomBinding.roomId)
        assertTrue(source.sdkStoreKey.contentEquals(restored.sdkStoreKey))
        plaintext.fill(0)
        decrypted.fill(0)
    }

    private fun bootstrap() = MatrixBootstrap(
        homeserver = "https://matrix.example.org",
        oneTimeLoginToken = LOGIN_TOKEN,
        expectedUserId = "@alice:example.org",
        deviceName = "Codever Android",
        roomBinding = binding(),
    )

    private fun session() = StoredMatrixSession(
        accessToken = ACCESS_TOKEN,
        refreshToken = REFRESH_TOKEN,
        userId = "@alice:example.org",
        deviceId = "MATRIX-DEVICE",
        homeserverUrl = "https://matrix.example.org",
        oauthData = OAUTH_DATA,
        slidingSyncVersion = SlidingSyncVersion.NONE,
        roomBinding = binding(),
    )

    private fun binding() = MatrixRoomBinding(
        roomId = "!room:example.org",
        gatewayId = "gateway-1",
        conversationId = "conversation-1",
        gatewayUserId = "@gateway:example.org",
        gatewayDeviceId = "GATEWAY-DEVICE",
        gatewayDeviceEd25519 = "A".repeat(43),
    )

    private companion object {
        const val LOGIN_TOKEN = "one-time-secret-login-token"
        const val ACCESS_TOKEN = "secret-access-token"
        const val REFRESH_TOKEN = "secret-refresh-token"
        const val OAUTH_DATA = "secret-oauth-data"
    }
}

internal class JvmAesGcmCipher : SecretCipher {
    private val key = SecretKeySpec(ByteArray(32) { (it + 1).toByte() }, "AES")
    private val random = SecureRandom()

    override fun encrypt(plaintext: ByteArray, associatedData: ByteArray): EncryptedPayload {
        val iv = ByteArray(12).also(random::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, iv))
        cipher.updateAAD(associatedData)
        return EncryptedPayload(iv, cipher.doFinal(plaintext))
    }

    override fun decrypt(payload: EncryptedPayload, associatedData: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, payload.iv))
        cipher.updateAAD(associatedData)
        return cipher.doFinal(payload.ciphertext)
    }
}
