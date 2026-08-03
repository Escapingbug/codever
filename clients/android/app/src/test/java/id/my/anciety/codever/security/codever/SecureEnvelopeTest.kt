package id.my.anciety.codever.security.codever

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test

class SecureEnvelopeTest {
    private val now = 1_800_000_000_000L

    @Test
    fun `ECDH HKDF envelope round trips without plaintext and rejects replay`() {
        val device = TestP256Identity.generate()
        val gateway = TestP256Identity.generate()
        val bindings = bindings(device, gateway)
        val plaintext = Json.parseToJsonElement(
            """{"msgtype":"m.text","body":"secret prompt","io.codever":{"kind":"signed_command","version":1}}""",
        )
        val sealed = SecureEnvelopes.sealSecureEnvelope(
            bindings,
            plaintext,
            device,
            gateway.publicIdentity,
            envelopeId = "envelope-1",
            now = now,
        )
        assertFalse(CanonicalJson.encode(sealed.toJson()).contains("secret prompt"))
        val replayStore = InMemoryReplayStore()
        val opened = SecureEnvelopes.openSecureEnvelope(
            sealed,
            gateway,
            device.publicIdentity,
            bindings,
            replayStore,
            now + 1,
        )
        assertEquals(plaintext, opened.plaintext)
        assertCode(SecurityErrorCode.REPLAY) {
            SecureEnvelopes.openSecureEnvelope(
                sealed,
                gateway,
                device.publicIdentity,
                bindings,
                replayStore,
                now + 1,
            )
        }
    }

    @Test
    fun `envelope rejects wrong context expiry bad signature and unknown field`() {
        val device = TestP256Identity.generate()
        val gateway = TestP256Identity.generate()
        val bindings = bindings(device, gateway)
        val sealed = SecureEnvelopes.sealSecureEnvelope(
            bindings,
            JsonObject(mapOf("body" to JsonPrimitive("hello"))),
            device,
            gateway.publicIdentity,
            now = now,
        )
        assertCode(SecurityErrorCode.BINDING_MISMATCH) {
            SecureEnvelopes.openSecureEnvelope(
                sealed,
                gateway,
                device.publicIdentity,
                bindings.copy(conversationId = "other"),
                InMemoryReplayStore(),
                now + 1,
            )
        }
        assertCode(SecurityErrorCode.EXPIRED) {
            SecureEnvelopes.openSecureEnvelope(
                sealed,
                gateway,
                device.publicIdentity,
                bindings,
                InMemoryReplayStore(),
                sealed.envelope.expiresAt,
            )
        }
        val badSignature = sealed.copy(
            signature = sealed.signature.copy(
                value = Base64Url.encode(Base64Url.decode(sealed.signature.value).also { it[0] = (it[0].toInt() xor 1).toByte() }),
            ),
        )
        assertCode(SecurityErrorCode.INVALID_SIGNATURE) {
            SecureEnvelopes.openSecureEnvelope(
                badSignature,
                gateway,
                device.publicIdentity,
                bindings,
                InMemoryReplayStore(),
                now + 1,
            )
        }
        val json = CanonicalJson.encode(sealed.toJson())
        val withUnknown = json.replaceFirst("\"envelope\":{", "\"envelope\":{\"unknown\":true,")
        assertThrows(IllegalArgumentException::class.java) { SecureEnvelopeCodec.parse(withUnknown) }
    }

    private fun bindings(device: TestP256Identity, gateway: TestP256Identity) = SecureEnvelopeBindings(
        gatewayId = "gateway-1",
        conversationId = "conversation-1",
        direction = SecureEnvelopeDirection.DEVICE_TO_GATEWAY,
        senderDeviceId = "phone-1",
        recipientDeviceId = "gateway-device",
        senderKeyId = device.publicIdentity.keyId,
        recipientKeyId = gateway.publicIdentity.keyId,
    )

    private fun assertCode(code: SecurityErrorCode, block: () -> Unit) {
        val error = assertThrows(CodeverSecurityException::class.java, block)
        assertEquals(code, error.code)
    }
}
