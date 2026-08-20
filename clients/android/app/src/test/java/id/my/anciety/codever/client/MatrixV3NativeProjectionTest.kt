package id.my.anciety.codever.client

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MatrixV3NativeProjectionTest {
    @Test
    fun `out of order state converges and a tombstone removes only its session`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(
            sessionReady("session-a", stateVersion = 5, title = "Newest A", updatedAt = 500),
            "\$root-a",
            "\$root-a",
        )
        projection.applyGatewayEvent(
            sessionReady("session-a", stateVersion = 3, title = "Stale A", updatedAt = 300),
            "\$stale-a",
            "\$stale-a",
        )
        projection.applyGatewayEvent(
            sessionReady("session-b", stateVersion = 1, title = "Session B", updatedAt = 400),
            "\$root-b",
            "\$root-b",
        )

        var sessions = projection.snapshot()!!.getValue("sessions").jsonArray
        assertEquals(listOf("Newest A", "Session B"), sessions.map { sessionTitle(it.jsonObject) })
        assertEquals("\$root-a", projection.threadRootEventId("session-a"))

        projection.applyGatewayEvent(
            sessionLifecycle("session-a", stateVersion = 6, lifecycle = "deleted"),
            "\$deleted-a",
            "\$root-a",
        )
        sessions = projection.snapshot()!!.getValue("sessions").jsonArray
        assertEquals(listOf("Session B"), sessions.map { sessionTitle(it.jsonObject) })
        assertNull(projection.threadRootEventId("session-a"))
        assertEquals("\$root-b", projection.threadRootEventId("session-b"))
    }

    @Test
    fun `logical message ids are stable across duplicate physical Matrix events`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(
            sessionReady("session-a", 1, "Session A", 100),
            "\$root-a",
            "\$root-a",
        )

        val first = projection.applyGatewayEvent(
            assistant("logical-event-1", "message-1", "first body"),
            "\$physical-1",
            "\$root-a",
        )
        val replay = projection.applyGatewayEvent(
            assistant("logical-event-2", "message-1", "replacement body"),
            "\$physical-2",
            "\$root-a",
        )
        val exactDuplicate = projection.applyGatewayEvent(
            assistant("logical-event-1", "message-1", "must be ignored"),
            "\$physical-3",
            "\$root-a",
        )

        assertEquals("assistant:message-1:0", first.messages.single().eventId)
        assertEquals(first.messages.single().eventId, replay.messages.single().eventId)
        assertTrue(exactDuplicate.messages.isEmpty())
        assertFalse(exactDuplicate.changed)
    }

    @Test
    fun `durable projection restores current versions and thread roots`() {
        val original = projection()
        original.applyGatewayEvent(projectSnapshot(), "\$project", null)
        original.applyGatewayEvent(
            sessionReady("session-a", 7, "Restored", 700),
            "\$root-a",
            "\$root-a",
        )

        val restored = MatrixV3NativeProjection(
            gatewayId = { "gateway-1" },
            activeDeviceCount = { 2 },
            initialState = original.durableState(),
        )

        assertEquals("\$root-a", restored.threadRootEventId("session-a"))
        assertEquals("Restored", sessionTitle(restored.snapshot()!!
            .getValue("sessions").jsonArray.single().jsonObject))
        val duplicate = restored.applyGatewayEvent(
            sessionReady("session-a", 7, "Duplicate", 700),
            "\$duplicate",
            "\$duplicate",
        )
        assertFalse(duplicate.changed)
    }

    @Test
    fun `a thread directory latest event can discover a session without its ready event`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(
            sessionLifecycle("session-c", stateVersion = 4, lifecycle = "active"),
            "\$latest-c",
            "\$root-c",
        )

        assertEquals("\$root-c", projection.threadRootEventId("session-c"))
        assertEquals(
            listOf("session-c"),
            projection.snapshot()!!.getValue("sessions").jsonArray
                .map { it.jsonObject.getValue("id").jsonPrimitive.content },
        )
    }

    private fun projection() = MatrixV3NativeProjection(
        gatewayId = { "gateway-1" },
        activeDeviceCount = { 2 },
    )

    private fun projectSnapshot() = event(
        eventId = "project-snapshot-1",
        projectId = "project-1",
        payload = buildJsonObject {
            put("type", "project.snapshot")
            put("snapshotVersion", 1)
            put("name", "Project")
            put("cwd", "/workspace/project")
            put("provider", "codex")
            put("permissionMode", "default")
        },
    )

    private fun sessionReady(
        sessionId: String,
        stateVersion: Long,
        title: String,
        updatedAt: Long,
    ) = event(
        eventId = "ready-$sessionId-$stateVersion",
        projectId = "project-1",
        sessionId = sessionId,
        causationCommandId = "create-$sessionId",
        payload = buildJsonObject {
            put("type", "session.ready")
            put("provider", "codex")
            put("permissionMode", "default")
            put("projection", sessionProjection(stateVersion, title, "active", "idle", updatedAt))
        },
    )

    private fun sessionLifecycle(
        sessionId: String,
        stateVersion: Long,
        lifecycle: String,
    ) = event(
        eventId = "lifecycle-$sessionId-$stateVersion",
        projectId = "project-1",
        sessionId = sessionId,
        causationCommandId = "delete-$sessionId",
        payload = buildJsonObject {
            put("type", "session.lifecycle")
            put("projection", sessionProjection(stateVersion, "Newest A", lifecycle, "idle", 600))
        },
    )

    private fun assistant(eventId: String, messageId: String, body: String) = event(
        eventId = eventId,
        projectId = "project-1",
        sessionId = "session-a",
        payload = buildJsonObject {
            put("type", "assistant.message")
            put("messageId", messageId)
            put("partIndex", 0)
            put("format", "markdown")
            put("body", body)
        },
    )

    private fun sessionProjection(
        stateVersion: Long,
        title: String,
        lifecycle: String,
        activity: String,
        updatedAt: Long,
    ) = buildJsonObject {
        put("stateVersion", stateVersion)
        put("title", title)
        put("lifecycle", lifecycle)
        put("activity", activity)
        put("updatedAt", updatedAt)
    }

    private fun event(
        eventId: String,
        projectId: String,
        payload: JsonObject,
        sessionId: String? = null,
        causationCommandId: String? = null,
    ) = buildJsonObject {
        put("kind", "codever.event")
        put("version", 3)
        put("eventId", eventId)
        put("workspaceId", "workspace-1")
        put("projectId", projectId)
        sessionId?.let { put("sessionId", it) }
        causationCommandId?.let { put("causationCommandId", it) }
        put("occurredAt", 1000)
        put("payload", payload)
    }

    private fun sessionTitle(session: JsonObject) = session.getValue("title").jsonPrimitive.content
}
