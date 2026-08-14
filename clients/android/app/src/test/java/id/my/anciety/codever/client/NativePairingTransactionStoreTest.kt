package id.my.anciety.codever.client

import id.my.anciety.codever.matrix.JvmAesGcmCipher
import id.my.anciety.codever.security.codever.Base64Url
import id.my.anciety.codever.security.codever.CanonicalJson
import id.my.anciety.codever.security.codever.MatrixTransportBinding
import id.my.anciety.codever.security.codever.PairingOffer
import id.my.anciety.codever.security.codever.PairingOperation
import id.my.anciety.codever.security.codever.PairingRequest
import id.my.anciety.codever.security.codever.PairingResponse
import id.my.anciety.codever.security.codever.PairingSecurity
import id.my.anciety.codever.security.codever.PairingSignature
import id.my.anciety.codever.security.codever.PairingCertificate
import id.my.anciety.codever.security.codever.SignedPairingCertificate
import id.my.anciety.codever.security.codever.SignedPairingOffer
import id.my.anciety.codever.security.codever.SignedPairingResponse
import id.my.anciety.codever.security.codever.TestP256Identity
import java.security.SecureRandom
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class NativePairingTransactionStoreTest {
    @Test
    fun `encrypted transaction restores the exact signed request without plaintext leakage`() {
        val transaction = transaction()
        val blob = MemoryPairingBlobStore()
        val store = AtomicEncryptedPairingTransactionStore(blob, JvmAesGcmCipher(), "phone-a")

        store.save(transaction)

        assertEquals(transaction, store.load())
        val raw = blob.value!!.toString(Charsets.ISO_8859_1)
        assertFalse(raw.contains(transaction.offer.offer.challenge))
        assertFalse(raw.contains(transaction.request!!.request.deviceName))
    }

    @Test
    fun `ciphertext is bound to the native application identity scope`() {
        val blob = MemoryPairingBlobStore()
        val cipher = JvmAesGcmCipher()
        AtomicEncryptedPairingTransactionStore(blob, cipher, "phone-a").save(transaction())

        assertThrows(Exception::class.java) {
            AtomicEncryptedPairingTransactionStore(blob, cipher, "phone-b").load()
        }
    }

    @Test
    fun `tampered transaction fails closed and is not silently discarded`() {
        val blob = MemoryPairingBlobStore()
        val store = AtomicEncryptedPairingTransactionStore(blob, JvmAesGcmCipher(), "phone-a")
        store.save(transaction())
        blob.value!![blob.value!!.lastIndex] = (blob.value!!.last().toInt() xor 1).toByte()

        assertThrows(Exception::class.java) { store.load() }
        assertEquals(true, blob.exists())
    }

    @Test
    fun `clear removes an interrupted pairing transaction`() {
        val blob = MemoryPairingBlobStore()
        val store = AtomicEncryptedPairingTransactionStore(blob, JvmAesGcmCipher(), "phone-a")
        store.save(transaction())

        store.clear()

        assertNull(store.load())
    }

    @Test
    fun `received commit proof is durably round tripped before local trust commit`() {
        val requestOnly = transaction()
        val response = signedResponse(requestOnly)
        val transaction = requestOnly.copy(response = response)
        val blob = MemoryPairingBlobStore()
        val store = AtomicEncryptedPairingTransactionStore(blob, JvmAesGcmCipher(), "phone-a")

        store.save(transaction)

        assertEquals(response, store.load()?.response)
    }

    private class MemoryPairingBlobStore : PairingTransactionBlobStore {
        var value: ByteArray? = null
        override fun exists(): Boolean = value != null
        override fun read(): ByteArray = checkNotNull(value).copyOf()
        override fun write(bytes: ByteArray) {
            value = bytes.copyOf()
        }
        override fun clear() {
            value = null
        }
    }

    private fun transaction(): PersistedPairingTransaction {
        val gateway = TestP256Identity.generate()
        val device = TestP256Identity.generate()
        val issuedAt = 1_800_000_000_000L
        val offerDocument = PairingOffer(
            offerId = "offer-one",
            gatewayId = "gateway-one",
            gatewayName = "Gateway",
            gatewayKey = gateway.publicIdentity,
            gatewayTransport = MatrixTransportBinding(
                homeserver = "https://matrix.example.org",
                roomId = "!room:example.org",
                userId = "@gateway:example.org",
                deviceId = "GATEWAY",
                ed25519 = "A".repeat(43),
            ),
            challenge = Base64Url.encode(ByteArray(32).also(SecureRandom()::nextBytes)),
            allowedOperations = listOf(PairingOperation.PROMPT),
            issuedAt = issuedAt,
            expiresAt = issuedAt + 10 * 60_000,
        )
        val offer = SignedPairingOffer(
            offerDocument,
            PairingSignature(
                gateway.publicIdentity.keyId,
                Base64Url.encode(gateway.sign(CanonicalJson.bytes(buildJsonObject {
                    put("domain", "codever.pairing.offer.v1")
                    put("document", offerDocument.toJson())
                }))),
            ),
        )
        val request = PairingRequest(
            requestId = "request-one",
            offerId = offerDocument.offerId,
            offerDigest = PairingSecurity.offerDigest(offer),
            gatewayId = offerDocument.gatewayId,
            deviceId = device.publicIdentity.keyId,
            deviceName = "Private phone name",
            deviceKey = device.publicIdentity,
            deviceTransport = MatrixTransportBinding(
                homeserver = "https://matrix.example.org",
                roomId = "!room:example.org",
                userId = "@phone:example.org",
                deviceId = "PHONE",
                ed25519 = "B".repeat(43),
            ),
            requestedOperations = listOf(PairingOperation.PROMPT),
            issuedAt = issuedAt + 1,
            expiresAt = issuedAt + 2 * 60_000,
        )
        return PersistedPairingTransaction(
            offer,
            PairingSecurity.signRequest(request, offer, device),
            null,
        )
    }

    private fun signedResponse(transaction: PersistedPairingTransaction): SignedPairingResponse {
        // Storage deliberately parses but does not establish authority; the
        // runtime re-verifies the response before trusting it. Reuse the
        // offer's public identity and a syntactically valid signature here to
        // exercise the persistence shape independently from crypto fixtures.
        val request = checkNotNull(transaction.request)
        val offer = transaction.offer.offer
        val certificate = PairingCertificate(
            certificateId = "certificate-one",
            offerId = offer.offerId,
            offerDigest = request.request.offerDigest,
            requestId = request.request.requestId,
            requestDigest = PairingSecurity.requestDigest(request),
            gatewayId = offer.gatewayId,
            gatewayKeyId = offer.gatewayKey.keyId,
            gatewayTransport = offer.gatewayTransport,
            deviceId = request.request.deviceId,
            deviceName = request.request.deviceName,
            deviceKey = request.request.deviceKey,
            deviceTransport = request.request.deviceTransport,
            allowedOperations = request.request.requestedOperations,
            issuedAt = request.request.issuedAt + 1,
            expiresAt = request.request.issuedAt + 60_000,
        )
        val placeholder = PairingSignature(offer.gatewayKey.keyId, "A".repeat(86))
        return SignedPairingResponse(
            PairingResponse(
                offerId = offer.offerId,
                requestId = request.request.requestId,
                requestDigest = PairingSecurity.requestDigest(request),
                gatewayId = offer.gatewayId,
                activeDeviceCount = 1,
                certificate = SignedPairingCertificate(certificate, placeholder),
                issuedAt = request.request.issuedAt + 2,
                expiresAt = certificate.expiresAt,
            ),
            placeholder,
        )
    }
}
