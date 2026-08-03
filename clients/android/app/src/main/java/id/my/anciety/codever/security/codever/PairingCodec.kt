package id.my.anciety.codever.security.codever

import java.net.URI
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

object PairingCodec {
    private const val MAX_PAIRING_JSON_BYTES = 256 * 1024
    private const val PAIRING_LINK_PREFIX = "codever://pair?data="
    private val json = Json { isLenient = false; allowSpecialFloatingPointValues = false }

    fun parseOffer(input: String): SignedPairingOffer = parseOffer(parseRoot(input))

    fun parseRequest(input: String): SignedPairingRequest = parseRequest(parseRoot(input))

    fun parseResponse(input: String): SignedPairingResponse = parseResponse(parseRoot(input))

    fun parseRejection(input: String): SignedPairingRejection = parseRejection(parseRoot(input))

    fun decodePairingLink(input: String): SignedPairingOffer {
        require(input.startsWith(PAIRING_LINK_PREFIX)) { "Invalid Codever pairing link." }
        val payload = input.removePrefix(PAIRING_LINK_PREFIX)
        return parseOffer(Base64Url.decode(payload).toString(Charsets.UTF_8))
    }

    fun encodePairingLink(input: SignedPairingOffer): String =
        PAIRING_LINK_PREFIX + Base64Url.encode(CanonicalJson.bytes(input.toJson()))

    internal fun parseOffer(value: JsonObject): SignedPairingOffer {
        value.requireExactKeys(setOf("offer", "signature"), "signed pairing offer")
        val offerObject = value.requiredObject("offer")
        offerObject.requireExactKeys(
            setOf(
                "kind", "version", "offerId", "gatewayId", "gatewayName", "gatewayKey",
                "gatewayTransport", "challenge", "allowedOperations", "issuedAt", "expiresAt",
            ),
            "pairing offer",
        )
        require(offerObject.requiredString("kind") == "codever.pairing.offer")
        require(offerObject.requiredLong("version") == 1L)
        val issuedAt = offerObject.requiredTimestamp("issuedAt")
        val expiresAt = offerObject.requiredTimestamp("expiresAt")
        require(expiresAt > issuedAt) { "Pairing offer lifetime is invalid." }
        return SignedPairingOffer(
            offer = PairingOffer(
                offerId = offerObject.requiredOpaqueId("offerId"),
                gatewayId = offerObject.requiredOpaqueId("gatewayId"),
                gatewayName = offerObject.requiredString("gatewayName", 128),
                gatewayKey = parsePublicKey(offerObject.requiredObject("gatewayKey")),
                gatewayTransport = parseTransport(offerObject.requiredObject("gatewayTransport")),
                challenge = offerObject.requiredBase64Url("challenge", 43, 128),
                allowedOperations = offerObject.requiredOperations("allowedOperations"),
                issuedAt = issuedAt,
                expiresAt = expiresAt,
            ),
            signature = parseSignature(value.requiredObject("signature")),
        )
    }

    internal fun parseRequest(value: JsonObject): SignedPairingRequest {
        value.requireExactKeys(setOf("request", "signature"), "signed pairing request")
        val request = value.requiredObject("request")
        request.requireExactKeys(
            setOf(
                "kind", "version", "requestId", "offerId", "offerDigest", "gatewayId",
                "deviceId", "deviceName", "deviceKey", "deviceTransport", "requestedOperations",
                "issuedAt", "expiresAt",
            ),
            "pairing request",
        )
        require(request.requiredString("kind") == "codever.pairing.request")
        require(request.requiredLong("version") == 1L)
        val issuedAt = request.requiredTimestamp("issuedAt")
        val expiresAt = request.requiredTimestamp("expiresAt")
        require(expiresAt > issuedAt) { "Pairing request lifetime is invalid." }
        return SignedPairingRequest(
            request = PairingRequest(
                requestId = request.requiredOpaqueId("requestId"),
                offerId = request.requiredOpaqueId("offerId"),
                offerDigest = request.requiredSha256("offerDigest"),
                gatewayId = request.requiredOpaqueId("gatewayId"),
                deviceId = request.requiredOpaqueId("deviceId"),
                deviceName = request.requiredString("deviceName", 128),
                deviceKey = parsePublicKey(request.requiredObject("deviceKey")),
                deviceTransport = parseTransport(request.requiredObject("deviceTransport")),
                requestedOperations = request.requiredOperations("requestedOperations"),
                issuedAt = issuedAt,
                expiresAt = expiresAt,
            ),
            signature = parseSignature(value.requiredObject("signature")),
        )
    }

