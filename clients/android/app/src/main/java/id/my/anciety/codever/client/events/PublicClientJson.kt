package id.my.anciety.codever.client.events

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
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

/** Exact JSON wire codec shared by persistence and the future bridge adapter. */
object PublicClientJson {
    fun encodeEvent(value: ClientEvent): JsonObject = buildJsonObject {
        put("schemaVersion", value.schemaVersion)
        put("eventId", value.eventId)
        put("cursor", value.cursor)
        put("occurredAt", value.occurredAt)
        put("type", value.type.wireValue)
        put("payload", value.payload)
    }

    fun decodeEvent(element: JsonElement): ClientEvent {
        val value = element.strictObject(
            "client event",
            setOf("schemaVersion", "eventId", "cursor", "occurredAt", "type", "payload"),
        )
        return ClientEvent(
            schemaVersion = value.requiredInt("schemaVersion"),
            eventId = value.requiredString("eventId", 512),
            cursor = value.requiredString("cursor", 512),
            occurredAt = value.requiredLong("occurredAt"),
            type = ClientEventType.fromWire(value.requiredString("type", 128)),
            payload = value.getValue("payload"),
        )
    }

    fun encodeMessage(value: ClientMessage): JsonObject = buildJsonObject {
        put("eventId", value.eventId)
        put("sender", value.sender)
        put("timestamp", value.timestamp)
        put("encrypted", value.encrypted)
        put("kind", value.kind.wireValue)
        value.text?.let { put("text", it) }
        value.sessionId?.let { put("sessionId", it) }
        value.historical?.let { put("historical", it) }
        value.operationId?.let { put("operationId", it) }
        value.requestId?.let { put("requestId", it) }
        value.streamId?.let { put("streamId", it) }
        value.toolCallId?.let { put("toolCallId", it) }
        value.toolStatus?.let { put("toolStatus", it.wireValue) }
        value.replacesEventId?.let { put("replacesEventId", it) }
        value.commandId?.let { put("commandId", it) }
        value.revision?.let { put("revision", it) }
        value.originDeviceId?.let { put("originDeviceId", it) }
        value.originDeviceName?.let { put("originDeviceName", it) }
        value.activeDeviceCount?.let { put("activeDeviceCount", it) }
        put("format", value.format.wireValue)
        value.attachments?.let { items -> put("attachments", JsonArray(items.map(::encodeAttachment))) }
        value.toolGroup?.let { put("toolGroup", encodeToolGroup(it)) }
        value.semantic?.let { put("semantic", it) }
    }

    fun decodeMessage(element: JsonElement): ClientMessage {
        val value = element.strictObject("client message", MESSAGE_KEYS, MESSAGE_REQUIRED_KEYS)
        val attachments = value["attachments"]?.let { candidate ->
            candidate.strictArray("client message attachments", 10).map(::decodeAttachment)
        }
        return ClientMessage(
            eventId = value.requiredString("eventId", 512),
            sender = value.requiredString("sender", 512),
            timestamp = value.requiredLong("timestamp"),
            encrypted = value.requiredBoolean("encrypted"),
            kind = ClientMessageKind.fromWire(value.requiredString("kind", 128)),
            text = value.optionalString("text", 2_000_000),
            sessionId = value.optionalString("sessionId", 512),
            historical = value.optionalBoolean("historical"),
            operationId = value.optionalString("operationId", 512),
            requestId = value.optionalString("requestId", 512),
            streamId = value.optionalString("streamId", 512),
            toolCallId = value.optionalString("toolCallId", 512),
            toolStatus = value.optionalString("toolStatus", 128)?.let(ClientToolStatus::fromWire),
            replacesEventId = value.optionalString("replacesEventId", 512),
            commandId = value.optionalString("commandId", 512),
            revision = value.optionalLong("revision"),
            originDeviceId = value.optionalString("originDeviceId", 512),
            originDeviceName = value.optionalString("originDeviceName", 256),
            activeDeviceCount = value.optionalInt("activeDeviceCount"),
            format = ClientMessageFormat.fromWire(value.requiredString("format", 128)),
            attachments = attachments,
            toolGroup = value["toolGroup"]?.let(::decodeToolGroup),
            semantic = value.optionalObject("semantic"),
        )
    }

