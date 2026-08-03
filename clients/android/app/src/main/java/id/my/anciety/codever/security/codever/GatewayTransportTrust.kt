package id.my.anciety.codever.security.codever

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

data class GatewayDeviceRotation(
    val rotationId: String,
    val gatewayId: String,
    val gatewayKeyId: String,
    val previousTransport: MatrixTransportBinding,
    val nextTransport: MatrixTransportBinding,
    val issuedAt: Long,
    val expiresAt: Long,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("kind", "codever.gateway.device-rotation")
        put("version", 1)
        put("rotationId", rotationId)
        put("gatewayId", gatewayId)
        put("gatewayKeyId", gatewayKeyId)
        put("previousTransport", previousTransport.toJson())
        put("nextTransport", nextTransport.toJson())
        put("issuedAt", issuedAt)
        put("expiresAt", expiresAt)
    }
}

data class SignedGatewayDeviceRotation(
    val rotation: GatewayDeviceRotation,
    val signature: PairingSignature,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("rotation", rotation.toJson())
        put("signature", signature.toJson())
    }
}

data class GatewayTransportSnapshot(
    val snapshotId: String,
    val gatewayId: String,
    val gatewayKeyId: String,
    val transport: MatrixTransportBinding,
    val issuedAt: Long,
    val expiresAt: Long,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("kind", "codever.gateway.transport-snapshot")
        put("version", 1)
        put("snapshotId", snapshotId)
        put("gatewayId", gatewayId)
        put("gatewayKeyId", gatewayKeyId)
        put("transport", transport.toJson())
        put("issuedAt", issuedAt)
        put("expiresAt", expiresAt)
    }
}

data class SignedGatewayTransportSnapshot(
    val snapshot: GatewayTransportSnapshot,
    val signature: PairingSignature,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("snapshot", snapshot.toJson())
        put("signature", signature.toJson())
    }
}

object GatewayTransportCodec {
    private const val MAX_BYTES = 256 * 1024
    private val json = Json { isLenient = false; allowSpecialFloatingPointValues = false }

    fun parseRotation(input: String): SignedGatewayDeviceRotation = parseRotation(parseRoot(input))

    fun parseSnapshot(input: String): SignedGatewayTransportSnapshot = parseSnapshot(parseRoot(input))

    internal fun parseRotation(root: JsonObject): SignedGatewayDeviceRotation {
        root.requireExactKeys(setOf("rotation", "signature"), "signed Gateway device rotation")
        val value = root.requiredObject("rotation")
        value.requireExactKeys(
            setOf(
                "kind", "version", "rotationId", "gatewayId", "gatewayKeyId",
                "previousTransport", "nextTransport", "issuedAt", "expiresAt",
            ),
            "Gateway device rotation",
        )
        require(value.requiredString("kind") == "codever.gateway.device-rotation")
        require(value.requiredLong("version") == 1L)
        val issuedAt = value.requiredTimestamp("issuedAt")
        val expiresAt = value.requiredTimestamp("expiresAt")
        require(expiresAt > issuedAt) { "Gateway device rotation lifetime is invalid." }
        val previous = PairingCodec.parseTransport(value.requiredObject("previousTransport"))
        val next = PairingCodec.parseTransport(value.requiredObject("nextTransport"))
        require(sameScope(previous, next)) {
            "Gateway device rotation cannot change homeserver, room, or user identity."
        }
        require(previous.deviceId != next.deviceId || previous.ed25519 != next.ed25519) {
            "Gateway device rotation must replace the device identity."
        }
        return SignedGatewayDeviceRotation(
            GatewayDeviceRotation(
                rotationId = value.requiredOpaqueId("rotationId"),
                gatewayId = value.requiredOpaqueId("gatewayId"),
                gatewayKeyId = value.requiredSha256("gatewayKeyId"),
                previousTransport = previous,
                nextTransport = next,
                issuedAt = issuedAt,
                expiresAt = expiresAt,
            ),
            PairingCodec.parseSignature(root.requiredObject("signature")),
        )
    }

