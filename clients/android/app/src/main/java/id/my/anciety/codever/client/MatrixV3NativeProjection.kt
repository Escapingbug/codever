package id.my.anciety.codever.client

import id.my.anciety.codever.client.events.ClientMessage
import id.my.anciety.codever.client.events.ClientMessageFormat
import id.my.anciety.codever.client.events.ClientMessageKind
import id.my.anciety.codever.client.events.PublicClientJson
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

internal data class MatrixV3NativeTerminal(
    val commandId: String,
    val outcome: String,
    val sessionId: String?,
    val result: JsonElement? = null,
    val errorCode: String? = null,
    val errorMessage: String? = null,
    val retryable: Boolean = false,
)

internal data class MatrixV3NativeProjectionResult(
    val messages: List<ClientMessage> = emptyList(),
    val acknowledgedCommandId: String? = null,
    val terminal: MatrixV3NativeTerminal? = null,
    val changed: Boolean = false,
)

/** Order-independent Android materialized view of protocol-v3 timeline data. */
internal class MatrixV3NativeProjection(
    private val gatewayId: () -> String,
    private val activeDeviceCount: () -> Int,
    initialState: JsonObject? = null,
) {
    private data class Project(
        val id: String,
        val snapshotVersion: Long,
        val name: String,
        val cwd: String,
        val provider: String,
        val model: String?,
        val reasoningEffort: String?,
        val permissionMode: String,
    )

    private data class Session(
        val id: String,
        val projectId: String,
        val threadRootEventId: String,
        val title: String,
        val lifecycle: String,
        val activity: String,
        val updatedAt: Long,
        val stateVersion: Long,
        val provider: String?,
        val model: String?,
        val reasoningEffort: String?,
        val permissionMode: String?,
    )

    private var project: Project? = null
    private val sessions = linkedMapOf<String, Session>()
    private val seenEvents = mutableSetOf<String>()
    private val seenCommands = mutableSetOf<String>()

    init {
        initialState?.let(::restore)
    }

    @Synchronized
    fun applyOwnCommand(
        command: JsonObject,
        physicalEventId: String,
        timestamp: Long,
    ): MatrixV3NativeProjectionResult {
        val commandId = command.requiredString("commandId", 256)
        val deviceId = command.requiredString("deviceId", 256)
        val certificateId = command.requiredString("certificateId", 256)
        if (!seenCommands.add("$deviceId\u0000$certificateId\u0000$commandId")) {
            return MatrixV3NativeProjectionResult()
        }
        val operation = command.requiredString("operation", 128)
        val payload = command.requiredObject("payload")
        return when (operation) {
            "session.create" -> {
                val sessionId = command.requiredString("sessionId", 256)
                val initial = payload["initialPrompt"] as? JsonObject
                sessions[sessionId] = Session(
                    id = sessionId,
                    projectId = command.requiredString("projectId", 256),
                    threadRootEventId = physicalEventId,
                    title = payload.optionalString("title", 512)
                        ?: titleFromPrompt(initial?.optionalString("text", Int.MAX_VALUE).orEmpty()),
                    lifecycle = "active",
                    activity = if (initial == null) "idle" else "queued",
                    updatedAt = timestamp,
                    stateVersion = 1,
                    provider = payload.optionalString("provider", 256),
                    model = payload.optionalString("model", 256),
                    reasoningEffort = payload.optionalString("reasoningEffort", 64),
                    permissionMode = payload.optionalString("permissionMode", 128),
                )
                MatrixV3NativeProjectionResult(
                    messages = initial?.let {
                        listOf(userMessage(
                            commandId,
                            sessionId,
                            physicalEventId,
                            timestamp,
                            it.optionalString("text", Int.MAX_VALUE).orEmpty(),
                            deviceId,
                            it,
                        ))
                    }.orEmpty(),
                    changed = true,
                )
            }
            "prompt.submit" -> MatrixV3NativeProjectionResult(
                messages = listOf(userMessage(
                    commandId,
                    command.requiredString("sessionId", 256),
                    physicalEventId,
                    timestamp,
                    payload.optionalString("text", Int.MAX_VALUE).orEmpty(),
                    deviceId,
                    payload,
                )),
                changed = true,
            )
            else -> MatrixV3NativeProjectionResult()
        }
    }

    @Synchronized
    fun applyGatewayEvent(
        event: JsonObject,
        physicalEventId: String,
        threadRootHint: String?,
    ): MatrixV3NativeProjectionResult {
        val eventId = event.requiredString("eventId", 256)
        if (!seenEvents.add(eventId)) return MatrixV3NativeProjectionResult()
        val occurredAt = event.requiredLong("occurredAt")
        val sessionId = event.optionalString("sessionId", 256)
        val projectId = event.optionalString("projectId", 256)
        val causation = event.optionalString("causationCommandId", 256)
        val payload = event.requiredObject("payload")
        val type = payload.requiredString("type", 128)

        if (type == "project.snapshot" && projectId != null) {
            val version = payload.requiredPositiveLong("snapshotVersion")
            val current = project
            if (current == null || version >= current.snapshotVersion) {
                project = Project(
                    id = projectId,
                    snapshotVersion = version,
                    name = payload.requiredString("name", 256),
                    cwd = payload.requiredString("cwd", 8_192),
                    provider = payload.requiredString("provider", 256),
                    model = payload.optionalString("model", 256),
                    reasoningEffort = payload.optionalString("reasoningEffort", 64),
                    permissionMode = payload.requiredString("permissionMode", 128),
                )
                return MatrixV3NativeProjectionResult(changed = true)
            }
            return MatrixV3NativeProjectionResult()
        }

        if (sessionId != null && payload["projection"] is JsonObject) {
            applySessionProjection(
                sessionId,
                projectId,
                payload.requiredObject("projection"),
                threadRootHint,
            )
        }

        var messages = emptyList<ClientMessage>()
        when (type) {
            "session.ready" -> if (sessionId != null && projectId != null) {
                val projection = payload.requiredObject("projection")
                val current = sessions[sessionId]
                if (current != null && current.stateVersion > projection.requiredPositiveLong("stateVersion")) {
                    return MatrixV3NativeProjectionResult()
                }
                sessions[sessionId] = decodeSession(
                    sessionId = sessionId,
                    projectId = projectId,
                    threadRootEventId = current?.threadRootEventId.orEmpty()
                        .ifEmpty { threadRootHint.orEmpty() },
                    projection = projection,
                    provider = payload.requiredString("provider", 256),
                    model = payload.optionalString("model", 256),
                    reasoningEffort = payload.optionalString("reasoningEffort", 64),
                    permissionMode = payload.requiredString("permissionMode", 128),
                )
                val initial = payload["initialPrompt"] as? JsonObject
                val rootCommandId = payload.optionalString("rootCommandId", 256)
                if (initial != null && rootCommandId != null) {
                    messages = listOf(userMessage(
                        rootCommandId,
                        sessionId,
                        sessions[sessionId]?.threadRootEventId.orEmpty().ifEmpty { physicalEventId },
                        occurredAt,
                        initial.optionalString("text", Int.MAX_VALUE).orEmpty(),
                        payload.optionalString("originDeviceId", 256),
                        initial,
                    ))
                }
            }
            "turn.queued" -> if (sessionId != null) {
                messages = listOf(userMessage(
                    payload.requiredString("turnId", 256),
                    sessionId,
                    physicalEventId,
                    occurredAt,
                    payload.optionalString("text", Int.MAX_VALUE).orEmpty(),
                    payload.requiredString("originDeviceId", 256),
                    payload,
                ))
            }
            "assistant.message" -> if (sessionId != null) {
                val messageId = payload.requiredString("messageId", 256)
                val part = payload.optionalInt("partIndex") ?: 0
                val attachments = (payload["attachments"] as? JsonArray)?.mapNotNull { item ->
                    runCatching { PublicClientJson.decodeAttachment(item) }.getOrNull()
                }
                messages = listOf(ClientMessage(
                    eventId = "assistant:$messageId:$part",
                    sender = gatewayId(),
                    timestamp = occurredAt,
                    encrypted = true,
                    kind = ClientMessageKind.AGENT,
                    format = if (payload.optionalString("format", 32) == "plain") {
                        ClientMessageFormat.PLAIN
                    } else {
                        ClientMessageFormat.MARKDOWN
                    },
                    text = payload.optionalString("body", Int.MAX_VALUE).orEmpty(),
                    sessionId = sessionId,
                    commandId = causation,
                    attachments = attachments?.takeIf { it.isNotEmpty() },
                    semantic = payload,
                ))
            }
            "decision.requested" -> if (sessionId != null) {
                val requestId = payload.requiredString("requestId", 256)
                messages = listOf(ClientMessage(
                    eventId = "decision:$requestId",
                    sender = gatewayId(),
                    timestamp = occurredAt,
                    encrypted = true,
                    kind = ClientMessageKind.PERMISSION,
                    format = ClientMessageFormat.MARKDOWN,
                    text = payload.requiredString("title", 1_024),
                    sessionId = sessionId,
                    requestId = requestId,
                    commandId = causation,
                    semantic = payload,
                ))
            }
            "turn.failed" -> if (sessionId != null) {
                val turnId = payload.requiredString("turnId", 256)
                messages = listOf(ClientMessage(
                    eventId = "turn-failed:$turnId",
                    sender = gatewayId(),
                    timestamp = occurredAt,
                    encrypted = true,
                    kind = ClientMessageKind.ERROR,
                    format = ClientMessageFormat.PLAIN,
                    text = payload.requiredString("message", 8_192),
                    sessionId = sessionId,
                    commandId = causation ?: turnId,
                    semantic = payload,
                ))
            }
        }

        return MatrixV3NativeProjectionResult(
            messages = messages,
            acknowledgedCommandId = if (type in setOf("turn.queued", "turn.started")) causation else null,
            terminal = terminal(type, event, payload, causation, sessionId),
            changed = sessionId != null || messages.isNotEmpty(),
        )
    }

    @Synchronized
    fun snapshot(): JsonObject? {
        val activeProject = project ?: return null
        val visible = sessions.values
            .filter { it.lifecycle != "deleted" }
            .sortedWith(compareByDescending<Session> { it.updatedAt }.thenBy { it.id })
        val latestVersion = maxOf(1L, visible.maxOfOrNull { it.stateVersion } ?: 1L)
        val latestTimestamp = visible.maxOfOrNull { it.updatedAt } ?: 0L
        return buildJsonObject {
            put("version", 1)
            put("kind", "gateway_state")
            put("revision", 0)
            put("revision_epoch", "matrix-native-v3")
            put("revision_epoch_generation", 1)
            put("state_version", latestVersion)
            put("active_device_count", activeDeviceCount().coerceAtLeast(1))
            put("updated_at", latestTimestamp)
            put("command_sequences", JsonArray(emptyList()))
            put("current_session_id", JsonNull)
            put("sessions", buildJsonArray {
                visible.forEach { session -> add(publicSession(session, activeProject)) }
            })
            put("workspace", buildJsonObject {
                put("project_id", activeProject.id)
                put("project_name", activeProject.name)
                put("cwd", activeProject.cwd)
                put("provider", activeProject.provider)
                activeProject.model?.let { put("model", it) }
                activeProject.reasoningEffort?.let { put("reasoning_effort", it) }
                put("permission_mode", activeProject.permissionMode)
            })
            put("capabilities", buildJsonObject {
                put("models", JsonArray(emptyList()))
                put("permission_modes", buildJsonArray {
                    add(buildJsonObject { put("id", "default"); put("name", "Default") })
                })
                put("can_create_session", true)
                put("can_select_session", false)
                put("can_archive_session", true)
                put("can_delete_session", true)
                put("session_extensions", JsonArray(emptyList()))
            })
        }
    }

    @Synchronized
    fun threadRootEventId(sessionId: String): String? = sessions[sessionId]
        ?.takeIf { it.lifecycle != "deleted" }
        ?.threadRootEventId
        ?.takeIf { it.isNotBlank() }

    @Synchronized
    fun clear() {
        project = null
        sessions.clear()
        seenEvents.clear()
        seenCommands.clear()
    }

    @Synchronized
    fun durableState(): JsonObject = buildJsonObject {
        put("schemaVersion", 1)
        val activeProject = project
        if (activeProject == null) {
            put("project", JsonNull)
        } else {
            put("project", buildJsonObject {
                put("id", activeProject.id)
                put("snapshotVersion", activeProject.snapshotVersion)
                put("name", activeProject.name)
                put("cwd", activeProject.cwd)
                put("provider", activeProject.provider)
                activeProject.model?.let { put("model", it) }
                activeProject.reasoningEffort?.let { put("reasoningEffort", it) }
                put("permissionMode", activeProject.permissionMode)
            })
        }
        put("sessions", buildJsonArray {
            sessions.values.forEach { session ->
                add(buildJsonObject {
                    put("id", session.id)
                    put("projectId", session.projectId)
                    put("threadRootEventId", session.threadRootEventId)
                    put("title", session.title)
                    put("lifecycle", session.lifecycle)
                    put("activity", session.activity)
                    put("updatedAt", session.updatedAt)
                    put("stateVersion", session.stateVersion)
                    session.provider?.let { put("provider", it) }
                    session.model?.let { put("model", it) }
                    session.reasoningEffort?.let { put("reasoningEffort", it) }
                    session.permissionMode?.let { put("permissionMode", it) }
                })
            }
        })
        put("seenEvents", JsonArray(seenEvents.toList().takeLast(MAX_SEEN_IDS).map(::JsonPrimitive)))
        put("seenCommands", JsonArray(seenCommands.toList().takeLast(MAX_SEEN_IDS).map(::JsonPrimitive)))
    }

    private fun restore(value: JsonObject) {
        require(value.requiredLong("schemaVersion") == 1L)
        val restoredProject = value["project"] as? JsonObject
        project = restoredProject?.let {
            Project(
                id = it.requiredString("id", 256),
                snapshotVersion = it.requiredPositiveLong("snapshotVersion"),
                name = it.requiredString("name", 256),
                cwd = it.requiredString("cwd", 8_192),
                provider = it.requiredString("provider", 256),
                model = it.optionalString("model", 256),
                reasoningEffort = it.optionalString("reasoningEffort", 64),
                permissionMode = it.requiredString("permissionMode", 128),
            )
        }
        val restoredSessions = value["sessions"] as? JsonArray
            ?: throw IllegalArgumentException("The Matrix v3 session projection is invalid.")
        require(restoredSessions.size <= 20_000)
        restoredSessions.forEach { item ->
            val session = item as? JsonObject
                ?: throw IllegalArgumentException("The Matrix v3 session projection is invalid.")
            val id = session.requiredString("id", 256)
            sessions[id] = Session(
                id = id,
                projectId = session.requiredString("projectId", 256),
                threadRootEventId = session.optionalString("threadRootEventId", 512).orEmpty(),
                title = session.requiredString("title", 512),
                lifecycle = session.requiredOneOf("lifecycle", setOf("active", "archived", "deleted")),
                activity = session.requiredOneOf(
                    "activity",
                    setOf("idle", "queued", "working", "attention", "failed"),
                ),
                updatedAt = session.requiredLong("updatedAt"),
                stateVersion = session.requiredPositiveLong("stateVersion"),
                provider = session.optionalString("provider", 256),
                model = session.optionalString("model", 256),
                reasoningEffort = session.optionalString("reasoningEffort", 64),
                permissionMode = session.optionalString("permissionMode", 128),
            )
        }
        (value["seenEvents"] as? JsonArray).orEmpty().takeLast(MAX_SEEN_IDS).forEach {
            seenEvents += it.jsonPrimitive.content
        }
        (value["seenCommands"] as? JsonArray).orEmpty().takeLast(MAX_SEEN_IDS).forEach {
            seenCommands += it.jsonPrimitive.content
        }
    }

    private companion object {
        const val MAX_SEEN_IDS = 10_000
    }

    private fun applySessionProjection(
        sessionId: String,
        projectId: String?,
        projection: JsonObject,
        threadRootHint: String?,
    ) {
        val nextVersion = projection.requiredPositiveLong("stateVersion")
        val current = sessions[sessionId]
        if (current != null && current.stateVersion > nextVersion) return
        sessions[sessionId] = decodeSession(
            sessionId,
            projectId ?: current?.projectId.orEmpty(),
            current?.threadRootEventId.orEmpty().ifEmpty { threadRootHint.orEmpty() },
            projection,
            current?.provider,
            current?.model,
            current?.reasoningEffort,
            current?.permissionMode,
        )
    }

    private fun decodeSession(
        sessionId: String,
        projectId: String,
        threadRootEventId: String,
        projection: JsonObject,
        provider: String?,
        model: String?,
        reasoningEffort: String?,
        permissionMode: String?,
    ): Session = Session(
        id = sessionId,
        projectId = projectId,
        threadRootEventId = threadRootEventId,
        title = projection.requiredString("title", 512),
        lifecycle = projection.requiredOneOf("lifecycle", setOf("active", "archived", "deleted")),
        activity = projection.requiredOneOf(
            "activity",
            setOf("idle", "queued", "working", "attention", "failed"),
        ),
        updatedAt = projection.requiredLong("updatedAt"),
        stateVersion = projection.requiredPositiveLong("stateVersion"),
        provider = provider,
        model = model,
        reasoningEffort = reasoningEffort,
        permissionMode = permissionMode,
    )

    private fun terminal(
        type: String,
        event: JsonObject,
        payload: JsonObject,
        commandId: String?,
        sessionId: String?,
    ): MatrixV3NativeTerminal? {
        commandId ?: return null
        return when (type) {
            "session.ready", "session.updated", "session.lifecycle", "decision.resolved" ->
                MatrixV3NativeTerminal(commandId, "succeeded", sessionId)
            "turn.completed" -> MatrixV3NativeTerminal(
                commandId,
                if (payload.requiredString("outcome", 32) == "cancelled") "cancelled" else "succeeded",
                sessionId,
            )
            "turn.failed" -> MatrixV3NativeTerminal(
                commandId,
                "failed",
                sessionId,
                errorCode = payload.requiredString("code", 128),
                errorMessage = payload.requiredString("message", 8_192),
            )
            "command.rejected" -> MatrixV3NativeTerminal(
                commandId,
                "failed",
                sessionId,
                errorCode = payload.requiredString("code", 128),
                errorMessage = payload.requiredString("message", 8_192),
                retryable = payload.requiredBoolean("retryable"),
            )
            "device.invitation.created" -> MatrixV3NativeTerminal(
                commandId,
                "succeeded",
                sessionId,
                result = buildJsonObject {
                    put("pairingLink", payload.requiredString("pairingLink", 128 * 1024))
                    put("expiresAt", payload.requiredLong("expiresAt"))
                },
            )
            else -> null
        }
    }

    private fun userMessage(
        commandId: String,
        sessionId: String,
        physicalEventId: String,
        timestamp: Long,
        text: String,
        originDeviceId: String?,
        semantic: JsonObject,
    ) = ClientMessage(
        eventId = "user:$commandId",
        sender = originDeviceId ?: gatewayId(),
        timestamp = timestamp,
        encrypted = true,
        kind = ClientMessageKind.USER,
        format = ClientMessageFormat.MARKDOWN,
        text = text,
        sessionId = sessionId,
        commandId = commandId,
        originDeviceId = originDeviceId,
        semantic = JsonObject(semantic + ("physicalEventId" to JsonPrimitive(physicalEventId))),
    )

    private fun publicSession(session: Session, project: Project): JsonObject = buildJsonObject {
        put("id", session.id)
        put("title", session.title)
        put("updated_at", session.updatedAt)
        put("status", when (session.activity) {
            "queued", "working", "attention" -> "running"
            "failed" -> "failed"
            else -> "idle"
        })
        if (session.lifecycle == "archived") put("archived", true)
        put("activity_phase", when (session.activity) {
            "queued" -> "starting"
            "working", "attention" -> "working"
            "failed" -> "failed"
            else -> "idle"
        })
        put("project_id", session.projectId.ifEmpty { project.id })
        put("project_name", project.name)
        put("cwd", project.cwd)
        put("provider", session.provider ?: project.provider)
        (session.model ?: project.model)?.let { put("model", it) }
        (session.reasoningEffort ?: project.reasoningEffort)?.let { put("reasoning_effort", it) }
        put("extensions", JsonArray(emptyList()))
    }

    private fun titleFromPrompt(text: String): String {
        val title = text.replace(Regex("\\s+"), " ").trim()
        if (title.isEmpty()) return "New session"
        return if (title.length <= 64) title else title.take(61) + "..."
    }
}