    fun encodeSnapshot(value: ClientSnapshot): JsonObject = buildJsonObject {
        put("schemaVersion", value.schemaVersion)
        put("deviceId", value.deviceId)
        put("cursor", value.cursor)
        put("generatedAt", value.generatedAt)
        put("lifecycle", buildJsonObject {
            put("phase", value.lifecycle.phase.wireValue)
            put("since", value.lifecycle.since)
            value.lifecycle.detailCode?.let { put("detailCode", it) }
        })
        put("foregroundService", buildJsonObject {
            put("required", value.foregroundService.required)
            put("active", value.foregroundService.active)
            put("notificationVisible", value.foregroundService.notificationVisible)
        })
        put("trust", encodeTrust(value.trust))
        value.gatewayState?.let { put("gatewayState", it) }
        put("commands", JsonArray(value.commands.map(::encodeCommand)))
        value.pairing?.let { put("pairing", it) }
    }

    fun decodeSnapshot(element: JsonElement): ClientSnapshot {
        val value = element.strictObject("client snapshot", SNAPSHOT_KEYS, SNAPSHOT_REQUIRED_KEYS)
        val lifecycle = value.getValue("lifecycle").strictObject(
            "client lifecycle",
            setOf("phase", "since", "detailCode"),
            requiredKeys = setOf("phase", "since"),
        )
        val foreground = value.getValue("foregroundService").strictObject(
            "foreground service state",
            setOf("required", "active", "notificationVisible"),
        )
        val commands = value.getValue("commands").strictArray("snapshot commands", 1_000)
            .map(::decodeCommand)
        return ClientSnapshot(
            schemaVersion = value.requiredInt("schemaVersion"),
            deviceId = value.requiredString("deviceId", 512),
            cursor = value.requiredString("cursor", 512),
            generatedAt = value.requiredLong("generatedAt"),
            lifecycle = ClientLifecycle(
                phase = LifecyclePhase.fromWire(lifecycle.requiredString("phase", 128)),
                since = lifecycle.requiredLong("since"),
                detailCode = lifecycle.optionalString("detailCode", 128),
            ),
            foregroundService = ForegroundServiceState(
                required = foreground.requiredBoolean("required"),
                active = foreground.requiredBoolean("active"),
                notificationVisible = foreground.requiredBoolean("notificationVisible"),
            ),
            trust = decodeTrust(value.getValue("trust")),
            gatewayState = value.optionalObject("gatewayState"),
            commands = commands,
            pairing = value.optionalObject("pairing"),
        )
    }

    fun encodeTrust(value: PublicTrustState): JsonObject = when (value) {
        PublicTrustState.Unpaired -> buildJsonObject { put("state", "unpaired") }
        is PublicTrustState.Pairing -> buildJsonObject {
            put("state", "pairing")
            put("pairingId", value.pairingId)
            put("expiresAt", value.expiresAt)
        }
        is PublicTrustState.Trusted -> buildJsonObject {
            put("state", "trusted")
            put("gatewayId", value.gatewayId)
            put("gatewayName", value.gatewayName)
            put("certificateId", value.certificateId)
            put("pairedAt", value.pairedAt)
            value.activeDeviceCount?.let { put("activeDeviceCount", it) }
        }
        is PublicTrustState.Blocked -> buildJsonObject {
            put("state", "blocked")
            put("reasonCode", value.reasonCode)
        }
    }

    fun encodeCommand(value: CommandView): JsonObject = buildJsonObject {
        put("operationId", value.operationId)
        value.commandId?.let { put("commandId", it) }
        put("idempotencyKey", value.idempotencyKey)
        put("state", value.state.wireValue)
        put("submittedAt", value.submittedAt)
        put("updatedAt", value.updatedAt)
        value.sessionId?.let { put("sessionId", it) }
        value.sequence?.let { put("sequence", it) }
        value.revision?.let { put("revision", it) }
        value.cancelRequested?.let { put("cancelRequested", it) }
        value.completion?.let { put("completion", encodeCommandCompletion(it)) }
    }

