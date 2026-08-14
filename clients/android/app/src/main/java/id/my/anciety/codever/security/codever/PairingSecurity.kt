package id.my.anciety.codever.security.codever

import java.security.interfaces.ECPublicKey
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

object PairingSecurity {
    private const val DEFAULT_FUTURE_SKEW_MS = 30_000L
    private const val OFFER_LIFETIME_MS = 10 * 60_000L
    private const val REQUEST_LIFETIME_MS = 2 * 60_000L
    private const val REJECTION_LIFETIME_MS = 2 * 60_000L
    private const val CERTIFICATE_LIFETIME_MS = 366L * 24 * 60 * 60_000
    private const val RESPONSE_LIFETIME_MS = CERTIFICATE_LIFETIME_MS

    fun offerDigest(offer: SignedPairingOffer): String =
        CodeverCrypto.sha256Base64Url(CanonicalJson.bytes(offer.toJson()))

    fun requestDigest(request: SignedPairingRequest): String =
        CodeverCrypto.sha256Base64Url(CanonicalJson.bytes(request.toJson()))

    fun verifyOffer(
        signed: SignedPairingOffer,
        pinnedGatewayKey: PairingPublicKey? = null,
        now: Long = System.currentTimeMillis(),
        maxFutureSkewMs: Long = DEFAULT_FUTURE_SKEW_MS,
    ): PairingOffer {
        val embedded = signed.offer.gatewayKey
        if (pinnedGatewayKey != null && pinnedGatewayKey.keyId != embedded.keyId) {
            fail(SecurityErrorCode.KEY_MISMATCH, "Gateway application key does not match the pin.")
        }
        verifyDomainSignature(
            domain = "codever.pairing.offer.v1",
            document = signed.offer.toJson(),
            signature = signed.signature,
            expectedKey = embedded,
            message = "Pairing offer signature is invalid.",
        )
        assertWindow(signed.offer.issuedAt, signed.offer.expiresAt, now, maxFutureSkewMs, OFFER_LIFETIME_MS)
        return signed.offer
    }

    fun signRequest(
        request: PairingRequest,
        offer: SignedPairingOffer,
        identity: CodeverPrivateIdentity,
    ): SignedPairingRequest {
        assertRequestBindings(request, offer)
        if (request.deviceKey.keyId != identity.publicIdentity.keyId) {
            fail(SecurityErrorCode.KEY_MISMATCH, "Pairing request key does not match its signer.")
        }
        val preimage = secretBoundPreimage(
            domain = "codever.pairing.request.v1",
            challenge = offer.offer.challenge,
            document = request.toJson(),
        )
        return SignedPairingRequest(
            request,
            PairingSignature(identity.publicIdentity.keyId, Base64Url.encode(identity.sign(preimage))),
        )
    }

    fun verifyRequest(
        signed: SignedPairingRequest,
        offer: SignedPairingOffer,
        now: Long = System.currentTimeMillis(),
        maxFutureSkewMs: Long = DEFAULT_FUTURE_SKEW_MS,
    ): PairingRequest {
        verifyOffer(offer, now = now, maxFutureSkewMs = maxFutureSkewMs)
        assertRequestBindings(signed.request, offer)
        val key = signed.request.deviceKey
        val valid = signed.signature.keyId == key.keyId && CodeverCrypto.verifyRawEs256(
            CodeverCrypto.importPublicKey(key.publicKey),
            secretBoundPreimage(
                "codever.pairing.request.v1",
                offer.offer.challenge,
                signed.request.toJson(),
            ),
            Base64Url.decode(signed.signature.value),
        )
        if (!valid) fail(SecurityErrorCode.INVALID_SIGNATURE, "Pairing request signature is invalid.")
        assertWindow(
            signed.request.issuedAt,
            signed.request.expiresAt,
            now,
            maxFutureSkewMs,
            REQUEST_LIFETIME_MS,
        )
        return signed.request
    }

