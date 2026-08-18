package id.my.anciety.codever.client

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * Projects authoritative Matrix Room State into the Web bridge snapshot.
 * Timeline events may advance a revision, but they never create, delete, or
 * resurrect inventory. Gateway and session entities converge independently
 * within the current Gateway revision epoch.
 */
class MatrixNativeProjection {
    private data class NativeRevision(
        val revision: Long,
        val epoch: String,
        val generation: Long,
    )

    private var gateway: JsonObject? = null
    private val sessionStates = linkedMapOf<String, JsonObject>()
    private val pendingSessionStates = linkedMapOf<String, JsonObject>()
    private val statusOverrides = linkedMapOf<String, JsonObject>()
    private var latestRevision: NativeRevision? = null

    @Synchronized
    fun applyRoomState(value: JsonObject): JsonObject? {
        require(value.number("version") == 2L)
        when (value.text("kind")) {
            "gateway_state" -> applyGateway(value)
            "session_state" -> applySession(value)
            "session_directory" -> return snapshot()
            else -> error("Unsupported Codever Matrix Room State kind.")
        }
        return snapshot()
    }

    /** Replaces one materialized directory behind a single publication barrier. */
    @Synchronized
    fun applyRoomStateBatch(values: List<JsonObject>): JsonObject? {
        val gateways = values.filter { it.text("kind") == "gateway_state" }
        require(gateways.size == 1 && values.none { it.text("kind") == "session_directory" })
        val nextGateway = gateways.single()
        val watermark = (nextGateway["session_directory"] as? JsonObject)
            ?.number("state_version") ?: error("Matrix Gateway directory watermark is missing.")
        val previousGateway = gateway
        val previousSessions = sessionStates.toMap()
        val previousPending = pendingSessionStates.toMap()
        val previousOverrides = statusOverrides.toMap()
        val previousRevision = latestRevision
        return try {
            val newer = (sessionStates.values + pendingSessionStates.values)
                .filter { value ->
                    value.number("revision_epoch_generation") ==
                        nextGateway.number("revision_epoch_generation") &&
                        value.text("revision_epoch") == nextGateway.text("revision_epoch") &&
                        (value.number("state_version") ?: -1) > watermark
                }
                .sortedWith(::compareEntityState)
            gateway = null
            sessionStates.clear()
            pendingSessionStates.clear()
            statusOverrides.clear()
            latestRevision = null
            (listOf(nextGateway) + values.filter { it.text("kind") == "session_state" } + newer)
                .forEach { value ->
                require(value.number("version") == 2L)
                when (value.text("kind")) {
                    "gateway_state" -> applyGateway(value)
                    "session_state" -> applySession(value)
                    else -> error("Unsupported Codever Matrix Room State kind.")
                }
            }
            snapshot()
        } catch (error: Throwable) {
            gateway = previousGateway
            sessionStates.clear()
            sessionStates.putAll(previousSessions)
            pendingSessionStates.clear()
            pendingSessionStates.putAll(previousPending)
            statusOverrides.clear()
            statusOverrides.putAll(previousOverrides)
            latestRevision = previousRevision
            throw error
        }
    }

    @Synchronized
    fun applyTimeline(value: JsonObject): JsonObject? {
        when (value.text("kind")) {
            "session_root", "session_update", "session_lifecycle", "gateway_revision" ->
                observeRevision(value)
            else -> return snapshot()
        }
        return snapshot()
    }

    @Synchronized
    fun applyStatus(value: JsonObject): JsonObject? {
        if (value.text("kind") != "status") return snapshot()
        val sessionId = value.text("session_id") ?: return snapshot()
        val currentState = sessionStates[sessionId] ?: return snapshot()
        if (currentState.text("state") == "deleted") return snapshot()
        val current = currentState["session"] as? JsonObject ?: return snapshot()
        val status = value.text("state").takeIf { it in setOf("running", "stopping", "failed") }
            ?: "idle"
        val phase = value.text("activity_phase")
            ?.takeIf { it in setOf("starting", "working", "stopping", "idle", "failed") }
        val nextSession = JsonObject(current + buildMap {
            put("status", JsonPrimitive(status))
            phase?.let { put("activity_phase", JsonPrimitive(it)) }
        })
        statusOverrides[sessionId] = nextSession
        return snapshot()
    }