    fun encodeCommandCompletion(value: CommandCompletion): JsonObject = buildJsonObject {
        put("commandId", value.commandId)
        put("sequence", value.sequence)
        put("revision", value.revision)
        put("outcome", value.outcome.wireValue)
        value.sessionId?.let { put("sessionId", it) }
        value.result?.let { put("result", it) }
        value.error?.let { error ->
            put("error", buildJsonObject {
                put("code", error.code)
                put("message", error.message)
                put("retryable", error.retryable)
            })
        }
    }

    fun decodeCommand(element: JsonElement): CommandView {
        val value = element.strictObject(
            "command view",
            COMMAND_KEYS,
            setOf("operationId", "idempotencyKey", "state", "submittedAt", "updatedAt"),
        )
        val completion = value["completion"]?.let { candidate ->
            val item = candidate.strictObject(
                "command completion",
                setOf("commandId", "sequence", "revision", "outcome", "sessionId", "result", "error"),
                setOf("commandId", "sequence", "revision", "outcome"),
            )
            val error = item["error"]?.let { errorElement ->
                val errorValue = errorElement.strictObject(
                    "command error",
                    setOf("code", "message", "retryable"),
                )
                PublicCommandError(
                    errorValue.requiredString("code", 128),
                    errorValue.requiredString("message", 2_048),
                    errorValue.requiredBoolean("retryable"),
                )
            }
            CommandCompletion(
                commandId = item.requiredString("commandId", 512),
                sequence = item.requiredLong("sequence"),
                revision = item.requiredLong("revision"),
                outcome = CommandOutcome.fromWire(item.requiredString("outcome", 64)),
                sessionId = item.optionalString("sessionId", 512),
                result = item["result"],
                error = error,
            )
        }
        return CommandView(
            operationId = value.requiredString("operationId", 512),
            commandId = value.optionalString("commandId", 512),
            idempotencyKey = value.requiredString("idempotencyKey", 128),
            state = CommandState.fromWire(value.requiredString("state", 64)),
            submittedAt = value.requiredLong("submittedAt"),
            updatedAt = value.requiredLong("updatedAt"),
            sessionId = value.optionalString("sessionId", 512),
            sequence = value.optionalLong("sequence"),
            revision = value.optionalLong("revision"),
            cancelRequested = value.optionalBoolean("cancelRequested"),
            completion = completion,
        )
    }

    fun encodeAttachment(value: CodeverAttachment): JsonObject = buildJsonObject {
        put("id", value.id)
        put("name", value.name)
        put("mimeType", value.mimeType)
        put("size", value.size)
        put("sha256", value.sha256)
        put("media", buildJsonObject {
            put("url", value.media.url)
            put("key", value.media.key)
            put("iv", value.media.iv)
            put("sha256", value.media.sha256)
            put("size", value.media.size)
        })
    }

    fun decodeAttachment(element: JsonElement): CodeverAttachment {
        val value = element.strictObject(
            "attachment",
            setOf("id", "name", "mimeType", "size", "sha256", "media"),
        )
        val media = value.getValue("media").strictObject(
            "attachment media",
            setOf("url", "key", "iv", "sha256", "size"),
        )
        return CodeverAttachment(
            id = value.requiredString("id", 512),
            name = value.requiredString("name", 1_024),
            mimeType = value.requiredString("mimeType", 256),
            size = value.requiredLong("size"),
            sha256 = value.requiredString("sha256", 43),
            media = EncryptedMedia(
                url = media.requiredString("url", 2_048),
                key = media.requiredString("key", 128),
                iv = media.requiredString("iv", 128),
                sha256 = media.requiredString("sha256", 43),
                size = media.requiredLong("size"),
            ),
        )
    }