    internal fun parseSnapshot(root: JsonObject): SignedGatewayTransportSnapshot {
        root.requireExactKeys(setOf("snapshot", "signature"), "signed Gateway transport snapshot")
        val value = root.requiredObject("snapshot")
        value.requireExactKeys(
            setOf(
                "kind", "version", "snapshotId", "gatewayId", "gatewayKeyId", "transport",
                "issuedAt", "expiresAt",
            ),
            "Gateway transport snapshot",
        )
        require(value.requiredString("kind") == "codever.gateway.transport-snapshot")
        require(value.requiredLong("version") == 1L)
        val issuedAt = value.requiredTimestamp("issuedAt")
        val expiresAt = value.requiredTimestamp("expiresAt")
        require(expiresAt > issuedAt) { "Gateway transport snapshot lifetime is invalid." }
        return SignedGatewayTransportSnapshot(
            GatewayTransportSnapshot(
                snapshotId = value.requiredOpaqueId("snapshotId"),
                gatewayId = value.requiredOpaqueId("gatewayId"),
                gatewayKeyId = value.requiredSha256("gatewayKeyId"),
                transport = PairingCodec.parseTransport(value.requiredObject("transport")),
                issuedAt = issuedAt,
                expiresAt = expiresAt,
            ),
            PairingCodec.parseSignature(root.requiredObject("signature")),
        )
    }

    private fun parseRoot(input: String): JsonObject {
        require(input.toByteArray(Charsets.UTF_8).size <= MAX_BYTES) {
            "Gateway transport document is too large."
        }
        return try {
            json.parseToJsonElement(input).jsonObject
        } catch (error: Exception) {
            throw IllegalArgumentException("Gateway transport document is invalid.", error)
        }
    }

    internal fun sameScope(left: MatrixTransportBinding, right: MatrixTransportBinding): Boolean =
        left.homeserver == right.homeserver && left.roomId == right.roomId && left.userId == right.userId
}

object GatewayTransportSecurity {
    private const val MAX_LIFETIME_MS = 366L * 24 * 60 * 60_000
    private const val DEFAULT_FUTURE_SKEW_MS = 30_000L

    fun verifyRotation(
        signed: SignedGatewayDeviceRotation,
        pinnedGatewayKey: PairingPublicKey,
        gatewayId: String,
        previousTransport: MatrixTransportBinding,
        issuedAfter: Long? = null,
        now: Long = System.currentTimeMillis(),
        maxFutureSkewMs: Long = DEFAULT_FUTURE_SKEW_MS,
    ): GatewayDeviceRotation {
        val rotation = signed.rotation
        if (rotation.gatewayId != gatewayId || rotation.gatewayKeyId != pinnedGatewayKey.keyId) {
            fail(SecurityErrorCode.BINDING_MISMATCH, "Gateway rotation is not bound to the pinned identity.")
        }
        if (rotation.previousTransport != previousTransport) {
            fail(
                SecurityErrorCode.BINDING_MISMATCH,
                "Gateway rotation does not continue from the pinned Matrix device.",
            )
        }
        if (issuedAfter != null && rotation.issuedAt <= issuedAfter) {
            fail(SecurityErrorCode.REPLAY, "Gateway rotation does not advance the signed rotation chain.")
        }
        verifySignature(
            "codever.gateway.device-rotation.v1",
            rotation.toJson(),
            signed.signature,
            pinnedGatewayKey,
            "Gateway device rotation signature is invalid.",
        )
        assertWindow(rotation.issuedAt, rotation.expiresAt, now, maxFutureSkewMs)
        return rotation
    }

