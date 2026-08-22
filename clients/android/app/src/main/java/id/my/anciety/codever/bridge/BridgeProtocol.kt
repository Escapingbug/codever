package id.my.anciety.codever.bridge

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.UUID
import id.my.anciety.codever.client.NativeClientRuntime
import id.my.anciety.codever.client.NativePairingRejectedException
import id.my.anciety.codever.client.NativeTrustRequiredException
import id.my.anciety.codever.client.AttachmentChunkConflictException
import id.my.anciety.codever.client.AttachmentHashMismatchException
import id.my.anciety.codever.client.AttachmentTooLargeException
import id.my.anciety.codever.client.AttachmentTransferNotFoundException
import id.my.anciety.codever.client.command.CommandIdempotencyConflictException
import id.my.anciety.codever.client.command.CommandBusyException
import id.my.anciety.codever.client.command.CommandReceipt
import id.my.anciety.codever.client.command.CommandState
import id.my.anciety.codever.client.command.RevisionConflictAction
import id.my.anciety.codever.client.command.UnknownCommandException
import id.my.anciety.codever.client.events.ClientEvent
import id.my.anciety.codever.client.events.ClientEventListener
import id.my.anciety.codever.client.events.ClientSnapshot
import id.my.anciety.codever.client.events.HistoryCursorInvalidException
import id.my.anciety.codever.client.events.HistoryPage
import id.my.anciety.codever.client.events.InvalidSubscriptionCursorException
import id.my.anciety.codever.client.events.PublicClientJson
import id.my.anciety.codever.client.events.PublicTrustState
import id.my.anciety.codever.client.events.SubscriptionBootstrap
import id.my.anciety.codever.client.events.SubscriptionCursorResult
import id.my.anciety.codever.client.events.UnknownSubscriptionException
import id.my.anciety.codever.matrix.MatrixBootstrap
import id.my.anciety.codever.matrix.MatrixIdentifiers
import id.my.anciety.codever.matrix.MatrixLoginException
import id.my.anciety.codever.matrix.MatrixLoginTokenIssueException
import id.my.anciety.codever.matrix.MatrixLoginTokenIssueResult
import id.my.anciety.codever.matrix.MatrixLoginTokenRateLimitException
import id.my.anciety.codever.matrix.MatrixOfflineException
import id.my.anciety.codever.matrix.MatrixRoomBinding
import id.my.anciety.codever.matrix.PublicMatrixSession
import id.my.anciety.codever.security.codever.CodeverSecurityException
import id.my.anciety.codever.security.codever.SecurityErrorCode
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

data class BridgeRequest(
    val id: String,
    val method: String,
    val params: JsonObject,
)

enum class BridgeError(
    val rpcCode: Int,
    val wireName: String,
) {
    PARSE_ERROR(-32700, "PARSE_ERROR"),
    INVALID_REQUEST(-32600, "INVALID_REQUEST"),
    METHOD_NOT_FOUND(-32601, "METHOD_NOT_FOUND"),
    INVALID_PARAMS(-32602, "INVALID_PARAMS"),
    NATIVE_INTERNAL(-32603, "NATIVE_INTERNAL"),
    BRIDGE_NOT_READY(-32001, "BRIDGE_NOT_READY"),
    PROTOCOL_UNSUPPORTED(-32002, "PROTOCOL_UNSUPPORTED"),
    CAPABILITY_UNAVAILABLE(-32003, "CAPABILITY_UNAVAILABLE"),
    UNAUTHORIZED_ORIGIN(-32004, "UNAUTHORIZED_ORIGIN"),
    STALE_WEB_INSTANCE(-32005, "STALE_WEB_INSTANCE"),
    INVALID_STATE(-32010, "INVALID_STATE"),
    IDEMPOTENCY_CONFLICT(-32020, "IDEMPOTENCY_CONFLICT"),
    OPERATION_NOT_FOUND(-32021, "OPERATION_NOT_FOUND"),
    OFFLINE(-32030, "OFFLINE"),
    RATE_LIMITED(-32032, "RATE_LIMITED"),
    TRUST_REQUIRED(-32040, "TRUST_REQUIRED"),
    PAIRING_EXPIRED(-32042, "PAIRING_EXPIRED"),
    PAIRING_REJECTED(-32043, "PAIRING_REJECTED"),
    CURSOR_EXPIRED(-32050, "CURSOR_EXPIRED"),
    HISTORY_CURSOR_INVALID(-32051, "HISTORY_CURSOR_INVALID"),
    TRANSFER_NOT_FOUND(-32060, "TRANSFER_NOT_FOUND"),
    CHUNK_CONFLICT(-32061, "CHUNK_CONFLICT"),
    ATTACHMENT_TOO_LARGE(-32062, "ATTACHMENT_TOO_LARGE"),
    HASH_MISMATCH(-32063, "HASH_MISMATCH"),
}

sealed interface BridgeParseResult {
    data class Valid(val request: BridgeRequest) : BridgeParseResult

    data class Invalid(
        val id: String?,
        val error: BridgeError,
        val message: String,
    ) : BridgeParseResult
}

private class BridgeDispatchException(
    val error: BridgeError,
    override val message: String,
    val retryable: Boolean = false,
    val userAction: String? = null,
) : IllegalArgumentException(message)

class BridgeRuntimeFailure(
    val error: BridgeError,
    override val message: String,
    val retryable: Boolean = false,
    val userAction: String? = null,
) : IllegalStateException(message)

object BridgeProtocol {
    const val VERSION = 1
    const val MAX_MESSAGE_BYTES = 512 * 1024
    const val MAX_JSON_DEPTH = 32
    const val MAX_RPC_ID_LENGTH = 128

    private val json = Json {
        explicitNulls = false
        isLenient = false
    }
    private val fields = setOf("jsonrpc", "id", "method", "params")
    private val methods = setOf(
        "codever.bridge.hello",
        "codever.client.start",
        "codever.client.bootstrap",
        "codever.matrix.loginToken",
        "codever.client.snapshot",
        "codever.client.disconnect",
        "codever.events.subscribe",
        "codever.events.activate",
        "codever.events.ack",
        "codever.events.unsubscribe",
        "codever.command.send",
        "codever.command.cancel",
        "codever.command.recover",
        "codever.command.get",
        "codever.command.release",
        "codever.command.resolveConflict",
        "codever.history.page",
        "codever.attachment.upload.open",
        "codever.attachment.upload.chunk",
        "codever.attachment.upload.finish",
        "codever.attachment.upload.abort",
        "codever.attachment.download.open",
        "codever.attachment.download.read",
        "codever.attachment.download.close",
        "codever.pairing.inspect",
        "codever.pairing.complete",
        "codever.pairing.cancel",
        "codever.trust.get",
    )
    private val rpcIdPattern = Regex("^[A-Za-z0-9._:-]+$")

