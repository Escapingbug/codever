package id.my.anciety.codever.security.codever

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

data class CapabilityRenewalRequest(
    val requestId: String,
    val gatewayId: String,
    val deviceId: String,
    val certificateId: String,
    val requestedOperations: List<PairingOperation>,
    val issuedAt: Long,
    val expiresAt: Long,
) {
    init {
        require(requestId.isNotBlank() && requestId.length <= 256)
        require(gatewayId.isNotBlank() && gatewayId.length <= 256)
        require(deviceId.isNotBlank() && deviceId.length <= 256)
        require(certificateId.isNotBlank() && certificateId.length <= 256)
        require(requestedOperations.isNotEmpty())
        require(requestedOperations.distinct().size == requestedOperations.size)
        require(expiresAt > issuedAt)
    }

    fun toJson(): JsonObject = buildJsonObject {
        put("version", 1)
        put("kind", "capability_renewal_request")
        put("request_id", requestId)
        put("gateway_id", gatewayId)
        put("device_id", deviceId)
        put("certificate_id", certificateId)
        put(
            "requested_operations",
            JsonArray(requestedOperations.map { JsonPrimitive(it.wireName) }),
        )
        put("issued_at", issuedAt)
        put("expires_at", expiresAt)
    }
}

data class CapabilityRenewalOffer(
    val requestId: String,
    val certificateId: String,
    val pairingLink: String,
    val expiresAt: Long,
    val activeDeviceCount: Int?,
)

object CapabilityRenewalCodec {
    fun parseOfferContent(plaintext: JsonElement): CapabilityRenewalOffer {
        val content = plaintext as? JsonObject
            ?: throw IllegalArgumentException("Capability renewal content must be an object.")
        content.requireExactKeys(
            setOf("msgtype", "body", "io.codever"),
            "capability renewal content",
        )
        require(content.requiredString("msgtype") == "m.notice")
        content.requiredString("body", 256)
        val extension = content.requiredObject("io.codever")
        extension.requireAllowedKeys(
            required = setOf(
                "version",
                "kind",
                "request_id",
                "certificate_id",
                "pairing_link",
                "expires_at",
            ),
            optional = setOf("active_device_count"),
            label = "capability renewal offer",
        )
        require(extension.requiredLong("version") == 1L)
        require(extension.requiredString("kind") == "capability_renewal_offer")
        val activeDeviceCount = extension["active_device_count"]
            ?.jsonPrimitive
            ?.intOrNull
        require(activeDeviceCount == null || activeDeviceCount > 0) {
            "Capability renewal active device count is invalid."
        }
        return CapabilityRenewalOffer(
            requestId = extension.requiredOpaqueId("request_id"),
            certificateId = extension.requiredOpaqueId("certificate_id"),
            pairingLink = extension.requiredString("pairing_link", 128 * 1024),
            expiresAt = extension.requiredTimestamp("expires_at"),
            activeDeviceCount = activeDeviceCount,
        )
    }
}
