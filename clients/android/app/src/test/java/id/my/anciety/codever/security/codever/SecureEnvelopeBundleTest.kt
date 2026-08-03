package id.my.anciety.codever.security.codever

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test

class SecureEnvelopeBundleTest {
    private val now = 1_800_000_000_000L

    @Test
    fun `one signed ciphertext opens for each addressed device and rejects replay`() {
        val gateway = TestP256Identity.generate()
        val phone = TestP256Identity.generate()
        val tablet = TestP256Identity.generate()
        val plaintext = Json.parseToJsonElement(
            """{"msgtype":"m.text","body":"shared secret","io.codever":{"kind":"message","version":1}}""",
        )
        val bindings = bindings(gateway)
        val sealed = SecureEnvelopeBundles.seal(
            bindings,
            plaintext,
            gateway,
            listOf(
                SecureEnvelopeBundles.SealRecipient("phone-1", phone.publicIdentity),
                SecureEnvelopeBundles.SealRecipient("tablet-1", tablet.publicIdentity),
            ),
            envelopeId = "bundle-1",
            now = now,
        )

        assertFalse(CanonicalJson.encode(sealed.toJson()).contains("shared secret"))
        assertEquals(2, sealed.bundle.recipients.size)
        val replay = InMemoryReplayStore()
        assertEquals(
            plaintext,
            SecureEnvelopeBundles.open(
                sealed,
                phone,
                gateway.publicIdentity,
                bindings,
                "phone-1",
                replay,
                now + 1,
            ).plaintext,
        )
        assertCode(SecurityErrorCode.REPLAY) {
            SecureEnvelopeBundles.open(
                sealed,
                phone,
                gateway.publicIdentity,
                bindings,
                "phone-1",
                replay,
                now + 1,
            )
        }
        assertEquals(
            plaintext,
            SecureEnvelopeBundles.open(
                sealed,
                tablet,
                gateway.publicIdentity,
                bindings,
                "tablet-1",
                InMemoryReplayStore(),
                now + 1,
            ).plaintext,
        )
    }

    @Test
    fun `bundle rejects tampering and a recipient outside the route`() {
        val gateway = TestP256Identity.generate()
        val phone = TestP256Identity.generate()
        val outsider = TestP256Identity.generate()
        val bindings = bindings(gateway)
        val sealed = SecureEnvelopeBundles.seal(
            bindings,
            Json.parseToJsonElement("""{"body":"hello"}"""),
            gateway,
            listOf(SecureEnvelopeBundles.SealRecipient("phone-1", phone.publicIdentity)),
            now = now,
        )
        val ciphertext = Base64Url.decode(sealed.bundle.ciphertext).also {
            it[0] = (it[0].toInt() xor 1).toByte()
        }
        val tampered = sealed.copy(bundle = sealed.bundle.copy(ciphertext = Base64Url.encode(ciphertext)))
        assertCode(SecurityErrorCode.INVALID_SIGNATURE) {
            SecureEnvelopeBundles.open(
                tampered,
                phone,
                gateway.publicIdentity,
                bindings,
                "phone-1",
                InMemoryReplayStore(),
                now + 1,
            )
        }
        assertCode(SecurityErrorCode.BINDING_MISMATCH) {
            SecureEnvelopeBundles.open(
                sealed,
                outsider,
                gateway.publicIdentity,
                bindings,
                "outsider-1",
                InMemoryReplayStore(),
                now + 1,
            )
        }
        val unknown = CanonicalJson.encode(sealed.toJson())
            .replaceFirst("\"bundle\":{", "\"bundle\":{\"unknown\":true,")
        assertThrows(IllegalArgumentException::class.java) {
            SecureEnvelopeBundleCodec.parse(unknown)
        }
    }

    private fun bindings(gateway: TestP256Identity) = SecureEnvelopeBundleBindings(
        gatewayId = "gateway-1",
        conversationId = "conversation-1",
        direction = SecureEnvelopeDirection.GATEWAY_TO_DEVICE,
        senderDeviceId = "gateway-device",
        senderKeyId = gateway.publicIdentity.keyId,
    )

    private fun assertCode(code: SecurityErrorCode, block: () -> Unit) {
        val error = assertThrows(CodeverSecurityException::class.java, block)
        assertEquals(code, error.code)
    }
}
