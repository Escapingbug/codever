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
    private val deletedSessions = mutableSetOf<String>()
    private var checkpoint: JsonObject? = null
    private var latestRevision: NativeRevision? = null

    @Synchronized
    fun apply(extension: JsonObject): JsonObject? {
        val kind = extension.text("kind")
        if (kind !in NATIVE_KINDS) return snapshot()
        observeRevision(extension)
        when (kind) {
            "gateway_checkpoint" -> {
                require(extension.number("version") == 2L)
                val current = checkpoint?.number("state_version") ?: -1
                if ((extension.number("state_version") ?: -1) >= current) checkpoint = extension
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
            deletedSessions += sessionId
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
        val next = NativeRevision(
            revision = value.number("revision") ?: error("Matrix native revision is missing."),
            epoch = value.text("revision_epoch")
                ?: error("Matrix native revision epoch is missing."),
            generation = value.number("revision_epoch_generation")
                ?: error("Matrix native revision generation is missing."),
        )
        require(next.revision >= 0 && next.generation > 0)
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