    private fun applyGateway(value: JsonObject) {
        validateGateway(value)
        val current = gateway
        if (current != null) {
            val generation = value.number("revision_epoch_generation")!!
            val currentGeneration = current.number("revision_epoch_generation")!!
            if (generation < currentGeneration) return
            if (generation == currentGeneration) {
                require(value.text("revision_epoch") == current.text("revision_epoch")) {
                    "Matrix Room State disagrees on the Gateway revision epoch."
                }
                if ((value.number("state_version") ?: -1) < (current.number("state_version") ?: -1)) {
                    return
                }
                if (compareRevisions(value, current) < 0) return
            } else {
                sessionStates.clear()
                statusOverrides.clear()
                pendingSessionStates.entries.removeAll { (_, state) ->
                    state.number("revision_epoch_generation") != generation ||
                        state.text("revision_epoch") != value.text("revision_epoch")
                }
            }
        }
        gateway = value
        observeRevision(value)
        commitPending()
    }

    private fun applySession(value: JsonObject) {
        validateSession(value)
        if (belongsToCurrentGateway(value)) {
            commitSession(value)
            return
        }
        val sessionId = value.text("session_id")!!
        val pending = pendingSessionStates[sessionId]
        if (pending == null || compareEntityState(value, pending) >= 0) {
            pendingSessionStates[sessionId] = value
        }
    }

    private fun commitPending() {
        pendingSessionStates.entries.toList().forEach { (sessionId, state) ->
            if (belongsToCurrentGateway(state)) {
                pendingSessionStates.remove(sessionId)
                commitSession(state)
            }
        }
    }

    private fun commitSession(value: JsonObject) {
        val sessionId = value.text("session_id")!!
        val current = sessionStates[sessionId]
        if (current == null || compareEntityState(value, current) >= 0) {
            sessionStates[sessionId] = value
            statusOverrides.remove(sessionId)
            observeRevision(value)
        }
    }

    private fun belongsToCurrentGateway(value: JsonObject): Boolean {
        val current = gateway ?: return false
        return value.number("revision_epoch_generation") == current.number("revision_epoch_generation") &&
            value.text("revision_epoch") == current.text("revision_epoch")
    }

    @Synchronized
    fun snapshot(): JsonObject? {
        val currentGateway = gateway ?: return null
        val committed = sessionStates.values.filter(::belongsToCurrentGateway)
        val revision = latestRevision ?: nativeRevision(currentGateway)
        val workspace = currentGateway["workspace"] as JsonObject
        val project = workspace["project"] as JsonObject
        val sessions = committed.asSequence()
            .filter { it.text("state") != "deleted" }
            .map { state ->
                statusOverrides[state.text("session_id")] ?: state["session"] as JsonObject
            }
            .map(::publicSession)
            .sortedByDescending { it.number("updated_at") ?: 0 }
            .toList()
        return buildJsonObject {
            put("version", 1)
            put("kind", "gateway_state")
            put("revision", revision.revision)
            put("revision_epoch", revision.epoch)
            put("revision_epoch_generation", revision.generation)
            put("state_version", currentGateway.number("state_version")!!)
            put("active_device_count", currentGateway.number("active_device_count")!!)
            put("updated_at", currentGateway.number("updated_at")!!)
            put("command_sequences", currentGateway.getValue("command_sequences"))
            put("current_session_id", kotlinx.serialization.json.JsonNull)
            put("sessions", JsonArray(sessions))
            put("workspace", buildJsonObject {
                put("project_id", project.text("id")!!)
                put("project_name", project.text("name")!!)
                put("cwd", project.text("cwd")!!)
                put("provider", workspace.text("provider")!!)
                workspace.text("model")?.let { put("model", it) }
                workspace.text("reasoning_effort")?.let { put("reasoning_effort", it) }
                put("permission_mode", workspace.text("permission_mode")!!)
            })
            put("capabilities", currentGateway.getValue("capabilities"))
        }
    }

    @Synchronized
    fun threadRootEventId(sessionId: String): String? = sessionStates[sessionId]
        ?.takeIf(::belongsToCurrentGateway)
        ?.takeIf { it.text("state") != "deleted" }
        ?.get("session")
        ?.let { it as? JsonObject }
        ?.text("thread_root_event_id")

