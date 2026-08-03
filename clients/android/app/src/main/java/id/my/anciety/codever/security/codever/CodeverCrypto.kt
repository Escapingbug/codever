package id.my.anciety.codever.security.codever

import java.math.BigDecimal
import java.nio.charset.StandardCharsets
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.PublicKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

enum class SecurityErrorCode {
    INVALID_SIGNATURE,
    KEY_MISMATCH,
    BINDING_MISMATCH,
    EXPIRED,
    ISSUED_IN_FUTURE,
    LIFETIME_EXCEEDED,
    REPLAY,
    INVALID_DOCUMENT,
}

class CodeverSecurityException(
    val code: SecurityErrorCode,
    message: String,
    cause: Throwable? = null,
) : SecurityException(message, cause)

object Base64Url {
    private val valid = Regex("^[A-Za-z0-9_-]+$")
    private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    private val reverse = IntArray(128) { -1 }.also { table ->
        ALPHABET.forEachIndexed { index, character -> table[character.code] = index }
    }

    fun encode(bytes: ByteArray): String = buildString((bytes.size * 4 + 2) / 3) {
        var offset = 0
        while (offset + 3 <= bytes.size) {
            val value = ((bytes[offset].toInt() and 0xff) shl 16) or
                ((bytes[offset + 1].toInt() and 0xff) shl 8) or
                (bytes[offset + 2].toInt() and 0xff)
            append(ALPHABET[value ushr 18])
            append(ALPHABET[(value ushr 12) and 63])
            append(ALPHABET[(value ushr 6) and 63])
            append(ALPHABET[value and 63])
            offset += 3
        }
        val remaining = bytes.size - offset
        if (remaining == 1) {
            val value = (bytes[offset].toInt() and 0xff) shl 4
            append(ALPHABET[value ushr 6])
            append(ALPHABET[value and 63])
        } else if (remaining == 2) {
            val value = ((bytes[offset].toInt() and 0xff) shl 10) or
                ((bytes[offset + 1].toInt() and 0xff) shl 2)
            append(ALPHABET[value ushr 12])
            append(ALPHABET[(value ushr 6) and 63])
            append(ALPHABET[value and 63])
        }
    }

    fun decode(value: String): ByteArray {
        require(value.isNotEmpty() && valid.matches(value)) { "Invalid base64url value." }
        require(value.length % 4 != 1) { "Invalid base64url value." }
        val output = ByteArray(value.length * 6 / 8)
        var inputOffset = 0
        var outputOffset = 0
        while (inputOffset + 4 <= value.length) {
            val bits = (digit(value[inputOffset]) shl 18) or
                (digit(value[inputOffset + 1]) shl 12) or
                (digit(value[inputOffset + 2]) shl 6) or
                digit(value[inputOffset + 3])
            output[outputOffset++] = (bits ushr 16).toByte()
            output[outputOffset++] = (bits ushr 8).toByte()
            output[outputOffset++] = bits.toByte()
            inputOffset += 4
        }
        when (value.length - inputOffset) {
            2 -> {
                val first = digit(value[inputOffset])
                val second = digit(value[inputOffset + 1])
                require(second and 0x0f == 0) { "Invalid base64url trailing bits." }
                output[outputOffset] = ((first shl 2) or (second ushr 4)).toByte()
            }
            3 -> {
                val first = digit(value[inputOffset])
                val second = digit(value[inputOffset + 1])
                val third = digit(value[inputOffset + 2])
                require(third and 0x03 == 0) { "Invalid base64url trailing bits." }
                output[outputOffset++] = ((first shl 2) or (second ushr 4)).toByte()
                output[outputOffset] = ((second shl 4) or (third ushr 2)).toByte()
            }
        }
        return output
    }

    private fun digit(character: Char): Int = reverse.getOrNull(character.code)?.takeIf { it >= 0 }
        ?: throw IllegalArgumentException("Invalid base64url value.")
}

/** RFC 8785-style canonical JSON used by the TypeScript protocol package. */
object CanonicalJson {
    fun encode(value: JsonElement): String = buildString { appendValue(value) }

    fun bytes(value: JsonElement): ByteArray = encode(value).toByteArray(StandardCharsets.UTF_8)