    fun parse(raw: String): BridgeParseResult {
        if (raw.toByteArray(StandardCharsets.UTF_8).size > MAX_MESSAGE_BYTES) {
            return BridgeParseResult.Invalid(
                null,
                BridgeError.INVALID_REQUEST,
                "JSON-RPC message exceeds the native bridge size limit.",
            )
        }

        val trimmed = raw.trim()
        if (trimmed.firstOrNull()?.isLetter() == true &&
            trimmed != "true" && trimmed != "false" && trimmed != "null"
        ) {
            return BridgeParseResult.Invalid(null, BridgeError.PARSE_ERROR, "Invalid JSON.")
        }

        val value = runCatching { json.parseToJsonElement(raw) }.getOrNull()
            ?: return BridgeParseResult.Invalid(null, BridgeError.PARSE_ERROR, "Invalid JSON.")
        if (!isBoundedJson(value)) {
            return BridgeParseResult.Invalid(
                null,
                BridgeError.INVALID_REQUEST,
                "JSON-RPC message exceeds the native bridge depth or shape limit.",
            )
        }
        val request = runCatching { value.jsonObject }.getOrNull()
            ?: return BridgeParseResult.Invalid(
                null,
                BridgeError.INVALID_REQUEST,
                "JSON-RPC request must be an object.",
            )
        val candidateId = request["id"]
            ?.let(::stringContent)
        if ((request.keys - fields).isNotEmpty()) {
            return BridgeParseResult.Invalid(
                validCandidateId(candidateId),
                BridgeError.INVALID_REQUEST,
                "JSON-RPC request contains unknown fields.",
            )
        }
        if (request["jsonrpc"]?.let(::stringContent) != "2.0") {
            return BridgeParseResult.Invalid(
                validCandidateId(candidateId),
                BridgeError.INVALID_REQUEST,
                "jsonrpc must be exactly '2.0'.",
            )
        }
        val id = validCandidateId(candidateId)
            ?: return BridgeParseResult.Invalid(
                null,
                BridgeError.INVALID_REQUEST,
                "Invalid JSON-RPC id.",
            )
        val method = request["method"]
            ?.let(::stringContent)
            ?.takeIf { it.isNotEmpty() && it.length <= 128 }
            ?: return BridgeParseResult.Invalid(
                id,
                BridgeError.INVALID_REQUEST,
                "method must be a valid string.",
            )
        if (method !in methods) {
            return BridgeParseResult.Invalid(
                id,
                BridgeError.METHOD_NOT_FOUND,
                "Unsupported native bridge method: $method",
            )
        }
        val params = request["params"]
            ?.let { runCatching { it.jsonObject }.getOrNull() }
            ?: return BridgeParseResult.Invalid(
                id,
                BridgeError.INVALID_PARAMS,
                "method params must be an object.",
            )
        return BridgeParseResult.Valid(BridgeRequest(id, method, params))
    }

    fun success(id: String, result: JsonElement): String = buildJsonObject {
        put("jsonrpc", "2.0")
        put("id", id)
        put("result", result)
    }.toString()

    fun failure(
        id: String?,
        error: BridgeError,
        message: String,
        retryable: Boolean = false,
        userAction: String? = null,
        retryAfterMs: Long? = null,
        details: JsonElement? = null,
    ): String = buildJsonObject {
        put("jsonrpc", "2.0")
        put("id", id?.let(::JsonPrimitive) ?: JsonNull)
        put("error", buildJsonObject {
            put("code", error.rpcCode)
            put("message", message)
            put("data", buildJsonObject {
                put("errorCode", error.wireName)
                put("retryable", retryable)
                userAction?.let { put("userAction", it) }
                retryAfterMs?.let { put("retryAfterMs", it) }
                details?.let { put("details", it) }
            })
        })
    }.toString()

    private fun validCandidateId(candidate: String?): String? = candidate
        ?.takeIf { it.isNotEmpty() && it.length <= MAX_RPC_ID_LENGTH && rpcIdPattern.matches(it) }

    private fun stringContent(element: JsonElement): String? = runCatching {
        element.jsonPrimitive.takeIf { it.isString }?.contentOrNull
    }.getOrNull()

    private fun isBoundedJson(element: JsonElement, depth: Int = 0): Boolean {
        if (depth > MAX_JSON_DEPTH) return false
        return when (element) {
            is JsonArray -> element.size <= 10_000 && element.all { isBoundedJson(it, depth + 1) }
            is JsonObject -> element.size <= 10_000 && element.all { (key, value) ->
                key.length <= 1_024 && isBoundedJson(value, depth + 1)
            }
            is JsonPrimitive, JsonNull -> true
        }
    }
}

interface BridgeRuntime {
    val runtimeVersion: String
    val runtimeBuild: String
    val nativeDeviceId: String

    suspend fun client(): NativeClientRuntime

    suspend fun snapshot(): ClientSnapshot

    suspend fun start(): ClientSnapshot

    suspend fun bootstrap(input: MatrixBootstrap): Pair<PublicMatrixSession, ClientSnapshot>

    suspend fun issueMatrixLoginToken(
        invitationId: String,
        password: String?,
    ): MatrixLoginTokenIssueResult = client().issueMatrixLoginToken(invitationId, password)

    suspend fun completePairing(
        pairingId: String,
        deviceName: String,
    ): Pair<PublicTrustState.Trusted, ClientSnapshot>

    suspend fun disconnect(mode: String): ClientSnapshot
}