    fun consumeOffer(
        offer: SignedPairingOffer,
        request: SignedPairingRequest,
        replayStore: ReplayStore,
        now: Long = System.currentTimeMillis(),
    ): PairingRequest {
        val verified = verifyRequest(request, offer, now)
        val challengeId = CodeverCrypto.sha256Base64Url(offer.offer.challenge.toByteArray())
        val scope = CanonicalJson.encode(
            buildJsonArray {
                add(kotlinx.serialization.json.JsonPrimitive(offer.offer.gatewayId))
                add(kotlinx.serialization.json.JsonPrimitive(offer.offer.offerId))
            },
        )
        if (!replayStore.claimAll(
                listOf(
                    ReplayClaim("$scope:pairing-offer", offer.offer.expiresAt),
                    ReplayClaim("$scope:pairing-challenge:$challengeId", offer.offer.expiresAt),
                ),
                now,
            )
        ) {
            fail(SecurityErrorCode.REPLAY, "Pairing offer has already been consumed.")
        }
        return verified
    }

    fun verifyResponse(
        signed: SignedPairingResponse,
        offer: SignedPairingOffer,
        request: SignedPairingRequest,
        pinnedGatewayKey: PairingPublicKey,
        now: Long = System.currentTimeMillis(),
        maxFutureSkewMs: Long = DEFAULT_FUTURE_SKEW_MS,
    ): PairingResponse {
        verifyOffer(offer, pinnedGatewayKey, offer.offer.issuedAt, maxFutureSkewMs)
        verifyRequest(request, offer, request.request.issuedAt, maxFutureSkewMs)
        val digest = requestDigest(request)
        val response = signed.response
        if (
            response.offerId != offer.offer.offerId ||
            response.requestId != request.request.requestId ||
            response.requestDigest != digest ||
            response.gatewayId != offer.offer.gatewayId ||
            response.certificate.certificate.requestDigest != digest
        ) {
            fail(SecurityErrorCode.BINDING_MISMATCH, "Pairing response is not bound to this handshake.")
        }
        verifyDomainSignature(
            "codever.pairing.response.v1",
            response.toJson(),
            signed.signature,
            pinnedGatewayKey,
            "Pairing response signature is invalid.",
        )
        assertWindow(response.issuedAt, response.expiresAt, now, maxFutureSkewMs, RESPONSE_LIFETIME_MS)
        verifyCertificate(response.certificate, offer, request, pinnedGatewayKey, now, maxFutureSkewMs)
        return response
    }

    fun verifyRejection(
        signed: SignedPairingRejection,
        offer: SignedPairingOffer,
        request: SignedPairingRequest,
        now: Long = System.currentTimeMillis(),
        maxFutureSkewMs: Long = DEFAULT_FUTURE_SKEW_MS,
    ): PairingRejection {
        verifyOffer(offer, offer.offer.gatewayKey, offer.offer.issuedAt, maxFutureSkewMs)
        verifyRequest(request, offer, request.request.issuedAt, maxFutureSkewMs)
        val rejection = signed.rejection
        if (
            rejection.offerId != offer.offer.offerId ||
            rejection.requestId != request.request.requestId ||
            rejection.requestDigest != requestDigest(request) ||
            rejection.gatewayId != offer.offer.gatewayId
        ) {
            fail(SecurityErrorCode.BINDING_MISMATCH, "Pairing rejection is not bound to this handshake.")
        }
        verifyDomainSignature(
            "codever.pairing.rejection.v1",
            rejection.toJson(),
            signed.signature,
            offer.offer.gatewayKey,
            "Pairing rejection signature is invalid.",
        )
        assertWindow(
            rejection.issuedAt,
            rejection.expiresAt,
            now,
            maxFutureSkewMs,
            REJECTION_LIFETIME_MS,
        )
        return rejection
    }