    private fun StringBuilder.appendValue(value: JsonElement) {
        when (value) {
            JsonNull -> append("null")
            is JsonObject -> {
                append('{')
                value.entries.sortedBy { it.key }.forEachIndexed { index, (key, child) ->
                    if (index > 0) append(',')
                    appendQuoted(key)
                    append(':')
                    appendValue(child)
                }
                append('}')
            }
            is JsonArray -> {
                append('[')
                value.forEachIndexed { index, child ->
                    if (index > 0) append(',')
                    appendValue(child)
                }
                append(']')
            }
            is JsonPrimitive -> when {
                value.isString -> appendQuoted(value.content)
                value.content == "true" || value.content == "false" -> append(value.content)
                else -> append(canonicalNumber(value.content))
            }
        }
    }

    private fun StringBuilder.appendQuoted(value: String) {
        append('"')
        var index = 0
        while (index < value.length) {
            val character = value[index]
            when (character) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\b' -> append("\\b")
                '\u000c' -> append("\\f")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> when {
                    Character.isHighSurrogate(character) &&
                        index + 1 < value.length &&
                        Character.isLowSurrogate(value[index + 1]) -> {
                        append(character)
                        index += 1
                        append(value[index])
                    }
                    character.code < 0x20 || Character.isSurrogate(character) -> {
                        append("\\u")
                        append(character.code.toString(16).padStart(4, '0'))
                    }
                    else -> append(character)
                }
            }
            index += 1
        }
        append('"')
    }

    private fun canonicalNumber(input: String): String {
        val number = input.toDoubleOrNull()
            ?: throw IllegalArgumentException("Canonical JSON contains an invalid number.")
        require(number.isFinite()) { "Canonical JSON cannot encode non-finite numbers." }
        if (number == 0.0) return "0"
        val decimal = BigDecimal(java.lang.Double.toString(number)).stripTrailingZeros()
        val absolute = decimal.abs()
        if (absolute >= BigDecimal("1e21") || absolute < BigDecimal("1e-6")) {
            val digits = decimal.unscaledValue().abs().toString()
            val exponent = digits.length - decimal.scale() - 1
            val sign = if (decimal.signum() < 0) "-" else ""
            val mantissa = if (digits.length == 1) digits else "${digits[0]}.${digits.drop(1)}"
            val exponentSign = if (exponent >= 0) "+" else ""
            return "$sign$mantissa" + "e$exponentSign$exponent"
        }
        return decimal.toPlainString()
    }
}

object CodeverCrypto {
    fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

    fun sha256Base64Url(bytes: ByteArray): String = Base64Url.encode(sha256(bytes))

    fun publicKeyId(key: EcPublicJwk): String = sha256Base64Url(
        CanonicalJson.bytes(
            JsonObject(
                linkedMapOf(
                    "crv" to JsonPrimitive("P-256"),
                    "kty" to JsonPrimitive("EC"),
                    "x" to JsonPrimitive(key.x),
                    "y" to JsonPrimitive(key.y),
                ),
            ),
        ),
    )

    fun importPublicKey(jwk: EcPublicJwk): ECPublicKey {
        jwk.validate()
        val parameters = AlgorithmParameters.getInstance("EC").apply {
            init(ECGenParameterSpec("secp256r1"))
        }.getParameterSpec(java.security.spec.ECParameterSpec::class.java)
        return KeyFactory.getInstance("EC").generatePublic(
            ECPublicKeySpec(
                ECPoint(
                    java.math.BigInteger(1, Base64Url.decode(jwk.x)),
                    java.math.BigInteger(1, Base64Url.decode(jwk.y)),
                ),
                parameters,
            ),
        ) as ECPublicKey
    }

    fun exportPublicKey(key: ECPublicKey): EcPublicJwk = EcPublicJwk(
        x = Base64Url.encode(unsigned32(key.w.affineX.toByteArray())),
        y = Base64Url.encode(unsigned32(key.w.affineY.toByteArray())),
    )

    fun verifyRawEs256(publicKey: PublicKey, message: ByteArray, rawSignature: ByteArray): Boolean {
        if (rawSignature.size != 64) return false
        return Signature.getInstance("SHA256withECDSA").run {
            initVerify(publicKey)
            update(message)
            verify(EcdsaSignature.rawToDer(rawSignature))
        }
    }