    private fun encodeToolGroup(value: ToolGroupPresentation): JsonObject = buildJsonObject {
        put("kind", value.kind)
        put("version", value.version)
        put("groupId", value.groupId)
        put("tools", buildJsonArray {
            value.tools.forEach { tool ->
                add(buildJsonObject {
                    put("id", tool.id)
                    put("name", tool.name)
                    put("title", tool.title)
                    tool.detail?.let { put("detail", it) }
                    tool.result?.let { put("result", it) }
                    put("category", tool.category.wireValue)
                    put("phase", tool.phase.wireValue)
                    put("isError", tool.isError)
                    put("startedAt", tool.startedAt)
                    put("updatedAt", tool.updatedAt)
                })
            }
        })
    }

    private fun decodeToolGroup(element: JsonElement): ToolGroupPresentation {
        val value = element.strictObject(
            "tool group",
            setOf("kind", "version", "groupId", "tools"),
        )
        return ToolGroupPresentation(
            kind = value.requiredString("kind", 64),
            version = value.requiredInt("version"),
            groupId = value.requiredString("groupId", 512),
            tools = value.getValue("tools").strictArray("tool group tools", 200).map { element ->
                val tool = element.strictObject(
                    "tool presentation",
                    setOf(
                        "id", "name", "title", "detail", "result", "category", "phase",
                        "isError", "startedAt", "updatedAt",
                    ),
                    setOf(
                        "id", "name", "title", "category", "phase", "isError", "startedAt",
                        "updatedAt",
                    ),
                )
                ToolPresentationItem(
                    id = tool.requiredString("id", 512),
                    name = tool.requiredString("name", 512),
                    title = tool.requiredString("title", 512),
                    detail = tool.optionalString("detail", 4_096),
                    result = tool.optionalString("result", 64 * 1_024),
                    category = ToolCategory.fromWire(tool.requiredString("category", 64)),
                    phase = ToolPhase.fromWire(tool.requiredString("phase", 64)),
                    isError = tool.requiredBoolean("isError"),
                    startedAt = tool.requiredLong("startedAt"),
                    updatedAt = tool.requiredLong("updatedAt"),
                )
            },
        )
    }

    private fun decodeTrust(element: JsonElement): PublicTrustState {
        val value = element.strictAnyObject("public trust")
        return when (value.requiredString("state", 32)) {
            "unpaired" -> {
                value.requireKeys("public trust", setOf("state"))
                PublicTrustState.Unpaired
            }
            "pairing" -> {
                value.requireKeys("public trust", setOf("state", "pairingId", "expiresAt"))
                PublicTrustState.Pairing(
                    value.requiredString("pairingId", 512),
                    value.requiredLong("expiresAt"),
                )
            }
            "trusted" -> {
                value.requireKeys(
                    "public trust",
                    setOf(
                        "state", "gatewayId", "gatewayName", "certificateId", "pairedAt",
                        "activeDeviceCount",
                    ),
                    setOf("state", "gatewayId", "gatewayName", "certificateId", "pairedAt"),
                )
                PublicTrustState.Trusted(
                    gatewayId = value.requiredString("gatewayId", 512),
                    gatewayName = value.requiredString("gatewayName", 256),
                    certificateId = value.requiredString("certificateId", 512),
                    pairedAt = value.requiredLong("pairedAt"),
                    activeDeviceCount = value.optionalInt("activeDeviceCount"),
                )
            }
            "blocked" -> {
                value.requireKeys("public trust", setOf("state", "reasonCode"))
                PublicTrustState.Blocked(value.requiredString("reasonCode", 128))
            }
            else -> throw IllegalArgumentException("Unknown public trust state.")
        }
    }

    private val MESSAGE_KEYS = setOf(
        "eventId", "sender", "timestamp", "encrypted", "kind", "text", "sessionId",
        "historical", "operationId", "requestId", "streamId", "toolCallId", "toolStatus",
        "replacesEventId", "commandId", "revision", "originDeviceId", "originDeviceName",
        "activeDeviceCount", "format", "attachments", "toolGroup", "semantic",
    )
    private val MESSAGE_REQUIRED_KEYS = setOf(
        "eventId", "sender", "timestamp", "encrypted", "kind", "format",
    )
    private val SNAPSHOT_KEYS = setOf(
        "schemaVersion", "deviceId", "cursor", "generatedAt", "lifecycle",
        "foregroundService", "trust", "gatewayState", "commands", "pairing",
    )
    private val SNAPSHOT_REQUIRED_KEYS = setOf(
        "schemaVersion", "deviceId", "cursor", "generatedAt", "lifecycle",
        "foregroundService", "trust", "commands",
    )
    private val COMMAND_KEYS = setOf(
        "operationId", "commandId", "idempotencyKey", "state", "submittedAt", "updatedAt",
        "sessionId", "sequence", "revision", "cancelRequested", "completion",
    )

