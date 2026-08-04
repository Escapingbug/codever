package id.my.anciety.codever.matrix

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.matrix.rustcomponents.sdk.SlidingSyncVersion

object MatrixSecretCodec {
    private const val SCHEMA_VERSION = 1
    private val json = Json { explicitNulls = true }

    fun encode(value: PersistedMatrixSecrets): ByteArray = buildJsonObject {
        put("schemaVersion", SCHEMA_VERSION)
        put("sdkStoreKeyHex", Hex.encode(value.sdkStoreKey))
        put("session", encodeSession(value.session))
    }.toString().toByteArray(Charsets.UTF_8)

    fun decode(bytes: ByteArray): PersistedMatrixSecrets {
        require(bytes.size <= 256 * 1024) { "Matrix secret payload is too large." }
        val root = json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject
        requireExactKeys(root, setOf("schemaVersion", "sdkStoreKeyHex", "session"))
        require(root.requiredInt("schemaVersion") == SCHEMA_VERSION) {
            "Matrix secret schema is unsupported."
        }
        val storeKey = Hex.decode(root.requiredString("sdkStoreKeyHex"))
        require(storeKey.size == 32) { "Matrix SDK store key is invalid." }
        return PersistedMatrixSecrets(
            sdkStoreKey = storeKey,
            session = decodeSession(root.getValue("session").jsonObject),
        )
    }

    private fun encodeSession(value: StoredMatrixSession): JsonObject = buildJsonObject {
        put("accessToken", value.accessToken)
        put("refreshToken", value.refreshToken?.let(::JsonPrimitive) ?: JsonNull)
        put("userId", value.userId)
        put("deviceId", value.deviceId)
        put("homeserverUrl", value.homeserverUrl)
        put("oauthData", value.oauthData?.let(::JsonPrimitive) ?: JsonNull)
        put("slidingSyncVersion", value.slidingSyncVersion.name)
        put("roomBinding", encodeRoomBinding(value.roomBinding))
    }

    private fun decodeSession(value: JsonObject): StoredMatrixSession {
        requireExactKeys(
            value,
            setOf(
                "accessToken",
                "refreshToken",
                "userId",
                "deviceId",
                "homeserverUrl",
                "oauthData",
                "slidingSyncVersion",
                "roomBinding",
            ),
        )
        val session = StoredMatrixSession(
            accessToken = value.requiredString("accessToken", 32_768),
            refreshToken = value.optionalString("refreshToken", 32_768),
            userId = MatrixIdentifiers.requireUserId(value.requiredString("userId", 512)),
            deviceId = value.requiredString("deviceId", 512),
            homeserverUrl = MatrixIdentifiers.normalizeHomeserver(
                value.requiredString("homeserverUrl", 2_048),
            ),
            oauthData = value.optionalString("oauthData", 64 * 1024),
            slidingSyncVersion = runCatching {
                SlidingSyncVersion.valueOf(value.requiredString("slidingSyncVersion", 16))
            }.getOrElse { throw IllegalArgumentException("Sliding sync version is invalid.") },
            roomBinding = decodeRoomBinding(value.getValue("roomBinding").jsonObject),
        )
        require(
            session.slidingSyncVersion == SlidingSyncVersion.NONE ||
                session.slidingSyncVersion == SlidingSyncVersion.NATIVE,
        ) {
            "Matrix sliding sync version is unsupported."
        }
        return session
    }

    fun encodeRoomBinding(value: MatrixRoomBinding): JsonObject = buildJsonObject {
        put("roomId", value.roomId)
        put("gatewayId", value.gatewayId)
        put("conversationId", value.conversationId)
        put("gatewayUserId", value.gatewayUserId)
        put("gatewayDeviceId", value.gatewayDeviceId)
        put("gatewayDeviceEd25519", value.gatewayDeviceEd25519)
    }

    fun decodeRoomBinding(value: JsonObject): MatrixRoomBinding {
        requireExactKeys(
            value,
            setOf(
                "roomId",
                "gatewayId",
                "conversationId",
                "gatewayUserId",
                "gatewayDeviceId",
                "gatewayDeviceEd25519",
            ),
        )
        return MatrixIdentifiers.validateRoomBinding(
            MatrixRoomBinding(
                roomId = value.requiredString("roomId", 512),
                gatewayId = value.requiredString("gatewayId", 512),
                conversationId = value.requiredString("conversationId", 512),
                gatewayUserId = value.requiredString("gatewayUserId", 512),
                gatewayDeviceId = value.requiredString("gatewayDeviceId", 512),
                gatewayDeviceEd25519 = value.requiredString("gatewayDeviceEd25519", 64),
            ),
        )
    }

    private fun requireExactKeys(value: JsonObject, keys: Set<String>) {
        require(value.keys == keys) { "Matrix secret payload has an invalid shape." }
    }

    private fun JsonObject.requiredString(key: String, maxLength: Int = Int.MAX_VALUE): String =
        get(key)?.stringContent()?.takeIf { it.isNotEmpty() && it.length <= maxLength }
            ?: throw IllegalArgumentException("Matrix secret field $key is invalid.")

    private fun JsonObject.optionalString(key: String, maxLength: Int): String? {
        val element = get(key) ?: throw IllegalArgumentException("Matrix secret field $key is missing.")
        if (element is JsonNull) return null
        return element.stringContent()?.takeIf { it.length <= maxLength }
            ?: throw IllegalArgumentException("Matrix secret field $key is invalid.")
    }

    private fun JsonObject.requiredInt(key: String): Int = get(key)
        ?.jsonPrimitive
        ?.contentOrNull
        ?.toIntOrNull()
        ?: throw IllegalArgumentException("Matrix secret field $key is invalid.")

    private fun JsonElement.stringContent(): String? = runCatching {
        jsonPrimitive.takeIf { it.isString }?.contentOrNull
    }.getOrNull()
}

object Hex {
    private val alphabet = "0123456789abcdef".toCharArray()

    fun encode(bytes: ByteArray): String = CharArray(bytes.size * 2).also { output ->
        bytes.forEachIndexed { index, byte ->
            val value = byte.toInt() and 0xff
            output[index * 2] = alphabet[value ushr 4]
            output[index * 2 + 1] = alphabet[value and 0x0f]
        }
    }.concatToString()

    fun decode(value: String): ByteArray {
        require(value.length % 2 == 0) { "Hex value has an invalid length." }
        return ByteArray(value.length / 2) { index ->
            val high = value[index * 2].digitToIntOrNull(16)
                ?: throw IllegalArgumentException("Hex value is invalid.")
            val low = value[index * 2 + 1].digitToIntOrNull(16)
                ?: throw IllegalArgumentException("Hex value is invalid.")
            ((high shl 4) or low).toByte()
        }
    }
}