    fun hkdfSha256(inputKeyMaterial: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        require(length in 1..(255 * 32)) { "Invalid HKDF output length." }
        val extract = Mac.getInstance("HmacSHA256").run {
            init(SecretKeySpec(salt, "HmacSHA256"))
            doFinal(inputKeyMaterial)
        }
        return try {
            val output = ByteArray(length)
            var previous = ByteArray(0)
            var offset = 0
            var counter = 1
            while (offset < length) {
                previous = Mac.getInstance("HmacSHA256").run {
                    init(SecretKeySpec(extract, "HmacSHA256"))
                    update(previous)
                    update(info)
                    update(counter.toByte())
                    doFinal()
                }
                val copied = minOf(previous.size, length - offset)
                previous.copyInto(output, offset, 0, copied)
                offset += copied
                counter += 1
            }
            previous.fill(0)
            output
        } finally {
            extract.fill(0)
        }
    }

    private fun unsigned32(input: ByteArray): ByteArray {
        val start = input.indexOfFirst { it.toInt() != 0 }.let { if (it < 0) input.lastIndex else it }
        val significant = input.copyOfRange(start, input.size)
        require(significant.size <= 32) { "P-256 coordinate is too large." }
        return ByteArray(32).also { significant.copyInto(it, 32 - significant.size) }
    }
}

object EcdsaSignature {
    fun derToRaw(der: ByteArray): ByteArray {
        require(der.size in 8..72 && der[0] == 0x30.toByte()) { "Invalid DER ECDSA signature." }
        var offset = 1
        val (sequenceLength, afterSequenceLength) = readLength(der, offset)
        offset = afterSequenceLength
        require(offset + sequenceLength == der.size) { "Invalid DER ECDSA signature." }
        val r = readInteger(der, offset)
        offset = r.second
        val s = readInteger(der, offset)
        offset = s.second
        require(offset == der.size) { "Invalid DER ECDSA signature." }
        return ByteArray(64).also {
            copyInteger(r.first, it, 0)
            copyInteger(s.first, it, 32)
        }
    }

    fun rawToDer(raw: ByteArray): ByteArray {
        require(raw.size == 64) { "ES256 signatures must contain 64 raw bytes." }
        val r = encodeInteger(raw.copyOfRange(0, 32))
        val s = encodeInteger(raw.copyOfRange(32, 64))
        val length = r.size + s.size
        return byteArrayOf(0x30, length.toByte()) + r + s
    }

    private fun readInteger(bytes: ByteArray, start: Int): Pair<ByteArray, Int> {
        require(start < bytes.size && bytes[start] == 0x02.toByte()) { "Invalid DER ECDSA signature." }
        val (length, contentStart) = readLength(bytes, start + 1)
        require(length in 1..33 && contentStart + length <= bytes.size) { "Invalid DER ECDSA signature." }
        val value = bytes.copyOfRange(contentStart, contentStart + length)
        require(value[0].toInt() and 0x80 == 0) { "Negative ECDSA integer." }
        require(value.size == 1 || value[0] != 0.toByte() || value[1].toInt() and 0x80 != 0) {
            "Non-minimal ECDSA integer."
        }
        return value to (contentStart + length)
    }

    private fun readLength(bytes: ByteArray, start: Int): Pair<Int, Int> {
        require(start < bytes.size) { "Invalid DER ECDSA signature." }
        val first = bytes[start].toInt() and 0xff
        require(first < 0x80) { "Long DER lengths are not valid for P-256 signatures." }
        return first to (start + 1)
    }

    private fun copyInteger(integer: ByteArray, output: ByteArray, offset: Int) {
        val unsigned = if (integer.size == 33) integer.copyOfRange(1, integer.size) else integer
        require(unsigned.size <= 32) { "ECDSA integer is too large." }
        unsigned.copyInto(output, offset + 32 - unsigned.size)
    }

    private fun encodeInteger(unsigned: ByteArray): ByteArray {
        var start = 0
        while (start < unsigned.lastIndex && unsigned[start] == 0.toByte()) start += 1
        var value = unsigned.copyOfRange(start, unsigned.size)
        if (value[0].toInt() and 0x80 != 0) value = byteArrayOf(0) + value
        return byteArrayOf(0x02, value.size.toByte()) + value
    }
}
