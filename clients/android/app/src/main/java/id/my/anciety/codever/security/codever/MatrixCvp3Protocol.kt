package id.my.anciety.codever.security.codever

import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

const val CVP3_MATRIX_KEY_GRANT_EVENT_TYPE = "io.codever.project.key_grant.v3"
const val CVP3_MATRIX_PROJECT_POINTER_EVENT_TYPE = "io.codever.project.current.v3"
const val CVP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE = "io.codever.workspace.current.v3"

data class MatrixCvp3ProjectKey(
    val keyId: String,
    val key: ByteArray,
    val createdAt: Long,
)

data class MatrixCvp3ProjectKeyGrant(
    val workspaceId: String,
    val projectId: String,
    val roomId: String,
    val deviceId: String,
    val certificateId: String,
    val activeKeyId: String,
    val keys: List<MatrixCvp3ProjectKey>,
) {
    fun activeKey(): MatrixCvp3ProjectKey = keys.single { it.keyId == activeKeyId }

    fun key(keyId: String): MatrixCvp3ProjectKey? = keys.firstOrNull { it.keyId == keyId }

    fun wipe() = keys.forEach { it.key.fill(0) }
}

data class OpenedMatrixCvp3Content(
    val logicalEventId: String,
    val projectId: String,
    val keyId: String,
    val plaintext: JsonObject,
)

/** Cross-language implementation of the CVP/3 project envelope. */
object MatrixCvp3Protocol {
    private const val GRANT_SIGNATURE_DOMAIN =
        "codever.project-key-grant-envelope.signature.v3"
    private const val GRANT_KDF_DOMAIN =
        "codever.project-key-grant-envelope.kdf.v3"
    private val json = Json {
        isLenient = false
        allowSpecialFloatingPointValues = false
    }

    fun openProjectKeyGrant(
        state: JsonObject,
        identity: CodeverPrivateIdentity,
        gatewayKey: PairingPublicKey,
        expectedWorkspaceId: String,
        expectedRoomId: String,
        expectedCertificateId: String,
    ): MatrixCvp3ProjectKeyGrant {
        state.requireExactKeys(
            setOf(
                "kind", "version", "workspaceId", "projectId", "roomId",
                "deviceId", "certificateId", "grantId", "sealedGrant",
            ),
            "CVP/3 project key grant",
        )
        require(state.string("kind") == "project.key_grant")
        require(state.long("version") == 3L)
        val workspaceId = state.opaque("workspaceId")
        val projectId = state.opaque("projectId")
        val roomId = state.opaque("roomId", 512)
        val deviceId = state.opaque("deviceId")
        val certificateId = state.opaque("certificateId")
        val grantId = state.opaque("grantId")
        require(workspaceId == expectedWorkspaceId)
        require(roomId == expectedRoomId)
        require(deviceId == identity.publicIdentity.keyId)
        require(certificateId == expectedCertificateId)

        val signed = state.objectValue("sealedGrant")
        signed.requireExactKeys(setOf("envelope", "signature"), "CVP/3 signed project key grant")
        val envelope = signed.objectValue("envelope")
        envelope.requireExactKeys(
            setOf(
                "kind", "version", "grantId", "workspaceId", "projectId", "roomId",
                "deviceId", "certificateId", "senderKeyId", "recipientKeyId", "nonce",
                "ciphertext",
            ),
            "CVP/3 project key grant envelope",
        )
        require(envelope.string("kind") == "codever.project-key-grant-envelope")
        require(envelope.long("version") == 3L)
        require(envelope.opaque("grantId") == grantId)
        require(envelope.opaque("workspaceId") == workspaceId)
        require(envelope.opaque("projectId") == projectId)
        require(envelope.opaque("roomId", 512) == roomId)
        require(envelope.opaque("deviceId") == deviceId)
        require(envelope.opaque("certificateId") == certificateId)
        require(envelope.string("senderKeyId") == gatewayKey.keyId)
        require(envelope.string("recipientKeyId") == identity.publicIdentity.keyId)
        val nonce = envelope.base64("nonce", 12)
        val ciphertext = envelope.base64("ciphertext", null)
        require(ciphertext.size in 16..(64 * 1024))

        val signature = signed.objectValue("signature")
        verifySignature(
            signature,
            gatewayKey,
            buildJsonObject {
                put("domain", GRANT_SIGNATURE_DOMAIN)
                put("envelope", envelope)
            },
        )
        val shared = identity.agree(CodeverCrypto.importPublicKey(gatewayKey.publicKey))
        val salt = CanonicalJson.bytes(buildJsonObject {
            put("domain", GRANT_KDF_DOMAIN)
            put("workspaceId", workspaceId)
            put("projectId", projectId)
            put("senderKeyId", gatewayKey.keyId)
            put("recipientKeyId", identity.publicIdentity.keyId)
        }).let(MessageDigest.getInstance("SHA-256")::digest)
        val info = CanonicalJson.bytes(buildJsonObject {
            put("roomId", roomId)
            put("deviceId", deviceId)
            put("certificateId", certificateId)
            put("grantId", grantId)
        })
        val key = try {
            CodeverCrypto.hkdfSha256(shared, salt, info, 32)
        } finally {
            shared.fill(0)
            salt.fill(0)
            info.fill(0)
        }
        val plaintext = try {
            decrypt(envelope.without("ciphertext"), nonce, ciphertext, key)
        } finally {
            key.fill(0)
            nonce.fill(0)
            ciphertext.fill(0)
        }
        val value = parseObject(plaintext, "CVP/3 project key grant plaintext")
        plaintext.fill(0)
        return decodeProjectKeyGrant(
            value,
            workspaceId,
            projectId,
            roomId,
            deviceId,
            certificateId,
        )
    }