    private fun JsonElement.strictObject(
        label: String,
        allowedKeys: Set<String>,
        requiredKeys: Set<String> = allowedKeys,
    ): JsonObject = strictAnyObject(label).also {
        it.requireKeys(label, allowedKeys, requiredKeys)
    }

    private fun JsonElement.strictAnyObject(label: String): JsonObject = this as? JsonObject
        ?: throw IllegalArgumentException("$label must be an object.")

    private fun JsonObject.requireKeys(
        label: String,
        allowedKeys: Set<String>,
        requiredKeys: Set<String> = allowedKeys,
    ) {
        require(keys.all(allowedKeys::contains) && keys.containsAll(requiredKeys)) {
            "$label shape is invalid."
        }
    }

    private fun JsonElement.strictArray(label: String, maxSize: Int): JsonArray = (this as? JsonArray)
        ?.also { require(it.size <= maxSize) { "$label is too large." } }
        ?: throw IllegalArgumentException("$label must be an array.")

    private fun JsonObject.requiredString(key: String, maxLength: Int): String = get(key)
        ?.jsonPrimitive
        ?.takeIf(JsonPrimitive::isString)
        ?.contentOrNull
        ?.takeIf { it.length in 1..maxLength }
        ?: throw IllegalArgumentException("$key is invalid.")

    private fun JsonObject.optionalString(key: String, maxLength: Int): String? = when (val value = get(key)) {
        null -> null
        JsonNull -> throw IllegalArgumentException("$key is invalid.")
        else -> value.jsonPrimitive.takeIf(JsonPrimitive::isString)?.contentOrNull
            ?.takeIf { it.length in 1..maxLength }
            ?: throw IllegalArgumentException("$key is invalid.")
    }

    private fun JsonObject.requiredLong(key: String): Long = get(key)?.jsonPrimitive?.longOrNull
        ?: throw IllegalArgumentException("$key is invalid.")

    private fun JsonObject.optionalLong(key: String): Long? = when (val value = get(key)) {
        null -> null
        JsonNull -> throw IllegalArgumentException("$key is invalid.")
        else -> value.jsonPrimitive.longOrNull ?: throw IllegalArgumentException("$key is invalid.")
    }

    private fun JsonObject.requiredInt(key: String): Int = get(key)?.jsonPrimitive?.intOrNull
        ?: throw IllegalArgumentException("$key is invalid.")

    private fun JsonObject.optionalInt(key: String): Int? = when (val value = get(key)) {
        null -> null
        JsonNull -> throw IllegalArgumentException("$key is invalid.")
        else -> value.jsonPrimitive.intOrNull ?: throw IllegalArgumentException("$key is invalid.")
    }

    private fun JsonObject.requiredBoolean(key: String): Boolean = get(key)?.jsonPrimitive?.booleanOrNull
        ?: throw IllegalArgumentException("$key is invalid.")

    private fun JsonObject.optionalBoolean(key: String): Boolean? = when (val value = get(key)) {
        null -> null
        JsonNull -> throw IllegalArgumentException("$key is invalid.")
        else -> value.jsonPrimitive.booleanOrNull ?: throw IllegalArgumentException("$key is invalid.")
    }

    private fun JsonObject.optionalObject(key: String): JsonObject? = when (val value = get(key)) {
        null -> null
        JsonNull -> throw IllegalArgumentException("$key must be an object.")
        is JsonObject -> value
        else -> throw IllegalArgumentException("$key must be an object.")
    }
}