private fun JsonObject.requiredObject(key: String): JsonObject = get(key) as? JsonObject
    ?: throw IllegalArgumentException("$key must be an object.")

private fun JsonObject.requiredString(key: String, maximum: Int): String {
    val primitive = get(key) as? JsonPrimitive
        ?: throw IllegalArgumentException("$key must be a string.")
    require(primitive.isString)
    return primitive.content.also { require(it.isNotEmpty() && it.length <= maximum) }
}

private fun JsonObject.optionalString(key: String, maximum: Int): String? {
    val primitive = get(key) as? JsonPrimitive ?: return null
    require(primitive.isString)
    return primitive.content.also { require(it.length <= maximum) }
}

private fun JsonObject.requiredLong(key: String): Long {
    val primitive = get(key) as? JsonPrimitive
        ?: throw IllegalArgumentException("$key must be an integer.")
    require(!primitive.isString)
    return primitive.longOrNull?.also { require(it >= 0) }
        ?: throw IllegalArgumentException("$key must be an integer.")
}

private fun JsonObject.requiredPositiveLong(key: String): Long = requiredLong(key).also {
    require(it > 0)
}

private fun JsonObject.optionalInt(key: String): Int? = get(key)?.jsonPrimitive?.intOrNull

private fun JsonObject.requiredBoolean(key: String): Boolean {
    val value = get(key)?.jsonPrimitive?.contentOrNull
    require(value == "true" || value == "false")
    return value == "true"
}

private fun JsonObject.requiredOneOf(key: String, values: Set<String>): String =
    requiredString(key, 128).also { require(it in values) }