    fun verifyCertificate(
        signed: SignedPairingCertificate,
        offer: SignedPairingOffer,
        request: SignedPairingRequest,
        pinnedGatewayKey: PairingPublicKey,
        now: Long = System.currentTimeMillis(),
        maxFutureSkewMs: Long = DEFAULT_FUTURE_SKEW_MS,
    ): PairingCertificate {
        val certificate = signed.certificate
        if (
            certificate.offerId != offer.offer.offerId ||
            certificate.offerDigest != offerDigest(offer) ||
            certificate.requestId != request.request.requestId ||
            certificate.requestDigest != requestDigest(request) ||
            certificate.gatewayId != offer.offer.gatewayId ||
            certificate.gatewayKeyId != offer.offer.gatewayKey.keyId ||
            certificate.deviceId != request.request.deviceId ||
            certificate.deviceName != request.request.deviceName ||
            certificate.gatewayTransport != offer.offer.gatewayTransport ||
            certificate.deviceKey != request.request.deviceKey ||
            certificate.deviceTransport != request.request.deviceTransport ||
            certificate.allowedOperations.any { it !in request.request.requestedOperations }
        ) {
            fail(SecurityErrorCode.BINDING_MISMATCH, "Pairing certificate is not bound to the handshake.")
        }
        if (pinnedGatewayKey.keyId != offer.offer.gatewayKey.keyId) {
            fail(SecurityErrorCode.KEY_MISMATCH, "Pairing certificate Gateway key does not match the pin.")
        }
        verifyDomainSignature(
            "codever.pairing.certificate.v1",
            certificate.toJson(),
            signed.signature,
            pinnedGatewayKey,
            "Pairing certificate signature is invalid.",
        )
        assertWindow(
            certificate.issuedAt,
            certificate.expiresAt,
            now,
            maxFutureSkewMs,
            CERTIFICATE_LIFETIME_MS,
        )
        return certificate
    }

    private fun assertRequestBindings(request: PairingRequest, offer: SignedPairingOffer) {
        if (
            request.offerId != offer.offer.offerId ||
            request.gatewayId != offer.offer.gatewayId ||
            request.offerDigest != offerDigest(offer) ||
            request.requestedOperations.any { it !in offer.offer.allowedOperations } ||
            request.expiresAt > offer.offer.expiresAt
        ) {
            fail(SecurityErrorCode.BINDING_MISMATCH, "Pairing request is not bound to this offer.")
        }
    }

    private fun verifyDomainSignature(
        domain: String,
        document: JsonObject,
        signature: PairingSignature,
        expectedKey: PairingPublicKey,
        message: String,
    ) {
        val valid = signature.keyId == expectedKey.keyId && CodeverCrypto.verifyRawEs256(
            CodeverCrypto.importPublicKey(expectedKey.publicKey),
            domainPreimage(domain, document),
            Base64Url.decode(signature.value),
        )
        if (!valid) fail(SecurityErrorCode.INVALID_SIGNATURE, message)
    }

    private fun domainPreimage(domain: String, document: JsonObject): ByteArray = CanonicalJson.bytes(
        buildJsonObject {
            put("domain", domain)
            put("document", document)
        },
    )

    private fun secretBoundPreimage(domain: String, challenge: String, document: JsonObject): ByteArray =
        CanonicalJson.bytes(
            buildJsonObject {
                put("challenge", challenge)
                put("document", document)
                put("domain", domain)
            },
        )

    private fun assertWindow(
        issuedAt: Long,
        expiresAt: Long,
        now: Long,
        maxFutureSkewMs: Long,
        maxLifetimeMs: Long,
    ) {
        if (expiresAt <= now) fail(SecurityErrorCode.EXPIRED, "Pairing document has expired.")
        if (issuedAt > now + maxFutureSkewMs) {
            fail(SecurityErrorCode.ISSUED_IN_FUTURE, "Pairing document issue time is too far in the future.")
        }
        if (expiresAt - issuedAt > maxLifetimeMs) {
            fail(SecurityErrorCode.LIFETIME_EXCEEDED, "Pairing document validity window exceeds policy.")
        }
    }

    private fun fail(code: SecurityErrorCode, message: String): Nothing =
        throw CodeverSecurityException(code, message)
}