    @Synchronized
    private fun publicSession(value: JsonObject): JsonObject {
        val project = value["project"] as JsonObject
        return buildJsonObject {
            put("id", value.text("session_id")!!)
            put("title", value.text("title")!!)
            put("updated_at", value.number("updated_at")!!)
            put("status", if (value.boolean("archived")) "idle" else value.text("status")!!)
            if (value.boolean("archived")) put("archived", true)
            value.text("activity_phase")?.let { put("activity_phase", it) }
            put("project_id", project.text("id")!!)
            put("project_name", project.text("name")!!)
            put("cwd", project.text("cwd")!!)
            put("provider", value.text("provider")!!)
            value.text("model")?.let { put("model", it) }
            value.text("reasoning_effort")?.let { put("reasoning_effort", it) }
            put("extensions", value["extensions"] as? JsonArray ?: JsonArray(emptyList()))
        }
    }

    private fun validateGateway(value: JsonObject) {
        value.requireExactKeys(
            setOf(
                "version", "kind", "gateway_id", "conversation_id", "revision",
                "revision_epoch", "revision_epoch_generation", "state_version",
                "active_device_count", "command_sequences", "workspace", "capabilities", "updated_at",
                "session_directory",
            ),
            "Matrix Gateway state",
        )
        require(value.requiredLong("version", "Matrix Gateway state") == 2L)
        require(value.requiredString("kind", 64, "Matrix Gateway state") == "gateway_state")
        value.requiredOpaqueId("gateway_id", "Matrix Gateway state")
        value.requiredOpaqueId("conversation_id", "Matrix Gateway state")
        require(value.requiredLong("state_version", "Matrix Gateway state") >= 0)
        require(value.requiredLong("active_device_count", "Matrix Gateway state") > 0)
        validateCommandSequences(
            value.requiredArray("command_sequences", 256, "Matrix Gateway state"),
        )
        value.requiredTimestamp("updated_at", "Matrix Gateway state")
        validateWorkspace(value.requiredObject("workspace", "Matrix Gateway state"))
        validateCapabilities(value.requiredObject("capabilities", "Matrix Gateway state"))
        val directory = value.requiredObject("session_directory", "Matrix Gateway state")
        directory.requireExactKeys(
            setOf("generation", "state_version", "slot", "page_count", "state_key_prefix", "digest"),
            "Matrix session directory",
        )
        require(directory.requiredLong("generation", "Matrix session directory") >= 0)
        require(directory.requiredLong("state_version", "Matrix session directory") >= 0)
        require(directory.requiredLong("slot", "Matrix session directory") in 0..2)
        require(directory.requiredLong("page_count", "Matrix session directory") in 0..100_000)
        directory.requiredString("state_key_prefix", 128, "Matrix session directory")
        directory.requiredBase64Url("digest", 43, "Matrix session directory")
        nativeRevision(value)
    }

    private fun validateCommandSequences(values: List<JsonElement>) {
        val identities = mutableSetOf<Pair<String, String>>()
        values.forEach { element ->
            val value = element as? JsonObject
                ?: throw IllegalArgumentException("Matrix Gateway command sequence is invalid.")
            value.requireExactKeys(
                setOf("device_id", "sequence_epoch", "sequence"),
                "Matrix Gateway command sequence",
            )
            val deviceId = value.requiredOpaqueId("device_id", "Matrix Gateway command sequence")
            val sequenceEpoch = value.requiredOpaqueId(
                "sequence_epoch",
                "Matrix Gateway command sequence",
            )
            require(value.requiredLong("sequence", "Matrix Gateway command sequence") >= 0)
            require(identities.add(deviceId to sequenceEpoch)) {
                "Matrix Gateway command sequence identity is duplicated."
            }
        }
    }

    private fun validateSession(value: JsonObject) {
        value.requireExactKeys(
            required = setOf(
                "version", "kind", "gateway_id", "conversation_id", "revision",
                "revision_epoch", "revision_epoch_generation", "state_version",
                "session_id", "state", "updated_at",
            ),
            optional = setOf("session", "source_command_id"),
            label = "Matrix session state",
        )
        require(value.requiredLong("version", "Matrix session state") == 2L)
        require(value.requiredString("kind", 64, "Matrix session state") == "session_state")
        value.requiredOpaqueId("gateway_id", "Matrix session state")
        value.requiredOpaqueId("conversation_id", "Matrix session state")
        val sessionId = value.requiredOpaqueId("session_id", "Matrix session state")
        val state = value.requiredString("state", 32, "Matrix session state")
        require(state in setOf("active", "archived", "deleted"))
        val session = value["session"] as? JsonObject
        require((state == "deleted") == (session == null))
        if (session != null) {
            validateSessionSummary(session)
            require(session.text("session_id") == sessionId)
        }
        require(value.requiredLong("state_version", "Matrix session state") >= 0)
        value.requiredTimestamp("updated_at", "Matrix session state")
        value.optionalOpaqueId("source_command_id", "Matrix session state")
        nativeRevision(value)
    }

