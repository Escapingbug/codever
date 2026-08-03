package id.my.anciety.codever.security.codever

import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

enum class SecureEnvelopeDirection(val wireName: String) {
    DEVICE_TO_GATEWAY("device_to_gateway"),
    GATEWAY_TO_DEVICE("gateway_to_device");

    companion object {
        fun parse(value: String): SecureEnvelopeDirection = entries.firstOrNull { it.wireName == value }
            ?: throw IllegalArgumentException("Secure envelope direction is invalid.")
    }
}

data class SecureEnvelopeBindings(
    val gatewayId: String,
    val conversationId: String,
    val direction: SecureEnvelopeDirection,
    val senderDeviceId: String,
    val recipientDeviceId: String,
    val senderKeyId: String,
    val recipientKeyId: String,
)

data class SecureEnvelope(
    val envelopeId: String,
    val gatewayId: String,
    val conversationId: String,
    val direction: SecureEnvelopeDirection,
    val senderDeviceId: String,
    val recipientDeviceId: String,
    val senderKeyId: String,
    val recipientKeyId: String,
    val issuedAt: Long,
    val expiresAt: Long,
    val nonce: String,
    val ciphertext: String,
) {
    fun headerJson(): JsonObject = buildJsonObject {
        put("kind", "codever.secure-envelope")
        put("version", 1)
        put("envelopeId", envelopeId)
        put("contentType", "io.codever.matrix-content.v1")
        put("gatewayId", gatewayId)
        put("conversationId", conversationId)
        put("direction", direction.wireName)
        put("senderDeviceId", senderDeviceId)
        put("recipientDeviceId", recipientDeviceId)
        put("senderKeyId", senderKeyId)
        put("recipientKeyId", recipientKeyId)
        put("issuedAt", issuedAt)
        put("expiresAt", expiresAt)
        put("nonce", nonce)
    }

    fun toJson(): JsonObject = JsonObject(headerJson() + ("ciphertext" to kotlinx.serialization.json.JsonPrimitive(ciphertext)))
}

data class SignedSecureEnvelope(
    val envelope: SecureEnvelope,
    val signature: PairingSignature,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("envelope", envelope.toJson())
        put("signature", signature.toJson())
    }
}

data class OpenedSecureEnvelope(val plaintext: JsonElement, val envelope: SecureEnvelope)

object SecureEnvelopeCodec {
    private const val MAX_INPUT_BYTES = 24 * 1024 * 1024 + 64 * 1024
    private val json = Json { isLenient = false; allowSpecialFloatingPointValues = false }

    fun parse(input: String): SignedSecureEnvelope {
        require(input.toByteArray(Charsets.UTF_8).size <= MAX_INPUT_BYTES) { "Secure envelope is too large." }
        val root = try {
            json.parseToJsonElement(input).jsonObject
        } catch (error: Exception) {
            throw IllegalArgumentException("Secure envelope is invalid.", error)
        }
        root.requireExactKeys(setOf("envelope", "signature"), "signed secure envelope")
        val envelope = root.requiredObject("envelope")
        envelope.requireExactKeys(
            setOf(
                "kind", "version", "envelopeId", "contentType", "gatewayId", "conversationId",
                "direction", "senderDeviceId", "recipientDeviceId", "senderKeyId", "recipientKeyId",
                "issuedAt", "expiresAt", "nonce", "ciphertext",
            ),
            "secure envelope",
        )
        require(envelope.requiredString("kind") == "codever.secure-envelope")
        require(envelope.requiredLong("version") == 1L)
        require(envelope.requiredString("contentType") == "io.codever.matrix-content.v1")
        val issuedAt = envelope.requiredTimestamp("issuedAt")
        val expiresAt = envelope.requiredTimestamp("expiresAt")
        require(expiresAt > issuedAt) { "Secure envelope lifetime is invalid." }
        val senderDeviceId = envelope.requiredOpaqueId("senderDeviceId")
        val recipientDeviceId = envelope.requiredOpaqueId("recipientDeviceId")
        val senderKeyId = envelope.requiredSha256("senderKeyId")
        val recipientKeyId = envelope.requiredSha256("recipientKeyId")
        require(senderDeviceId != recipientDeviceId) { "Secure envelope cannot address its sender." }
        require(senderKeyId != recipientKeyId) { "Secure envelope cannot reuse the sender key." }
        val nonce = envelope.requiredBase64Url("nonce", 16, 16)
        require(Base64Url.decode(nonce).size == 12) { "Secure envelope nonce is invalid." }
        val ciphertext = envelope.requiredBase64Url("ciphertext", 22, 24 * 1024 * 1024)
        require(Base64Url.decode(ciphertext).size >= 16) { "Secure envelope ciphertext is invalid." }
        return SignedSecureEnvelope(
            envelope = SecureEnvelope(
                envelopeId = envelope.requiredOpaqueId("envelopeId"),
                gatewayId = envelope.requiredOpaqueId("gatewayId"),
                conversationId = envelope.requiredOpaqueId("conversationId"),
                direction = SecureEnvelopeDirection.parse(envelope.requiredString("direction")),
                senderDeviceId = senderDeviceId,
                recipientDeviceId = recipientDeviceId,
                senderKeyId = senderKeyId,
                recipientKeyId = recipientKeyId,
                issuedAt = issuedAt,
                expiresAt = expiresAt,
                nonce = nonce,
                ciphertext = ciphertext,
            ),
            signature = PairingCodec.parseSignature(root.requiredObject("signature")),
        )
    }
}

