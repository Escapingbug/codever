package id.my.anciety.codever.matrix

import java.io.ByteArrayOutputStream
import java.net.URI
import java.net.URL
import java.net.URLEncoder
import javax.net.ssl.HttpsURLConnection
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import org.matrix.rustcomponents.sdk.SlidingSyncVersion

data class MatrixHttpResponse(
    val status: Int,
    val body: ByteArray,
)

fun interface MatrixLoginTransport {
    suspend fun postJson(endpoint: URI, body: ByteArray): MatrixHttpResponse
}

fun interface MatrixLoginTokenTransport {
    suspend fun postJson(
        endpoint: URI,
        accessToken: String,
        body: ByteArray,
    ): MatrixHttpResponse
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

class RestrictedHttpsMatrixLoginTokenTransport(
    private val connectTimeoutMs: Int = 15_000,
    private val readTimeoutMs: Int = 30_000,
) : MatrixLoginTokenTransport {
    override suspend fun postJson(
        endpoint: URI,
        accessToken: String,
        body: ByteArray,
    ): MatrixHttpResponse = withContext(Dispatchers.IO) {
        require(endpoint.scheme == "https" && endpoint.rawUserInfo == null) {
            "Matrix login-token endpoint must use HTTPS."
        }
        require(accessToken.isNotEmpty() && accessToken.length <= 32_768)
        val connection = URL(endpoint.toASCIIString()).openConnection() as HttpsURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.requestMethod = "POST"
            connection.connectTimeout = connectTimeoutMs
            connection.readTimeout = readTimeoutMs
            connection.doOutput = true
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty("Authorization", "Bearer $accessToken")
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
                    require(total <= MAX_RESPONSE_BYTES) {
                        "Matrix login-token response is too large."
                    }
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
                HttpsURLConnection.HTTP_OK -> {
                    val root = Json.parseToJsonElement(
                        response.body.toString(Charsets.UTF_8),
                    ).jsonObject
                    // Matrix returns a custom profile field as
                    // { "<field-name>": <field-value> }. Keep accepting the
                    // unwrapped form for compatible homeserver variants.
                    (root[key] as? JsonObject) ?: root
                }
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

sealed interface MatrixLoginTokenIssueResult {
    data class Ready(
        val loginToken: String,
        val expiresAt: Long,
    ) : MatrixLoginTokenIssueResult {
        override fun toString(): String =
            "MatrixLoginTokenIssueResult.Ready(loginToken=<redacted>, expiresAt=$expiresAt)"
    }

    data class ReauthenticationRequired(
        val passwordSupported: Boolean,
    ) : MatrixLoginTokenIssueResult

    data object Unsupported : MatrixLoginTokenIssueResult
}

class MatrixLoginTokenIssueClient(
    private val transport: MatrixLoginTokenTransport = RestrictedHttpsMatrixLoginTokenTransport(),
    private val now: () -> Long = System::currentTimeMillis,
) {
    suspend fun issue(
        session: StoredMatrixSession,
        password: String? = null,
    ): MatrixLoginTokenIssueResult {
        val homeserver = MatrixIdentifiers.normalizeHomeserver(session.homeserverUrl)
        MatrixIdentifiers.requireUserId(session.userId)
        require(password == null || password.length in 1..4_096) {
            "Matrix reauthentication password is invalid."
        }
        val endpoint = URI("$homeserver/_matrix/client/v1/login/get_token")
        val initial = post(endpoint, session.accessToken, buildJsonObject {})
        if (initial.status in 200..299) return ready(initial.body)
        if (unsupported(initial)) return MatrixLoginTokenIssueResult.Unsupported
        if (rateLimited(initial)) throw rateLimitException(initial.body)
        if (initial.status != HttpsURLConnection.HTTP_UNAUTHORIZED) {
            throw MatrixLoginTokenIssueException(initial.status, retryable(initial.status))
        }

        val authenticationSession = initial.body.string("session", 4_096)
        val passwordSupported = supportsPassword(initial.body)
        if (password == null) {
            return MatrixLoginTokenIssueResult.ReauthenticationRequired(passwordSupported)
        }
        if (authenticationSession == null || !passwordSupported) {
            throw MatrixLoginTokenIssueException(initial.status, retryable = false)
        }
        val completed = post(
            endpoint,
            session.accessToken,
            buildJsonObject {
                put("auth", buildJsonObject {
                    put("type", "m.login.password")
                    put("identifier", buildJsonObject {
                        put("type", "m.id.user")
                        put("user", session.userId)
                    })
                    put("password", password)
                    put("session", authenticationSession)
                })
            },
        )
        if (rateLimited(completed)) throw rateLimitException(completed.body)
        if (completed.status !in 200..299) {
            throw MatrixLoginTokenIssueException(completed.status, retryable(completed.status))
        }
        return ready(completed.body)
    }

    private suspend fun post(
        endpoint: URI,
        accessToken: String,
        body: JsonObject,
    ): ParsedMatrixResponse {
        val requestBytes = body.toString().toByteArray(Charsets.UTF_8)
        val response = try {
            transport.postJson(endpoint, accessToken, requestBytes)
        } finally {
            requestBytes.fill(0)
        }
        return try {
            ParsedMatrixResponse(
                response.status,
                runCatching {
                    if (response.body.isEmpty()) null else Json.parseToJsonElement(
                        response.body.toString(Charsets.UTF_8),
                    ).jsonObject
                }.getOrNull(),
            )
        } finally {
            response.body.fill(0)
        }
    }

    private fun ready(body: JsonObject?): MatrixLoginTokenIssueResult.Ready {
        val loginToken = body.string("login_token", 4_096)
            ?: throw MatrixLoginTokenIssueException(200, retryable = false)
        val expiresInMs = body?.get("expires_in_ms")
            ?.jsonPrimitive
            ?.longOrNull
            ?.takeIf { it > 0 }
            ?.coerceAtMost(MAX_TOKEN_LIFETIME_MS)
            ?: DEFAULT_TOKEN_LIFETIME_MS
        return MatrixLoginTokenIssueResult.Ready(
            loginToken = loginToken,
            expiresAt = Math.addExact(now(), expiresInMs),
        )
    }

    private fun unsupported(response: ParsedMatrixResponse): Boolean =
        response.status == HttpsURLConnection.HTTP_NOT_FOUND ||
            response.status == HttpsURLConnection.HTTP_BAD_METHOD ||
            response.body.string("errcode", 128) == "M_UNRECOGNIZED"

    private fun supportsPassword(body: JsonObject?): Boolean = (body?.get("flows") as? JsonArray)
        ?.any { flow ->
            ((flow as? JsonObject)?.get("stages") as? JsonArray)?.any { stage ->
                (stage as? JsonPrimitive)?.contentOrNull == "m.login.password"
            } == true
        } == true

    private fun rateLimited(response: ParsedMatrixResponse): Boolean =
        response.status == 429 || response.body.string("errcode", 128) == "M_LIMIT_EXCEEDED"

    private fun rateLimitException(body: JsonObject?): MatrixLoginTokenRateLimitException =
        MatrixLoginTokenRateLimitException(
            body?.get("retry_after_ms")
                ?.jsonPrimitive
                ?.longOrNull
                ?.takeIf { it > 0 }
                ?.coerceAtMost(MAX_RETRY_AFTER_MS)
                ?: DEFAULT_RETRY_AFTER_MS,
        )

    private fun retryable(status: Int): Boolean = status == 408 || status >= 500

    private fun JsonObject?.string(key: String, maxLength: Int): String? = this?.get(key)
        ?.jsonPrimitive
        ?.takeIf { it.isString }
        ?.contentOrNull
        ?.takeIf { it.isNotEmpty() && it.length <= maxLength }

    private data class ParsedMatrixResponse(
        val status: Int,
        val body: JsonObject?,
    )

    private companion object {
        const val DEFAULT_TOKEN_LIFETIME_MS = 2 * 60_000L
        const val MAX_TOKEN_LIFETIME_MS = 24 * 60 * 60_000L
        const val DEFAULT_RETRY_AFTER_MS = 60_000L
        const val MAX_RETRY_AFTER_MS = 60 * 60_000L
    }
}

class MatrixLoginTokenIssueException(
    val status: Int,
    val retryable: Boolean,
) : IllegalStateException("Matrix could not create a one-time login token ($status).")

class MatrixLoginTokenRateLimitException(
    val retryAfterMs: Long,
) : IllegalStateException("Matrix is temporarily limiting new-device sign-ins.")

class MatrixLoginException(
    val code: String?,
    val retryable: Boolean,
) : IllegalStateException(
    if (code == null) "Matrix sign-in was not accepted." else "Matrix sign-in failed ($code).",
)
