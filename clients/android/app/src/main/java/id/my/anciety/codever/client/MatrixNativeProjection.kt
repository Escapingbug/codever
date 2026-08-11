package id.my.anciety.codever.client

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/** Rebuilds the Web bridge's compatibility snapshot from Matrix thread events. */
class MatrixNativeProjection {
    private data class NativeRevision(
        val revision: Long,
        val epoch: String,
        val generation: Long,
    )

    private val sessions = linkedMapOf<String, JsonObject>()
    private val pendingDeltas = linkedMapOf<String, MutableList<JsonObject>>()
    private val deletedSessions = mutableMapOf<String, NativeRevision>()
    private var checkpoint: JsonObject? = null
    private var latestRevision: NativeRevision? = null

    /**
     * Restores the projection baseline cached by the Web bridge. The direct
     * Matrix receiver resumes from a persisted /sync cursor, so after a
     * process restart it may see an incremental root/lifecycle event before
     * another checkpoint. Seeding the projector keeps those live events
     * applicable without replaying old room history.
     */
    @Synchronized
    fun restore(snapshot: JsonObject): JsonObject {
        require(snapshot.number("version") == 1L)
        require(snapshot.text("kind") == "gateway_state")
        val revision = nativeRevision(snapshot)
        val stateVersion = snapshot.number("state_version") ?: error("Gateway state version is missing.")
        val activeDeviceCount = snapshot.number("active_device_count")
            ?: error("Gateway active device count is missing.")
        val workspace = snapshot["workspace"] as? JsonObject
            ?: error("Gateway workspace is missing.")
        val capabilities = snapshot["capabilities"] as? JsonObject
            ?: error("Gateway capabilities are missing.")
        val restoredSessions = snapshot["sessions"] as? JsonArray
            ?: error("Gateway sessions are missing.")

        sessions.clear()
        pendingDeltas.clear()
        deletedSessions.clear()
        restoredSessions.forEach { entry ->
            val session = entry as? JsonObject ?: error("Gateway session is invalid.")
            val sessionId = session.text("id") ?: error("Gateway session id is missing.")
            require(session.number("updated_at") != null)
            require(session.text("project_id") != null)
            require(session.text("project_name") != null)
            require(session.text("cwd") != null)
            require(session.text("provider") != null)
            sessions[sessionId] = session
        }
        checkpoint = buildJsonObject {
            put("version", 2)
            put("kind", "gateway_checkpoint")
            put("revision", revision.revision)
            put("revision_epoch", revision.epoch)
            put("revision_epoch_generation", revision.generation)
            put("state_version", stateVersion)
            put("active_device_count", activeDeviceCount)
            put("workspace", buildJsonObject {
                put("project", buildJsonObject {
                    put("id", workspace.text("project_id") ?: error("Workspace project id is missing."))
                    put("name", workspace.text("project_name") ?: error("Workspace project name is missing."))
                    put("cwd", workspace.text("cwd") ?: error("Workspace cwd is missing."))
                })
                put("provider", workspace.text("provider") ?: error("Workspace provider is missing."))
                workspace.text("model")?.let { put("model", it) }
                workspace.text("reasoning_effort")?.let { put("reasoning_effort", it) }
                put("permission_mode", workspace.text("permission_mode") ?: "default")
            })
            put("capabilities", capabilities)
        }
        latestRevision = revision
        return snapshot() ?: error("Gateway state projection could not be restored.")
    }

    @Synchronized
    fun apply(extension: JsonObject): JsonObject? {
        val kind = extension.text("kind")
        if (kind !in NATIVE_KINDS) return snapshot()
        observeRevision(extension)
        if (kind != "gateway_checkpoint" && isOlderThanCheckpoint(extension)) return snapshot()
        when (kind) {
            "gateway_checkpoint" -> {
                require(extension.number("version") == 2L)
                val current = checkpoint?.number("state_version") ?: -1
                if ((extension.number("state_version") ?: -1) > current) {
                    checkpoint = extension
                    applyCheckpointSessions(extension)
                }
            }
            "gateway_revision" -> Unit
            "session_root" -> applyRoot(extension)
            "session_update" -> applyUpdate(extension, queueIfMissing = true)
            "session_lifecycle" -> applyLifecycle(extension, queueIfMissing = true)
        }
        return snapshot()
    }

    @Synchronized
    fun applyStatus(extension: JsonObject): JsonObject? {
        val sessionId = extension.text("session_id") ?: return snapshot()
        val current = sessions[sessionId] ?: return snapshot()
        val state = extension.text("state").takeIf { it in setOf("running", "stopping", "failed") }
            ?: "idle"
        sessions[sessionId] = JsonObject(current + buildMap {
            put("status", JsonPrimitive(state))
            extension.text("activity_phase")?.let { put("activity_phase", JsonPrimitive(it)) }
        })
        return snapshot()
    }

