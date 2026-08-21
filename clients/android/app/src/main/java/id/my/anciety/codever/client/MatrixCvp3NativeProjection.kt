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

internal data class MatrixCvp3NativeTerminal(
    val commandId: String,
    val outcome: String,
    val sessionId: String?,
    val result: JsonElement? = null,
    val errorCode: String? = null,
    val errorMessage: String? = null,
    val retryable: Boolean = false,
)

internal data class MatrixCvp3NativeProjectionResult(
    val messages: List<ClientMessage> = emptyList(),
    val acknowledgedCommandId: String? = null,
    val terminal: MatrixCvp3NativeTerminal? = null,
    val changed: Boolean = false,
)

/** Order-independent Android materialized view of CVP/3 timeline data. */
internal class MatrixCvp3NativeProjection(
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
        val installedExtensions: JsonArray,
        val defaultExtensions: JsonArray,
        val extensionDefaultsRevision: Long,
    )

    private data class WorkspaceCapabilities(
        val snapshotVersion: Long,
        val value: JsonObject,
    )

    private data class Session(
        val id: String,
        val projectId: String,
        val threadRootEventId: String,
        val title: String,
        val scope: String,
        val cwd: String,
        val lifecycle: String,
        val activity: String,
        val updatedAt: Long,
        val stateVersion: Long,
        val provider: String?,
        val model: String?,
        val reasoningEffort: String?,
        val permissionMode: String?,
        val extensions: JsonArray,
        val extensionRevision: Long,
    )

    private data class InboxFile(
        val id: String,
        val receivedAt: Long,
        val caption: String?,
        val sourceLabel: String?,
        val attachment: JsonObject,
    )

    private var project: Project? = null
    private var workspaceCapabilities: WorkspaceCapabilities? = null
    private val sessions = linkedMapOf<String, Session>()
    private val inboxFiles = linkedMapOf<String, InboxFile>()
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
    ): MatrixCvp3NativeProjectionResult {
        val commandId = command.requiredString("commandId", 256)
        val deviceId = command.requiredString("deviceId", 256)
        val certificateId = command.requiredString("certificateId", 256)
        if (!seenCommands.add("$deviceId\u0000$certificateId\u0000$commandId")) {
            return MatrixCvp3NativeProjectionResult()
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
                    scope = payload.optionalString("scope", 32)?.also {
                        require(it == "project" || it == "scratch")
                    } ?: "project",
                    cwd = project?.cwd.orEmpty(),
                    lifecycle = "active",
                    activity = if (initial == null) "idle" else "queued",
                    updatedAt = timestamp,
                    stateVersion = 1,
                    provider = payload.optionalString("provider", 256),
                    model = payload.optionalString("model", 256),
                    reasoningEffort = payload.optionalString("reasoningEffort", 64),
                    permissionMode = payload.optionalString("permissionMode", 128),
                    extensions = payload["extensions"] as? JsonArray ?: JsonArray(emptyList()),
                    extensionRevision = 1,
                )
                MatrixCvp3NativeProjectionResult(
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
            "prompt.submit" -> MatrixCvp3NativeProjectionResult(
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
            else -> MatrixCvp3NativeProjectionResult()
        }
    }

    @Synchronized
    fun applyGatewayEvent(
        event: JsonObject,
        physicalEventId: String,
        threadRootHint: String?,
    ): MatrixCvp3NativeProjectionResult {
        val eventId = event.requiredString("eventId", 256)
        val occurredAt = event.requiredLong("occurredAt")
        val sessionId = event.optionalString("sessionId", 256)
        val projectId = event.optionalString("projectId", 256)
        val causation = event.optionalString("causationCommandId", 256)
        val payload = event.requiredObject("payload")
        val type = payload.requiredString("type", 128)

        if (type == "workspace.snapshot") {
            val version = payload.requiredPositiveLong("snapshotVersion")
            val current = workspaceCapabilities
            if (current != null && version <= current.snapshotVersion) {
                return MatrixCvp3NativeProjectionResult()
            }
            val protocolMin = payload.requiredPositiveLong("protocolMin")
            val protocolMax = payload.requiredPositiveLong("protocolMax")
            require(protocolMin <= 3L && protocolMax >= 3L) {
                "The Matrix workspace snapshot does not support CVP/3."
            }
            payload.requiredString("gatewayKeyId", 256)
            val capabilities = payload.requiredObject("capabilities")
            validateCapabilities(capabilities)
            seenEvents.add(eventId)
            workspaceCapabilities = WorkspaceCapabilities(version, capabilities)
            return MatrixCvp3NativeProjectionResult(changed = true)
        }

        if (!seenEvents.add(eventId)) return MatrixCvp3NativeProjectionResult()

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
                    installedExtensions = payload["installedExtensions"] as? JsonArray
                        ?: JsonArray(emptyList()),
                    defaultExtensions = payload["defaultExtensions"] as? JsonArray
                        ?: JsonArray(emptyList()),
                    extensionDefaultsRevision = payload.optionalLong("extensionDefaultsRevision")
                        ?.takeIf { it > 0 }
                        ?: 1,
                )
                return MatrixCvp3NativeProjectionResult(changed = true)
            }
            return MatrixCvp3NativeProjectionResult()
        }

        if (type == "inbox.file.received" && projectId != null) {
            val fileId = payload.requiredString("fileId", 256)
            val attachment = payload.requiredObject("attachment")
            PublicClientJson.decodeAttachment(attachment)
            val source = payload.requiredObject("source")
            require(source.requiredString("kind", 32) == "local-cli")
            inboxFiles[fileId] = InboxFile(
                id = fileId,
                receivedAt = occurredAt,
                caption = payload.optionalString("caption", 8_192),
                sourceLabel = source.optionalString("label", 256),
                attachment = attachment,
            )
            return MatrixCvp3NativeProjectionResult(changed = true)
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
                    return MatrixCvp3NativeProjectionResult()
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
            "extension.interaction.requested" -> if (sessionId != null) {
                val requestId = payload.requiredString("requestId", 256)
                val view = payload.requiredObject("view")
                messages = listOf(ClientMessage(
                    eventId = "decision:$requestId",
                    sender = gatewayId(),
                    timestamp = occurredAt,
                    encrypted = true,
                    kind = ClientMessageKind.PERMISSION,
                    format = ClientMessageFormat.PLAIN,
                    text = view.requiredString("title", 256),
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

        return MatrixCvp3NativeProjectionResult(
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
        val latestTimestamp = maxOf(
            visible.maxOfOrNull { it.updatedAt } ?: 0L,
            inboxFiles.values.maxOfOrNull { it.receivedAt } ?: 0L,
        )
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
            put("inbox_files", buildJsonArray {
                inboxFiles.values.sortedByDescending { it.receivedAt }.forEach { file ->
                    add(buildJsonObject {
                        put("id", file.id)
                        put("received_at", file.receivedAt)
                        file.caption?.let { put("caption", it) }
                        file.sourceLabel?.let { put("source_label", it) }
                        put("attachment", file.attachment)
                    })
                }
            })
            put("workspace", buildJsonObject {
                put("project_id", activeProject.id)
                put("project_name", activeProject.name)
                put("cwd", activeProject.cwd)
                put("provider", activeProject.provider)
                activeProject.model?.let { put("model", it) }
                activeProject.reasoningEffort?.let { put("reasoning_effort", it) }
                put("permission_mode", activeProject.permissionMode)
                put("default_extensions", activeProject.defaultExtensions)
                put("extension_defaults_revision", activeProject.extensionDefaultsRevision)
            })
            put(
                "capabilities",
                workspaceCapabilities?.value ?: defaultCapabilities(activeProject.installedExtensions),
            )
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
        workspaceCapabilities = null
        sessions.clear()
        inboxFiles.clear()
        seenEvents.clear()
        seenCommands.clear()
    }

    @Synchronized
    fun durableState(): JsonObject = buildJsonObject {
        put("schemaVersion", 3)
        val activeCapabilities = workspaceCapabilities
        if (activeCapabilities == null) {
            put("workspaceCapabilities", JsonNull)
        } else {
            put("workspaceCapabilities", buildJsonObject {
                put("snapshotVersion", activeCapabilities.snapshotVersion)
                put("value", activeCapabilities.value)
            })
        }
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
                put("installedExtensions", activeProject.installedExtensions)
                put("defaultExtensions", activeProject.defaultExtensions)
                put("extensionDefaultsRevision", activeProject.extensionDefaultsRevision)
            })
        }
        put("sessions", buildJsonArray {
            sessions.values.forEach { session ->
                add(buildJsonObject {
                    put("id", session.id)
                    put("projectId", session.projectId)
                    put("threadRootEventId", session.threadRootEventId)
                    put("title", session.title)
                    put("scope", session.scope)
                    put("cwd", session.cwd)
                    put("lifecycle", session.lifecycle)
                    put("activity", session.activity)
                    put("updatedAt", session.updatedAt)
                    put("stateVersion", session.stateVersion)
                    session.provider?.let { put("provider", it) }
                    session.model?.let { put("model", it) }
                    session.reasoningEffort?.let { put("reasoningEffort", it) }
                    session.permissionMode?.let { put("permissionMode", it) }
                    put("extensions", session.extensions)
                    put("extensionRevision", session.extensionRevision)
                })
            }
        })
        put("inboxFiles", buildJsonArray {
            inboxFiles.values.forEach { file ->
                add(buildJsonObject {
                    put("id", file.id)
                    put("receivedAt", file.receivedAt)
                    file.caption?.let { put("caption", it) }
                    file.sourceLabel?.let { put("sourceLabel", it) }
                    put("attachment", file.attachment)
                })
            }
        })
        put("seenEvents", JsonArray(seenEvents.toList().takeLast(MAX_SEEN_IDS).map(::JsonPrimitive)))
        put("seenCommands", JsonArray(seenCommands.toList().takeLast(MAX_SEEN_IDS).map(::JsonPrimitive)))
    }

    private fun restore(value: JsonObject) {
        val schemaVersion = value.requiredLong("schemaVersion")
        require(schemaVersion == 1L || schemaVersion == 2L || schemaVersion == 3L)
        workspaceCapabilities = if (schemaVersion == 1L) {
            null
        } else {
            (value["workspaceCapabilities"] as? JsonObject)?.let {
                val capabilities = it.requiredObject("value")
                validateCapabilities(capabilities)
                WorkspaceCapabilities(
                    snapshotVersion = it.requiredPositiveLong("snapshotVersion"),
                    value = capabilities,
                )
            }
        }
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
                installedExtensions = it["installedExtensions"] as? JsonArray
                    ?: JsonArray(emptyList()),
                defaultExtensions = it["defaultExtensions"] as? JsonArray
                    ?: JsonArray(emptyList()),
                extensionDefaultsRevision = it.optionalLong("extensionDefaultsRevision")
                    ?.takeIf { version -> version > 0 }
                    ?: 1,
            )
        }
        val restoredSessions = value["sessions"] as? JsonArray
            ?: throw IllegalArgumentException("The CVP/3 session projection is invalid.")
        require(restoredSessions.size <= 20_000)
        restoredSessions.forEach { item ->
            val session = item as? JsonObject
                ?: throw IllegalArgumentException("The CVP/3 session projection is invalid.")
            val id = session.requiredString("id", 256)
            sessions[id] = Session(
                id = id,
                projectId = session.requiredString("projectId", 256),
                threadRootEventId = session.optionalString("threadRootEventId", 512).orEmpty(),
                title = session.requiredString("title", 512),
                scope = session.optionalString("scope", 32)?.also {
                    require(it == "project" || it == "scratch")
                } ?: "project",
                cwd = session.optionalString("cwd", 8_192) ?: project?.cwd.orEmpty(),
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
                extensions = session["extensions"] as? JsonArray ?: JsonArray(emptyList()),
                extensionRevision = session.optionalLong("extensionRevision")
                    ?.takeIf { it > 0 }
                    ?: 1,
            )
        }
        if (schemaVersion >= 3L) {
            val restoredInbox = value["inboxFiles"] as? JsonArray
                ?: throw IllegalArgumentException("The CVP/3 inbox projection is invalid.")
            require(restoredInbox.size <= 100_000)
            restoredInbox.forEach { item ->
                val file = item as? JsonObject
                    ?: throw IllegalArgumentException("The CVP/3 inbox projection is invalid.")
                val id = file.requiredString("id", 256)
                val attachment = file.requiredObject("attachment")
                PublicClientJson.decodeAttachment(attachment)
                inboxFiles[id] = InboxFile(
                    id = id,
                    receivedAt = file.requiredLong("receivedAt"),
                    caption = file.optionalString("caption", 8_192),
                    sourceLabel = file.optionalString("sourceLabel", 256),
                    attachment = attachment,
                )
            }
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
        scope = projection.optionalString("scope", 32)?.also {
            require(it == "project" || it == "scratch")
        } ?: sessions[sessionId]?.scope ?: "project",
        cwd = projection.optionalString("cwd", 8_192)
            ?: sessions[sessionId]?.cwd
            ?: project?.cwd.orEmpty(),
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
        extensions = projection["extensions"] as? JsonArray
            ?: sessions[sessionId]?.extensions
            ?: JsonArray(emptyList()),
        extensionRevision = projection.optionalLong("extensionRevision")
            ?.takeIf { it > 0 }
            ?: sessions[sessionId]?.extensionRevision
            ?: 1,
    )

    private fun terminal(
        type: String,
        event: JsonObject,
        payload: JsonObject,
        commandId: String?,
        sessionId: String?,
    ): MatrixCvp3NativeTerminal? {
        commandId ?: return null
        return when (type) {
            "session.ready", "session.updated", "session.lifecycle", "decision.resolved",
            "extension.interaction.resolved", "project.snapshot" ->
                MatrixCvp3NativeTerminal(commandId, "succeeded", sessionId)
            "turn.completed" -> MatrixCvp3NativeTerminal(
                commandId,
                if (payload.requiredString("outcome", 32) == "cancelled") "cancelled" else "succeeded",
                sessionId,
            )
            "turn.failed" -> MatrixCvp3NativeTerminal(
                commandId,
                "failed",
                sessionId,
                errorCode = payload.requiredString("code", 128),
                errorMessage = payload.requiredString("message", 8_192),
            )
            "command.rejected" -> MatrixCvp3NativeTerminal(
                commandId,
                "failed",
                sessionId,
                errorCode = payload.requiredString("code", 128),
                errorMessage = payload.requiredString("message", 8_192),
                retryable = payload.requiredBoolean("retryable"),
            )
            "device.invitation.created" -> MatrixCvp3NativeTerminal(
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
        put("project_name", if (session.scope == "scratch") "Temporary" else project.name)
        put("scope", session.scope)
        put("cwd", session.cwd.ifEmpty { project.cwd })
        put("provider", session.provider ?: project.provider)
        (session.model ?: project.model)?.let { put("model", it) }
        (session.reasoningEffort ?: project.reasoningEffort)?.let { put("reasoning_effort", it) }
        put("extensions", session.extensions)
    }

    private fun validateCapabilities(value: JsonObject) {
        value.requireKeys(
            setOf(
                "models",
                "permission_modes",
                "can_create_session",
                "can_select_session",
                "can_archive_session",
                "can_delete_session",
                "session_extensions",
            ),
            emptySet(),
            "CVP/3 capabilities",
        )
        val models = value.requiredArray("models", 256)
        models.forEach { item ->
            val model = item as? JsonObject
                ?: throw IllegalArgumentException("A CVP/3 model capability must be an object.")
            model.requireKeys(
                setOf("id", "name"),
                setOf("default_reasoning_level", "supported_reasoning_levels"),
                "CVP/3 model capability",
            )
            model.requiredString("id", 256)
            model.requiredString("name", 256)
            model.optionalString("default_reasoning_level", 64)
            model.optionalArray("supported_reasoning_levels", 64).orEmpty().forEach { levelValue ->
                val level = levelValue as? JsonObject
                    ?: throw IllegalArgumentException("A CVP/3 reasoning capability must be an object.")
                level.requireKeys(
                    setOf("effort"),
                    setOf("description"),
                    "CVP/3 reasoning capability",
                )
                level.requiredString("effort", 64)
                level.optionalString("description", 4_096)
            }
        }
        requireUniqueIds(models, "CVP/3 model capabilities")

        val permissionModes = value.requiredArray("permission_modes", 128)
        permissionModes.forEach { item ->
            val mode = item as? JsonObject
                ?: throw IllegalArgumentException("A CVP/3 permission capability must be an object.")
            mode.requireKeys(setOf("id", "name"), emptySet(), "CVP/3 permission capability")
            mode.requiredString("id", 256)
            mode.requiredString("name", 256)
        }
        requireUniqueIds(permissionModes, "CVP/3 permission capabilities")
        value.requiredBoolean("can_create_session")
        value.requiredBoolean("can_select_session")
        value.requiredBoolean("can_archive_session")
        value.requiredBoolean("can_delete_session")

        val extensions = value.requiredArray("session_extensions", 128)
        extensions.forEach { item ->
            val extension = item as? JsonObject
                ?: throw IllegalArgumentException("A CVP/3 extension capability must be an object.")
            extension.requireKeys(
                setOf("id", "name", "description", "version", "settings"),
                emptySet(),
                "CVP/3 extension capability",
            )
            extension.requiredString("id", 256)
            extension.requiredString("name", 256)
            extension.requiredString("description", 4_096)
            extension.requiredString("version", 128)
            val settings = extension.requiredArray("settings", 32)
            settings.forEach { settingValue ->
                val setting = settingValue as? JsonObject
                    ?: throw IllegalArgumentException("A CVP/3 extension setting must be an object.")
                when (setting.requiredOneOf("type", setOf("text", "boolean"))) {
                    "text" -> setting.requireKeys(
                        setOf("id", "type", "label"),
                        setOf("description", "required", "placeholder", "default_value"),
                        "CVP/3 text extension setting",
                    )
                    "boolean" -> setting.requireKeys(
                        setOf("id", "type", "label"),
                        setOf("description", "default_value"),
                        "CVP/3 boolean extension setting",
                    )
                }
                setting.requiredString("id", 128)
                setting.requiredString("label", 256)
                setting.optionalString("description", 2_048)
                setting.optionalString("placeholder", 512)
                if (setting["required"] != null) setting.requiredBoolean("required")
                val defaultValue = setting["default_value"]
                if (defaultValue != null) {
                    val primitive = defaultValue as? JsonPrimitive
                        ?: throw IllegalArgumentException("A CVP/3 extension default must be scalar.")
                    if (setting.requiredString("type", 16) == "text") {
                        require(primitive.isString && primitive.content.length <= 4_096)
                    } else {
                        require(!primitive.isString && primitive.content in setOf("true", "false"))
                    }
                }
            }
            requireUniqueIds(settings, "CVP/3 extension settings")
        }
        requireUniqueIds(extensions, "CVP/3 extension capabilities")
    }

    private fun defaultCapabilities(
        installedExtensions: JsonArray = JsonArray(emptyList()),
    ): JsonObject = buildJsonObject {
        put("models", JsonArray(emptyList()))
        put("permission_modes", buildJsonArray {
            add(buildJsonObject { put("id", "default"); put("name", "Default") })
        })
        put("can_create_session", true)
        put("can_select_session", false)
        put("can_archive_session", true)
        put("can_delete_session", true)
        put("session_extensions", installedExtensions)
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

private fun JsonObject.optionalLong(key: String): Long? {
    val primitive = get(key) as? JsonPrimitive ?: return null
    require(!primitive.isString)
    return primitive.longOrNull
}

private fun JsonObject.requiredBoolean(key: String): Boolean {
    val value = get(key)?.jsonPrimitive?.contentOrNull
    require(value == "true" || value == "false")
    return value == "true"
}

private fun JsonObject.requiredOneOf(key: String, values: Set<String>): String =
    requiredString(key, 128).also { require(it in values) }

private fun JsonObject.requiredArray(key: String, maximum: Int): JsonArray =
    (get(key) as? JsonArray
        ?: throw IllegalArgumentException("$key must be an array."))
        .also { require(it.size <= maximum) }

private fun JsonObject.optionalArray(key: String, maximum: Int): JsonArray? =
    get(key)?.let {
        (it as? JsonArray
            ?: throw IllegalArgumentException("$key must be an array."))
            .also { array -> require(array.size <= maximum) }
    }

private fun JsonObject.requireKeys(
    required: Set<String>,
    optional: Set<String>,
    label: String,
) {
    require(keys.containsAll(required) && keys.all { it in required || it in optional }) {
        "$label contains unexpected or missing fields."
    }
}

private fun requireUniqueIds(values: JsonArray, label: String) {
    val ids = values.map { (it as JsonObject).requiredString("id", 256) }
    require(ids.toSet().size == ids.size) { "$label contain duplicate IDs." }
}
