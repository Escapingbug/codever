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
    fun `restores cached gateway state before accepting a live incremental root`() {
        val original = MatrixNativeProjection()
        val cached = original.apply(
            checkpoint(sessions = JsonArray(listOf(checkpointSession()))),
        )!!
        val restored = MatrixNativeProjection()

        restored.restore(cached)
        val state = restored.apply(root(revision = 2))!!

        assertEquals("2", state.getValue("revision").jsonPrimitive.content)
        assertEquals(
            setOf("session-existing", "session-1"),
            state.getValue("sessions").jsonArray
                .map { it.jsonObject.getValue("id").jsonPrimitive.content }
                .toSet(),
        )
    }

    @Test
    fun `bootstraps existing sessions from a checkpoint without historical roots`() {
        val projection = MatrixNativeProjection()
        val state = projection.apply(checkpoint(sessions = JsonArray(listOf(checkpointSession()))))!!

        val session = state.getValue("sessions").jsonArray.single().jsonObject
        assertEquals("session-existing", session.getValue("id").jsonPrimitive.content)
        assertEquals("Existing work", session.getValue("title").jsonPrimitive.content)
        assertEquals("codever", session.getValue("project_name").jsonPrimitive.content)
    }

    @Test
    fun `does not let a duplicate checkpoint erase a newer session root`() {
        val projection = MatrixNativeProjection()
        val initial = checkpoint(sessions = JsonArray(listOf(checkpointSession())))
        projection.apply(initial)
        projection.apply(root())

        val sessions = projection.apply(initial)!!.getValue("sessions").jsonArray
        assertEquals(
            setOf("session-1", "session-existing"),
            sessions.map { it.jsonObject.getValue("id").jsonPrimitive.content }.toSet(),
        )
    }

    @Test
    fun `does not let historical events mutate a newer checkpoint inventory`() {
        val projection = MatrixNativeProjection()
        projection.apply(checkpoint(
            sessions = JsonArray(listOf(checkpointSession())),
            revision = 5,
            stateVersion = 2,
        ))

        projection.apply(root(revision = 1))
        projection.apply(buildJsonObject {
            put("version", 2)
            put("kind", "session_lifecycle")
            putRevision(4)
            put("session_id", "session-existing")
            put("state", "deleted")
            put("updated_at", 8)
        })

        val sessions = projection.snapshot()!!.getValue("sessions").jsonArray
        assertEquals(
            listOf("session-existing"),
            sessions.map { it.jsonObject.getValue("id").jsonPrimitive.content },
        )
    }

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

    private fun root(revision: Long = 1) = buildJsonObject {
        put("version", 2)
        put("kind", "session_root")
        putRevision(revision)
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

    private fun checkpoint(
        sessions: JsonArray? = null,
        revision: Long = 1,
        stateVersion: Long = 1,
    ) = buildJsonObject {
        put("version", 2)
        put("kind", "gateway_checkpoint")
        put("gateway_id", "gateway-1")
        put("conversation_id", "conversation-1")
        put("revision", revision)
        put("revision_epoch", "revision-epoch-1")
        put("revision_epoch_generation", 1)
        put("state_version", stateVersion)
        put("active_device_count", 1)
        sessions?.let { put("sessions", it) }
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

    private fun checkpointSession() = buildJsonObject {
        put("session_id", "session-existing")
        put("title", "Existing work")
        put("updated_at", 7)
        put("archived", false)
        put("status", "idle")
        put("project", buildJsonObject {
            put("id", "project-1")
            put("name", "codever")
            put("cwd", "/repo")
        })
        put("provider", "codex")
        put("extensions", JsonArray(emptyList()))
    }

    private fun kotlinx.serialization.json.JsonObjectBuilder.putRevision(revision: Long) {
        put("revision", revision)
        put("revision_epoch", "revision-epoch-1")
        put("revision_epoch_generation", 1)
    }
}