    fun openContent(
        extension: JsonObject,
        roomId: String,
        projectId: String,
        keys: MatrixCvp3ProjectKeyGrant,
    ): OpenedMatrixCvp3Content {
        extension.requireExactKeys(setOf("version", "envelope"), "CVP/3 Matrix extension")
        require(extension.long("version") == 3L)
        val envelope = extension.objectValue("envelope")
        envelope.requireExactKeys(
            setOf(
                "kind", "version", "roomId", "projectId", "keyId", "logicalEventId",
                "nonce", "ciphertext",
            ),
            "CVP/3 project envelope",
        )
        require(envelope.string("kind") == "codever.project-envelope")
        require(envelope.long("version") == 3L)
        require(envelope.opaque("roomId", 512) == roomId)
        require(envelope.opaque("projectId") == projectId)
        val keyId = envelope.opaque("keyId")
        val projectKey = keys.key(keyId)
            ?: throw CodeverSecurityException(
                SecurityErrorCode.KEY_MISMATCH,
                "The CVP/3 project envelope uses an unavailable project key.",
            )
        val nonce = envelope.base64("nonce", 12)
        val ciphertext = envelope.base64("ciphertext", null)
        require(ciphertext.size in 16..(128 * 1024))
        val plaintext = try {
            decrypt(envelope.without("ciphertext"), nonce, ciphertext, projectKey.key)
        } finally {
            nonce.fill(0)
            ciphertext.fill(0)
        }
        val value = parseObject(plaintext, "CVP/3 project content")
        plaintext.fill(0)
        value.requireExactKeys(setOf("kind", "value"), "CVP/3 project content")
        require(value.string("kind") in setOf("signed_command", "signed_event"))
        return OpenedMatrixCvp3Content(
            logicalEventId = envelope.opaque("logicalEventId"),
            projectId = projectId,
            keyId = keyId,
            plaintext = value,
        )
    }

    fun verifyGatewayEvent(
        signed: JsonObject,
        gatewayKey: PairingPublicKey,
        workspaceId: String,
        projectId: String,
    ): JsonObject {
        signed.requireExactKeys(setOf("event", "signature"), "CVP/3 signed event")
        val event = signed.objectValue("event")
        verifySignature(signed.objectValue("signature"), gatewayKey, event)
        require(event.string("kind") == "codever.event")
        require(event.long("version") == 3L)
        require(event.opaque("workspaceId") == workspaceId)
        event.string("projectId")?.let { require(it == projectId) }
        event.opaque("eventId")
        event.nonnegative("occurredAt")
        event.objectValue("payload")
        return event
    }

    fun verifyDeviceCommand(
        signed: JsonObject,
        deviceKey: PairingPublicKey,
        workspaceId: String,
        projectId: String,
        certificateId: String,
    ): JsonObject {
        signed.requireExactKeys(setOf("command", "signature"), "CVP/3 signed command")
        val command = signed.objectValue("command")
        verifySignature(signed.objectValue("signature"), deviceKey, command)
        require(command.string("kind") == "codever.command")
        require(command.long("version") == 3L)
        require(command.opaque("workspaceId") == workspaceId)
        require(command.opaque("projectId") == projectId)
        require(command.opaque("deviceId") == deviceKey.keyId)
        require(command.opaque("certificateId") == certificateId)
        command.opaque("commandId")
        command.nonnegative("createdAt")
        command.objectValue("payload")
        return command
    }