    internal fun parseResponse(value: JsonObject): SignedPairingResponse {
        value.requireExactKeys(setOf("response", "signature"), "signed pairing response")
        val response = value.requiredObject("response")
        response.requireAllowedKeys(
            required = setOf(
                "kind", "version", "offerId", "requestId", "requestDigest", "gatewayId",
                "certificate", "issuedAt", "expiresAt",
            ),
            optional = setOf("activeDeviceCount"),
            label = "pairing response",
        )
        require(response.requiredString("kind") == "codever.pairing.response")
        require(response.requiredLong("version") == 1L)
        val issuedAt = response.requiredTimestamp("issuedAt")
        val expiresAt = response.requiredTimestamp("expiresAt")
        require(expiresAt > issuedAt) { "Pairing response lifetime is invalid." }
        val activeDeviceCount = response["activeDeviceCount"]?.jsonPrimitive?.intOrNull
        require(activeDeviceCount == null || activeDeviceCount > 0) { "Active device count is invalid." }
        return SignedPairingResponse(
            response = PairingResponse(
                offerId = response.requiredOpaqueId("offerId"),
                requestId = response.requiredOpaqueId("requestId"),
                requestDigest = response.requiredSha256("requestDigest"),
                gatewayId = response.requiredOpaqueId("gatewayId"),
                activeDeviceCount = activeDeviceCount,
                certificate = parseCertificate(response.requiredObject("certificate")),
                issuedAt = issuedAt,
                expiresAt = expiresAt,
            ),
            signature = parseSignature(value.requiredObject("signature")),
        )
    }

    internal fun parseRejection(value: JsonObject): SignedPairingRejection {
        value.requireExactKeys(setOf("rejection", "signature"), "signed pairing rejection")
        val rejection = value.requiredObject("rejection")
        rejection.requireExactKeys(
            setOf(
                "kind", "version", "offerId", "requestId", "requestDigest", "gatewayId",
                "code", "message", "retryable", "issuedAt", "expiresAt",
            ),
            "pairing rejection",
        )
        require(rejection.requiredString("kind") == "codever.pairing.rejection")
        require(rejection.requiredLong("version") == 1L)
        val issuedAt = rejection.requiredTimestamp("issuedAt")
        val expiresAt = rejection.requiredTimestamp("expiresAt")
        require(expiresAt > issuedAt) { "Pairing rejection lifetime is invalid." }
        val retryable = rejection["retryable"]?.jsonPrimitive?.booleanOrNull
            ?: throw IllegalArgumentException("Pairing rejection retryable flag is invalid.")
        return SignedPairingRejection(
            PairingRejection(
                offerId = rejection.requiredOpaqueId("offerId"),
                requestId = rejection.requiredOpaqueId("requestId"),
                requestDigest = rejection.requiredSha256("requestDigest"),
                gatewayId = rejection.requiredOpaqueId("gatewayId"),
                code = PairingRejectionCode.parse(rejection.requiredString("code", 64)),
                message = rejection.requiredString("message", 256),
                retryable = retryable,
                issuedAt = issuedAt,
                expiresAt = expiresAt,
            ),
            parseSignature(value.requiredObject("signature")),
        )
    }