class BridgeDispatcher(
    private val runtime: BridgeRuntime,
    private val bridgeSessionId: String = UUID.randomUUID().toString(),
    private val eventSink: (String) -> Unit = {},
) {
    private var negotiated = false
    private var negotiatedCapabilities = emptyMap<String, Int>()
    private val mutationMutex = Mutex()
    private val mutationResults = object : LinkedHashMap<String, MutationRecord>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, MutationRecord>?): Boolean =
            size > MAX_IDEMPOTENCY_RECORDS
    }
    private val inFlightMutations = mutableMapOf<String, InFlightMutation>()

    suspend fun dispatch(raw: String): String =
        when (val parsed = BridgeProtocol.parse(raw)) {
            is BridgeParseResult.Invalid -> BridgeProtocol.failure(
                parsed.id,
                parsed.error,
                parsed.message,
            )
            is BridgeParseResult.Valid -> dispatch(parsed.request)
        }

    private suspend fun dispatch(request: BridgeRequest): String = try {
        val result = when (request.method) {
            "codever.bridge.hello" -> hello(request.params)
            "codever.client.start" -> {
                requireContext(request.params, mutation = true)
                mutationResult(request) {
                    val snapshot = runtime.start()
                    buildJsonObject {
                        put("deviceId", runtime.nativeDeviceId)
                        put("snapshot", PublicClientJson.encodeSnapshot(snapshot))
                    }
                }
            }
            "codever.client.bootstrap" -> {
                requireContext(
                    request.params,
                    mutation = true,
                    requiredExtra = setOf(
                        "homeserver",
                        "expectedUserId",
                        "deviceName",
                        "roomBinding",
                    ),
                    optionalExtra = setOf("oneTimeLoginToken", "password"),
                )
                if (MATRIX_BOOTSTRAP_CAPABILITY !in negotiatedCapabilities) {
                    throw BridgeDispatchException(
                        BridgeError.CAPABILITY_UNAVAILABLE,
                        "Matrix session bootstrap was not negotiated.",
                        userAction = "update_native",
                    )
                }
                mutationResult(request) {
                    val bootstrap = parseBootstrap(request.params)
                    val (session, snapshot) = runtime.bootstrap(bootstrap)
                    buildJsonObject {
                        put("deviceId", runtime.nativeDeviceId)
                        put("session", session.toJson())
                        put("snapshot", PublicClientJson.encodeSnapshot(snapshot))
                    }
                }
            }
            "codever.matrix.loginToken" -> {
                requireContext(
                    request.params,
                    mutation = true,
                    requiredExtra = setOf("invitationId"),
                    optionalExtra = setOf("password"),
                )
                if (MATRIX_LOGIN_TOKEN_CAPABILITY !in negotiatedCapabilities) {
                    throw BridgeDispatchException(
                        BridgeError.CAPABILITY_UNAVAILABLE,
                        "Matrix login-token issuance was not negotiated.",
                        userAction = "update_native",
                    )
                }
                mutationResult(request) {
                    matrixLoginTokenResultToJson(
                        runtime.issueMatrixLoginToken(
                            requiredString(request.params, "invitationId", 512),
                            optionalString(request.params, "password", 4_096),
                        ),
                    )
                }
            }
            "codever.client.snapshot" -> {
                requireContext(request.params, mutation = false)
                PublicClientJson.encodeSnapshot(runtime.snapshot())
            }
            "codever.client.disconnect" -> {
                requireContext(request.params, mutation = true, requiredExtra = setOf("mode"))
                val mode = requiredString(request.params, "mode", 16)
                if (mode != "stop" && mode != "revoke") invalidParams("mode has an unsupported value.")
                mutationResult(request) {
                    buildJsonObject {
                        put("mode", mode)
                        put("snapshot", PublicClientJson.encodeSnapshot(runtime.disconnect(mode)))
                    }
                }
            }
            "codever.events.subscribe" -> {
                requireContext(
                    request.params,
                    mutation = false,
                    optionalExtra = setOf("afterCursor", "maxReplayEvents"),
                )
                var subscriptionId: String? = null
                val listener = object : ClientEventListener {
                    override fun onEvents(events: List<ClientEvent>) = notifyEvents(
                        subscriptionId ?: throw IllegalStateException("Event subscription is not initialized."),
                        events,
                    )
                    override fun onCursorExpired(snapshot: ClientSnapshot) = Unit
                }
                var subscribed = runtime.client().subscribe(
                    optionalString(request.params, "afterCursor", 512),
                    optionalInt(request.params, "maxReplayEvents") ?: 1_000,
                    listener,
                )
                var response = subscriptionToJson(subscribed)
                if (response.toString().toByteArray(Charsets.UTF_8).size > MAX_RPC_RESULT_BYTES) {
                    runtime.client().unsubscribe(subscribed.subscriptionId)
                    subscribed = runtime.client().subscribe(
                        afterCursor = null,
                        maxReplayEvents = optionalInt(request.params, "maxReplayEvents") ?: 1_000,
                        listener = listener,
                    )
                    response = subscriptionToJson(subscribed)
                }
                subscriptionId = subscribed.subscriptionId
                response
            }
            "codever.events.activate" -> {
                requireContext(
                    request.params,
                    mutation = false,
                    requiredExtra = setOf("subscriptionId", "throughCursor"),
                )
                cursorResultToJson(runtime.client().activate(
                    requiredString(request.params, "subscriptionId", 512),
                    requiredString(request.params, "throughCursor", 512),
                ))
            }
            "codever.events.ack" -> {
                requireContext(
                    request.params,
                    mutation = false,
                    requiredExtra = setOf("subscriptionId", "throughCursor"),
                )
                cursorResultToJson(runtime.client().acknowledge(
                    requiredString(request.params, "subscriptionId", 512),
                    requiredString(request.params, "throughCursor", 512),
                ))
            }
            "codever.events.unsubscribe" -> {
                requireContext(
                    request.params,
                    mutation = false,
                    requiredExtra = setOf("subscriptionId"),
                )
                val id = requiredString(request.params, "subscriptionId", 512)
                runtime.client().unsubscribe(id)
                buildJsonObject { put("subscriptionId", id); put("unsubscribed", true) }
            }
            "codever.command.send" -> {
                requireContext(request.params, true, requiredExtra = setOf("payload"))
                mutationResult(request) {
                    commandReceiptToJson(runtime.client().sendCommand(
                        requiredString(request.params, "idempotencyKey", 64),
                        requiredObject(request.params, "payload"),
                    ))
                }
            }
            "codever.command.cancel" -> {
                requireContext(
                    request.params,
                    true,
                    requiredExtra = setOf("sessionId"),
                    optionalExtra = setOf("targetCommandId"),
                )
                mutationResult(request) {
                    commandReceiptToJson(runtime.client().cancelCommand(
                        requiredString(request.params, "idempotencyKey", 64),
                        requiredString(request.params, "sessionId", 512),
                        optionalString(request.params, "targetCommandId", 512),
                    ))
                }
            }
            "codever.command.recover" -> {
                requireContext(request.params, true, requiredExtra = setOf("commandId"))
                mutationResult(request) {
                    commandReceiptToJson(runtime.client().recoverCommand(
                        requiredString(request.params, "commandId", 512),
                    ))
                }
            }
            "codever.command.get" -> {
                requireContext(request.params, false, requiredExtra = setOf("commandId"))
                PublicClientJson.encodeCommand(runtime.client().command(
                    requiredString(request.params, "commandId", 512),
                ))
            }
            "codever.command.release" -> {
                requireContext(request.params, true, requiredExtra = setOf("commandId"))
                mutationResult(request) {
                    val commandId = requiredString(request.params, "commandId", 512)
                    if (!runtime.client().releaseCommand(commandId)) operationNotFound("Command was not found.")
                    buildJsonObject { put("commandId", commandId); put("released", true) }
                }
            }
            "codever.command.resolveConflict" -> {
                requireContext(
                    request.params,
                    true,
                    requiredExtra = setOf("commandId", "action"),
                )
                mutationResult(request) {
                    val action = when (requiredString(request.params, "action", 16)) {
                        "retry" -> RevisionConflictAction.RETRY
                        "discard" -> RevisionConflictAction.DISCARD
                        else -> invalidParams("action has an unsupported value.")
                    }
                    commandReceiptToJson(runtime.client().resolveConflict(
                        requiredString(request.params, "commandId", 512),
                        action,
                    ))
                }
            }
            "codever.history.page" -> {
                val historyVersion = negotiatedCapabilities["history.page"]
                    ?: throw BridgeDispatchException(
                        BridgeError.CAPABILITY_UNAVAILABLE,
                        "Native history pagination was not negotiated.",
                        userAction = "update_native",
                    )
                requireContext(
                    request.params,
                    false,
                    requiredExtra = if (historyVersion >= 2) {
                        setOf("sessionId", "limit", "source")
                    } else {
                        setOf("sessionId", "limit")
                    },
                    optionalExtra = setOf("before"),
                )
                val allowRemote = if (historyVersion >= 2) {
                    when (requiredString(request.params, "source", 16)) {
                        "local" -> false
                        "matrix" -> true
                        else -> invalidParams("source has an unsupported value.")
                    }
                } else {
                    true
                }
                boundedHistoryPage(
                    requiredString(request.params, "sessionId", 512),
                    optionalString(request.params, "before", 512),
                    requiredInt(request.params, "limit", 1, 100),
                    allowRemote,
                )
            }
            "codever.attachment.upload.open" -> {
                requireContext(
                    request.params,
                    true,
                    requiredExtra = setOf("name", "mimeType", "size", "sha256"),
                )
                mutationResult(request) {
                    val size = requiredLong(request.params, "size", 0, Long.MAX_VALUE)
                    if (size > 50L * 1024 * 1024) {
                        throw AttachmentTooLargeException("Attachment exceeds the native size limit.")
                    }
                    val transfer = runtime.client().openUpload(
                        requiredString(request.params, "name", 1_024),
                        requiredString(request.params, "mimeType", 256),
                        size,
                        requiredString(request.params, "sha256", 43),
                    )
                    buildJsonObject {
                        put("transferId", transfer.transferId)
                        put("chunkBytes", transfer.chunkBytes)
                        put("nextIndex", transfer.nextIndex)
                        put("expiresAt", transfer.expiresAt)
                    }
                }
            }
            "codever.attachment.upload.chunk" -> {
                requireContext(
                    request.params,
                    false,
                    requiredExtra = setOf("transferId", "index", "dataBase64Url", "chunkSha256"),
                )
                val result = runtime.client().uploadChunk(
                    requiredString(request.params, "transferId", 512),
                    requiredInt(request.params, "index", 0, 100_000),
                    requiredStringAllowEmpty(request.params, "dataBase64Url", 512 * 1024),
                    requiredString(request.params, "chunkSha256", 43),
                )
                buildJsonObject {
                    put("transferId", result.transferId)
                    put("index", result.index)
                    put("receivedBytes", result.receivedBytes)
                    put("nextIndex", result.nextIndex)
                }
            }
            "codever.attachment.upload.finish" -> {
                requireContext(request.params, true, requiredExtra = setOf("transferId"))
                mutationResult(request) {
                    buildJsonObject {
                        put("attachment", PublicClientJson.encodeAttachment(
                            runtime.client().finishUpload(
                                requiredString(request.params, "transferId", 512),
                            ),
                        ))
                    }
                }
            }
            "codever.attachment.upload.abort" -> {
                requireContext(request.params, true, requiredExtra = setOf("transferId"))
                mutationResult(request) {
                    val id = requiredString(request.params, "transferId", 512)
                    runtime.client().abortUpload(id)
                    buildJsonObject { put("transferId", id); put("aborted", true) }
                }
            }
            "codever.attachment.download.open" -> {
                requireContext(request.params, false, requiredExtra = setOf("attachment"))
                val transfer = runtime.client().openDownload(
                    PublicClientJson.decodeAttachment(requiredObject(request.params, "attachment")),
                )
                buildJsonObject {
                    put("transferId", transfer.transferId)
                    put("size", transfer.size)
                    put("sha256", transfer.sha256)
                    put("chunkBytes", transfer.chunkBytes)
                    put("chunkCount", transfer.chunkCount)
                }
            }
            "codever.attachment.download.read" -> {
                requireContext(
                    request.params,
                    false,
                    requiredExtra = setOf("transferId", "index"),
                )
                val chunk = runtime.client().readDownload(
                    requiredString(request.params, "transferId", 512),
                    requiredInt(request.params, "index", 0, 100_000),
                )
                buildJsonObject {
                    put("transferId", chunk.transferId)
                    put("index", chunk.index)
                    put("dataBase64Url", chunk.dataBase64Url)
                    put("chunkSha256", chunk.chunkSha256)
                    put("eof", chunk.eof)
                }
            }
            "codever.attachment.download.close" -> {
                requireContext(request.params, false, requiredExtra = setOf("transferId"))
                val id = requiredString(request.params, "transferId", 512)
                runtime.client().closeDownload(id)
                buildJsonObject { put("transferId", id); put("closed", true) }
            }
            "codever.pairing.inspect" -> {
                requireContext(request.params, false, requiredExtra = setOf("link"))
                runtime.client().inspectPairing(
                    requiredString(request.params, "link", 512 * 1024),
                ).let { preview ->
                    buildJsonObject {
                        put("pairingId", preview.pairingId)
                        put("gatewayId", preview.gatewayId)
                        put("gatewayName", preview.gatewayName)
                        put("verificationCode", preview.verificationCode)
                        put("expiresAt", preview.expiresAt)
                        put("requiresNativeConfirmation", true)
                    }
                }
            }
            "codever.pairing.complete" -> {
                requireContext(
                    request.params,
                    true,
                    requiredExtra = setOf("pairingId", "deviceName"),
                )
                mutationResult(request) {
                    val (trust, snapshot) = runtime.completePairing(
                        requiredString(request.params, "pairingId", 512),
                        requiredString(request.params, "deviceName", 256),
                    )
                    buildJsonObject {
                        put("trust", PublicClientJson.encodeTrust(trust))
                        put("snapshot", PublicClientJson.encodeSnapshot(snapshot))
                    }
                }
            }
            "codever.pairing.cancel" -> {
                requireContext(request.params, true, requiredExtra = setOf("pairingId"))
                mutationResult(request) {
                    val id = requiredString(request.params, "pairingId", 512)
                    runtime.client().cancelPairing(id)
                    buildJsonObject { put("pairingId", id); put("cancelled", true) }
                }
            }
            "codever.trust.get" -> {
                requireContext(request.params, false)
                PublicClientJson.encodeTrust(runtime.client().trustState())
            }
            else -> throw BridgeDispatchException(
                BridgeError.METHOD_NOT_FOUND,
                "Unsupported native bridge method: ${request.method}",
            )
        }
        BridgeProtocol.success(request.id, result)
    } catch (error: BridgeDispatchException) {
        BridgeProtocol.failure(
            request.id,
            error.error,
            error.message,
            error.retryable,
            error.userAction,
        )
    } catch (error: BridgeRuntimeFailure) {
        BridgeProtocol.failure(
            request.id,
            error.error,
            error.message,
            error.retryable,
            error.userAction,
        )
    } catch (error: CancellationException) {
        throw error
    } catch (error: MatrixLoginException) {
        BridgeProtocol.failure(
            request.id,
            BridgeError.INVALID_STATE,
            "Matrix sign-in was not accepted.",
            retryable = error.retryable,
            userAction = if (error.retryable) "retry" else null,
        )
    } catch (error: MatrixLoginTokenRateLimitException) {
        BridgeProtocol.failure(
            request.id,
            BridgeError.RATE_LIMITED,
            error.message ?: "Matrix is temporarily limiting new-device sign-ins.",
            retryable = true,
            userAction = "retry",
            retryAfterMs = error.retryAfterMs,
        )
    } catch (error: MatrixLoginTokenIssueException) {
        BridgeProtocol.failure(
            request.id,
            BridgeError.INVALID_STATE,
            error.message ?: "Matrix could not create a one-time login token.",
            retryable = error.retryable,
            userAction = if (error.retryable) "retry" else null,
        )
    } catch (error: MatrixOfflineException) {
        BridgeProtocol.failure(
            request.id,
            BridgeError.OFFLINE,
            error.message ?: "The native Matrix connection is offline.",
            retryable = true,
            userAction = "retry",
        )
    } catch (error: AttachmentTransferNotFoundException) {
        BridgeProtocol.failure(request.id, BridgeError.TRANSFER_NOT_FOUND, error.message.orEmpty())
    } catch (error: AttachmentChunkConflictException) {
        BridgeProtocol.failure(request.id, BridgeError.CHUNK_CONFLICT, error.message.orEmpty())
    } catch (error: AttachmentHashMismatchException) {
        BridgeProtocol.failure(request.id, BridgeError.HASH_MISMATCH, error.message.orEmpty())
    } catch (error: AttachmentTooLargeException) {
        BridgeProtocol.failure(request.id, BridgeError.ATTACHMENT_TOO_LARGE, error.message.orEmpty())
    } catch (error: CommandIdempotencyConflictException) {
        BridgeProtocol.failure(
            request.id,
            BridgeError.IDEMPOTENCY_CONFLICT,
            error.message ?: "Command idempotency conflict.",
        )
    } catch (error: CommandBusyException) {
        val needsReview = error.blockingState == CommandState.NEEDS_REVIEW
        BridgeProtocol.failure(
            request.id,
            BridgeError.INVALID_STATE,
            error.message.orEmpty(),
            retryable = !needsReview,
            userAction = if (needsReview) null else "retry",
            retryAfterMs = if (needsReview) null else 5_000,
            details = buildJsonObject {
                put("kind", "command_blocked")
                put("commandId", error.blockingCommandId)
                put("state", error.blockingState.wireName)
                put("operation", error.blockingOperation.wireName)
                error.expectedRevision?.let { put("expectedRevision", it) }
            },
        )
    } catch (error: UnknownSubscriptionException) {
        BridgeProtocol.failure(request.id, BridgeError.OPERATION_NOT_FOUND, error.message.orEmpty())
    } catch (error: UnknownCommandException) {
        BridgeProtocol.failure(request.id, BridgeError.OPERATION_NOT_FOUND, error.message.orEmpty())
    } catch (error: InvalidSubscriptionCursorException) {
        BridgeProtocol.failure(request.id, BridgeError.CURSOR_EXPIRED, error.message.orEmpty(), true)
    } catch (error: HistoryCursorInvalidException) {
        BridgeProtocol.failure(request.id, BridgeError.HISTORY_CURSOR_INVALID, error.message.orEmpty())
    } catch (error: NativeTrustRequiredException) {
        BridgeProtocol.failure(
            request.id,
            BridgeError.TRUST_REQUIRED,
            error.message ?: "Gateway trust is required.",
            userAction = "pair_again",
        )
    } catch (error: NativePairingRejectedException) {
        BridgeProtocol.failure(
            request.id,
            BridgeError.PAIRING_REJECTED,
            error.message ?: "Pairing was rejected.",
            retryable = error.retryable,
            userAction = if (error.retryable) "retry" else "pair_again",
        )
    } catch (error: CodeverSecurityException) {
        val expired = error.code == SecurityErrorCode.EXPIRED
        BridgeProtocol.failure(
            request.id,
            if (expired) BridgeError.PAIRING_EXPIRED else BridgeError.PAIRING_REJECTED,
            error.message ?: "Native security verification rejected the request.",
            userAction = "pair_again",
        )
    } catch (error: IllegalArgumentException) {
        BridgeProtocol.failure(
            request.id,
            BridgeError.INVALID_PARAMS,
            error.message ?: "Native request parameters are invalid.",
        )
    } catch (error: IllegalStateException) {
        BridgeProtocol.failure(
            request.id,
            BridgeError.INVALID_STATE,
            error.message ?: "The native runtime is not ready.",
            retryable = true,
        )
    } catch (_: Exception) {
        BridgeProtocol.failure(
            request.id,
            BridgeError.NATIVE_INTERNAL,
            "Native runtime request failed.",
        )
    }

    private fun hello(params: JsonObject): JsonObject {
        requireExactKeys(
            params,
            setOf(
                "application",
                "webBuild",
                "webInstanceId",
                "supportedProtocolVersions",
                "requiredCapabilities",
                "optionalCapabilities",
            ),
        )
        if (requiredString(params, "application", 64) != "codever-web") {
            invalidParams("application must be 'codever-web'.")
        }
        requiredString(params, "webBuild", 256)
        val webInstanceId = requiredString(params, "webInstanceId", 64)
        if (!UUID_PATTERN.matches(webInstanceId)) invalidParams("webInstanceId must be a UUID.")
        val protocolVersions = versionArray(params["supportedProtocolVersions"], "supportedProtocolVersions")
        if (BridgeProtocol.VERSION !in protocolVersions) {
            throw BridgeDispatchException(
                BridgeError.PROTOCOL_UNSUPPORTED,
                "The Web UI and native runtime do not share a bridge protocol version.",
                userAction = "update_native",
            )
        }
        val required = capabilityArray(params["requiredCapabilities"], "requiredCapabilities")
        val optional = capabilityArray(params["optionalCapabilities"], "optionalCapabilities")
        val requiredNames = required.map { it.first }.toSet()
        if (optional.any { it.first in requiredNames }) {
            invalidParams("A capability cannot be both required and optional.")
        }
        val selectedCapabilities = linkedMapOf<String, Int>()
        required.forEach { (name, versions) ->
            val selected = versions
                .filter { it in supportedCapabilityVersions(name) }
                .maxOrNull()
            if (selected == null) {
                throw BridgeDispatchException(
                    BridgeError.CAPABILITY_UNAVAILABLE,
                    "Required native capability is unavailable: $name.",
                    userAction = "update_native",
                )
            }
            selectedCapabilities[name] = selected
        }
        optional.forEach { (name, versions) ->
            versions
                .filter { it in supportedCapabilityVersions(name) }
                .maxOrNull()
                ?.let { selectedCapabilities[name] = it }
        }
        negotiated = true
        negotiatedCapabilities = selectedCapabilities
        return buildJsonObject {
            put("protocolVersion", BridgeProtocol.VERSION)
            put("bridgeSessionId", bridgeSessionId)
            put("native", buildJsonObject {
                put("runtimeVersion", runtime.runtimeVersion)
                put("runtimeBuild", runtime.runtimeBuild)
                put("platform", "android")
            })
            put("capabilities", buildJsonObject {
                selectedCapabilities.forEach { (name, version) ->
                    put(name, buildJsonObject { put("version", version) })
                }
            })
            put("limits", buildJsonObject {
                put("maxRpcBytes", 512 * 1024)
                put("maxEventBatchBytes", 256 * 1024)
                put("maxEventBatchCount", 100)
                put("maxReplayEvents", 1_000)
                put("maxAttachmentBytes", 50 * 1024 * 1024)
                put("attachmentChunkBytes", 256 * 1024)
                put("maxJsonDepth", 32)
                put("maxRpcIdLength", 128)
            })
        }
    }

    private fun notifyEvents(subscriptionId: String, events: List<ClientEvent>) {
        if (events.isEmpty()) return
        val batch = mutableListOf<JsonObject>()
        fun notification(candidates: List<JsonObject>): String = buildJsonObject {
            put("jsonrpc", "2.0")
            put("method", "codever.events.deliver")
            put("params", buildJsonObject {
                put("subscriptionId", subscriptionId)
                put("events", JsonArray(candidates))
            })
        }.toString()
        events.forEach { event ->
            val encoded = PublicClientJson.encodeEvent(event)
            val candidate = notification(batch + encoded)
            if (candidate.toByteArray(Charsets.UTF_8).size <= MAX_EVENT_BATCH_BYTES) {
                batch += encoded
            } else {
                check(batch.isNotEmpty()) { "A native event exceeds the negotiated bridge limit." }
                eventSink(notification(batch))
                batch.clear()
                val single = notification(listOf(encoded))
                check(single.toByteArray(Charsets.UTF_8).size <= MAX_EVENT_BATCH_BYTES) {
                    "A native event exceeds the negotiated bridge limit."
                }
                batch += encoded
            }
        }
        if (batch.isNotEmpty()) eventSink(notification(batch))
    }

    private fun subscriptionToJson(value: SubscriptionBootstrap): JsonObject = when (value) {
        is SubscriptionBootstrap.Replay -> buildJsonObject {
            put("subscriptionId", value.subscriptionId)
            put("barrierCursor", value.barrierCursor)
            put("mode", "replay")
            put("events", buildJsonArray {
                value.events.forEach { add(PublicClientJson.encodeEvent(it)) }
            })
        }
        is SubscriptionBootstrap.Snapshot -> buildJsonObject {
            put("subscriptionId", value.subscriptionId)
            put("barrierCursor", value.barrierCursor)
            put("mode", "snapshot")
            put("snapshot", PublicClientJson.encodeSnapshot(value.snapshot))
        }
    }

    private fun cursorResultToJson(value: SubscriptionCursorResult): JsonObject = buildJsonObject {
        put("subscriptionId", value.subscriptionId)
        put("throughCursor", value.throughCursor)
    }

    private fun commandReceiptToJson(value: CommandReceipt): JsonObject = buildJsonObject {
        put("operationId", value.operationId)
        put("commandId", value.commandId)
        put("idempotencyKey", value.idempotencyKey)
        put("state", value.state.wireName)
        put("submittedAt", value.submittedAt)
        put("updatedAt", value.updatedAt)
        value.sessionId?.let { put("sessionId", it) }
        put("sequence", value.sequence)
        value.revision?.let { put("revision", it) }
    }

    private fun historyToJson(value: HistoryPage): JsonObject = buildJsonObject {
        put("sessionId", value.sessionId)
        put("messages", buildJsonArray {
            value.messages.forEach { add(PublicClientJson.encodeMessage(it)) }
        })
        value.nextBefore?.let { put("nextBefore", it) }
        put("hasMore", value.hasMore)
        put("asOfCursor", value.asOfCursor)
    }

    private suspend fun boundedHistoryPage(
        sessionId: String,
        before: String?,
        requestedLimit: Int,
        allowRemote: Boolean,
    ): JsonObject {
        var limit = requestedLimit
        while (true) {
            val encoded = historyToJson(
                runtime.client().historyPage(sessionId, before, limit, allowRemote),
            )
            if (encoded.toString().toByteArray(Charsets.UTF_8).size <= MAX_RPC_RESULT_BYTES) {
                return encoded
            }
            check(limit > 1) { "A native history message exceeds the bridge response limit." }
            limit = maxOf(1, limit / 2)
        }
    }

    private fun requireContext(
        params: JsonObject,
        mutation: Boolean,
        requiredExtra: Set<String> = emptySet(),
        optionalExtra: Set<String> = emptySet(),
    ) {
        if (!negotiated) {
            throw BridgeDispatchException(
                BridgeError.BRIDGE_NOT_READY,
                "codever.bridge.hello must succeed before client requests.",
            )
        }
        val required = buildSet {
            add("context")
            if (mutation) add("idempotencyKey")
            addAll(requiredExtra)
        }
        val allowed = required + optionalExtra
        if (!params.keys.containsAll(required) || params.keys.any { it !in allowed }) {
            invalidParams("method params has an invalid shape.")
        }
        val context = params["context"]
            ?.let { runCatching { it.jsonObject }.getOrNull() }
            ?: invalidParams("context must be an object.")
        requireExactKeys(context, setOf("bridgeSessionId"))
        if (requiredString(context, "bridgeSessionId", 256) != bridgeSessionId) {
            throw BridgeDispatchException(
                BridgeError.STALE_WEB_INSTANCE,
                "The bridge session is stale.",
                userAction = "retry",
            )
        }
        if (mutation) {
            val key = requiredString(params, "idempotencyKey", 64)
            if (!UUID_PATTERN.matches(key)) invalidParams("idempotencyKey must be a UUID.")
        }
    }

    private suspend fun mutationResult(
        request: BridgeRequest,
        execute: suspend () -> JsonObject,
    ): JsonObject {
        val idempotencyKey = requiredString(request.params, "idempotencyKey", 64)
        val fingerprint = mutationFingerprint(request.method, request.params)
        var owner = false
        val pending = mutationMutex.withLock {
            mutationResults[idempotencyKey]?.let { existing ->
                if (existing.method != request.method || existing.fingerprint != fingerprint) {
                    throw BridgeDispatchException(
                        BridgeError.IDEMPOTENCY_CONFLICT,
                        "The idempotency key was already used for a different mutation.",
                    )
                }
                return existing.result
            }
            inFlightMutations[idempotencyKey]?.let { existing ->
                if (existing.method != request.method || existing.fingerprint != fingerprint) {
                    throw BridgeDispatchException(
                        BridgeError.IDEMPOTENCY_CONFLICT,
                        "The idempotency key is active for a different mutation.",
                    )
                }
                return@withLock existing.result
            }
            owner = true
            CompletableDeferred<JsonObject>().also { result ->
                inFlightMutations[idempotencyKey] = InFlightMutation(
                    request.method,
                    fingerprint,
                    result,
                )
            }
        }
        if (!owner) return pending.await()
        try {
            val result = execute()
            mutationMutex.withLock {
                mutationResults[idempotencyKey] = MutationRecord(request.method, fingerprint, result)
                inFlightMutations.remove(idempotencyKey)
                pending.complete(result)
            }
            return result
        } catch (error: Throwable) {
            mutationMutex.withLock {
                inFlightMutations.remove(idempotencyKey)
                pending.completeExceptionally(error)
            }
            throw error
        }
    }

    private fun mutationFingerprint(method: String, params: JsonObject): String {
        val bytes = "$method\u0000${canonicalJson(params)}".toByteArray(Charsets.UTF_8)
        return try {
            MessageDigest.getInstance("SHA-256").digest(bytes)
                .joinToString(separator = "") { byte -> "%02x".format(byte) }
        } finally {
            bytes.fill(0)
        }
    }

    private fun canonicalJson(value: JsonElement): String = when (value) {
        is JsonObject -> value.entries.sortedBy { it.key }.joinToString(",", "{", "}") {
            "${JsonPrimitive(it.key)}:${canonicalJson(it.value)}"
        }
        is JsonArray -> value.joinToString(",", "[", "]", transform = ::canonicalJson)
        is JsonPrimitive, JsonNull -> value.toString()
    }

    private fun requireExactKeys(value: JsonObject, allowed: Set<String>) {
        val unknown = value.keys.firstOrNull { it !in allowed }
        if (unknown != null) invalidParams("method params contains unknown field: $unknown.")
        val missing = allowed.firstOrNull { it !in value }
        if (missing != null) invalidParams("method params is missing field: $missing.")
    }

    private fun parseBootstrap(params: JsonObject): MatrixBootstrap {
        val oneTimeLoginToken = optionalString(params, "oneTimeLoginToken", 4_096)
        val password = optionalString(params, "password", 4_096)
        if ((oneTimeLoginToken == null) == (password == null)) {
            invalidParams("Exactly one Matrix bootstrap credential is required.")
        }
        val bootstrap = MatrixBootstrap(
            homeserver = requiredString(params, "homeserver", 2_048),
            oneTimeLoginToken = oneTimeLoginToken,
            expectedUserId = requiredString(params, "expectedUserId", 512),
            deviceName = requiredString(params, "deviceName", 256),
            roomBinding = params["roomBinding"]
                ?.let { runCatching { it.jsonObject }.getOrNull() }
                ?.let(::parseRoomBinding)
                ?: invalidParams("roomBinding must be an object."),
            password = password,
        )
        return try {
            MatrixIdentifiers.validateBootstrap(bootstrap)
        } catch (error: IllegalArgumentException) {
            invalidParams(error.message ?: "Matrix bootstrap parameters are invalid.")
        }
    }

    private fun parseRoomBinding(value: JsonObject): MatrixRoomBinding {
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
        return MatrixRoomBinding(
            roomId = requiredString(value, "roomId", 512),
            gatewayId = requiredString(value, "gatewayId", 512),
            conversationId = requiredString(value, "conversationId", 512),
            gatewayUserId = requiredString(value, "gatewayUserId", 512),
            gatewayDeviceId = requiredString(value, "gatewayDeviceId", 512),
            gatewayDeviceEd25519 = requiredString(value, "gatewayDeviceEd25519", 64),
        )
    }

    private fun requiredString(value: JsonObject, key: String, maxLength: Int): String = value[key]
        ?.let { element ->
            runCatching {
                element.jsonPrimitive.takeIf { it.isString }?.contentOrNull
            }.getOrNull()
        }
        ?.takeIf { it.isNotEmpty() && it.length <= maxLength }
        ?: invalidParams("$key must be a valid string.")

    private fun requiredStringAllowEmpty(
        value: JsonObject,
        key: String,
        maxLength: Int,
    ): String = value[key]
        ?.let { element ->
            runCatching { element.jsonPrimitive.takeIf { it.isString }?.contentOrNull }.getOrNull()
        }
        ?.takeIf { it.length <= maxLength }
        ?: invalidParams("$key must be a valid string.")

    private fun optionalString(value: JsonObject, key: String, maxLength: Int): String? {
        val element = value[key] ?: return null
        return runCatching { element.jsonPrimitive.takeIf { it.isString }?.contentOrNull }
            .getOrNull()
            ?.takeIf { it.isNotEmpty() && it.length <= maxLength }
            ?: invalidParams("$key must be a valid string.")
    }

    private fun requiredObject(value: JsonObject, key: String): JsonObject = value[key] as? JsonObject
        ?: invalidParams("$key must be an object.")

    private fun optionalInt(value: JsonObject, key: String): Int? {
        val element = value[key] ?: return null
        return element.jsonPrimitive.takeIf { !it.isString }?.intOrNull
            ?: invalidParams("$key must be an integer.")
    }

    private fun requiredInt(
        value: JsonObject,
        key: String,
        minimum: Int,
        maximum: Int,
    ): Int = optionalInt(value, key)?.takeIf { it in minimum..maximum }
        ?: invalidParams("$key is outside its allowed range.")

    private fun requiredLong(
        value: JsonObject,
        key: String,
        minimum: Long,
        maximum: Long,
    ): Long = value[key]
        ?.jsonPrimitive
        ?.takeIf { !it.isString }
        ?.longOrNull
        ?.takeIf { it in minimum..maximum }
        ?: invalidParams("$key is outside its allowed range.")

    private fun versionArray(value: JsonElement?, label: String): List<Int> {
        val array = value?.let { runCatching { it.jsonArray }.getOrNull() }
            ?: invalidParams("$label must be a non-empty version array.")
        if (array.isEmpty() || array.size > 16) invalidParams("$label must be a non-empty version array.")
        val versions = array.map {
            val primitive = it.jsonPrimitive
            if (primitive.isString) invalidParams("$label must contain integers.")
            primitive.intOrNull ?: invalidParams("$label must contain integers.")
        }
        if (versions.any { it < 1 } || versions.toSet().size != versions.size) {
            invalidParams("$label must contain unique positive versions.")
        }
        return versions
    }

    private fun capabilityArray(value: JsonElement?, label: String): List<Pair<String, List<Int>>> {
        val array = value?.let { runCatching { it.jsonArray }.getOrNull() }
            ?: invalidParams("$label must be an array.")
        if (array.size > 64) invalidParams("$label contains too many capabilities.")
        val capabilities = array.mapIndexed { index, element ->
            val capability = runCatching { element.jsonObject }.getOrNull()
                ?: invalidParams("$label[$index] must be an object.")
            requireExactKeys(capability, setOf("name", "versions"))
            requiredString(capability, "name", 128) to
                versionArray(capability["versions"], "$label[$index].versions")
        }
        if (capabilities.map { it.first }.toSet().size != capabilities.size) {
            invalidParams("$label cannot contain duplicate capability names.")
        }
        return capabilities
    }

    private fun invalidParams(message: String): Nothing =
        throw BridgeDispatchException(BridgeError.INVALID_PARAMS, message)

    private fun operationNotFound(message: String): Nothing =
        throw BridgeDispatchException(BridgeError.OPERATION_NOT_FOUND, message)

    private companion object {
        const val FOREGROUND_SERVICE_CAPABILITY = "background.foreground-service"
        const val MATRIX_BOOTSTRAP_CAPABILITY = "matrix.session-bootstrap"
        const val MATRIX_LOGIN_TOKEN_CAPABILITY = "matrix.login-token"
        val SUPPORTED_CAPABILITIES = setOf(
            "client.lifecycle",
            "events.replay",
            "state.snapshot",
            "commands.durable",
            "history.page",
            "attachments.chunked",
            "pairing.native",
            "trust.native",
            FOREGROUND_SERVICE_CAPABILITY,
            MATRIX_BOOTSTRAP_CAPABILITY,
            MATRIX_LOGIN_TOKEN_CAPABILITY,
        )
        fun supportedCapabilityVersions(name: String): Set<Int> = when {
            name == "history.page" || name == "commands.durable" -> setOf(1, 2)
            name in SUPPORTED_CAPABILITIES -> setOf(1)
            else -> emptySet()
        }
        const val MAX_IDEMPOTENCY_RECORDS = 128
        const val MAX_RPC_RESULT_BYTES = 480 * 1024
        const val MAX_EVENT_BATCH_BYTES = 256 * 1024
        val UUID_PATTERN = Regex(
            "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            RegexOption.IGNORE_CASE,
        )
    }

    private data class MutationRecord(
        val method: String,
        val fingerprint: String,
        val result: JsonObject,
    )

    private data class InFlightMutation(
        val method: String,
        val fingerprint: String,
        val result: CompletableDeferred<JsonObject>,
    )
}

private fun PublicMatrixSession.toJson(): JsonObject = buildJsonObject {
    put("homeserver", homeserver)
    put("userId", userId)
    put("matrixDeviceId", matrixDeviceId)
    put("roomBinding", buildJsonObject {
        put("roomId", roomBinding.roomId)
        put("gatewayId", roomBinding.gatewayId)
        put("conversationId", roomBinding.conversationId)
        put("gatewayUserId", roomBinding.gatewayUserId)
        put("gatewayDeviceId", roomBinding.gatewayDeviceId)
        put("gatewayDeviceEd25519", roomBinding.gatewayDeviceEd25519)
    })
}

private fun matrixLoginTokenResultToJson(value: MatrixLoginTokenIssueResult): JsonObject =
    when (value) {
        is MatrixLoginTokenIssueResult.Ready -> buildJsonObject {
            put("status", "ready")
            put("loginToken", value.loginToken)
            put("expiresAt", value.expiresAt)
        }
        is MatrixLoginTokenIssueResult.ReauthenticationRequired -> buildJsonObject {
            put("status", "reauth-required")
            put("passwordSupported", value.passwordSupported)
        }
        MatrixLoginTokenIssueResult.Unsupported -> buildJsonObject {
            put("status", "unsupported")
        }
    }
