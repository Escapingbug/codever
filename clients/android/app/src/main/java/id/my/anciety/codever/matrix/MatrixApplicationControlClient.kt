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
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

internal const val CODEVER_MATRIX_APPLICATION_CONTROL_EVENT_TYPE =
    "io.codever.secure_control.v1"

internal fun isCodeverApplicationControlEvent(rawJson: String): Boolean = runCatching {
    val root = Json.parseToJsonElement(rawJson).jsonObject
    if (
        root["type"]?.jsonPrimitive?.contentOrNull !=
        CODEVER_MATRIX_APPLICATION_CONTROL_EVENT_TYPE
    ) {
        return@runCatching false
    }
    val content = root["content"] as? JsonObject ?: return@runCatching false
    val extension = content["io.codever"] as? JsonObject ?: return@runCatching false
    if (extension["version"]?.jsonPrimitive?.intOrNull != 1) return@runCatching false
    when (extension["kind"]?.jsonPrimitive?.contentOrNull) {
        "secure_envelope" -> extension["secure_envelope"] is JsonObject
        "secure_envelope_bundle" -> extension["secure_envelope_bundle"] is JsonObject
        else -> false
    }
}.getOrDefault(false)

fun interface MatrixApplicationControlTransport {
    suspend fun putJson(
        endpoint: URI,
        accessToken: String,
        body: ByteArray,
    ): MatrixHttpResponse
}

fun interface MatrixApplicationControlSyncTransport {
    suspend fun getJson(
        endpoint: URI,
        accessToken: String,
    ): MatrixHttpResponse
}

