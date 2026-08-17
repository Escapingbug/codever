package id.my.anciety.codever.matrix

import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.net.URLEncoder
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
internal const val CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE =
    "io.codever.gateway.current.v2"
internal const val CODEVER_MATRIX_SESSION_STATE_EVENT_TYPE =
    "io.codever.session.current.v2"

internal fun isCodeverApplicationControlEvent(rawJson: String): Boolean = runCatching {
    val root = Json.parseToJsonElement(rawJson).jsonObject
    val eventType = root["type"]?.jsonPrimitive?.contentOrNull
    val content = root["content"] as? JsonObject ?: return@runCatching false
    when (eventType) {
        CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE,
        CODEVER_MATRIX_SESSION_STATE_EVENT_TYPE ->
            root["state_key"]?.jsonPrimitive?.contentOrNull?.isNotBlank() == true &&
                content["version"]?.jsonPrimitive?.intOrNull == 2 &&
                content["kind"]?.jsonPrimitive?.contentOrNull == "state_envelope" &&
                content["state_envelope"] is JsonObject
        CODEVER_MATRIX_APPLICATION_CONTROL_EVENT_TYPE -> {
            val extension = content["io.codever"] as? JsonObject ?: return@runCatching false
            if (extension["version"]?.jsonPrimitive?.intOrNull != 1) {
                return@runCatching false
            }
            when (extension["kind"]?.jsonPrimitive?.contentOrNull) {
                "secure_envelope" -> extension["secure_envelope"] is JsonObject
                "secure_envelope_bundle" -> extension["secure_envelope_bundle"] is JsonObject
                else -> false
            }
        }
        "m.room.message" -> {
            val extension = content["io.codever"] as? JsonObject ?: return@runCatching false
            extension["version"]?.jsonPrimitive?.intOrNull == 2 &&
                extension["kind"]?.jsonPrimitive?.contentOrNull == "timeline_envelope" &&
                extension["timeline_envelope"] is JsonObject &&
                extension["timeline_key_ring_bundle"] is JsonObject
        }
        else -> false
    }
}.getOrDefault(false)

internal fun isCodeverPairingResponseEvent(rawJson: String): Boolean = runCatching {
    val root = Json.parseToJsonElement(rawJson).jsonObject
    if (root["type"]?.jsonPrimitive?.contentOrNull != "m.room.message") {
        return@runCatching false
    }
    val extension = root["content"]
        ?.jsonObject
        ?.get("io.codever") as? JsonObject ?: return@runCatching false
    extension["version"]?.jsonPrimitive?.intOrNull == 1 &&
        when (extension["kind"]?.jsonPrimitive?.contentOrNull) {
            "pairing_response" -> extension["pairing_response"] is JsonObject
            "pairing_rejection" -> extension["pairing_rejection"] is JsonObject
            else -> false
        }
}.getOrDefault(false)

internal fun codeverApplicationEventKind(rawJson: String): String = runCatching {
    val root = Json.parseToJsonElement(rawJson).jsonObject
    when (root["type"]?.jsonPrimitive?.contentOrNull) {
        CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE -> return@runCatching "gateway_room_state"
        CODEVER_MATRIX_SESSION_STATE_EVENT_TYPE -> return@runCatching "session_room_state"
    }
    val extension = root["content"]
        ?.jsonObject
        ?.get("io.codever")
        ?.jsonObject
    extension
        ?.get("kind")
        ?.jsonPrimitive
        ?.contentOrNull
        ?.takeIf { it.matches(Regex("^[a-z0-9_]{1,64}$")) }
        ?: "unknown"
}.getOrDefault("unknown")

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
        MatrixIdentifiers.requireAllowedEndpoint(endpoint, "Matrix control endpoint")
        require(accessToken.isNotEmpty() && accessToken.length <= 32_768)
        val connection = URL(endpoint.toASCIIString()).openConnection() as HttpURLConnection
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
        MatrixIdentifiers.requireAllowedEndpoint(endpoint, "Matrix control sync endpoint")
        require(accessToken.isNotEmpty() && accessToken.length <= 32_768)
        val connection = URL(endpoint.toASCIIString()).openConnection() as HttpURLConnection
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
    val candidateEventCount: Int,
    val limited: Boolean,
)

