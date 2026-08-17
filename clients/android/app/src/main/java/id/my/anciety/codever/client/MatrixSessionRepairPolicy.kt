package id.my.anciety.codever.client

import id.my.anciety.codever.matrix.MatrixIdentifiers
import id.my.anciety.codever.matrix.PublicMatrixSession
import id.my.anciety.codever.security.codever.GatewayTrust
import id.my.anciety.codever.security.codever.MatrixTransportBinding
import id.my.anciety.codever.security.codever.SignedPairingOffer

/**
 * Distinguishes a missing/replaced Matrix login from a new, untrusted device.
 *
 * The Codever device identity and pinned Gateway key survive this repair. A
 * fresh Matrix login may replace only the device-side transport, and only an
 * invitation from the already pinned Gateway route can authorize that change.
 */
internal object MatrixSessionRepairPolicy {
    fun required(trust: GatewayTrust?, session: PublicMatrixSession?): Boolean {
        return requiredForTransport(trust?.certificate?.deviceTransport, session)
    }

    fun requiredForTransport(
        expected: MatrixTransportBinding?,
        session: PublicMatrixSession?,
    ): Boolean {
        if (expected == null) return false
        if (session == null) return true
        return MatrixIdentifiers.normalizeHomeserver(expected.homeserver) !=
            MatrixIdentifiers.normalizeHomeserver(session.homeserver) ||
            expected.roomId != session.roomBinding.roomId ||
            expected.userId != session.userId ||
            expected.deviceId != session.matrixDeviceId
    }

    fun requirePinnedOffer(trust: GatewayTrust, offer: SignedPairingOffer) {
        require(offer.offer.gatewayId == trust.gatewayId) {
            "Connection repair must use an invitation from the approved Gateway."
        }
        require(offer.offer.gatewayKey.keyId == trust.gatewayKey.keyId) {
            "Connection repair cannot replace the approved Gateway identity."
        }
        require(sameTransport(offer.offer.gatewayTransport, trust.transportTrust.currentTransport)) {
            "Connection repair must use the Gateway's currently approved Matrix route."
        }
    }

    fun requireReplacement(trust: GatewayTrust, replacement: MatrixTransportBinding) {
        val previous = trust.certificate.deviceTransport
        require(
            replacement.deviceId != previous.deviceId || replacement.ed25519 != previous.ed25519,
        ) { "Connection repair must replace the lost Matrix device credentials." }
    }

    private fun sameTransport(left: MatrixTransportBinding, right: MatrixTransportBinding): Boolean =
        MatrixIdentifiers.normalizeHomeserver(left.homeserver) ==
            MatrixIdentifiers.normalizeHomeserver(right.homeserver) &&
            left.roomId == right.roomId &&
            left.userId == right.userId &&
            left.deviceId == right.deviceId &&
            left.ed25519 == right.ed25519
}
