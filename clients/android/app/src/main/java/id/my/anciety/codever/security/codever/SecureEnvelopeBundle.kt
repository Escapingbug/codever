package id.my.anciety.codever.security.codever

import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

data class SecureEnvelopeBundleBindings(
    val gatewayId: String,
    val conversationId: String,
    val direction: SecureEnvelopeDirection,
    val senderDeviceId: String,
    val senderKeyId: String,
)

data class SecureEnvelopeBundleRecipient(
    val recipientDeviceId: String,
    val recipientKeyId: String,
    val nonce: String,
    val wrappedKey: String,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("recipientDeviceId", recipientDeviceId)
        put("recipientKeyId", recipientKeyId)
        put("nonce", nonce)
        put("wrappedKey", wrappedKey)
    }
}

data class SecureEnvelopeBundle(
    val envelopeId: String,
    val gatewayId: String,
    val conversationId: String,
    val direction: SecureEnvelopeDirection,
    val senderDeviceId: String,
    val senderKeyId: String,
    val issuedAt: Long,
    val expiresAt: Long,
    val nonce: String,
    val ciphertext: String,
    val recipients: List<SecureEnvelopeBundleRecipient>,
) {
    fun headerJson(): JsonObject = buildJsonObject {
        put("kind", "codever.secure-envelope-bundle")
        put("version", 1)
        put("envelopeId", envelopeId)
        put("contentType", "io.codever.matrix-content.v1")
        put("gatewayId", gatewayId)
        put("conversationId", conversationId)
        put("direction", direction.wireName)
        put("senderDeviceId", senderDeviceId)
        put("senderKeyId", senderKeyId)
        put("issuedAt", issuedAt)
        put("expiresAt", expiresAt)
        put("nonce", nonce)
    }

    fun toJson(): JsonObject = JsonObject(
        headerJson() + mapOf(
            "ciphertext" to kotlinx.serialization.json.JsonPrimitive(ciphertext),
            "recipients" to JsonArray(recipients.map(SecureEnvelopeBundleRecipient::toJson)),
        ),
    )
}

data class SignedSecureEnvelopeBundle(
    val bundle: SecureEnvelopeBundle,
    val signature: PairingSignature,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("bundle", bundle.toJson())
        put("signature", signature.toJson())
    }
}

data class OpenedSecureEnvelopeBundle(
    val plaintext: JsonElement,
    val bundle: SecureEnvelopeBundle,
)

object SecureEnvelopeBundleCodec {
    private const val MAX_INPUT_BYTES = 24 * 1024 * 1024 + 256 * 1024
    private val json = Json { isLenient = false; allowSpecialFloatingPointValues = false }