    private fun validateWorkspace(value: JsonObject) {
        value.requireExactKeys(
            required = setOf("project", "provider", "permission_mode"),
            optional = setOf("model", "reasoning_effort"),
            label = "Matrix Gateway workspace",
        )
        validateProject(value.requiredObject("project", "Matrix Gateway workspace"))
        value.requiredString("provider", 256, "Matrix Gateway workspace")
        value.optionalString("model", 256, "Matrix Gateway workspace")
        value.optionalString("reasoning_effort", 64, "Matrix Gateway workspace")
        value.requiredString("permission_mode", 128, "Matrix Gateway workspace")
    }

    private fun validateProject(value: JsonObject) {
        value.requireExactKeys(setOf("id", "name", "cwd"), "Matrix project")
        value.requiredOpaqueId("id", "Matrix project")
        value.requiredString("name", 256, "Matrix project")
        value.requiredString("cwd", 8_192, "Matrix project")
    }

    private fun validateSessionSummary(value: JsonObject) {
        value.requireExactKeys(
            required = setOf(
                "session_id", "title", "updated_at", "archived", "status",
                "project", "provider", "extensions",
            ),
            optional = setOf(
                "thread_root_event_id", "activity_phase", "model", "reasoning_effort",
            ),
            label = "Matrix session summary",
        )
        value.requiredOpaqueId("session_id", "Matrix session summary")
        value.optionalString("thread_root_event_id", 512, "Matrix session summary")
        value.requiredString("title", 512, "Matrix session summary")
        value.requiredTimestamp("updated_at", "Matrix session summary")
        value.requiredBoolean("archived", "Matrix session summary")
        require(
            value.requiredString("status", 32, "Matrix session summary") in
                setOf("idle", "running", "stopping", "failed"),
        )
        value.optionalString("activity_phase", 32, "Matrix session summary")?.let {
            require(it in setOf("starting", "working", "stopping", "idle", "failed"))
        }
        validateProject(value.requiredObject("project", "Matrix session summary"))
        value.requiredString("provider", 256, "Matrix session summary")
        value.optionalString("model", 256, "Matrix session summary")
        value.optionalString("reasoning_effort", 64, "Matrix session summary")
        validateSessionExtensionSummaries(
            value.requiredArray("extensions", 128, "Matrix session summary"),
        )
    }

    private fun validateCapabilities(value: JsonObject) {
        value.requireExactKeys(
            setOf(
                "models", "permission_modes", "can_create_session", "can_select_session",
                "can_archive_session", "can_delete_session", "session_extensions",
            ),
            "Matrix Gateway capabilities",
        )
        val models = value.requiredArray("models", 256, "Matrix Gateway capabilities")
            .map { it.requiredObject("Matrix model capability") }
        requireUniqueIds(models, "Matrix model capabilities")
        models.forEach { model ->
            model.requireExactKeys(
                required = setOf("id", "name"),
                optional = setOf("default_reasoning_level", "supported_reasoning_levels"),
                label = "Matrix model capability",
            )
            model.requiredOpaqueId("id", "Matrix model capability")
            model.requiredString("name", 256, "Matrix model capability")
            model.optionalString("default_reasoning_level", 64, "Matrix model capability")
            model.optionalArray(
                "supported_reasoning_levels",
                64,
                "Matrix model capability",
            )?.forEach { entry ->
                val level = entry.requiredObject("Matrix reasoning capability")
                level.requireExactKeys(
                    required = setOf("effort"),
                    optional = setOf("description"),
                    label = "Matrix reasoning capability",
                )
                level.requiredString("effort", 64, "Matrix reasoning capability")
                level.optionalString(
                    "description",
                    4_096,
                    "Matrix reasoning capability",
                    allowEmpty = true,
                )
            }
        }
        val modes = value.requiredArray(
            "permission_modes",
            128,
            "Matrix Gateway capabilities",
        ).map { it.requiredObject("Matrix permission capability") }
        requireUniqueIds(modes, "Matrix permission capabilities")
        modes.forEach { mode ->
            mode.requireExactKeys(setOf("id", "name"), "Matrix permission capability")
            mode.requiredOpaqueId("id", "Matrix permission capability")
            mode.requiredString("name", 256, "Matrix permission capability")
        }
        value.requiredBoolean("can_create_session", "Matrix Gateway capabilities")
        value.requiredBoolean("can_select_session", "Matrix Gateway capabilities")
        value.requiredBoolean("can_archive_session", "Matrix Gateway capabilities")
        value.requiredBoolean("can_delete_session", "Matrix Gateway capabilities")
        val extensions = value.requiredArray(
            "session_extensions",
            128,
            "Matrix Gateway capabilities",
        ).map { it.requiredObject("Matrix extension capability") }
        requireUniqueIds(extensions, "Matrix extension capabilities")
        extensions.forEach(::validateSessionExtensionCapability)
    }