    fun verifySnapshot(
        signed: SignedGatewayTransportSnapshot,
        pinnedGatewayKey: PairingPublicKey,
        gatewayId: String,
        currentTransport: MatrixTransportBinding,
        issuedAfter: Long? = null,
        now: Long = System.currentTimeMillis(),
        maxFutureSkewMs: Long = DEFAULT_FUTURE_SKEW_MS,
    ): GatewayTransportSnapshot {
        val snapshot = signed.snapshot
        if (snapshot.gatewayId != gatewayId || snapshot.gatewayKeyId != pinnedGatewayKey.keyId) {
            fail(
                SecurityErrorCode.BINDING_MISMATCH,
                "Gateway transport snapshot is not bound to the pinned identity.",
            )
        }
        if (!GatewayTransportCodec.sameScope(snapshot.transport, currentTransport)) {
            fail(
                SecurityErrorCode.BINDING_MISMATCH,
                "Gateway transport snapshot changed the pinned Matrix scope.",
            )
        }
        if (issuedAfter != null && snapshot.issuedAt <= issuedAfter) {
            fail(SecurityErrorCode.REPLAY, "Gateway transport snapshot does not advance trusted transport.")
        }
        verifySignature(
            "codever.gateway.transport-snapshot.v1",
            snapshot.toJson(),
            signed.signature,
            pinnedGatewayKey,
            "Gateway transport snapshot signature is invalid.",
        )
        assertWindow(snapshot.issuedAt, snapshot.expiresAt, now, maxFutureSkewMs)
        return snapshot
    }

    private fun verifySignature(
        domain: String,
        document: JsonObject,
        signature: PairingSignature,
        pinnedGatewayKey: PairingPublicKey,
        message: String,
    ) {
        val preimage = CanonicalJson.bytes(
            buildJsonObject {
                put("domain", domain)
                put("document", document)
            },
        )
        val valid = signature.keyId == pinnedGatewayKey.keyId && CodeverCrypto.verifyRawEs256(
            CodeverCrypto.importPublicKey(pinnedGatewayKey.publicKey),
            preimage,
            Base64Url.decode(signature.value),
        )
        if (!valid) fail(SecurityErrorCode.INVALID_SIGNATURE, message)
    }

    private fun assertWindow(
        issuedAt: Long,
        expiresAt: Long,
        now: Long,
        maxFutureSkewMs: Long,
    ) {
        if (expiresAt <= now) fail(SecurityErrorCode.EXPIRED, "Gateway transport document has expired.")
        if (issuedAt > now + maxFutureSkewMs) {
            fail(
                SecurityErrorCode.ISSUED_IN_FUTURE,
                "Gateway transport document issue time is too far in the future.",
            )
        }
        if (expiresAt - issuedAt > MAX_LIFETIME_MS) {
            fail(
                SecurityErrorCode.LIFETIME_EXCEEDED,
                "Gateway transport document validity window exceeds policy.",
            )
        }
    }

    private fun fail(code: SecurityErrorCode, message: String): Nothing =
        throw CodeverSecurityException(code, message)
}

/** Immutable locally trusted cursor; updates occur only after root-signature verification. */
data class GatewayTransportTrustState(
    val gatewayId: String,
    val gatewayKey: PairingPublicKey,
    val currentTransport: MatrixTransportBinding,
    val lastIssuedAt: Long,
) {
    init {
        require(gatewayId.isNotEmpty() && gatewayId.length <= 256)
        require(lastIssuedAt >= 0)
    }

    fun applyRotation(
        signed: SignedGatewayDeviceRotation,
        now: Long = System.currentTimeMillis(),
    ): GatewayTransportTrustState {
        val verified = GatewayTransportSecurity.verifyRotation(
            signed,
            gatewayKey,
            gatewayId,
            currentTransport,
            issuedAfter = lastIssuedAt,
            now = now,
        )
        return copy(currentTransport = verified.nextTransport, lastIssuedAt = verified.issuedAt)
    }

    fun applySnapshot(
        signed: SignedGatewayTransportSnapshot,
        now: Long = System.currentTimeMillis(),
    ): GatewayTransportTrustState {
        val verified = GatewayTransportSecurity.verifySnapshot(
            signed,
            gatewayKey,
            gatewayId,
            currentTransport,
            issuedAfter = lastIssuedAt,
            now = now,
        )
        return copy(currentTransport = verified.transport, lastIssuedAt = verified.issuedAt)
    }

    companion object {
        fun fromPairing(trust: GatewayTrust): GatewayTransportTrustState = GatewayTransportTrustState(
            gatewayId = trust.gatewayId,
            gatewayKey = trust.gatewayKey,
            currentTransport = trust.certificate.gatewayTransport,
            lastIssuedAt = maxOf(trust.offer.offer.issuedAt, trust.certificate.issuedAt),
        )
    }
}