    fun parse(input: String): SignedSecureEnvelopeBundle {
        require(input.toByteArray(Charsets.UTF_8).size <= MAX_INPUT_BYTES) {
            "Secure envelope bundle is too large."
        }
        val root = try {
            json.parseToJsonElement(input).jsonObject
        } catch (error: Exception) {
            throw IllegalArgumentException("Secure envelope bundle is invalid.", error)
        }
        root.requireExactKeys(setOf("bundle", "signature"), "signed secure envelope bundle")
        val value = root.requiredObject("bundle")
        value.requireExactKeys(
            setOf(
                "kind", "version", "envelopeId", "contentType", "gatewayId",
                "conversationId", "direction", "senderDeviceId", "senderKeyId", "issuedAt",
                "expiresAt", "nonce", "ciphertext", "recipients",
            ),
            "secure envelope bundle",
        )
        require(value.requiredString("kind") == "codever.secure-envelope-bundle")
        require(value.requiredLong("version") == 1L)
        require(value.requiredString("contentType") == "io.codever.matrix-content.v1")
        val issuedAt = value.requiredTimestamp("issuedAt")
        val expiresAt = value.requiredTimestamp("expiresAt")
        require(expiresAt > issuedAt) { "Secure envelope bundle lifetime is invalid." }
        val recipients = value.getValue("recipients").jsonArray.map { item ->
            val recipient = item.jsonObject
            recipient.requireExactKeys(
                setOf("recipientDeviceId", "recipientKeyId", "nonce", "wrappedKey"),
                "secure envelope bundle recipient",
            )
            SecureEnvelopeBundleRecipient(
                recipientDeviceId = recipient.requiredOpaqueId("recipientDeviceId"),
                recipientKeyId = recipient.requiredSha256("recipientKeyId"),
                nonce = recipient.requiredBase64Url("nonce", 16, 16).also {
                    require(Base64Url.decode(it).size == 12)
                },
                wrappedKey = recipient.requiredBase64Url("wrappedKey", 64, 64).also {
                    require(Base64Url.decode(it).size == 48)
                },
            )
        }
        require(recipients.size in 1..256) { "Secure envelope bundle recipient count is invalid." }
        require(recipients.map { it.recipientDeviceId }.distinct().size == recipients.size)
        require(recipients.map { it.recipientKeyId }.distinct().size == recipients.size)
        return SignedSecureEnvelopeBundle(
            bundle = SecureEnvelopeBundle(
                envelopeId = value.requiredOpaqueId("envelopeId"),
                gatewayId = value.requiredOpaqueId("gatewayId"),
                conversationId = value.requiredOpaqueId("conversationId"),
                direction = SecureEnvelopeDirection.parse(value.requiredString("direction")),
                senderDeviceId = value.requiredOpaqueId("senderDeviceId"),
                senderKeyId = value.requiredSha256("senderKeyId"),
                issuedAt = issuedAt,
                expiresAt = expiresAt,
                nonce = value.requiredBase64Url("nonce", 16, 16).also {
                    require(Base64Url.decode(it).size == 12)
                },
                ciphertext = value.requiredBase64Url("ciphertext", 22, 24 * 1024 * 1024),
                recipients = recipients,
            ),
            signature = PairingCodec.parseSignature(root.requiredObject("signature")),
        )
    }
}

object SecureEnvelopeBundles {
    private const val DEFAULT_LIFETIME_MS = 2 * 60_000L
    private const val MAX_LIFETIME_MS = 366L * 24 * 60 * 60_000
    private const val DEFAULT_FUTURE_SKEW_MS = 30_000L
    private const val SIGNATURE_DOMAIN = "codever.secure-envelope-bundle.signature.v1"
    private const val KDF_DOMAIN = "codever.secure-envelope-bundle.kdf.v1"
    private val random = SecureRandom()
    private val json = Json { isLenient = false; allowSpecialFloatingPointValues = false }

    data class SealRecipient(
        val recipientDeviceId: String,
        val recipientPublicKey: PairingPublicKey,
    )

    fun seal(
        bindings: SecureEnvelopeBundleBindings,
        plaintext: JsonElement,
        senderIdentity: CodeverPrivateIdentity,
        recipients: List<SealRecipient>,
        envelopeId: String = Base64Url.encode(ByteArray(24).also(random::nextBytes)),
        now: Long = System.currentTimeMillis(),
        lifetimeMs: Long = DEFAULT_LIFETIME_MS,
    ): SignedSecureEnvelopeBundle {
        require(recipients.size in 1..256)
        require(lifetimeMs in 1_000..MAX_LIFETIME_MS)
        require(senderIdentity.publicIdentity.keyId == bindings.senderKeyId)
        val payloadNonce = ByteArray(12).also(random::nextBytes)
        val shell = SecureEnvelopeBundle(
            envelopeId = envelopeId,
            gatewayId = bindings.gatewayId,
            conversationId = bindings.conversationId,
            direction = bindings.direction,
            senderDeviceId = bindings.senderDeviceId,
            senderKeyId = bindings.senderKeyId,
            issuedAt = now,
            expiresAt = Math.addExact(now, lifetimeMs),
            nonce = Base64Url.encode(payloadNonce),
            ciphertext = "",
            recipients = emptyList(),
        )
        val contentKey = ByteArray(32).also(random::nextBytes)
        val plaintextBytes = CanonicalJson.bytes(plaintext)
        val ciphertext = try {
            aesGcm(
                Cipher.ENCRYPT_MODE,
                contentKey,
                payloadNonce,
                CanonicalJson.bytes(shell.headerJson()),
                plaintextBytes,
            )
        } finally {
            plaintextBytes.fill(0)
        }
        val routed = recipients.map { recipient ->
            require(recipient.recipientDeviceId != bindings.senderDeviceId)
            val nonce = ByteArray(12).also(random::nextBytes)
            val recipientHeader = buildJsonObject {
                put("recipientDeviceId", recipient.recipientDeviceId)
                put("recipientKeyId", recipient.recipientPublicKey.keyId)
                put("nonce", Base64Url.encode(nonce))
            }
            val wrappingKey = deriveWrappingKey(
                senderIdentity,
                recipient.recipientPublicKey,
                shell,
                recipient.recipientDeviceId,
                recipient.recipientPublicKey.keyId,
            )
            val wrapped = try {
                aesGcm(
                    Cipher.ENCRYPT_MODE,
                    wrappingKey,
                    nonce,
                    CanonicalJson.bytes(buildJsonObject {
                        put("header", shell.headerJson())
                        put("recipient", recipientHeader)
                    }),
                    contentKey,
                )
            } finally {
                wrappingKey.fill(0)
            }
            SecureEnvelopeBundleRecipient(
                recipient.recipientDeviceId,
                recipient.recipientPublicKey.keyId,
                Base64Url.encode(nonce),
                Base64Url.encode(wrapped),
            )
        }
        contentKey.fill(0)
        val bundle = shell.copy(
            ciphertext = Base64Url.encode(ciphertext),
            recipients = routed,
        )
        return SignedSecureEnvelopeBundle(
            bundle,
            PairingSignature(
                bindings.senderKeyId,
                Base64Url.encode(senderIdentity.sign(signaturePreimage(bundle))),
            ),
        )
    }