data class MatrixApplicationRoomStateBatch(
    val events: List<MatrixDecryptedEvent>,
    val candidateEventCount: Int,
)

data class MatrixThreadHistoryBatch(
    val events: List<MatrixDecryptedEvent>,
    val nextBatch: String?,
)

class MatrixApplicationControlSyncException(
    val status: Int,
    val retryAfterMs: Long?,
) : IllegalStateException("Matrix control sync failed ($status).") {
    val fatal: Boolean get() = status == 401 || status == 403
}

class MatrixApplicationControlPayloadException(message: String) :
    IllegalStateException(message)

/** Reads current replace-in-place Codever state independently of a /sync cursor. */
class MatrixApplicationRoomStateClient(
    private val transport: MatrixApplicationControlSyncTransport =
        RestrictedHttpsMatrixApplicationControlSyncTransport(),
) {
    suspend fun current(session: StoredMatrixSession): MatrixApplicationRoomStateBatch {
        val homeserver = MatrixIdentifiers.normalizeHomeserver(session.homeserverUrl)
        val roomId = MatrixIdentifiers.validateRoomBinding(session.roomBinding).roomId
        val response = transport.getJson(
            URI("$homeserver/_matrix/client/v3/rooms/${encode(roomId)}/state"),
            session.accessToken,
        )
        return try {
            if (response.status !in 200..299) {
                throw MatrixApplicationControlSyncException(
                    response.status,
                    parseMatrixRetryAfterMs(response.body),
                )
            }
            val candidates = runCatching {
                Json.parseToJsonElement(
                    response.body.toString(Charsets.UTF_8),
                ) as? JsonArray
            }.getOrNull() ?: throw MatrixApplicationControlPayloadException(
                "Current Codever Matrix Room State is not an array.",
            )
            val events = candidates
                .mapNotNull { it as? JsonObject }
                .filter { event ->
                    (event["sender"] as? JsonPrimitive)?.contentOrNull ==
                        session.roomBinding.gatewayUserId &&
                        (event["type"] as? JsonPrimitive)?.contentOrNull in setOf(
                            CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE,
                            CODEVER_MATRIX_SESSION_STATE_EVENT_TYPE,
                        )
                }
                .onEach { event ->
                    if (!isCodeverApplicationControlEvent(event.toString())) {
                        throw MatrixApplicationControlPayloadException(
                            "Current Codever Matrix Room State has an invalid envelope shape.",
                        )
                    }
                }
                .sortedBy { event ->
                    when ((event["type"] as? JsonPrimitive)?.contentOrNull) {
                        CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE -> 0
                        CODEVER_MATRIX_SESSION_STATE_EVENT_TYPE -> 1
                        else -> 2
                    }
                }
                .map { event ->
                    matrixApplicationEvent(roomId, event)
                        ?: throw MatrixApplicationControlPayloadException(
                            "Current Codever Matrix Room State has incomplete event metadata.",
                        )
                }
            MatrixApplicationRoomStateBatch(events, candidates.size)
        } finally {
            response.body.fill(0)
        }
    }

    private fun encode(value: String): String =
        URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")
}

