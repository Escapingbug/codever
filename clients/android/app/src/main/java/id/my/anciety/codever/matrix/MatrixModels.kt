package id.my.anciety.codever.matrix

import java.net.URI
import java.security.MessageDigest
import org.matrix.rustcomponents.sdk.Session
import org.matrix.rustcomponents.sdk.SlidingSyncVersion

data class MatrixRoomBinding(
    val roomId: String,
    val gatewayId: String,
    val conversationId: String,
    val gatewayUserId: String,
    val gatewayDeviceId: String,
    val gatewayDeviceEd25519: String,
)

/** The login token is intentionally memory-only and must never be logged or persisted. */
class MatrixBootstrap(
    val homeserver: String,
    val oneTimeLoginToken: String,
    val expectedUserId: String,
    val deviceName: String,
    val roomBinding: MatrixRoomBinding,
) {
    override fun toString(): String =
        "MatrixBootstrap(homeserver=$homeserver, oneTimeLoginToken=<redacted>, " +
            "expectedUserId=$expectedUserId, deviceName=$deviceName, roomBinding=$roomBinding)"
}

class StoredMatrixSession(
    val accessToken: String,
    val refreshToken: String?,
    val userId: String,
    val deviceId: String,
    val homeserverUrl: String,
    val oauthData: String?,
    val slidingSyncVersion: SlidingSyncVersion,
    val roomBinding: MatrixRoomBinding,
) {
    fun toSdkSession(): Session = Session(
        accessToken = accessToken,
        refreshToken = refreshToken,
        userId = userId,
        deviceId = deviceId,
        homeserverUrl = homeserverUrl,
        oauthData = oauthData,
        slidingSyncVersion = slidingSyncVersion,
    )

    override fun toString(): String =
        "StoredMatrixSession(accessToken=<redacted>, refreshToken=" +
            if (refreshToken == null) {
                "null, userId=$userId, deviceId=$deviceId, homeserverUrl=$homeserverUrl, " +
                    "oauthData=${if (oauthData == null) "null" else "<redacted>"}, " +
                    "slidingSyncVersion=$slidingSyncVersion, roomBinding=$roomBinding)"
            } else {
                "<redacted>, userId=$userId, deviceId=$deviceId, homeserverUrl=$homeserverUrl, " +
                    "oauthData=${if (oauthData == null) "null" else "<redacted>"}, " +
                    "slidingSyncVersion=$slidingSyncVersion, roomBinding=$roomBinding)"
            }

    companion object {
        fun fromSdkSession(session: Session, roomBinding: MatrixRoomBinding) = StoredMatrixSession(
            accessToken = session.accessToken,
            refreshToken = session.refreshToken,
            userId = session.userId,
            deviceId = session.deviceId,
            homeserverUrl = session.homeserverUrl,
            oauthData = session.oauthData,
            slidingSyncVersion = session.slidingSyncVersion,
            roomBinding = roomBinding,
        )
    }
}

class PersistedMatrixSecrets(
    val sdkStoreKey: ByteArray,
    val session: StoredMatrixSession,
) {
    override fun toString(): String =
        "PersistedMatrixSecrets(sdkStoreKey=<redacted>, session=$session)"
}

data class PublicMatrixSession(
    val homeserver: String,
    val userId: String,
    val matrixDeviceId: String,
    val roomBinding: MatrixRoomBinding,
)

object MatrixIdentifiers {
    private val matrixUserIdPattern = Regex("^@[^:\\s]+:[^:\\s]+$")
    private val matrixRoomIdPattern = Regex("^![^:\\s]+:[^\\s]+$")
    private val ed25519Pattern = Regex("^[A-Za-z0-9+/]{43}=?$")

    fun normalizeHomeserver(input: String): String {
        require(input.length in 1..2_048) { "homeserver must be a bounded HTTPS URL." }
        val uri = runCatching { URI(input) }.getOrElse {
            throw IllegalArgumentException("homeserver must be an absolute HTTPS URL.")
        }
        require(
            uri.scheme.equals("https", ignoreCase = true) &&
                !uri.host.isNullOrBlank() &&
                uri.rawUserInfo == null &&
                uri.rawQuery == null &&
                uri.rawFragment == null,
        ) { "homeserver must be a credential-free HTTPS URL." }
        val path = uri.rawPath.orEmpty().trimEnd('/')
        return URI("https", null, uri.host.lowercase(), uri.port, path.ifEmpty { null }, null, null)
            .toASCIIString()
    }

    fun requireUserId(value: String, label: String = "userId"): String = value.also {
        require(it.length <= 512 && matrixUserIdPattern.matches(it)) {
            "$label must be a Matrix user id."
        }
    }

    fun validateRoomBinding(binding: MatrixRoomBinding): MatrixRoomBinding = binding.also {
        require(it.roomId.length <= 512 && matrixRoomIdPattern.matches(it.roomId)) {
            "roomBinding.roomId must be a Matrix room id."
        }
        requireOpaque(it.gatewayId, "roomBinding.gatewayId")
        requireOpaque(it.conversationId, "roomBinding.conversationId")
        requireUserId(it.gatewayUserId, "roomBinding.gatewayUserId")
        requireOpaque(it.gatewayDeviceId, "roomBinding.gatewayDeviceId")
        require(ed25519Pattern.matches(it.gatewayDeviceEd25519)) {
            "roomBinding.gatewayDeviceEd25519 must be a Matrix Ed25519 key."
        }
    }

    fun validateBootstrap(input: MatrixBootstrap): MatrixBootstrap = input.also {
        normalizeHomeserver(it.homeserver)
        require(it.oneTimeLoginToken.length in 1..4_096) { "oneTimeLoginToken is invalid." }
        requireUserId(it.expectedUserId, "expectedUserId")
        require(it.deviceName.length in 1..256) { "deviceName is invalid." }
        validateRoomBinding(it.roomBinding)
    }

    fun accountStoreName(homeserver: String, userId: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest("${normalizeHomeserver(homeserver)}\u0000$userId".toByteArray(Charsets.UTF_8))
        return digest.joinToString(separator = "") { byte -> "%02x".format(byte) }
    }

    private fun requireOpaque(value: String, label: String) {
        require(value.isNotBlank() && value.length <= 512) { "$label is invalid." }
    }
}