object SecureEnvelopes {
    private const val DEFAULT_LIFETIME_MS = 2 * 60_000L
    private const val MAX_LIFETIME_MS = 366L * 24 * 60 * 60_000
    private const val DEFAULT_FUTURE_SKEW_MS = 30_000L
    private const val SIGNATURE_DOMAIN = "codever.secure-envelope.signature.v1"
    private const val KDF_DOMAIN = "codever.secure-envelope.kdf.v1"
    private val random = SecureRandom()
    private val json = Json { isLenient = false; allowSpecialFloatingPointValues = false }

    fun sealSecureEnvelope(
        bindings: SecureEnvelopeBindings,
        plaintext: JsonElement,
        senderIdentity: CodeverPrivateIdentity,
        recipientPublicKey: PairingPublicKey,
        envelopeId: String = Base64Url.encode(ByteArray(24).also(random::nextBytes)),
        now: Long = System.currentTimeMillis(),
        lifetimeMs: Long = DEFAULT_LIFETIME_MS,
    ): SignedSecureEnvelope {
        require(lifetimeMs in 1_000..MAX_LIFETIME_MS) {
            "Secure envelope lifetime must be between 1 second and 366 days."
        }
        assertIdentityBindings(bindings, senderIdentity.publicIdentity, recipientPublicKey)
        require(bindings.senderDeviceId != bindings.recipientDeviceId)
        require(bindings.senderKeyId != bindings.recipientKeyId)
        val nonce = ByteArray(12).also(random::nextBytes)
        val shell = SecureEnvelope(
            envelopeId = envelopeId.also { require(it.isNotEmpty() && it.length <= 256) },
            gatewayId = bindings.gatewayId,
            conversationId = bindings.conversationId,
            direction = bindings.direction,
            senderDeviceId = bindings.senderDeviceId,
            recipientDeviceId = bindings.recipientDeviceId,
            senderKeyId = bindings.senderKeyId,
            recipientKeyId = bindings.recipientKeyId,
            issuedAt = now,
            expiresAt = Math.addExact(now, lifetimeMs),
            nonce = Base64Url.encode(nonce),
            ciphertext = "",
        )
        val sharedSecret = senderIdentity.agree(CodeverCrypto.importPublicKey(recipientPublicKey.publicKey))
        val encryptionKey = deriveEncryptionKey(sharedSecret, shell)
        val plaintextBytes = CanonicalJson.bytes(plaintext)
        val ciphertext = try {
            aesGcm(Cipher.ENCRYPT_MODE, encryptionKey, nonce, CanonicalJson.bytes(shell.headerJson()), plaintextBytes)
        } finally {
            sharedSecret.fill(0)
            encryptionKey.fill(0)
            plaintextBytes.fill(0)
        }
        val envelope = shell.copy(ciphertext = Base64Url.encode(ciphertext))
        val signature = senderIdentity.sign(signaturePreimage(envelope))
        return SignedSecureEnvelope(
            envelope,
            PairingSignature(bindings.senderKeyId, Base64Url.encode(signature)),
        )
    }