    fun verifyProjectPointer(
        signed: JsonObject,
        gatewayKey: PairingPublicKey,
        workspaceId: String,
        roomId: String,
    ): JsonObject {
        signed.requireExactKeys(setOf("document", "signature"), "CVP/3 project pointer")
        val document = signed.objectValue("document")
        verifySignature(signed.objectValue("signature"), gatewayKey, document)
        require(document.string("kind") == "project.current")
        require(document.long("version") == 3L)
        require(document.opaque("workspaceId") == workspaceId)
        require(document.opaque("roomId", 512) == roomId)
        document.opaque("projectId")
        document.opaque("eventId", 512)
        document.opaque("logicalEventId")
        document.nonnegative("updatedAt")
        return document
    }

    fun verifyWorkspacePointer(
        signed: JsonObject,
        gatewayKey: PairingPublicKey,
        workspaceId: String,
        roomId: String,
    ): JsonObject {
        signed.requireExactKeys(setOf("document", "signature"), "CVP/3 workspace pointer")
        val document = signed.objectValue("document")
        verifySignature(signed.objectValue("signature"), gatewayKey, document)
        require(document.string("kind") == "workspace.current")
        require(document.long("version") == 3L)
        require(document.opaque("workspaceId") == workspaceId)
        require(document.opaque("roomId", 512) == roomId)
        document.opaque("projectId")
        document.opaque("eventId", 512)
        document.opaque("logicalEventId")
        document.nonnegative("updatedAt")
        return document
    }

    fun sealSignedCommand(
        command: JsonObject,
        identity: CodeverPrivateIdentity,
        roomId: String,
        projectId: String,
        projectKey: MatrixCvp3ProjectKey,
        nonce: ByteArray,
    ): JsonObject {
        require(nonce.size == 12)
        val signature = identity.sign(CanonicalJson.bytes(command))
        val plaintext = buildJsonObject {
            put("kind", "signed_command")
            put("value", buildJsonObject {
                put("command", command)
                put("signature", buildJsonObject {
                    put("algorithm", "ES256")
                    put("keyId", identity.publicIdentity.keyId)
                    put("value", Base64Url.encode(signature))
                })
            })
        }
        signature.fill(0)
        val logicalEventId = command.opaque("commandId")
        val header = buildJsonObject {
            put("kind", "codever.project-envelope")
            put("version", 3)
            put("roomId", roomId)
            put("projectId", projectId)
            put("keyId", projectKey.keyId)
            put("logicalEventId", logicalEventId)
            put("nonce", Base64Url.encode(nonce))
        }
        val plaintextBytes = CanonicalJson.bytes(plaintext)
        val ciphertext = try {
            encrypt(header, nonce, plaintextBytes, projectKey.key)
        } finally {
            plaintextBytes.fill(0)
        }
        return try {
            JsonObject(header + ("ciphertext" to JsonPrimitive(Base64Url.encode(ciphertext))))
        } finally {
            ciphertext.fill(0)
        }
    }

    private fun decodeProjectKeyGrant(
        value: JsonObject,
        workspaceId: String,
        projectId: String,
        roomId: String,
        deviceId: String,
        certificateId: String,
    ): MatrixCvp3ProjectKeyGrant {
        value.requireExactKeys(
            setOf(
                "kind", "version", "workspaceId", "projectId", "roomId", "deviceId",
                "certificateId", "activeKeyId", "keys",
            ),
            "CVP/3 project key grant plaintext",
        )
        require(value.string("kind") == "project.key_grant")
        require(value.long("version") == 3L)
        require(value.opaque("workspaceId") == workspaceId)
        require(value.opaque("projectId") == projectId)
        require(value.opaque("roomId", 512) == roomId)
        require(value.opaque("deviceId") == deviceId)
        require(value.opaque("certificateId") == certificateId)
        val activeKeyId = value.opaque("activeKeyId")
        val values = value["keys"] as? JsonArray
            ?: throw IllegalArgumentException("The CVP/3 project key grant has no keys.")
        require(values.size in 1..64)
        val keys = values.map { element ->
            val key = element as? JsonObject
                ?: throw IllegalArgumentException("A CVP/3 project key is invalid.")
            key.requireExactKeys(setOf("keyId", "key", "createdAt"), "CVP/3 project key")
            MatrixCvp3ProjectKey(
                keyId = key.opaque("keyId"),
                key = key.base64("key", 32),
                createdAt = key.nonnegative("createdAt"),
            )
        }
        require(keys.map { it.keyId }.distinct().size == keys.size)
        require(keys.any { it.keyId == activeKeyId })
        return MatrixCvp3ProjectKeyGrant(
            workspaceId,
            projectId,
            roomId,
            deviceId,
            certificateId,
            activeKeyId,
            keys,
        )
    }