    private fun validateSessionExtensionSummaries(values: List<JsonElement>) {
        val extensions = values.map { it.requiredObject("Matrix session extension") }
        requireUniqueIds(extensions, "Matrix session extensions")
        extensions.forEach { extension ->
            extension.requireExactKeys(setOf("id", "name", "version"), "Matrix session extension")
            extension.requiredOpaqueId("id", "Matrix session extension")
            extension.requiredString("name", 256, "Matrix session extension")
            extension.requiredString("version", 64, "Matrix session extension")
        }
    }

    private fun validateSessionExtensionCapability(value: JsonObject) {
        value.requireExactKeys(
            setOf("id", "name", "description", "version", "settings"),
            "Matrix extension capability",
        )
        value.requiredOpaqueId("id", "Matrix extension capability")
        value.requiredString("name", 256, "Matrix extension capability")
        value.requiredString("description", 4_096, "Matrix extension capability")
        value.requiredString("version", 128, "Matrix extension capability")
        val settings = value.requiredArray("settings", 32, "Matrix extension capability")
            .map { it.requiredObject("Matrix extension setting") }
        requireUniqueIds(settings, "Matrix extension settings")
        settings.forEach { setting ->
            val type = setting.requiredString("type", 16, "Matrix extension setting")
            when (type) {
                "text" -> setting.requireExactKeys(
                    required = setOf("id", "type", "label"),
                    optional = setOf("description", "required", "placeholder", "default_value"),
                    label = "Matrix text extension setting",
                )
                "boolean" -> setting.requireExactKeys(
                    required = setOf("id", "type", "label"),
                    optional = setOf("description", "default_value"),
                    label = "Matrix boolean extension setting",
                )
                else -> error("Matrix extension setting type is unsupported.")
            }
            setting.requiredOpaqueId("id", "Matrix extension setting")
            setting.requiredString("label", 256, "Matrix extension setting")
            setting.optionalString(
                "description",
                2_048,
                "Matrix extension setting",
                allowEmpty = true,
            )
            if (type == "text") {
                setting.optionalBoolean("required", "Matrix text extension setting")
                setting.optionalString(
                    "placeholder",
                    512,
                    "Matrix text extension setting",
                    allowEmpty = true,
                )
                setting.optionalString(
                    "default_value",
                    4_096,
                    "Matrix text extension setting",
                    allowEmpty = true,
                )
            } else {
                setting.optionalBoolean("default_value", "Matrix boolean extension setting")
            }
        }
    }

    private fun requireUniqueIds(values: List<JsonObject>, label: String) {
        val ids = values.map { it.requiredOpaqueId("id", label) }
        require(ids.distinct().size == ids.size) { "$label contain duplicate ids." }
    }

    private fun observeRevision(value: JsonObject) {
        val next = nativeRevision(value)
        val current = latestRevision
        if (current == null || next.generation > current.generation) {
            latestRevision = next
            return
        }
        if (next.generation < current.generation) return
        require(next.epoch == current.epoch) {
            "Matrix events disagree on the Gateway revision epoch."
        }
        if (next.revision >= current.revision) latestRevision = next
    }

    private fun compareEntityState(left: JsonObject, right: JsonObject): Int {
        val first = nativeRevision(left)
        val second = nativeRevision(right)
        if (first.generation != second.generation) {
            return first.generation.compareTo(second.generation)
        }
        require(first.epoch == second.epoch) {
            "Matrix events disagree on the Gateway revision epoch."
        }
        return (left.number("state_version") ?: 0)
            .compareTo(right.number("state_version") ?: 0)
            .takeIf { it != 0 }
            ?: first.revision.compareTo(second.revision).takeIf { it != 0 }
            ?: (left.number("updated_at") ?: 0).compareTo(right.number("updated_at") ?: 0)
    }

    private fun compareRevisions(left: JsonObject, right: JsonObject): Int {
        val first = nativeRevision(left)
        val second = nativeRevision(right)
        if (first.generation != second.generation) return first.generation.compareTo(second.generation)
        require(first.epoch == second.epoch) { "Matrix events disagree on the Gateway revision epoch." }
        return first.revision.compareTo(second.revision)
    }

