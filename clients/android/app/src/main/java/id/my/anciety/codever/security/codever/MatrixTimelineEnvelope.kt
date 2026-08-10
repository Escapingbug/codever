package id.my.anciety.codever.security.codever

import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

data class MatrixTimelineBindings(
    val gatewayId: String,
    val conversationId: String,
    val roomId: String,
    val epochId: String,
    val sessionId: String?,
    val threadRootEventId: String?,
)

data class MatrixTimelineEnvelope(
    val envelopeId: String,
    val gatewayId: String,
    val conversationId: String,
    val roomId: String,
    val epochId: String,
    val logicalEventId: String,
    val sessionId: String?,
    val threadRootEventId: String?,
    val issuedAt: Long,
    val nonce: String,
    val ciphertext: String,
) {
    fun headerJson(): JsonObject = buildJsonObject {
        put("kind", "codever.matrix-timeline-envelope")
        put("version", 2)
        put("envelopeId", envelopeId)
        put("contentType", "io.codever.matrix-timeline-content.v2")
        put("gatewayId", gatewayId)
        put("conversationId", conversationId)
        put("roomId", roomId)
        put("epochId", epochId)
        put("logicalEventId", logicalEventId)
        sessionId?.let { put("sessionId", it) }
        threadRootEventId?.let { put("threadRootEventId", it) }
        put("issuedAt", issuedAt)
        put("nonce", nonce)
    }

    fun toJson(): JsonObject = JsonObject(
        headerJson() + ("ciphertext" to kotlinx.serialization.json.JsonPrimitive(ciphertext)),
    )
}

data class SignedMatrixTimelineEnvelope(
    val envelope: MatrixTimelineEnvelope,
    val signature: PairingSignature,
)

object MatrixTimelineEnvelopeCodec {
    private val json = Json { isLenient = false; allowSpecialFloatingPointValues = false }

    fun parse(input: String): SignedMatrixTimelineEnvelope {
        val root = json.parseToJsonElement(input).jsonObject
        root.requireExactKeys(setOf("envelope", "signature"), "signed Matrix timeline envelope")
        val value = root.requiredObject("envelope")
        val optional = setOf("sessionId", "threadRootEventId")
        val required = setOf(
            "kind", "version", "envelopeId", "contentType", "gatewayId",
            "conversationId", "roomId", "epochId", "logicalEventId", "issuedAt",
            "nonce", "ciphertext",
        )
        require(value.keys.containsAll(required) && value.keys.all { it in required || it in optional })
        require(value.requiredString("kind") == "codever.matrix-timeline-envelope")
        require(value.requiredLong("version") == 2L)
        require(value.requiredString("contentType") == "io.codever.matrix-timeline-content.v2")
        val sessionId = value["sessionId"]?.let { value.requiredOpaqueId("sessionId") }
        val rootEventId = value["threadRootEventId"]?.let {
            value.requiredOpaqueId("threadRootEventId")
        }
        require(rootEventId == null || sessionId != null)
        val nonce = value.requiredBase64Url("nonce", 16, 16)
        require(Base64Url.decode(nonce).size == 12)
        val ciphertext = value.requiredBase64Url("ciphertext", 22, 32 * 1024)
        require(Base64Url.decode(ciphertext).size >= 16)
        return SignedMatrixTimelineEnvelope(
            MatrixTimelineEnvelope(
                envelopeId = value.requiredOpaqueId("envelopeId"),
                gatewayId = value.requiredOpaqueId("gatewayId"),
                conversationId = value.requiredOpaqueId("conversationId"),
                roomId = value.requiredOpaqueId("roomId"),
                epochId = value.requiredOpaqueId("epochId"),
                logicalEventId = value.requiredOpaqueId("logicalEventId"),
                sessionId = sessionId,
                threadRootEventId = rootEventId,
                issuedAt = value.requiredTimestamp("issuedAt"),
                nonce = nonce,
                ciphertext = ciphertext,
            ),
            PairingCodec.parseSignature(root.requiredObject("signature")),
        )
    }
}

object MatrixTimelineEnvelopes {
    private const val SIGNATURE_DOMAIN = "codever.matrix-timeline-envelope.signature.v2"
    private val json = Json { isLenient = false; allowSpecialFloatingPointValues = false }

    fun open(
        signed: SignedMatrixTimelineEnvelope,
        timelineKey: ByteArray,
        gatewayPublicKey: PairingPublicKey,
        expected: MatrixTimelineBindings,
    ): JsonElement {
        val envelope = signed.envelope
        require(timelineKey.size == 32) { "Matrix timeline key must contain 32 bytes." }
        if (
            envelope.gatewayId != expected.gatewayId ||
            envelope.conversationId != expected.conversationId ||
            envelope.roomId != expected.roomId ||
            envelope.epochId != expected.epochId ||
            envelope.sessionId != expected.sessionId ||
            envelope.threadRootEventId != expected.threadRootEventId
        ) {
            throw CodeverSecurityException(
                SecurityErrorCode.BINDING_MISMATCH,
                "Matrix timeline envelope binding is incorrect.",
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
                "Matrix timeline envelope signature is invalid.",
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
                "Matrix timeline envelope authentication failed.",
                error,
            )
        } finally {
            nonce.fill(0)
        }
        return try {
            json.parseToJsonElement(plaintext.toString(Charsets.UTF_8))
        } finally {
            plaintext.fill(0)
        }
    }
}