    private fun verifySignature(
        signature: JsonObject,
        expectedKey: PairingPublicKey,
        document: JsonElement,
    ) {
        signature.requireExactKeys(setOf("algorithm", "keyId", "value"), "ES256 signature")
        require(signature.string("algorithm") == "ES256")
        if (signature.string("keyId") != expectedKey.keyId) {
            throw CodeverSecurityException(
                SecurityErrorCode.KEY_MISMATCH,
                "The CVP/3 signature key does not match the paired Gateway.",
            )
        }
        val encoded = signature.string("value")
            ?: throw IllegalArgumentException("The CVP/3 signature is missing.")
        val bytes = Base64Url.decode(encoded)
        val preimage = CanonicalJson.bytes(document)
        val valid = try {
            CodeverCrypto.verifyRawEs256(
                CodeverCrypto.importPublicKey(expectedKey.publicKey),
                preimage,
                bytes,
            )
        } finally {
            bytes.fill(0)
            preimage.fill(0)
        }
        if (!valid) {
            throw CodeverSecurityException(
                SecurityErrorCode.INVALID_SIGNATURE,
                "The CVP/3 Gateway signature is invalid.",
            )
        }
    }

    private fun encrypt(
        header: JsonObject,
        nonce: ByteArray,
        plaintext: ByteArray,
        key: ByteArray,
    ): ByteArray = Cipher.getInstance("AES/GCM/NoPadding").run {
        init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        val aad = CanonicalJson.bytes(header)
        try {
            updateAAD(aad)
            doFinal(plaintext)
        } finally {
            aad.fill(0)
        }
    }

    private fun decrypt(
        header: JsonObject,
        nonce: ByteArray,
        ciphertext: ByteArray,
        key: ByteArray,
    ): ByteArray = try {
        Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
            val aad = CanonicalJson.bytes(header)
            try {
                updateAAD(aad)
                doFinal(ciphertext)
            } finally {
                aad.fill(0)
            }
        }
    } catch (error: Exception) {
        throw CodeverSecurityException(
            SecurityErrorCode.INVALID_SIGNATURE,
            "The CVP/3 project envelope authentication failed.",
            error,
        )
    }

    private fun parseObject(bytes: ByteArray, label: String): JsonObject = try {
        json.parseToJsonElement(bytes.toString(Charsets.UTF_8)) as? JsonObject
            ?: throw IllegalArgumentException("$label is not an object.")
    } catch (error: CodeverSecurityException) {
        throw error
    } catch (error: Exception) {
        throw CodeverSecurityException(
            SecurityErrorCode.INVALID_DOCUMENT,
            "$label is invalid.",
            error,
        )
    }
}

private fun JsonObject.without(key: String): JsonObject = JsonObject(filterKeys { it != key })

private fun JsonObject.string(key: String): String? = (get(key) as? JsonPrimitive)
    ?.takeIf(JsonPrimitive::isString)
    ?.content

private fun JsonObject.long(key: String): Long? = (get(key) as? JsonPrimitive)
    ?.takeUnless(JsonPrimitive::isString)
    ?.longOrNull

private fun JsonObject.opaque(key: String, maximum: Int = 256): String = string(key)?.also {
    require(it.isNotEmpty() && it.length <= maximum && !it.any(Char::isISOControl)) {
        "$key is invalid."
    }
} ?: throw IllegalArgumentException("$key is invalid.")

private fun JsonObject.nonnegative(key: String): Long = long(key)?.also {
    require(it >= 0) { "$key is invalid." }
} ?: throw IllegalArgumentException("$key is invalid.")

private fun JsonObject.objectValue(key: String): JsonObject = get(key) as? JsonObject
    ?: throw IllegalArgumentException("$key is not an object.")

private fun JsonObject.base64(key: String, expectedBytes: Int?): ByteArray {
    val value = string(key) ?: throw IllegalArgumentException("$key is invalid.")
    return Base64Url.decode(value).also { bytes ->
        if (expectedBytes != null) require(bytes.size == expectedBytes) { "$key is invalid." }
    }
}