    private fun applyCheckpointSessions(value: JsonObject) {
        val inventory = value["sessions"] as? JsonArray ?: return
        val checkpointRevision = nativeRevision(value)
        deletedSessions.entries.removeAll { (_, revision) ->
            compareRevisions(revision, checkpointRevision) < 0
        }
        pendingDeltas.entries.removeAll { (_, deltas) ->
            deltas.removeAll { compareRevisions(nativeRevision(it), checkpointRevision) < 0 }
            deltas.isEmpty()
        }
        sessions.clear()
        inventory.forEach { entry ->
            val session = entry as? JsonObject ?: return@forEach
            val sessionId = session.text("session_id") ?: return@forEach
            if (sessionId in deletedSessions) return@forEach
            val project = session["project"] as? JsonObject ?: return@forEach
            val updatedAt = session.number("updated_at") ?: return@forEach
            val projectId = project.text("id") ?: return@forEach
            val projectName = project.text("name") ?: return@forEach
            val cwd = project.text("cwd") ?: return@forEach
            val provider = session.text("provider") ?: return@forEach
            sessions[sessionId] = buildJsonObject {
                put("id", sessionId)
                put("title", session.text("title") ?: "Session")
                put("updated_at", updatedAt)
                put("status", session.text("status") ?: "idle")
                if (session["archived"]?.jsonPrimitive?.contentOrNull == "true") {
                    put("archived", true)
                }
                session.text("activity_phase")?.let { put("activity_phase", it) }
                put("project_id", projectId)
                put("project_name", projectName)
                put("cwd", cwd)
                put("provider", provider)
                session.text("model")?.let { put("model", it) }
                session.text("reasoning_effort")?.let { put("reasoning_effort", it) }
                put("extensions", session["extensions"] as? JsonArray ?: JsonArray(emptyList()))
            }
            drainPendingDeltas(sessionId)
        }
    }

    private fun applyRoot(value: JsonObject) {
        require(value.number("version") == 2L)
        val sessionId = value.text("session_id") ?: return
        if (sessionId in deletedSessions) return
        val updatedAt = value.number("updated_at") ?: return
        val current = sessions[sessionId]
        if (current != null && (current.number("updated_at") ?: 0) > updatedAt) return
        val project = value["project"] as? JsonObject ?: return
        sessions[sessionId] = buildJsonObject {
            put("id", sessionId)
            put("title", value.text("title") ?: "Session")
            put("updated_at", updatedAt)
            put("status", value.text("status") ?: "idle")
            if (value["archived"]?.jsonPrimitive?.contentOrNull == "true") put("archived", true)
            put("project_id", project.text("id") ?: return)
            put("project_name", project.text("name") ?: return)
            put("cwd", project.text("cwd") ?: return)
            put("provider", value.text("provider") ?: return)
            value.text("model")?.let { put("model", it) }
            value.text("reasoning_effort")?.let { put("reasoning_effort", it) }
            put("extensions", value["extensions"] as? JsonArray ?: JsonArray(emptyList()))
        }
        drainPendingDeltas(sessionId)
    }

    private fun applyUpdate(value: JsonObject, queueIfMissing: Boolean) {
        val sessionId = value.text("session_id") ?: return
        val current = sessions[sessionId] ?: run {
            if (queueIfMissing) queuePendingDelta(sessionId, value)
            return
        }
        val updatedAt = value.number("updated_at") ?: return
        if ((current.number("updated_at") ?: 0) > updatedAt) return
        val next = current.toMutableMap()
        next["updated_at"] = JsonPrimitive(updatedAt)
        value.text("title")?.let { next["title"] = JsonPrimitive(it) }
        value.text("provider")?.let { next["provider"] = JsonPrimitive(it) }
        applyNullableText(value, next, "model")
        applyNullableText(value, next, "reasoning_effort")
        (value["extensions"] as? JsonArray)?.let { next["extensions"] = it }
        (value["project"] as? JsonObject)?.let { project ->
            project.text("id")?.let { next["project_id"] = JsonPrimitive(it) }
            project.text("name")?.let { next["project_name"] = JsonPrimitive(it) }
            project.text("cwd")?.let { next["cwd"] = JsonPrimitive(it) }
        }
        sessions[sessionId] = JsonObject(next)
    }