    internal fun parseCertificate(value: JsonObject): SignedPairingCertificate {
        value.requireExactKeys(setOf("certificate", "signature"), "signed pairing certificate")
        val certificate = value.requiredObject("certificate")
        certificate.requireExactKeys(
            setOf(
                "kind", "version", "certificateId", "offerId", "offerDigest", "requestId",
                "requestDigest", "gatewayId", "gatewayKeyId", "gatewayTransport", "deviceId",
                "deviceName", "deviceKey", "deviceTransport", "allowedOperations", "issuedAt",
                "expiresAt",
            ),
            "pairing certificate",
        )
        require(certificate.requiredString("kind") == "codever.pairing.certificate")
        require(certificate.requiredLong("version") == 1L)
        val issuedAt = certificate.requiredTimestamp("issuedAt")
        val expiresAt = certificate.requiredTimestamp("expiresAt")
        require(expiresAt > issuedAt) { "Pairing certificate lifetime is invalid." }
        return SignedPairingCertificate(
            certificate = PairingCertificate(
                certificateId = certificate.requiredOpaqueId("certificateId"),
                offerId = certificate.requiredOpaqueId("offerId"),
                offerDigest = certificate.requiredSha256("offerDigest"),
                requestId = certificate.requiredOpaqueId("requestId"),
                requestDigest = certificate.requiredSha256("requestDigest"),
                gatewayId = certificate.requiredOpaqueId("gatewayId"),
                gatewayKeyId = certificate.requiredSha256("gatewayKeyId"),
                gatewayTransport = parseTransport(certificate.requiredObject("gatewayTransport")),
                deviceId = certificate.requiredOpaqueId("deviceId"),
                deviceName = certificate.requiredString("deviceName", 128),
                deviceKey = parsePublicKey(certificate.requiredObject("deviceKey")),
                deviceTransport = parseTransport(certificate.requiredObject("deviceTransport")),
                allowedOperations = certificate.requiredOperations("allowedOperations"),
                issuedAt = issuedAt,
                expiresAt = expiresAt,
            ),
            signature = parseSignature(value.requiredObject("signature")),
        )
    }

    internal fun parsePublicKey(value: JsonObject): PairingPublicKey {
        value.requireExactKeys(setOf("version", "algorithm", "keyId", "publicKey"), "pairing key")
        require(value.requiredLong("version") == 1L && value.requiredString("algorithm") == "ES256")
        val jwk = value.requiredObject("publicKey")
        jwk.requireAllowedKeys(
            required = setOf("kty", "crv", "x", "y"),
            optional = setOf("ext", "key_ops", "alg"),
            label = "P-256 JWK",
        )
        require(jwk.requiredString("kty") == "EC" && jwk.requiredString("crv") == "P-256")
        val ext = jwk["ext"]?.jsonPrimitive?.booleanOrNull
        require(jwk["ext"] == null || ext != null) { "P-256 JWK ext is invalid." }
        val keyOps = jwk["key_ops"]?.let { element ->
            val array = runCatching { element.jsonArray }.getOrElse {
                throw IllegalArgumentException("P-256 JWK key_ops is invalid.")
            }
            array.map { element ->
                element.stringValue()
                    ?: throw IllegalArgumentException("P-256 JWK key_ops is invalid.")
            }
        }
        return PairingPublicKey(
            keyId = value.requiredSha256("keyId"),
            publicKey = EcPublicJwk(
                x = jwk.requiredSha256("x"),
                y = jwk.requiredSha256("y"),
                ext = ext,
                keyOps = keyOps,
                alg = jwk["alg"]?.stringValue(),
            ),
        )
    }

