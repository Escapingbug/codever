package id.my.anciety.codever.matrix

import java.io.ByteArrayOutputStream
import java.net.URI
import java.net.URL
import java.net.URLEncoder
import javax.net.ssl.HttpsURLConnection
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.matrix.rustcomponents.sdk.SlidingSyncVersion

data class MatrixHttpResponse(
    val status: Int,
    val body: ByteArray,
)

fun interface MatrixLoginTransport {
    suspend fun postJson(endpoint: URI, body: ByteArray): MatrixHttpResponse
}

fun interface MatrixProfileTransport {
    suspend fun getJson(endpoint: URI, accessToken: String): MatrixHttpResponse
}

class RestrictedHttpsMatrixLoginTransport(
    private val connectTimeoutMs: Int = 15_000,
    private val readTimeoutMs: Int = 30_000,
) : MatrixLoginTransport {
    override suspend fun postJson(endpoint: URI, body: ByteArray): MatrixHttpResponse =
        withContext(Dispatchers.IO) {
            require(endpoint.scheme == "https" && endpoint.rawUserInfo == null) {
                "Matrix login endpoint must use HTTPS."
            }
            val connection = URL(endpoint.toASCIIString()).openConnection() as HttpsURLConnection
            try {
                connection.instanceFollowRedirects = false
                connection.requestMethod = "POST"
                connection.connectTimeout = connectTimeoutMs
                connection.readTimeout = readTimeoutMs
                connection.doOutput = true
                connection.setRequestProperty("Accept", "application/json")
                connection.setRequestProperty("Content-Type", "application/json")
                connection.setFixedLengthStreamingMode(body.size)
                connection.outputStream.use { it.write(body) }
                val status = connection.responseCode
                val input = if (status in 200..299) connection.inputStream else connection.errorStream
                MatrixHttpResponse(status, input?.use { stream ->
                    val output = ByteArrayOutputStream()
                    val buffer = ByteArray(8 * 1024)
                    var total = 0
                    while (true) {
                        val read = stream.read(buffer)
                        if (read < 0) break
                        total += read
                        require(total <= MAX_RESPONSE_BYTES) { "Matrix login response is too large." }
                        output.write(buffer, 0, read)
                    }
                    output.toByteArray()
                } ?: ByteArray(0))
            } finally {
                connection.disconnect()
            }
        }

    private companion object {
        const val MAX_RESPONSE_BYTES = 128 * 1024
    }
}

class RestrictedHttpsMatrixProfileTransport(
    private val connectTimeoutMs: Int = 15_000,
    private val readTimeoutMs: Int = 30_000,
) : MatrixProfileTransport {
    override suspend fun getJson(endpoint: URI, accessToken: String): MatrixHttpResponse =
        withContext(Dispatchers.IO) {
            require(endpoint.scheme == "https" && endpoint.rawUserInfo == null) {
                "Matrix profile endpoint must use HTTPS."
            }
            require(accessToken.isNotEmpty() && accessToken.length <= 32_768)
            val connection = URL(endpoint.toASCIIString()).openConnection() as HttpsURLConnection
            try {
                connection.instanceFollowRedirects = false
                connection.requestMethod = "GET"
                connection.connectTimeout = connectTimeoutMs
                connection.readTimeout = readTimeoutMs
                connection.setRequestProperty("Accept", "application/json")
                connection.setRequestProperty("Authorization", "Bearer $accessToken")
                val status = connection.responseCode
                val input = if (status in 200..299) connection.inputStream else connection.errorStream
                MatrixHttpResponse(status, input?.use { stream ->
                    val output = ByteArrayOutputStream()
                    val buffer = ByteArray(8 * 1024)
                    var total = 0
                    while (true) {
                        val read = stream.read(buffer)
                        if (read < 0) break
                        total += read
                        require(total <= MAX_RESPONSE_BYTES) { "Matrix profile response is too large." }
                        output.write(buffer, 0, read)
                    }
                    output.toByteArray()
                } ?: ByteArray(0))
            } finally {
                connection.disconnect()
            }
        }

    private companion object {
        const val MAX_RESPONSE_BYTES = 256 * 1024
    }
}