    private fun applyLifecycle(value: JsonObject, queueIfMissing: Boolean) {
        val sessionId = value.text("session_id") ?: return
        val state = value.text("state") ?: return
        val current = sessions[sessionId]
        if (current == null && queueIfMissing) {
            queuePendingDelta(sessionId, value)
            return
        }
        if (state == "deleted") {
            deletedSessions[sessionId] = nativeRevision(value)
            sessions.remove(sessionId)
            return
        }
        current ?: return
        val updatedAt = value.number("updated_at") ?: return
        if ((current.number("updated_at") ?: 0) > updatedAt) return
        sessions[sessionId] = JsonObject(current + buildMap {
            put("updated_at", JsonPrimitive(updatedAt))
            put("status", JsonPrimitive(if (state == "archived") "idle" else state))
            if (state == "archived") put("archived", JsonPrimitive(true))
            else put("archived", JsonPrimitive(false))
        })
    }

    private fun queuePendingDelta(sessionId: String, value: JsonObject) {
        val pending = pendingDeltas.getOrPut(sessionId) { mutableListOf() }
        require(pending.size < MAX_PENDING_DELTAS_PER_SESSION) {
            "Too many Matrix session deltas before root $sessionId"
        }
        pending += value
    }

    private fun drainPendingDeltas(sessionId: String) {
        pendingDeltas.remove(sessionId)
            ?.sortedBy { it.number("updated_at") ?: 0 }
            ?.forEach { value ->
                when (value.text("kind")) {
                    "session_update" -> applyUpdate(value, queueIfMissing = false)
                    "session_lifecycle" -> applyLifecycle(value, queueIfMissing = false)
                }
            }
    }

    private fun applyNullableText(
        source: JsonObject,
        target: MutableMap<String, JsonElement>,
        key: String,
    ) {
        if (key !in source) return
        val text = source.text(key)
        if (text == null) target.remove(key) else target[key] = JsonPrimitive(text)
    }

    @Synchronized
    fun snapshot(): JsonObject? {
        val value = checkpoint ?: return null
        val revision = latestRevision ?: return null
        val workspace = value["workspace"] as? JsonObject ?: return null
        val project = workspace["project"] as? JsonObject ?: return null
        return buildJsonObject {
            put("version", 1)
            put("kind", "gateway_state")
            put("revision", revision.revision)
            put("revision_epoch", revision.epoch)
            put("revision_epoch_generation", revision.generation)
            put("state_version", value.number("state_version") ?: return null)
            put("active_device_count", value.number("active_device_count") ?: return null)
            put("current_session_id", kotlinx.serialization.json.JsonNull)
            put("sessions", JsonArray(sessions.values.sortedByDescending {
                it.number("updated_at") ?: 0
            }))
            put("workspace", buildJsonObject {
                put("project_id", project.text("id") ?: return null)
                put("project_name", project.text("name") ?: return null)
                put("cwd", project.text("cwd") ?: return null)
                put("provider", workspace.text("provider") ?: return null)
                workspace.text("model")?.let { put("model", it) }
                workspace.text("reasoning_effort")?.let { put("reasoning_effort", it) }
                put("permission_mode", workspace.text("permission_mode") ?: "default")
            })
            put("capabilities", value["capabilities"] ?: return null)
        }
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
            "Matrix native events disagree on the revision epoch."
        }
        if (next.revision >= current.revision) latestRevision = next
    }

    private fun nativeRevision(value: JsonObject) = NativeRevision(
            revision = value.number("revision") ?: error("Matrix native revision is missing."),
            epoch = value.text("revision_epoch")
                ?: error("Matrix native revision epoch is missing."),
            generation = value.number("revision_epoch_generation")
                ?: error("Matrix native revision generation is missing."),
        ).also {
            require(it.revision >= 0 && it.generation > 0)
        }

    private fun isOlderThanCheckpoint(value: JsonObject): Boolean {
        val floor = checkpoint?.let(::nativeRevision) ?: return false
        return compareRevisions(nativeRevision(value), floor) < 0
    }

    private fun compareRevisions(left: NativeRevision, right: NativeRevision): Int {
        if (left.generation != right.generation) {
            return left.generation.compareTo(right.generation)
        }
        require(left.epoch == right.epoch) {
            "Matrix native events disagree on the revision epoch."
        }
        return left.revision.compareTo(right.revision)
    }

    private companion object {
        const val MAX_PENDING_DELTAS_PER_SESSION = 256
        val NATIVE_KINDS = setOf(
            "gateway_checkpoint",
            "gateway_revision",
            "session_root",
            "session_update",
            "session_lifecycle",
        )
    }
}

private fun JsonObject.text(key: String): String? =
    this[key]?.jsonPrimitive?.contentOrNull

private fun JsonObject.number(key: String): Long? =
    this[key]?.jsonPrimitive?.longOrNull