    internal fun parseTransport(value: JsonObject): MatrixTransportBinding {
        value.requireExactKeys(
            setOf("homeserver", "roomId", "userId", "deviceId", "ed25519"),
            "Matrix transport",
        )
        val homeserver = value.requiredString("homeserver", 2_048)
        val uri = runCatching { URI(homeserver) }.getOrElse {
            throw IllegalArgumentException("Matrix homeserver URL is invalid.")
        }
        require(uri.isAbsolute && (uri.scheme == "https" || uri.scheme == "http") && uri.host != null) {
            "Matrix homeserver URL is invalid."
        }
        return MatrixTransportBinding(
            homeserver = homeserver,
            roomId = value.requiredOpaqueId("roomId"),
            userId = value.requiredOpaqueId("userId"),
            deviceId = value.requiredOpaqueId("deviceId"),
            ed25519 = value.requiredString("ed25519", 256).also { require(it.length >= 16) },
        )
    }

    internal fun parseSignature(value: JsonObject): PairingSignature {
        value.requireExactKeys(setOf("algorithm", "keyId", "value"), "pairing signature")
        require(value.requiredString("algorithm") == "ES256")
        return PairingSignature(
            keyId = value.requiredSha256("keyId"),
            value = value.requiredBase64Url("value", 1, 512),
        )
    }

    private fun parseRoot(input: String): JsonObject {
        require(input.toByteArray(Charsets.UTF_8).size <= MAX_PAIRING_JSON_BYTES) {
            "Pairing document is too large."
        }
        return try {
            json.parseToJsonElement(input).jsonObject
        } catch (error: Exception) {
            throw IllegalArgumentException("Pairing document is invalid.", error)
        }
    }
}

internal fun JsonObject.requireExactKeys(keys: Set<String>, label: String) {
    require(this.keys == keys) { "$label has an invalid shape." }
}

internal fun JsonObject.requireAllowedKeys(required: Set<String>, optional: Set<String>, label: String) {
    require(keys.containsAll(required) && keys.all { it in required || it in optional }) {
        "$label has an invalid shape."
    }
}

internal fun JsonObject.requiredObject(key: String): JsonObject = try {
    getValue(key).jsonObject
} catch (error: Exception) {
    throw IllegalArgumentException("Field $key must be an object.", error)
}

internal fun JsonObject.requiredString(key: String, maxLength: Int = 256): String =
    get(key)?.stringValue()?.takeIf { it.isNotEmpty() && it.length <= maxLength }
        ?: throw IllegalArgumentException("Field $key is invalid.")

internal fun JsonElement.stringValue(): String? = runCatching {
    jsonPrimitive.takeIf { it.isString }?.contentOrNull
}.getOrNull()

internal fun JsonObject.requiredLong(key: String): Long = get(key)?.let {
    runCatching { it.jsonPrimitive }.getOrNull()?.takeIf { primitive -> !primitive.isString }?.longOrNull
} ?: throw IllegalArgumentException("Field $key is invalid.")

internal fun JsonObject.requiredTimestamp(key: String): Long = requiredLong(key).also {
    require(it >= 0L) { "Field $key is invalid." }
}

internal fun JsonObject.requiredOpaqueId(key: String): String = requiredString(key, 256)

internal fun JsonObject.requiredBase64Url(key: String, min: Int, max: Int): String =
    requiredString(key, max).also {
        require(it.length >= min) { "Field $key is invalid." }
        Base64Url.decode(it)
    }

internal fun JsonObject.requiredSha256(key: String): String = requiredBase64Url(key, 43, 43).also {
    require(Base64Url.decode(it).size == 32) { "Field $key is invalid." }
}

internal fun JsonObject.requiredOperations(key: String): List<PairingOperation> {
    val array: JsonArray = try {
        getValue(key).jsonArray
    } catch (error: Exception) {
        throw IllegalArgumentException("Field $key is invalid.", error)
    }
    require(array.size in 1..PairingOperation.entries.size) { "Pairing operations are invalid." }
    return array.map { PairingOperation.parse(it.stringValue() ?: "") }.also {
        require(it.distinct().size == it.size) { "Pairing operations must be unique." }
    }
}
