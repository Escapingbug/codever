package id.my.anciety.codever.security.codever

import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

data class MatrixStateBindings(
    val gatewayId: String,
    val conversationId: String,
    val roomId: String,
    val eventType: String,
    val stateKey: String,
    val epochId: String,
    val stateVersion: Long,
)

data class MatrixStateEnvelope(
    val gatewayId: String,
    val conversationId: String,
    val roomId: String,
    val eventType: String,
    val stateKey: String,
    val epochId: String,
    val stateVersion: Long,
    val issuedAt: Long,
    val nonce: String,
    val ciphertext: String,
) {
    fun headerJson(): JsonObject = buildJsonObject {
        put("kind", "codever.matrix-state-envelope")
        put("version", 2)
        put("contentType", "io.codever.matrix-state-content.v2")
        put("gatewayId", gatewayId)
        put("conversationId", conversationId)
        put("roomId", roomId)
        put("eventType", eventType)
        put("stateKey", stateKey)
        put("epochId", epochId)
        put("stateVersion", stateVersion)
        put("issuedAt", issuedAt)
        put("nonce", nonce)
    }

    fun toJson(): JsonObject = JsonObject(
        headerJson() + ("ciphertext" to kotlinx.serialization.json.JsonPrimitive(ciphertext)),
    )
}

data class SignedMatrixStateEnvelope(
    val envelope: MatrixStateEnvelope,
    val signature: PairingSignature,
)

object MatrixStateEnvelopeCodec {
    private val json = Json { isLenient = false; allowSpecialFloatingPointValues = false }

    fun parse(input: String): SignedMatrixStateEnvelope {
        val root = json.parseToJsonElement(input).jsonObject
        root.requireExactKeys(setOf("envelope", "signature"), "signed Matrix state envelope")
        val value = root.requiredObject("envelope")
        value.requireExactKeys(
            setOf(
                "kind", "version", "contentType", "gatewayId", "conversationId", "roomId",
                "eventType", "stateKey", "epochId", "stateVersion", "issuedAt", "nonce",
                "ciphertext",
            ),
            "Matrix state envelope",
        )
        require(value.requiredString("kind") == "codever.matrix-state-envelope")
        require(value.requiredLong("version") == 2L)
        require(value.requiredString("contentType") == "io.codever.matrix-state-content.v2")
        val eventType = value.requiredString("eventType")
        require(eventType in STATE_EVENT_TYPES)
        val nonce = value.requiredBase64Url("nonce", 16, 16)
        require(Base64Url.decode(nonce).size == 12)
        val ciphertext = value.requiredBase64Url("ciphertext", 22, 32 * 1024)
        require(Base64Url.decode(ciphertext).size >= 16)
        return SignedMatrixStateEnvelope(
            MatrixStateEnvelope(
                gatewayId = value.requiredOpaqueId("gatewayId"),
                conversationId = value.requiredOpaqueId("conversationId"),
                roomId = value.requiredOpaqueId("roomId"),
                eventType = eventType,
                stateKey = value.requiredOpaqueId("stateKey"),
                epochId = value.requiredOpaqueId("epochId"),
                stateVersion = value.requiredLong("stateVersion").also { require(it >= 0) },
                issuedAt = value.requiredTimestamp("issuedAt"),
                nonce = nonce,
                ciphertext = ciphertext,
            ),
            PairingCodec.parseSignature(root.requiredObject("signature")),
        )
    }

    private val STATE_EVENT_TYPES = setOf(
        "io.codever.gateway.current.v2",
        "io.codever.session.current.v2",
    )
}

object MatrixStateEnvelopes {
    private const val SIGNATURE_DOMAIN = "codever.matrix-state-envelope.signature.v2"
    private val json = Json { isLenient = false; allowSpecialFloatingPointValues = false }

    fun open(
        signed: SignedMatrixStateEnvelope,
        timelineKey: ByteArray,
        gatewayPublicKey: PairingPublicKey,
        expected: MatrixStateBindings,
    ): JsonObject {
        val envelope = signed.envelope
        require(timelineKey.size == 32) { "Matrix state key must contain 32 bytes." }
        if (
            envelope.gatewayId != expected.gatewayId ||
            envelope.conversationId != expected.conversationId ||
            envelope.roomId != expected.roomId ||
            envelope.eventType != expected.eventType ||
            envelope.stateKey != expected.stateKey ||
            envelope.epochId != expected.epochId ||
            envelope.stateVersion != expected.stateVersion
        ) {
            throw CodeverSecurityException(
                SecurityErrorCode.BINDING_MISMATCH,
                "Matrix state envelope binding is incorrect.",
            )
        }
        val signatureBytes = Base64Url.decode(signed.signature.value)
        val signaturePreimage = CanonicalJson.bytes(buildJsonObject {
            put("domain", SIGNATURE_DOMAIN)
            put("envelope", envelope.toJson())
        })
        val signatureValid = signed.signature.keyId == gatewayPublicKey.keyId &&
            CodeverCrypto.verifyRawEs256(
                CodeverCrypto.importPublicKey(gatewayPublicKey.publicKey),
                signaturePreimage,
                signatureBytes,
            )
        signatureBytes.fill(0)
        signaturePreimage.fill(0)
        if (!signatureValid) {
            throw CodeverSecurityException(
                SecurityErrorCode.INVALID_SIGNATURE,
                "Matrix state envelope signature is invalid.",
            )
        }
        val nonce = Base64Url.decode(envelope.nonce)
        val plaintext = try {
            Cipher.getInstance("AES/GCM/NoPadding").run {
                init(Cipher.DECRYPT_MODE, SecretKeySpec(timelineKey, "AES"), GCMParameterSpec(128, nonce))
                updateAAD(CanonicalJson.bytes(envelope.headerJson()))
                doFinal(Base64Url.decode(envelope.ciphertext))
            }
        } catch (error: Exception) {
            throw CodeverSecurityException(
                SecurityErrorCode.INVALID_SIGNATURE,
                "Matrix state envelope authentication failed.",
                error,
            )
        } finally {
            nonce.fill(0)
        }
        return try {
            json.parseToJsonElement(plaintext.toString(Charsets.UTF_8)).jsonObject
        } finally {
            plaintext.fill(0)
        }
    }
}