class MatrixProfileClient(
    private val transport: MatrixProfileTransport = RestrictedHttpsMatrixProfileTransport(),
) {
    suspend fun get(session: StoredMatrixSession, userId: String, key: String): JsonObject? {
        MatrixIdentifiers.requireUserId(userId)
        require(key.matches(Regex("^[A-Za-z0-9._-]{1,128}$"))) { "Matrix profile key is invalid." }
        val homeserver = MatrixIdentifiers.normalizeHomeserver(session.homeserverUrl)
        val encodedUserId = URLEncoder.encode(userId, Charsets.UTF_8.name()).replace("+", "%20")
        val endpoint = URI("$homeserver/_matrix/client/v3/profile/$encodedUserId/$key")
        val response = transport.getJson(endpoint, session.accessToken)
        return try {
            when (response.status) {
                HttpsURLConnection.HTTP_OK -> Json.parseToJsonElement(
                    response.body.toString(Charsets.UTF_8),
                ).jsonObject
                HttpsURLConnection.HTTP_NOT_FOUND -> null
                else -> throw IllegalStateException("Matrix profile request failed (${response.status}).")
            }
        } finally {
            response.body.fill(0)
        }
    }
}

class MatrixTokenLoginClient(
    private val transport: MatrixLoginTransport = RestrictedHttpsMatrixLoginTransport(),
) {
    suspend fun exchange(bootstrap: MatrixBootstrap): StoredMatrixSession {
        MatrixIdentifiers.validateBootstrap(bootstrap)
        val homeserver = MatrixIdentifiers.normalizeHomeserver(bootstrap.homeserver)
        val endpoint = URI("$homeserver/_matrix/client/v3/login")
        val requestBytes = buildJsonObject {
            put("type", "m.login.token")
            put("token", bootstrap.oneTimeLoginToken)
            put("initial_device_display_name", bootstrap.deviceName)
        }.toString().toByteArray(Charsets.UTF_8)
        val response = try {
            transport.postJson(endpoint, requestBytes)
        } finally {
            requestBytes.fill(0)
        }
        return try {
            parseResponse(response, homeserver, bootstrap.expectedUserId, bootstrap.roomBinding)
        } finally {
            response.body.fill(0)
        }
    }

    internal fun parseResponse(
        response: MatrixHttpResponse,
        homeserver: String,
        expectedUserId: String,
        roomBinding: MatrixRoomBinding,
    ): StoredMatrixSession {
        val body = try {
            if (response.body.isEmpty()) null else Json.parseToJsonElement(
                response.body.toString(Charsets.UTF_8),
            ).jsonObject
        } catch (_: Exception) {
            null
        }
        if (response.status != HttpsURLConnection.HTTP_OK) {
            val errorCode = body?.string("errcode", 128)
                ?.takeIf { MATRIX_ERROR_CODE.matches(it) }
            throw MatrixLoginException(
                code = errorCode,
                retryable = response.status == 408 || response.status == 429 || response.status >= 500,
            )
        }
        requireNotNull(body) { "Matrix login returned an invalid JSON response." }
        val accessToken = body.requiredString("access_token", 32_768)
        val userId = MatrixIdentifiers.requireUserId(body.requiredString("user_id", 512))
        require(userId == expectedUserId) { "Matrix login belongs to a different account." }
        val deviceId = body.requiredString("device_id", 512)
        val refreshToken = body.string("refresh_token", 32_768)
        return StoredMatrixSession(
            accessToken = accessToken,
            refreshToken = refreshToken,
            userId = userId,
            deviceId = deviceId,
            homeserverUrl = homeserver,
            oauthData = null,
            slidingSyncVersion = SlidingSyncVersion.NATIVE,
            roomBinding = MatrixIdentifiers.validateRoomBinding(roomBinding),
        )
    }

    private fun JsonObject.requiredString(key: String, maxLength: Int): String =
        string(key, maxLength)?.takeIf { it.isNotEmpty() }
            ?: throw IllegalArgumentException("Matrix login response is incomplete.")

    private fun JsonObject.string(key: String, maxLength: Int): String? = get(key)
        ?.jsonPrimitive
        ?.takeIf { it.isString }
        ?.contentOrNull
        ?.takeIf { it.length <= maxLength }

    private companion object {
        val MATRIX_ERROR_CODE = Regex("^M_[A-Z0-9_]{1,120}$")
    }
}

class MatrixLoginException(
    val code: String?,
    val retryable: Boolean,
) : IllegalStateException(
    if (code == null) "Matrix sign-in was not accepted." else "Matrix sign-in failed ($code).",
)
