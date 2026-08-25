package id.my.anciety.codever.security.codever

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CapabilityRenewalTest {
    @Test
    fun `encodes a strictly bound capability renewal request`() {
        val request = CapabilityRenewalRequest(
            requestId = "request-1",
            gatewayId = "gateway-1",
            deviceId = "device-1",
            certificateId = "certificate-1",
            requestedOperations = listOf(PairingOperation.PROVIDER_SESSIONS_LIST),
            issuedAt = 1_000,
            expiresAt = 121_000,
        )

        val encoded = request.toJson()

        assertEquals("capability_renewal_request", encoded.requiredString("kind"))
        assertEquals("certificate-1", encoded.requiredString("certificate_id"))
        assertEquals(
            listOf(PairingOperation.PROVIDER_SESSIONS_LIST),
            encoded.requiredOperations("requested_operations"),
        )
    }

    @Test
    fun `parses the encrypted Gateway renewal offer and rejects extra fields`() {
        val valid = Json.parseToJsonElement("""
            {
              "msgtype":"m.notice",
              "body":"Encrypted Codever capability renewal",
              "io.codever":{
                "version":1,
                "kind":"capability_renewal_offer",
                "request_id":"request-1",
                "certificate_id":"certificate-1",
                "pairing_link":"codever://pair?data=offer",
                "expires_at":121000,
                "active_device_count":2
              }
            }
        """.trimIndent())

        val offer = CapabilityRenewalCodec.parseOfferContent(valid)

        assertEquals("request-1", offer.requestId)
        assertEquals("certificate-1", offer.certificateId)
        assertEquals(2, offer.activeDeviceCount)

        val unexpected = Json.parseToJsonElement("""
            {
              "msgtype":"m.notice",
              "body":"Encrypted Codever capability renewal",
              "io.codever":{
                "version":1,
                "kind":"capability_renewal_offer",
                "request_id":"request-1",
                "certificate_id":"certificate-1",
                "pairing_link":"codever://pair?data=offer",
                "expires_at":121000,
                "unexpected":"secret"
              }
            }
        """.trimIndent())
        assertTrue(
            runCatching { CapabilityRenewalCodec.parseOfferContent(unexpected) }
                .exceptionOrNull() is IllegalArgumentException,
        )
    }
}
