package id.my.anciety.codever.security.codever

import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECPrivateKeySpec
import javax.crypto.KeyAgreement

internal class TestP256Identity private constructor(
    private val keyPair: KeyPair,
) : CodeverPrivateIdentity {
    override val publicIdentity: PairingPublicKey = CodeverCrypto.exportPublicKey(
        keyPair.public as ECPublicKey,
    ).let { PairingPublicKey(CodeverCrypto.publicKeyId(it), it) }

    override fun sign(message: ByteArray): ByteArray = Signature.getInstance("SHA256withECDSA").run {
        initSign(keyPair.private)
        update(message)
        EcdsaSignature.derToRaw(sign())
    }

    override fun agree(peerPublicKey: ECPublicKey): ByteArray = KeyAgreement.getInstance("ECDH").run {
        init(keyPair.private)
        doPhase(peerPublicKey, true)
        generateSecret()
    }

    companion object {
        fun generate(): TestP256Identity {
            val pair = KeyPairGenerator.getInstance("EC").run {
                initialize(ECGenParameterSpec("secp256r1"))
                generateKeyPair()
            }
            return TestP256Identity(pair)
        }

        fun fromPrivateJwk(publicJwk: EcPublicJwk, d: String): TestP256Identity {
            val parameters = AlgorithmParameters.getInstance("EC").apply {
                init(ECGenParameterSpec("secp256r1"))
            }.getParameterSpec(java.security.spec.ECParameterSpec::class.java)
            val privateKey = KeyFactory.getInstance("EC").generatePrivate(
                ECPrivateKeySpec(BigInteger(1, Base64Url.decode(d)), parameters),
            )
            return TestP256Identity(KeyPair(CodeverCrypto.importPublicKey(publicJwk), privateKey))
        }
    }
}
