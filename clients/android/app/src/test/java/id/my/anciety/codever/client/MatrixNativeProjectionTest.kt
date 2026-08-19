package id.my.anciety.codever.client

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class MatrixNativeProjectionTest {
    @Test
    fun `builds inventory from independent Gateway and session Room State`() {
        val projection = MatrixNativeProjection()
        val entity = sessionState("session-1", 2)
        assertNull(projection.applyRoomState(entity))
        val state = projection.applyRoomState(gatewayState(2))!!
        assertEquals("session-1", state.sessions().single().getValue("id").jsonPrimitive.content)
    }

    @Test
    fun `Gateway first exposes an empty view then accepts session state independently`() {
        val projection = MatrixNativeProjection()
        assertEquals(0, projection.applyRoomState(gatewayState(1))!!.sessions().size)
        val state = projection.applyRoomState(sessionState("session-1", 2))!!
        assertEquals("session-1", state.sessions().single().getValue("id").jsonPrimitive.content)
    }

    @Test
    fun `complete Room State batch publishes atomically and invalid batch rolls back`() {
        val projection = MatrixNativeProjection()
        val snapshot = projection.applyRoomStateBatch(listOf(
            gatewayState(2),
            sessionState("session-1", 2),
            sessionState("session-2", 3),
        ))!!
        assertEquals(setOf("session-1", "session-2"), snapshot.sessions().map {
            it.getValue("id").jsonPrimitive.content
        }.toSet())

        val before = projection.snapshot()
        assertThrows(IllegalArgumentException::class.java) {
            projection.applyRoomStateBatch(listOf(
                gatewayState(5),
                tombstone("session-1", 4),
                JsonObject(sessionState("broken", 5) + mapOf(
                    "state" to JsonPrimitive("invalid"),
                )),
            ))
        }
        assertEquals(before, projection.snapshot())
    }

    @Test
    fun `updates one session without waiting for a global inventory commit`() {
        val projection = MatrixNativeProjection()
        val before = sessionState("session-1", 2, "Before")
        val after = sessionState("session-1", 3, "After")
        projection.applyRoomState(before)
        projection.applyRoomState(gatewayState(2))
        projection.applyRoomState(after)
        assertEquals(
            "After",
            projection.snapshot()!!.sessions().single()
                .getValue("title").jsonPrimitive.content,
        )
    }

    @Test
    fun `directory replacement removes missing entries but preserves newer live state`() {
        val projection = MatrixNativeProjection()
        projection.applyRoomStateBatch(listOf(
            gatewayState(2),
            sessionState("kept", 2),
            sessionState("removed", 2),
        ))
        projection.applyRoomState(sessionState("arrived-live", 4))
        val committed = JsonObject(gatewayState(5) + mapOf(
            "session_directory" to buildJsonObject {
                put("generation", 5); put("state_version", 3); put("slot", 2)
                put("page_count", 1); put("state_key_prefix", "codever.directory")
                put("digest", "RBNvo1WzZ4oRRq0W9-hknpT7T8If536DEMBg9hyq_4o")
            },
        ))
        val snapshot = projection.applyRoomStateBatch(listOf(
            committed,
            sessionState("kept", 3),
        ))!!
        assertEquals(
            setOf("arrived-live", "kept"),
            snapshot.sessions().map { it.getValue("id").jsonPrimitive.content }.toSet(),
        )
    }

    @Test
    fun `Gateway directory commit requires a new authoritative batch`() {
        val projection = MatrixNativeProjection()
        val current = gatewayState(2)
        projection.applyRoomStateBatch(listOf(current, sessionState("removed", 2)))
        assertEquals(false, projection.requiresAuthoritativeDirectoryRefresh(
            JsonObject(current + mapOf("updated_at" to JsonPrimitive(42))),
        ))
        val committed = JsonObject(gatewayState(5) + mapOf(
            "session_directory" to buildJsonObject {
                put("generation", 5); put("state_version", 5); put("slot", 2)
                put("page_count", 0); put("state_key_prefix", "codever.directory")
                put("digest", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
            },
        ))
        assertEquals(true, projection.requiresAuthoritativeDirectoryRefresh(committed))
        assertEquals(false, projection.requiresCommandScopeRefresh(committed))
        projection.applyRoomStateBatch(listOf(committed))
        assertEquals(0, projection.snapshot()!!.sessions().size)
    }

    @Test
    fun `older directory fetch cannot overwrite a newer live commit`() {
        val projection = MatrixNativeProjection()
        projection.applyRoomStateBatch(listOf(
            gatewayState(2),
            sessionState("removed", 2),
        ))
        projection.applyRoomState(gatewayState(5))
        assertThrows(IllegalArgumentException::class.java) {
            projection.applyRoomStateBatch(listOf(
                gatewayState(3),
                sessionState("removed", 3),
            ))
        }
        assertEquals(false, projection.requiresAuthoritativeDirectoryRefresh(gatewayState(5)))
        projection.applyRoomStateBatch(listOf(gatewayState(5)))
        assertEquals(0, projection.snapshot()!!.sessions().size)
    }

    @Test
    fun `timeline history advances revision but never creates inventory`() {
        val projection = MatrixNativeProjection()
        projection.applyRoomState(gatewayState(1))
        projection.applyTimeline(buildJsonObject {
            put("version", 2); put("kind", "session_root"); putRevision(4)
            put("session_id", "timeline-only")
        })
        assertEquals(0, projection.snapshot()!!.sessions().size)
        assertEquals("4", projection.snapshot()!!.getValue("revision").jsonPrimitive.content)
    }

    @Test
    fun `Gateway heartbeat refreshes public liveness without advancing semantic state`() {
        val projection = MatrixNativeProjection()
        projection.applyRoomState(gatewayState(1))
        val heartbeat = JsonObject(gatewayState(1) + mapOf(
            "updated_at" to JsonPrimitive(42),
        ))
        val snapshot = projection.applyRoomState(heartbeat)!!
        assertEquals("1", snapshot.getValue("state_version").jsonPrimitive.content)
        assertEquals("1", snapshot.getValue("revision").jsonPrimitive.content)
        assertEquals("42", snapshot.getValue("updated_at").jsonPrimitive.content)
    }

    @Test
    fun `fresh authenticated session state also refreshes public Gateway liveness`() {
        val projection = MatrixNativeProjection()
        projection.applyRoomState(gatewayState(1))
        val freshSession = JsonObject(sessionState("session-1", 2) + mapOf(
            "updated_at" to JsonPrimitive(42),
        ))

        val snapshot = projection.applyRoomState(freshSession)!!

        assertEquals("42", snapshot.getValue("updated_at").jsonPrimitive.content)
        assertEquals("2", snapshot.getValue("revision").jsonPrimitive.content)
    }

    @Test
    fun `tombstone prevents stale state from resurrecting a deleted session`() {
        val projection = MatrixNativeProjection()
        val current = sessionState("session-1", 2)
        val deleted = tombstone("session-1", 4)
        projection.applyRoomState(current)
        projection.applyRoomState(gatewayState(2))
        projection.applyRoomState(deleted)
        projection.applyRoomState(sessionState("session-1", 3, "Stale"))
        assertEquals(0, projection.snapshot()!!.sessions().size)
        assertEquals("deleted", projection.sessionLifecycleState("session-1"))
    }

    @Test
    fun `older tombstone cannot complete while newer active entity remains projected`() {
        val projection = MatrixNativeProjection()
        projection.applyRoomState(gatewayState(2))
        projection.applyRoomState(sessionState("session-1", 5))
        projection.applyRoomState(tombstone("session-1", 4))

        assertEquals("active", projection.sessionLifecycleState("session-1"))
        assertEquals(1, projection.snapshot()!!.sessions().size)
    }

    @Test
    fun `new revision generation discards retired generation entities`() {
        val projection = MatrixNativeProjection()
        val old = sessionState("old", 2)
        projection.applyRoomState(old)
        projection.applyRoomState(gatewayState(2))
        val next = JsonObject(gatewayState(1) + mapOf(
            "revision_epoch" to JsonPrimitive("epoch-2"),
            "revision_epoch_generation" to JsonPrimitive(2),
        ))
        projection.applyRoomState(next)
        assertEquals(0, projection.snapshot()!!.sessions().size)
    }

    @Test
    fun `rejects incomplete or duplicate Gateway capabilities`() {
        val projection = MatrixNativeProjection()
        assertThrows(IllegalArgumentException::class.java) {
            projection.applyRoomState(JsonObject(gatewayState(1) + mapOf(
                "capabilities" to buildJsonObject { put("can_create_session", true) },
            )))
        }
        val duplicateModes = capabilities(permissionModeIds = listOf("default", "default"))
        assertThrows(IllegalArgumentException::class.java) {
            projection.applyRoomState(JsonObject(gatewayState(1) + mapOf(
                "capabilities" to duplicateModes,
            )))
        }
    }

    private fun gatewayState(version: Long) = buildJsonObject {
        put("version", 2); put("kind", "gateway_state")
        put("gateway_id", "gateway-1"); put("conversation_id", "conversation-1")
        putRevision(version); put("state_version", version)
        put("active_device_count", 1)
        put("command_sequences", JsonArray(listOf(buildJsonObject {
            put("device_id", "device-1")
            put("sequence_epoch", "certificate-1")
            put("sequence", 0)
        })))
        put("workspace", buildJsonObject {
            put("project", buildJsonObject {
                put("id", "project-1"); put("name", "codever"); put("cwd", "/repo")
            })
            put("provider", "codex"); put("permission_mode", "default")
        })
        put("capabilities", capabilities())
        put("session_directory", buildJsonObject {
            put("generation", version)
            put("state_version", version)
            put("slot", version % 3)
            put("page_count", 0)
            put("state_key_prefix", "codever.directory")
            put("digest", "RBNvo1WzZ4oRRq0W9-hknpT7T8If536DEMBg9hyq_4o")
        })
        put("updated_at", version)
    }

    private fun capabilities(
        permissionModeIds: List<String> = listOf("default"),
    ) = buildJsonObject {
        put("models", JsonArray(emptyList()))
        put("permission_modes", JsonArray(permissionModeIds.map { id ->
            buildJsonObject { put("id", id); put("name", "Default") }
        }))
        put("can_create_session", true)
        put("can_select_session", false)
        put("can_archive_session", true)
        put("can_delete_session", true)
        put("session_extensions", JsonArray(emptyList()))
    }

    private fun sessionState(id: String, version: Long, title: String = "Work") = buildJsonObject {
        put("version", 2); put("kind", "session_state")
        put("gateway_id", "gateway-1"); put("conversation_id", "conversation-1")
        putRevision(version); put("state_version", version)
        put("session_id", id); put("state", "active")
        put("session", buildJsonObject {
            put("session_id", id); put("title", title); put("updated_at", version)
            put("archived", false); put("status", "idle")
            put("project", buildJsonObject {
                put("id", "project-1"); put("name", "codever"); put("cwd", "/repo")
            })
            put("provider", "codex"); put("extensions", JsonArray(emptyList()))
        })
        put("updated_at", version)
    }

    private fun tombstone(id: String, version: Long) = buildJsonObject {
        put("version", 2); put("kind", "session_state")
        put("gateway_id", "gateway-1"); put("conversation_id", "conversation-1")
        putRevision(version); put("state_version", version)
        put("session_id", id); put("state", "deleted"); put("updated_at", version)
    }

    private fun kotlinx.serialization.json.JsonObjectBuilder.putRevision(revision: Long) {
        put("revision", revision); put("revision_epoch", "epoch-1")
        put("revision_epoch_generation", 1)
    }

    private fun JsonObject.sessions() = getValue("sessions").jsonArray.map { it.jsonObject }
    private fun JsonObject.text(key: String) = getValue(key).jsonPrimitive.content
}