/** Pages one session thread without scanning or materializing the room timeline. */
class MatrixThreadHistoryClient(
    private val transport: MatrixApplicationControlSyncTransport =
        RestrictedHttpsMatrixApplicationControlSyncTransport(),
) {
    suspend fun page(
        session: StoredMatrixSession,
        threadRootEventId: String,
        from: String?,
        limit: Int,
    ): MatrixThreadHistoryBatch {
        require(threadRootEventId.isNotBlank() && threadRootEventId.length <= 512)
        require(from == null || (from.isNotBlank() && from.length <= 4_096))
        require(limit in 1..100)
        val homeserver = MatrixIdentifiers.normalizeHomeserver(session.homeserverUrl)
        val roomId = MatrixIdentifiers.validateRoomBinding(session.roomBinding).roomId
        val query = buildList {
            add("dir=b")
            add("limit=$limit")
            add("recurse=true")
            if (from != null) add("from=${encode(from)}")
        }.joinToString("&")
        val response = transport.getJson(
            URI(
                "$homeserver/_matrix/client/v1/rooms/${encode(roomId)}/relations/" +
                    "${encode(threadRootEventId)}/${encode("m.thread")}?$query",
            ),
            session.accessToken,
        )
        return try {
            if (response.status !in 200..299) {
                throw MatrixApplicationControlSyncException(
                    response.status,
                    parseMatrixRetryAfterMs(response.body),
                )
            }
            val root = runCatching {
                Json.parseToJsonElement(
                    response.body.toString(Charsets.UTF_8),
                ) as? JsonObject
            }.getOrNull() ?: throw MatrixApplicationControlPayloadException(
                "Matrix thread history response is not an object.",
            )
            val events = root["chunk"]
                .let { it as? JsonArray }
                .orEmpty()
                .mapNotNull { it as? JsonObject }
                .filter { event ->
                    event["sender"]?.jsonPrimitive?.contentOrNull ==
                        session.roomBinding.gatewayUserId &&
                        isCodeverApplicationControlEvent(event.toString())
                }
                .mapNotNull { event -> matrixApplicationEvent(roomId, event) }
            val nextBatch = root["next_batch"]
                .let { it as? JsonPrimitive }
                ?.contentOrNull
                ?.takeIf { it.isNotBlank() && it.length <= 4_096 }
            MatrixThreadHistoryBatch(events, nextBatch)
        } finally {
            response.body.fill(0)
        }
    }

    private fun encode(value: String): String =
        URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")
}

/**
 * Receives Codever application-encrypted control and standard room-message
 * timeline events without relying on the Matrix UI timeline. `/sync` keeps
 * live state and history responsive even when a UI timeline is rebuilding.
 */
