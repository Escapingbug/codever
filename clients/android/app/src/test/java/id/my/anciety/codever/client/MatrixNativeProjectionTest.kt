package id.my.anciety.codever.client

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class MatrixNativeProjectionTest {
    @Test
    fun `replays update and lifecycle events that arrive before their root`() {
        val projection = MatrixNativeProjection()
        projection.apply(checkpoint())
        projection.apply(buildJsonObject {
            put("version", 2)
            put("kind", "session_update")
            putRevision(2)
            put("session_id", "session-1")
            put("updated_at", 3)
            put("title", "Recovered title")
            put("model", JsonNull)
        })
        projection.apply(buildJsonObject {
            put("version", 2)
            put("kind", "session_lifecycle")
            putRevision(3)
            put("session_id", "session-1")
            put("state", "archived")
            put("updated_at", 4)
        })

        val session = projection.apply(root())!!["sessions"]!!
            .jsonArray.single().jsonObject
        assertEquals("Recovered title", session.getValue("title").jsonPrimitive.content)
        assertEquals("true", session.getValue("archived").jsonPrimitive.content)
        assertFalse("model" in session)
    }

    @Test
    fun `does not resurrect a session deleted before its root is fetched`() {
        val projection = MatrixNativeProjection()
        projection.apply(checkpoint())
        projection.apply(buildJsonObject {
            put("version", 2)
            put("kind", "session_lifecycle")
            putRevision(2)
            put("session_id", "session-1")
            put("state", "deleted")
            put("updated_at", 4)
        })

        assertEquals(0, projection.apply(root())!!["sessions"]!!.jsonArray.size)
        assertEquals(0, projection.apply(root())!!["sessions"]!!.jsonArray.size)
    }

    @Test
    fun `advances revision from a lightweight room timeline event`() {
        val projection = MatrixNativeProjection()
        projection.apply(checkpoint())
        val state = projection.apply(buildJsonObject {
            put("version", 2)
            put("kind", "gateway_revision")
            putRevision(4)
            put("gateway_id", "gateway-1")
            put("conversation_id", "conversation-1")
            put("updated_at", 4)
            put("source_command_id", "command-4")
        })!!
        assertEquals("4", state.getValue("revision").jsonPrimitive.content)
        assertEquals(0, state.getValue("sessions").jsonArray.size)
    }

    private fun root() = buildJsonObject {
        put("version", 2)
        put("kind", "session_root")
        putRevision(1)
        put("session_id", "session-1")
        put("title", "Initial title")
        put("project", buildJsonObject {
            put("id", "project-1")
            put("name", "codever")
            put("cwd", "/repo")
        })
        put("created_at", 1)
        put("updated_at", 1)
        put("archived", false)
        put("status", "idle")
        put("provider", "codex")
        put("model", "old-model")
        put("permission_mode", "default")
        put("extensions", JsonArray(emptyList()))
    }

    private fun checkpoint() = buildJsonObject {
        put("version", 2)
        put("kind", "gateway_checkpoint")
        put("gateway_id", "gateway-1")
        put("conversation_id", "conversation-1")
        put("revision", 1)
        put("revision_epoch", "revision-epoch-1")
        put("revision_epoch_generation", 1)
        put("state_version", 1)
        put("active_device_count", 1)
        put("workspace", buildJsonObject {
            put("project", buildJsonObject {
                put("id", "project-1")
                put("name", "codever")
                put("cwd", "/repo")
            })
            put("provider", "codex")
            put("permission_mode", "default")
        })
        put("capabilities", buildJsonObject {
            put("can_create_session", true)
        })
        put("updated_at", 1)
    }

    private fun kotlinx.serialization.json.JsonObjectBuilder.putRevision(revision: Long) {
        put("revision", revision)
        put("revision_epoch", "revision-epoch-1")
        put("revision_epoch_generation", 1)
    }
}