    private fun nativeRevision(value: JsonObject) = NativeRevision(
        revision = value.requiredLong("revision", "Matrix native revision"),
        epoch = value.requiredOpaqueId("revision_epoch", "Matrix native revision"),
        generation = value.requiredLong("revision_epoch_generation", "Matrix native revision"),
    ).also { require(it.revision >= 0 && it.generation > 0) }
}

private fun JsonObject.text(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

private fun JsonObject.number(key: String): Long? =
    (this[key] as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull

private fun JsonObject.boolean(key: String): Boolean =
    (this[key] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull == true

private fun JsonObject.requireExactKeys(
    required: Set<String>,
    label: String,
) = requireExactKeys(required, emptySet(), label)

private fun JsonObject.requireExactKeys(
    required: Set<String>,
    optional: Set<String>,
    label: String,
) {
    require(keys.containsAll(required) && keys.all { it in required || it in optional }) {
        "$label has missing or unexpected fields."
    }
}

private fun JsonObject.requiredOpaqueId(key: String, label: String): String =
    requiredString(key, 256, label)

private fun JsonObject.requiredBase64Url(key: String, length: Int, label: String): String =
    requiredString(key, length, label).also {
        require(it.length == length && it.matches(Regex("^[A-Za-z0-9_-]+$"))) {
            "$label field $key must be base64url."
        }
    }

private fun JsonObject.optionalOpaqueId(key: String, label: String): String? =
    optionalString(key, 256, label)

private fun JsonObject.requiredString(key: String, maxLength: Int, label: String): String {
    val primitive = this[key] as? JsonPrimitive
        ?: throw IllegalArgumentException("$label field $key must be a string.")
    require(primitive.isString) { "$label field $key must be a string." }
    return primitive.content.also {
        require(it.isNotEmpty() && it.length <= maxLength) {
            "$label field $key has an invalid length."
        }
    }
}

private fun JsonObject.optionalString(
    key: String,
    maxLength: Int,
    label: String,
    allowEmpty: Boolean = false,
): String? {
    if (key !in this) return null
    val primitive = this[key] as? JsonPrimitive
        ?: throw IllegalArgumentException("$label field $key must be a string.")
    require(primitive.isString) { "$label field $key must be a string." }
    return primitive.content.also {
        require((allowEmpty || it.isNotEmpty()) && it.length <= maxLength) {
            "$label field $key has an invalid length."
        }
    }
}

private fun JsonObject.requiredLong(key: String, label: String): Long {
    val primitive = this[key] as? JsonPrimitive
        ?: throw IllegalArgumentException("$label field $key must be an integer.")
    require(!primitive.isString) { "$label field $key must be an integer." }
    return primitive.longOrNull
        ?: throw IllegalArgumentException("$label field $key must be an integer.")
}

private fun JsonObject.requiredTimestamp(key: String, label: String): Long =
    requiredLong(key, label).also { require(it >= 0) { "$label field $key is invalid." } }

private fun JsonObject.requiredBoolean(key: String, label: String): Boolean {
    val primitive = this[key] as? JsonPrimitive
        ?: throw IllegalArgumentException("$label field $key must be a boolean.")
    require(!primitive.isString) { "$label field $key must be a boolean." }
    return primitive.booleanOrNull
        ?: throw IllegalArgumentException("$label field $key must be a boolean.")
}

private fun JsonObject.optionalBoolean(key: String, label: String): Boolean? =
    if (key in this) requiredBoolean(key, label) else null

private fun JsonObject.requiredObject(key: String, label: String): JsonObject =
    this[key] as? JsonObject
        ?: throw IllegalArgumentException("$label field $key must be an object.")

private fun JsonElement.requiredObject(label: String): JsonObject = this as? JsonObject
    ?: throw IllegalArgumentException("$label must be an object.")

private fun JsonObject.requiredArray(
    key: String,
    maxSize: Int,
    label: String,
): List<JsonElement> = (this[key] as? JsonArray)
    ?.also { require(it.size <= maxSize) { "$label field $key is too large." } }
    ?.toList()
    ?: throw IllegalArgumentException("$label field $key must be an array.")

private fun JsonObject.optionalArray(
    key: String,
    maxSize: Int,
    label: String,
): List<JsonElement>? = if (key in this) requiredArray(key, maxSize, label) else null