    fun openSecureEnvelope(
        signed: SignedSecureEnvelope,
        recipientIdentity: CodeverPrivateIdentity,
        senderPublicKey: PairingPublicKey,
        expected: SecureEnvelopeBindings,
        replayStore: ReplayStore,
        now: Long = System.currentTimeMillis(),
        maxFutureSkewMs: Long = DEFAULT_FUTURE_SKEW_MS,
    ): OpenedSecureEnvelope {
        val envelope = signed.envelope
        assertExpectedBindings(envelope, expected)
        if (envelope.expiresAt <= now) fail(SecurityErrorCode.EXPIRED, "Secure envelope has expired.")
        if (envelope.issuedAt > now + maxFutureSkewMs) {
            fail(SecurityErrorCode.ISSUED_IN_FUTURE, "Secure envelope issue time is too far in the future.")
        }
        if (envelope.expiresAt - envelope.issuedAt > MAX_LIFETIME_MS) {
            fail(SecurityErrorCode.LIFETIME_EXCEEDED, "Secure envelope validity window exceeds policy.")
        }
        assertIdentityBindings(expected, senderPublicKey, recipientIdentity.publicIdentity)
        val signatureValid = signed.signature.keyId == envelope.senderKeyId &&
            CodeverCrypto.verifyRawEs256(
                CodeverCrypto.importPublicKey(senderPublicKey.publicKey),
                signaturePreimage(envelope),
                Base64Url.decode(signed.signature.value),
            )
        if (!signatureValid) fail(SecurityErrorCode.INVALID_SIGNATURE, "Secure envelope signature is invalid.")

        val nonce = Base64Url.decode(envelope.nonce)
        val sharedSecret = recipientIdentity.agree(CodeverCrypto.importPublicKey(senderPublicKey.publicKey))
        val encryptionKey = deriveEncryptionKey(sharedSecret, envelope)
        val plaintextBytes = try {
            aesGcm(
                Cipher.DECRYPT_MODE,
                encryptionKey,
                nonce,
                CanonicalJson.bytes(envelope.headerJson()),
                Base64Url.decode(envelope.ciphertext),
            )
        } catch (error: Exception) {
            throw CodeverSecurityException(
                SecurityErrorCode.INVALID_SIGNATURE,
                "Secure envelope authentication failed.",
                error,
            )
        } finally {
            sharedSecret.fill(0)
            encryptionKey.fill(0)
        }
        val plaintext = try {
            json.parseToJsonElement(plaintextBytes.toString(Charsets.UTF_8))
        } catch (error: Exception) {
            throw CodeverSecurityException(
                SecurityErrorCode.INVALID_DOCUMENT,
                "Secure envelope plaintext is not valid JSON.",
                error,
            )
        } finally {
            plaintextBytes.fill(0)
        }
        val scope = CanonicalJson.encode(
            buildJsonArray {
                add(kotlinx.serialization.json.JsonPrimitive(envelope.gatewayId))
                add(kotlinx.serialization.json.JsonPrimitive(envelope.conversationId))
                add(kotlinx.serialization.json.JsonPrimitive(envelope.direction.wireName))
                add(kotlinx.serialization.json.JsonPrimitive(envelope.senderDeviceId))
                add(kotlinx.serialization.json.JsonPrimitive(envelope.recipientDeviceId))
            },
        )
        if (!replayStore.claimAll(
                listOf(
                    ReplayClaim("$scope:envelope:${envelope.envelopeId}", envelope.expiresAt),
                    ReplayClaim("$scope:nonce:${envelope.nonce}", envelope.expiresAt),
                ),
                now,
            )
        ) {
            fail(SecurityErrorCode.REPLAY, "Secure envelope was already opened.")
        }
        return OpenedSecureEnvelope(plaintext, envelope)
    }

    private fun deriveEncryptionKey(sharedSecret: ByteArray, envelope: SecureEnvelope): ByteArray {
        val salt = CodeverCrypto.sha256(
            CanonicalJson.bytes(
                buildJsonObject {
                    put("domain", KDF_DOMAIN)
                    put("gatewayId", envelope.gatewayId)
                    put("recipientKeyId", envelope.recipientKeyId)
                    put("senderKeyId", envelope.senderKeyId)
                },
            ),
        )
        val info = CanonicalJson.bytes(
            buildJsonObject {
                put("contentType", "io.codever.matrix-content.v1")
                put("conversationId", envelope.conversationId)
                put("direction", envelope.direction.wireName)
                put("recipientDeviceId", envelope.recipientDeviceId)
                put("senderDeviceId", envelope.senderDeviceId)
            },
        )
        return try {
            CodeverCrypto.hkdfSha256(sharedSecret, salt, info, 32)
        } finally {
            salt.fill(0)
            info.fill(0)
        }
    }

    private fun signaturePreimage(envelope: SecureEnvelope): ByteArray = CanonicalJson.bytes(
        buildJsonObject {
            put("domain", SIGNATURE_DOMAIN)
            put("envelope", envelope.toJson())
        },
    )

    private fun aesGcm(
        mode: Int,
        key: ByteArray,
        nonce: ByteArray,
        aad: ByteArray,
        input: ByteArray,
    ): ByteArray = Cipher.getInstance("AES/GCM/NoPadding").run {
        init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        updateAAD(aad)
        doFinal(input)
    }

    private fun assertIdentityBindings(
        bindings: SecureEnvelopeBindings,
        sender: PairingPublicKey,
        recipient: PairingPublicKey,
    ) {
        if (sender.keyId != bindings.senderKeyId || recipient.keyId != bindings.recipientKeyId) {
            fail(SecurityErrorCode.KEY_MISMATCH, "Secure envelope key binding is incorrect.")
        }
    }

    private fun assertExpectedBindings(envelope: SecureEnvelope, expected: SecureEnvelopeBindings) {
        if (
            envelope.gatewayId != expected.gatewayId ||
            envelope.conversationId != expected.conversationId ||
            envelope.direction != expected.direction ||
            envelope.senderDeviceId != expected.senderDeviceId ||
            envelope.recipientDeviceId != expected.recipientDeviceId ||
            envelope.senderKeyId != expected.senderKeyId ||
            envelope.recipientKeyId != expected.recipientKeyId
        ) {
            fail(SecurityErrorCode.BINDING_MISMATCH, "Secure envelope binding is incorrect.")
        }
    }

    private fun fail(code: SecurityErrorCode, message: String): Nothing =
        throw CodeverSecurityException(code, message)
}
