package id.my.anciety.codever.security.codever

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import javax.crypto.KeyAgreement

/** Private key operations are injectable so protocol tests never depend on AndroidKeyStore. */
interface CodeverPrivateIdentity {
    val publicIdentity: PairingPublicKey

    /** Returns the WebCrypto/JOSE ES256 form: raw r || s, never ASN.1 DER. */
    fun sign(message: ByteArray): ByteArray

    /** Returns the 32-byte P-256 ECDH shared secret. */
    fun agree(peerPublicKey: ECPublicKey): ByteArray
}

class AndroidKeystoreP256Identity(
    private val alias: String = "codever.device.identity.v1",
) : CodeverPrivateIdentity {
    private val keyPair by lazy(::getOrCreateKeyPair)

    override val publicIdentity: PairingPublicKey by lazy {
        val jwk = CodeverCrypto.exportPublicKey(keyPair.public as ECPublicKey)
        PairingPublicKey(keyId = CodeverCrypto.publicKeyId(jwk), publicKey = jwk)
    }

    override fun sign(message: ByteArray): ByteArray = Signature.getInstance("SHA256withECDSA").run {
        initSign(keyPair.private)
        update(message)
        EcdsaSignature.derToRaw(sign())
    }

    override fun agree(peerPublicKey: ECPublicKey): ByteArray {
        check(Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            "Non-exportable Codever ECDH identities require Android 12 or newer."
        }
        return KeyAgreement.getInstance("ECDH").run {
            init(keyPair.private)
            doPhase(peerPublicKey, true)
            generateSecret().also {
                check(it.size == 32) { "AndroidKeyStore returned an invalid P-256 shared secret." }
            }
        }
    }

    private fun getOrCreateKeyPair(): java.security.KeyPair {
        check(Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            "A non-exportable Codever ECDSA/ECDH identity requires Android 12 or newer."
        }
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val existingPrivate = keyStore.getKey(alias, null) as? java.security.PrivateKey
        val existingPublic = keyStore.getCertificate(alias)?.publicKey
        if (existingPrivate != null && existingPublic is ECPublicKey) {
            return java.security.KeyPair(existingPublic, existingPrivate)
        }
        return KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE).run {
            initialize(
                KeyGenParameterSpec.Builder(
                    alias,
                    KeyProperties.PURPOSE_SIGN or
                        KeyProperties.PURPOSE_VERIFY or
                        KeyProperties.PURPOSE_AGREE_KEY,
                )
                    .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    .setUserAuthenticationRequired(false)
                    .build(),
            )
            generateKeyPair()
        }
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
    }
}
