package id.my.anciety.codever.security.codever

import id.my.anciety.codever.security.SecretCipher
import id.my.anciety.codever.security.SecretEnvelope
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

data class GatewayTrust(
    val offer: SignedPairingOffer,
    val request: SignedPairingRequest,
    val response: SignedPairingResponse,
    val transportTrust: GatewayTransportTrustState = GatewayTransportTrustState(
        gatewayId = offer.offer.gatewayId,
        gatewayKey = offer.offer.gatewayKey,
        currentTransport = response.response.certificate.certificate.gatewayTransport,
        lastIssuedAt = maxOf(
            offer.offer.issuedAt,
            response.response.certificate.certificate.issuedAt,
        ),
    ),
) {
    val gatewayId: String get() = offer.offer.gatewayId
    val gatewayKey: PairingPublicKey get() = offer.offer.gatewayKey
    val certificate: PairingCertificate get() = response.response.certificate.certificate

    fun validate(now: Long = System.currentTimeMillis()): GatewayTrust {
        PairingSecurity.verifyOffer(offer, gatewayKey, offer.offer.issuedAt)
        PairingSecurity.verifyRequest(request, offer, request.request.issuedAt)
        PairingSecurity.verifyCertificate(
            response.response.certificate,
            offer,
            request,
            gatewayKey,
            now,
        )
        require(transportTrust.gatewayId == gatewayId && transportTrust.gatewayKey == gatewayKey)
        require(GatewayTransportCodec.sameScope(
            transportTrust.currentTransport,
            certificate.gatewayTransport,
        ))
        require(transportTrust.lastIssuedAt >= maxOf(offer.offer.issuedAt, certificate.issuedAt))
        return this
    }
}

interface GatewayTrustStore {
    fun load(): GatewayTrust?
    fun save(trust: GatewayTrust)
    fun clear()
}

interface EncryptedTrustBlobStore {
    fun read(): ByteArray?
    fun write(bytes: ByteArray)
    fun clear()
}

/** Persistence adapter; the storage implementation must make write atomic. */
class EncryptedGatewayTrustStore(
    private val blobs: EncryptedTrustBlobStore,
    private val cipher: SecretCipher,
    private val now: () -> Long = System::currentTimeMillis,
) : GatewayTrustStore {
    override fun load(): GatewayTrust? {
        val envelope = blobs.read() ?: return null
        val plaintext = try {
            cipher.decrypt(SecretEnvelope.decode(envelope), ASSOCIATED_DATA)
        } finally {
            envelope.fill(0)
        }
        return try {
            GatewayTrustCodec.decode(plaintext).validate(now())
        } finally {
            plaintext.fill(0)
        }
    }

    override fun save(trust: GatewayTrust) {
        trust.validate(now())
        val plaintext = GatewayTrustCodec.encode(trust)
        val envelope = try {
            SecretEnvelope.encode(cipher.encrypt(plaintext, ASSOCIATED_DATA))
        } finally {
            plaintext.fill(0)
        }
        try {
            blobs.write(envelope)
        } finally {
            envelope.fill(0)
        }
    }

    override fun clear() = blobs.clear()

    private companion object {
        val ASSOCIATED_DATA = "codever.gateway-trust.v1".toByteArray(Charsets.UTF_8)
    }
}

object GatewayTrustCodec {
    private const val MAX_BYTES = 1024 * 1024
    private val json = Json { isLenient = false }

    fun encode(trust: GatewayTrust): ByteArray = CanonicalJson.bytes(
        buildJsonObject {
            put("schemaVersion", 2)
            put("offer", trust.offer.toJson())
            put("request", trust.request.toJson())
            put("response", trust.response.toJson())
            put("transportTrust", buildJsonObject {
                put("currentTransport", trust.transportTrust.currentTransport.toJson())
                put("lastIssuedAt", trust.transportTrust.lastIssuedAt)
            })
        },
    )

    fun decode(bytes: ByteArray): GatewayTrust {
        require(bytes.size <= MAX_BYTES) { "Gateway trust payload is too large." }
        val root = try {
            json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject
        } catch (error: Exception) {
            throw IllegalArgumentException("Gateway trust payload is invalid.", error)
        }
        val schemaVersion = root.requiredLong("schemaVersion")
        require(schemaVersion == 1L || schemaVersion == 2L) { "Gateway trust schema is unsupported." }
        val expectedKeys = if (schemaVersion == 1L) {
            setOf("schemaVersion", "offer", "request", "response")
        } else {
            setOf("schemaVersion", "offer", "request", "response", "transportTrust")
        }
        root.requireExactKeys(expectedKeys, "Gateway trust")
        val trust = GatewayTrust(
            PairingCodec.parseOffer(root.requiredObject("offer")),
            PairingCodec.parseRequest(root.requiredObject("request")),
            PairingCodec.parseResponse(root.requiredObject("response")),
        )
        if (schemaVersion == 1L) return trust
        val transport = root.requiredObject("transportTrust")
        transport.requireExactKeys(setOf("currentTransport", "lastIssuedAt"), "Gateway transport trust")
        return trust.copy(
            transportTrust = GatewayTransportTrustState(
                gatewayId = trust.gatewayId,
                gatewayKey = trust.gatewayKey,
                currentTransport = PairingCodec.parseTransport(transport.requiredObject("currentTransport")),
                lastIssuedAt = transport.requiredLong("lastIssuedAt"),
            ),
        )
    }
}