    fun open(
        signed: SignedSecureEnvelopeBundle,
        recipientIdentity: CodeverPrivateIdentity,
        senderPublicKey: PairingPublicKey,
        expected: SecureEnvelopeBundleBindings,
        recipientDeviceId: String,
        replayStore: ReplayStore,
        now: Long = System.currentTimeMillis(),
        maxFutureSkewMs: Long = DEFAULT_FUTURE_SKEW_MS,
    ): OpenedSecureEnvelopeBundle {
        val bundle = signed.bundle
        if (
            bundle.gatewayId != expected.gatewayId ||
            bundle.conversationId != expected.conversationId ||
            bundle.direction != expected.direction ||
            bundle.senderDeviceId != expected.senderDeviceId ||
            bundle.senderKeyId != expected.senderKeyId
        ) {
            fail(SecurityErrorCode.BINDING_MISMATCH, "Secure envelope bundle binding is incorrect.")
        }
        if (bundle.expiresAt <= now) fail(SecurityErrorCode.EXPIRED, "Secure envelope bundle has expired.")
        if (bundle.issuedAt > now + maxFutureSkewMs) {
            fail(SecurityErrorCode.ISSUED_IN_FUTURE, "Secure envelope bundle issue time is too far in the future.")
        }
        if (bundle.expiresAt - bundle.issuedAt > MAX_LIFETIME_MS) {
            fail(SecurityErrorCode.LIFETIME_EXCEEDED, "Secure envelope bundle validity window exceeds policy.")
        }
        if (
            signed.signature.keyId != senderPublicKey.keyId ||
            senderPublicKey.keyId != bundle.senderKeyId ||
            !CodeverCrypto.verifyRawEs256(
                CodeverCrypto.importPublicKey(senderPublicKey.publicKey),
                signaturePreimage(bundle),
                Base64Url.decode(signed.signature.value),
            )
        ) {
            fail(SecurityErrorCode.INVALID_SIGNATURE, "Secure envelope bundle signature is invalid.")
        }
        val recipientKeyId = recipientIdentity.publicIdentity.keyId
        val recipient = bundle.recipients.singleOrNull {
            it.recipientDeviceId == recipientDeviceId && it.recipientKeyId == recipientKeyId
        } ?: fail(
            SecurityErrorCode.BINDING_MISMATCH,
            "Secure envelope bundle is not addressed to this device.",
        )
        val wrappingKey = deriveWrappingKey(
            recipientIdentity,
            senderPublicKey,
            bundle,
            recipient.recipientDeviceId,
            recipient.recipientKeyId,
        )
        val contentKey = try {
            aesGcm(
                Cipher.DECRYPT_MODE,
                wrappingKey,
                Base64Url.decode(recipient.nonce),
                CanonicalJson.bytes(buildJsonObject {
                    put("header", bundle.headerJson())
                    put("recipient", buildJsonObject {
                        put("recipientDeviceId", recipient.recipientDeviceId)
                        put("recipientKeyId", recipient.recipientKeyId)
                        put("nonce", recipient.nonce)
                    })
                }),
                Base64Url.decode(recipient.wrappedKey),
            )
        } catch (error: Exception) {
            throw CodeverSecurityException(
                SecurityErrorCode.INVALID_SIGNATURE,
                "Secure envelope bundle authentication failed.",
                error,
            )
        } finally {
            wrappingKey.fill(0)
        }
        val plaintextBytes = try {
            require(contentKey.size == 32)
            aesGcm(
                Cipher.DECRYPT_MODE,
                contentKey,
                Base64Url.decode(bundle.nonce),
                CanonicalJson.bytes(bundle.headerJson()),
                Base64Url.decode(bundle.ciphertext),
            )
        } catch (error: Exception) {
            throw CodeverSecurityException(
                SecurityErrorCode.INVALID_SIGNATURE,
                "Secure envelope bundle authentication failed.",
                error,
            )
        } finally {
            contentKey.fill(0)
        }
        val plaintext = try {
            json.parseToJsonElement(plaintextBytes.toString(Charsets.UTF_8))
        } catch (error: Exception) {
            throw CodeverSecurityException(
                SecurityErrorCode.INVALID_DOCUMENT,
                "Secure envelope bundle plaintext is not valid JSON.",
                error,
            )
        } finally {
            plaintextBytes.fill(0)
        }
        val scope = CanonicalJson.encode(buildJsonArray {
            add(kotlinx.serialization.json.JsonPrimitive(bundle.gatewayId))
            add(kotlinx.serialization.json.JsonPrimitive(bundle.conversationId))
            add(kotlinx.serialization.json.JsonPrimitive(bundle.direction.wireName))
            add(kotlinx.serialization.json.JsonPrimitive(bundle.senderDeviceId))
            add(kotlinx.serialization.json.JsonPrimitive(recipient.recipientDeviceId))
        })
        if (!replayStore.claimAll(
                listOf(
                    ReplayClaim("$scope:bundle:${bundle.envelopeId}", bundle.expiresAt),
                    ReplayClaim("$scope:nonce:${bundle.nonce}", bundle.expiresAt),
                    ReplayClaim("$scope:wrapped-key-nonce:${recipient.nonce}", bundle.expiresAt),
                ),
                now,
            )
        ) {
            fail(SecurityErrorCode.REPLAY, "Secure envelope bundle was already opened.")
        }
        return OpenedSecureEnvelopeBundle(plaintext, bundle)
    }