class RestrictedHttpsMatrixApplicationControlTransport(
    private val connectTimeoutMs: Int = 15_000,
    private val readTimeoutMs: Int = 30_000,
) : MatrixApplicationControlTransport {
    override suspend fun putJson(
        endpoint: URI,
        accessToken: String,
        body: ByteArray,
    ): MatrixHttpResponse = withContext(Dispatchers.IO) {
        require(endpoint.scheme == "https" && endpoint.rawUserInfo == null) {
            "Matrix control endpoint must use HTTPS."
        }
        require(accessToken.isNotEmpty() && accessToken.length <= 32_768)
        val connection = URL(endpoint.toASCIIString()).openConnection() as HttpsURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.requestMethod = "PUT"
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
                        "Matrix control response is too large."
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

class RestrictedHttpsMatrixApplicationControlSyncTransport(
    private val connectTimeoutMs: Int = 15_000,
    private val readTimeoutMs: Int = 40_000,
) : MatrixApplicationControlSyncTransport {
    override suspend fun getJson(
        endpoint: URI,
        accessToken: String,
    ): MatrixHttpResponse = withContext(Dispatchers.IO) {
        require(endpoint.scheme == "https" && endpoint.rawUserInfo == null) {
            "Matrix control sync endpoint must use HTTPS."
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
                    require(total <= MAX_RESPONSE_BYTES) {
                        "Matrix control sync response is too large."
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
        const val MAX_RESPONSE_BYTES = 2 * 1024 * 1024
    }
}

data class MatrixApplicationControlSyncBatch(
    val nextBatch: String,
    val events: List<MatrixDecryptedEvent>,
    val limited: Boolean,
)

class MatrixApplicationControlSyncException(
    val status: Int,
    val retryAfterMs: Long?,
) : IllegalStateException("Matrix control sync failed ($status).") {
    val fatal: Boolean get() = status == 401 || status == 403
}

/**
 * Receives Codever's custom application-encrypted event without routing it
 * through the Matrix UI timeline. The Rust timeline intentionally omits
 * unknown plaintext event types, while `/sync` preserves their raw JSON.
 */
class MatrixApplicationControlSyncClient(
    private val transport: MatrixApplicationControlSyncTransport =
        RestrictedHttpsMatrixApplicationControlSyncTransport(),
) {
    suspend fun sync(
        session: StoredMatrixSession,
        since: String?,
    ): MatrixApplicationControlSyncBatch {
        require(since == null || (since.isNotBlank() && since.length <= 4_096)) {
            "Matrix control sync token is invalid."
        }
        val homeserver = MatrixIdentifiers.normalizeHomeserver(session.homeserverUrl)
        val roomId = MatrixIdentifiers.validateRoomBinding(session.roomBinding).roomId
        val filter = buildJsonObject {
            put("presence", buildJsonObject { put("types", JsonArray(emptyList())) })
            put("account_data", buildJsonObject { put("types", JsonArray(emptyList())) })
            put("room", buildJsonObject {
                put("rooms", buildJsonArray { add(JsonPrimitive(roomId)) })
                put("state", buildJsonObject { put("types", JsonArray(emptyList())) })
                put("ephemeral", buildJsonObject { put("types", JsonArray(emptyList())) })
                put("account_data", buildJsonObject { put("types", JsonArray(emptyList())) })
                put("timeline", buildJsonObject {
                    put("senders", buildJsonArray {
                        add(JsonPrimitive(session.roomBinding.gatewayUserId))
                    })
                    put("types", buildJsonArray {
                        add(JsonPrimitive(CODEVER_MATRIX_APPLICATION_CONTROL_EVENT_TYPE))
                    })
                    put(
                        "limit",
                        if (since == null) CATCHUP_TIMELINE_LIMIT else LIVE_TIMELINE_LIMIT,
                    )
                })
            })
        }.toString()
        val query = buildList {
            add("timeout=${if (since == null) 0 else LONG_POLL_TIMEOUT_MS}")
            add("filter=${encode(filter)}")
            if (since != null) add("since=${encode(since)}")
        }.joinToString("&")
        val response = transport.getJson(
            URI("$homeserver/_matrix/client/v3/sync?$query"),
            session.accessToken,
        )
        return try {
            if (response.status !in 200..299) {
                throw MatrixApplicationControlSyncException(
                    response.status,
                    parseRetryAfterMs(response.body),
                )
            }
            val root = Json.parseToJsonElement(
                response.body.toString(Charsets.UTF_8),
            ).jsonObject
            val nextBatch = root["next_batch"]
                ?.jsonPrimitive
                ?.contentOrNull
                ?.takeIf { it.isNotBlank() && it.length <= 4_096 }
                ?: throw IllegalStateException("Matrix control sync response is incomplete.")
            val timeline = root["rooms"]
                ?.jsonObject
                ?.get("join")
                ?.jsonObject
                ?.get(roomId)
                ?.jsonObject
                ?.get("timeline")
                ?.jsonObject
            val limited = timeline
                ?.get("limited")
                ?.jsonPrimitive
                ?.booleanOrNull
                ?: false
            val events = timeline
                ?.get("events")
                ?.jsonArray
                ?.mapNotNull { element ->
                    val event = element as? JsonObject ?: return@mapNotNull null
                    if (!isCodeverApplicationControlEvent(event.toString())) {
                        return@mapNotNull null
                    }
                    val eventId = event["event_id"]?.jsonPrimitive?.contentOrNull
                        ?.takeIf { it.isNotBlank() && it.length <= 512 }
                        ?: return@mapNotNull null
                    val sender = event["sender"]?.jsonPrimitive?.contentOrNull
                        ?.takeIf { it.isNotBlank() && it.length <= 512 }
                        ?: return@mapNotNull null
                    val timestamp = event["origin_server_ts"]?.jsonPrimitive?.longOrNull
                        ?.takeIf { it >= 0 }
                        ?: return@mapNotNull null
                    MatrixDecryptedEvent(
                        roomId = roomId,
                        eventId = eventId,
                        sender = sender,
                        timestamp = timestamp,
                        rawJson = event.toString(),
                    )
                }
                .orEmpty()
            MatrixApplicationControlSyncBatch(nextBatch, events, limited)
        } finally {
            response.body.fill(0)
        }
    }

    private fun parseRetryAfterMs(body: ByteArray): Long? = runCatching {
        Json.parseToJsonElement(body.toString(Charsets.UTF_8))
            .jsonObject["retry_after_ms"]
            ?.jsonPrimitive
            ?.longOrNull
            ?.coerceIn(100, MAX_RETRY_AFTER_MS)
    }.getOrNull()

    private fun encode(value: String): String =
        URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")

    private companion object {
        const val CATCHUP_TIMELINE_LIMIT = 100
        const val LIVE_TIMELINE_LIMIT = 100
        const val LONG_POLL_TIMEOUT_MS = 30_000
        const val MAX_RETRY_AFTER_MS = 60_000L
    }
}

/**
 * Sends an already signed and encrypted Codever envelope as a custom Matrix
 * event. This deliberately bypasses Megolm: confidentiality, authentication
 * and replay protection are provided by the inner Codever secure envelope.
 */
class MatrixApplicationControlClient(
    private val transport: MatrixApplicationControlTransport =
        RestrictedHttpsMatrixApplicationControlTransport(),
) {
    suspend fun send(
        session: StoredMatrixSession,
        contentJson: String,
        transactionId: String,
    ): String {
        require(transactionId.isNotBlank() && transactionId.length <= 512) {
            "Matrix control transaction ID is invalid."
        }
        require(transactionId.none(Char::isISOControl)) {
            "Matrix control transaction ID is invalid."
        }
        val content = Json.parseToJsonElement(contentJson).jsonObject
        requireSecureEnvelope(content)
        val homeserver = MatrixIdentifiers.normalizeHomeserver(session.homeserverUrl)
        val roomId = MatrixIdentifiers.validateRoomBinding(session.roomBinding).roomId
        val endpoint = URI(
            "$homeserver/_matrix/client/v3/rooms/${encode(roomId)}/send/" +
                "${encode(CODEVER_MATRIX_APPLICATION_CONTROL_EVENT_TYPE)}/${encode(transactionId)}",
        )
        val requestBytes = content.toString().toByteArray(Charsets.UTF_8)
        val response = try {
            transport.putJson(endpoint, session.accessToken, requestBytes)
        } finally {
            requestBytes.fill(0)
        }
        return try {
            require(response.status in 200..299) {
                "Matrix control request failed (${response.status})."
            }
            val root = Json.parseToJsonElement(
                response.body.toString(Charsets.UTF_8),
            ).jsonObject
            root["event_id"]
                ?.jsonPrimitive
                ?.takeIf { it.isString }
                ?.contentOrNull
                ?.takeIf { it.isNotBlank() && it.length <= 512 }
                ?: throw IllegalStateException("Matrix control response is incomplete.")
        } finally {
            response.body.fill(0)
        }
    }

    private fun requireSecureEnvelope(content: JsonObject) {
        val extension = content["io.codever"] as? JsonObject
        require(
            extension?.get("version")?.jsonPrimitive?.intOrNull == 1 &&
                extension["kind"]?.jsonPrimitive?.contentOrNull == "secure_envelope" &&
                extension["secure_envelope"] is JsonObject,
        ) {
            "Application control events must contain a Codever secure envelope."
        }
    }

    private fun encode(value: String): String =
        URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")
}
