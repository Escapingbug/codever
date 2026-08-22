package id.my.anciety.codever.security.codever

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

data class EcPublicJwk(
    val x: String,
    val y: String,
    val ext: Boolean? = null,
    val keyOps: List<String>? = null,
    val alg: String? = null,
) {
    fun validate() {
        require(Base64Url.decode(x).size == 32 && x.length == 43) { "P-256 JWK x is invalid." }
        require(Base64Url.decode(y).size == 32 && y.length == 43) { "P-256 JWK y is invalid." }
        require(ext == null || ext) { "P-256 JWK ext is invalid." }
        require(keyOps == null || keyOps == listOf("verify")) { "P-256 JWK key_ops is invalid." }
        require(alg == null || alg == "ES256") { "P-256 JWK alg is invalid." }
    }

    fun toJson(): JsonObject = buildJsonObject {
        put("kty", "EC")
        put("crv", "P-256")
        put("x", x)
        put("y", y)
        ext?.let { put("ext", it) }
        keyOps?.let { operations -> put("key_ops", JsonArray(operations.map(::JsonPrimitive))) }
        alg?.let { put("alg", it) }
    }
}

data class PairingPublicKey(
    val keyId: String,
    val publicKey: EcPublicJwk,
) {
    init {
        require(keyId.length == 43 && Base64Url.decode(keyId).size == 32) {
            "Pairing key ID is invalid."
        }
        publicKey.validate()
        require(CodeverCrypto.publicKeyId(publicKey) == keyId) { "Pairing key ID does not match its JWK." }
    }

    fun toJson(): JsonObject = buildJsonObject {
        put("version", 1)
        put("algorithm", "ES256")
        put("keyId", keyId)
        put("publicKey", publicKey.toJson())
    }
}

data class MatrixTransportBinding(
    val homeserver: String,
    val roomId: String,
    val userId: String,
    val deviceId: String,
    val ed25519: String,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("homeserver", homeserver)
        put("roomId", roomId)
        put("userId", userId)
        put("deviceId", deviceId)
        put("ed25519", ed25519)
    }
}

enum class PairingOperation(val wireName: String) {
    PROMPT("prompt"),
    CANCEL("cancel"),
    DECISION("decision"),
    SESSION_SETTINGS("session.settings"),
    SESSION_CREATE("session.create"),
    PROJECT_SETTINGS("project.settings"),
    PROVIDER_SESSIONS_LIST("provider.sessions.list"),
    PROVIDER_SESSION_INSPECT("provider.session.inspect"),
    SESSION_ARCHIVE("session.archive"),
    SESSION_RESTORE("session.restore"),
    SESSION_DELETE("session.delete"),
    DEVICE_INVITE("device.invite"),
    PRIVILEGE_APPROVE("privilege.approve");

    companion object {
        fun parse(value: String): PairingOperation = entries.firstOrNull { it.wireName == value }
            ?: throw IllegalArgumentException("Pairing operation is invalid.")
    }
}

data class PairingSignature(val keyId: String, val value: String) {
    init {
        require(keyId.length == 43 && Base64Url.decode(keyId).size == 32) {
            "Signature key ID is invalid."
        }
        require(Base64Url.decode(value).isNotEmpty()) { "Signature value is invalid." }
    }

    fun toJson(): JsonObject = buildJsonObject {
        put("algorithm", "ES256")
        put("keyId", keyId)
        put("value", value)
    }
}

data class PairingOffer(
    val offerId: String,
    val gatewayId: String,
    val gatewayName: String,
    val gatewayKey: PairingPublicKey,
    val gatewayTransport: MatrixTransportBinding,
    val challenge: String,
    val allowedOperations: List<PairingOperation>,
    val issuedAt: Long,
    val expiresAt: Long,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("kind", "codever.pairing.offer")
        put("version", 1)
        put("offerId", offerId)
        put("gatewayId", gatewayId)
        put("gatewayName", gatewayName)
        put("gatewayKey", gatewayKey.toJson())
        put("gatewayTransport", gatewayTransport.toJson())
        put("challenge", challenge)
        put("allowedOperations", operationsJson(allowedOperations))
        put("issuedAt", issuedAt)
        put("expiresAt", expiresAt)
    }
}

data class SignedPairingOffer(val offer: PairingOffer, val signature: PairingSignature) {
    fun toJson(): JsonObject = buildJsonObject {
        put("offer", offer.toJson())
        put("signature", signature.toJson())
    }
}