    private fun deriveWrappingKey(
        ownIdentity: CodeverPrivateIdentity,
        peerPublicKey: PairingPublicKey,
        header: SecureEnvelopeBundle,
        recipientDeviceId: String,
        recipientKeyId: String,
    ): ByteArray {
        val sharedSecret = ownIdentity.agree(CodeverCrypto.importPublicKey(peerPublicKey.publicKey))
        val salt = CodeverCrypto.sha256(CanonicalJson.bytes(buildJsonObject {
            put("domain", KDF_DOMAIN)
            put("gatewayId", header.gatewayId)
            put("senderKeyId", header.senderKeyId)
            put("recipientKeyId", recipientKeyId)
        }))
        val info = CanonicalJson.bytes(buildJsonObject {
            put("contentType", "io.codever.matrix-content.v1")
            put("conversationId", header.conversationId)
            put("direction", header.direction.wireName)
            put("envelopeId", header.envelopeId)
            put("senderDeviceId", header.senderDeviceId)
            put("recipientDeviceId", recipientDeviceId)
        })
        return try {
            CodeverCrypto.hkdfSha256(sharedSecret, salt, info, 32)
        } finally {
            sharedSecret.fill(0)
            salt.fill(0)
            info.fill(0)
        }
    }

    private fun signaturePreimage(bundle: SecureEnvelopeBundle): ByteArray = CanonicalJson.bytes(
        buildJsonObject {
            put("domain", SIGNATURE_DOMAIN)
            put("bundle", bundle.toJson())
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

    private fun fail(code: SecurityErrorCode, message: String): Nothing =
        throw CodeverSecurityException(code, message)
}