class MatrixApplicationControlSyncClient(
    private val transport: MatrixApplicationControlSyncTransport =
        RestrictedHttpsMatrixApplicationControlSyncTransport(),
) {
    suspend fun sync(
        session: StoredMatrixSession,
        since: String?,
        longPoll: Boolean = true,
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
                put("state", buildJsonObject {
                    put("senders", buildJsonArray {
                        add(JsonPrimitive(session.roomBinding.gatewayUserId))
                    })
                    put("types", buildJsonArray {
                        add(JsonPrimitive(CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE))
                        add(JsonPrimitive(CODEVER_MATRIX_SESSION_STATE_EVENT_TYPE))
                    })
                })
                put("ephemeral", buildJsonObject { put("types", JsonArray(emptyList())) })
                put("account_data", buildJsonObject { put("types", JsonArray(emptyList())) })
                put("timeline", buildJsonObject {
                    put("senders", buildJsonArray {
                        add(JsonPrimitive(session.roomBinding.gatewayUserId))
                    })
                    put("types", buildJsonArray {
                        add(JsonPrimitive(CODEVER_MATRIX_APPLICATION_CONTROL_EVENT_TYPE))
                        add(JsonPrimitive("m.room.message"))
                        // Incremental state changes are carried in the room
                        // timeline when they occur inside the limited window.
                        // The room `state` filter alone only supplies state
                        // needed outside that timeline, so both locations must
                        // admit Codever's authoritative entity events.
                        add(JsonPrimitive(CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE))
                        add(JsonPrimitive(CODEVER_MATRIX_SESSION_STATE_EVENT_TYPE))
                    })
                    put(
                        "limit",
                        if (since == null) INITIAL_TIMELINE_LIMIT else LIVE_TIMELINE_LIMIT,
                    )
                })
            })
        }.toString()
        val query = buildList {
            add("timeout=${if (since == null || !longPoll) 0 else LONG_POLL_TIMEOUT_MS}")
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
            val root = runCatching {
                Json.parseToJsonElement(
                    response.body.toString(Charsets.UTF_8),
                ) as? JsonObject
            }.getOrNull() ?: throw MatrixApplicationControlPayloadException(
                "Matrix control sync response is not an object.",
            )
            val nextBatch = root["next_batch"]
                .let { it as? JsonPrimitive }
                ?.contentOrNull
                ?.takeIf { it.isNotBlank() && it.length <= 4_096 }
                ?: throw MatrixApplicationControlPayloadException(
                    "Matrix control sync response is incomplete.",
                )
            val joinedRoom = (root["rooms"] as? JsonObject)
                ?.get("join")
                .let { it as? JsonObject }
                ?.get(roomId)
                .let { it as? JsonObject }
            val timeline = joinedRoom?.get("timeline")
                .let { it as? JsonObject }
            val limited = timeline
                ?.get("limited")
                .let { it as? JsonPrimitive }
                ?.booleanOrNull
                ?: false
            val stateEvents = joinedRoom
                ?.get("state")
                .let { it as? JsonObject }
                ?.get("events")
                .let { it as? JsonArray }
                .orEmpty()
                .sortedBy { event ->
                    when (
                        ((event as? JsonObject)?.get("type") as? JsonPrimitive)?.contentOrNull
                    ) {
                        CODEVER_MATRIX_GATEWAY_STATE_EVENT_TYPE -> 0
                        CODEVER_MATRIX_SESSION_STATE_EVENT_TYPE -> 1
                        else -> 2
                    }
                }
            val timelineEvents = timeline
                ?.get("events")
                .let { it as? JsonArray }
                .orEmpty()
            val candidateEvents = stateEvents + timelineEvents
            val events = candidateEvents
                .mapNotNull { element ->
                    val event = element as? JsonObject ?: return@mapNotNull null
                    if (!isCodeverApplicationControlEvent(event.toString())) {
                        return@mapNotNull null
                    }
                    matrixApplicationEvent(roomId, event)
                }
            MatrixApplicationControlSyncBatch(
                nextBatch = nextBatch,
                events = events,
                candidateEventCount = candidateEvents.size,
                limited = limited,
            )
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
        const val INITIAL_TIMELINE_LIMIT = 0
        const val LIVE_TIMELINE_LIMIT = 100
        const val LONG_POLL_TIMEOUT_MS = 30_000
        const val MAX_RETRY_AFTER_MS = 60_000L
    }
}

private fun matrixApplicationEvent(roomId: String, event: JsonObject): MatrixDecryptedEvent? {
    val eventId = (event["event_id"] as? JsonPrimitive)?.contentOrNull
        ?.takeIf { it.isNotBlank() && it.length <= 512 }
        ?: return null
    val sender = (event["sender"] as? JsonPrimitive)?.contentOrNull
        ?.takeIf { it.isNotBlank() && it.length <= 512 }
        ?: return null
    val timestamp = (event["origin_server_ts"] as? JsonPrimitive)?.longOrNull
        ?.takeIf { it >= 0 }
        ?: return null
    return MatrixDecryptedEvent(roomId, eventId, sender, timestamp, event.toString())
}

private fun parseMatrixRetryAfterMs(body: ByteArray): Long? = runCatching {
    Json.parseToJsonElement(body.toString(Charsets.UTF_8))
        .jsonObject["retry_after_ms"]
        ?.jsonPrimitive
        ?.longOrNull
        ?.coerceIn(100, 60_000L)
}.getOrNull()

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