data class PairingRequest(
    val requestId: String,
    val offerId: String,
    val offerDigest: String,
    val gatewayId: String,
    val deviceId: String,
    val deviceName: String,
    val deviceKey: PairingPublicKey,
    val deviceTransport: MatrixTransportBinding,
    val requestedOperations: List<PairingOperation>,
    val issuedAt: Long,
    val expiresAt: Long,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("kind", "codever.pairing.request")
        put("version", 1)
        put("requestId", requestId)
        put("offerId", offerId)
        put("offerDigest", offerDigest)
        put("gatewayId", gatewayId)
        put("deviceId", deviceId)
        put("deviceName", deviceName)
        put("deviceKey", deviceKey.toJson())
        put("deviceTransport", deviceTransport.toJson())
        put("requestedOperations", operationsJson(requestedOperations))
        put("issuedAt", issuedAt)
        put("expiresAt", expiresAt)
    }
}

data class SignedPairingRequest(val request: PairingRequest, val signature: PairingSignature) {
    fun toJson(): JsonObject = buildJsonObject {
        put("request", request.toJson())
        put("signature", signature.toJson())
    }
}

data class PairingCertificate(
    val certificateId: String,
    val offerId: String,
    val offerDigest: String,
    val requestId: String,
    val requestDigest: String,
    val gatewayId: String,
    val gatewayKeyId: String,
    val gatewayTransport: MatrixTransportBinding,
    val deviceId: String,
    val deviceName: String,
    val deviceKey: PairingPublicKey,
    val deviceTransport: MatrixTransportBinding,
    val allowedOperations: List<PairingOperation>,
    val issuedAt: Long,
    val expiresAt: Long,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("kind", "codever.pairing.certificate")
        put("version", 1)
        put("certificateId", certificateId)
        put("offerId", offerId)
        put("offerDigest", offerDigest)
        put("requestId", requestId)
        put("requestDigest", requestDigest)
        put("gatewayId", gatewayId)
        put("gatewayKeyId", gatewayKeyId)
        put("gatewayTransport", gatewayTransport.toJson())
        put("deviceId", deviceId)
        put("deviceName", deviceName)
        put("deviceKey", deviceKey.toJson())
        put("deviceTransport", deviceTransport.toJson())
        put("allowedOperations", operationsJson(allowedOperations))
        put("issuedAt", issuedAt)
        put("expiresAt", expiresAt)
    }
}

data class SignedPairingCertificate(
    val certificate: PairingCertificate,
    val signature: PairingSignature,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("certificate", certificate.toJson())
        put("signature", signature.toJson())
    }
}

data class PairingResponse(
    val offerId: String,
    val requestId: String,
    val requestDigest: String,
    val gatewayId: String,
    val activeDeviceCount: Int?,
    val certificate: SignedPairingCertificate,
    val issuedAt: Long,
    val expiresAt: Long,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("kind", "codever.pairing.response")
        put("version", 1)
        put("offerId", offerId)
        put("requestId", requestId)
        put("requestDigest", requestDigest)
        put("gatewayId", gatewayId)
        activeDeviceCount?.let { put("activeDeviceCount", it) }
        put("certificate", certificate.toJson())
        put("issuedAt", issuedAt)
        put("expiresAt", expiresAt)
    }
}

data class SignedPairingResponse(val response: PairingResponse, val signature: PairingSignature) {
    fun toJson(): JsonObject = buildJsonObject {
        put("response", response.toJson())
        put("signature", signature.toJson())
    }
}

enum class PairingRejectionCode(val wireName: String) {
    GATEWAY_REJECTED("gateway_rejected"),
    DEVICE_CONFLICT("device_conflict"),
    GATEWAY_ERROR("gateway_error"),
    ;

    companion object {
        fun parse(value: String): PairingRejectionCode = entries.firstOrNull { it.wireName == value }
            ?: throw IllegalArgumentException("Pairing rejection code is invalid.")
    }
}

data class PairingRejection(
    val offerId: String,
    val requestId: String,
    val requestDigest: String,
    val gatewayId: String,
    val code: PairingRejectionCode,
    val message: String,
    val retryable: Boolean,
    val issuedAt: Long,
    val expiresAt: Long,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("kind", "codever.pairing.rejection")
        put("version", 1)
        put("offerId", offerId)
        put("requestId", requestId)
        put("requestDigest", requestDigest)
        put("gatewayId", gatewayId)
        put("code", code.wireName)
        put("message", message)
        put("retryable", retryable)
        put("issuedAt", issuedAt)
        put("expiresAt", expiresAt)
    }
}

data class SignedPairingRejection(
    val rejection: PairingRejection,
    val signature: PairingSignature,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("rejection", rejection.toJson())
        put("signature", signature.toJson())
    }
}

internal fun operationsJson(value: List<PairingOperation>): JsonArray = buildJsonArray {
    value.forEach { add(JsonPrimitive(it.wireName)) }
}
