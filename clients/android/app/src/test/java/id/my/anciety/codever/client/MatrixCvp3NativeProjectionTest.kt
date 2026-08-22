package id.my.anciety.codever.client

import id.my.anciety.codever.client.events.ClientMessageKind
import id.my.anciety.codever.client.events.ToolCategory
import id.my.anciety.codever.client.events.ToolPhase
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
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

class MatrixCvp3NativeProjectionTest {
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
            assistant("logical-event-2", "message-1", "replacement body", version = 2),
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
    fun `older assistant message versions cannot truncate the latest text`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(
            sessionReady("session-a", 1, "Session A", 100),
            "\$root-a",
            "\$root-a",
        )

        val latest = projection.applyGatewayEvent(
            assistant("logical-event-v2", "message-1", "这是一句完整的话", version = 2),
            "\$physical-v2",
            "\$root-a",
        )
        val stale = projection.applyGatewayEvent(
            assistant("logical-event-v1", "message-1", "这是", version = 1),
            "\$physical-v1",
            "\$root-a",
        )

        assertEquals("这是一句完整的话", latest.messages.single().text)
        assertTrue(stale.messages.isEmpty())
    }

    @Test
    fun `assistant message versions survive durable restore`() {
        val original = projection()
        original.applyGatewayEvent(projectSnapshot(), "\$project", null)
        original.applyGatewayEvent(
            sessionReady("session-a", 1, "Session A", 100),
            "\$root-a",
            "\$root-a",
        )
        original.applyGatewayEvent(
            assistant("logical-event-v3", "message-1", "complete", version = 3),
            "\$physical-v3",
            "\$root-a",
        )

        val restored = MatrixCvp3NativeProjection(
            gatewayId = { "gateway-1" },
            activeDeviceCount = { 2 },
            initialState = original.durableState(),
        )
        val stale = restored.applyGatewayEvent(
            assistant("logical-event-v2", "message-1", "truncated", version = 2),
            "\$physical-v2",
            "\$root-a",
        )

        assertTrue(stale.messages.isEmpty())
    }

    @Test
    fun `assistant message tool presentation is projected as a tool message`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(
            sessionReady("session-a", 1, "Session A", 100),
            "\$root-a",
            "\$root-a",
        )

        val message = projection.applyGatewayEvent(
            assistantWithToolGroup(),
            "\$tool-message",
            "\$root-a",
        ).messages.single()

        assertEquals(ClientMessageKind.TOOL, message.kind)
        assertEquals("tool-call-1", message.toolGroup?.groupId)
        assertEquals(ToolCategory.READ, message.toolGroup?.tools?.single()?.category)
        assertEquals(ToolPhase.COMPLETED, message.toolGroup?.tools?.single()?.phase)
    }

    @Test
    fun `native tool activity is projected with a tool presentation`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(
            sessionReady("session-a", 1, "Session A", 100),
            "\$root-a",
            "\$root-a",
        )

        val message = projection.applyGatewayEvent(
            toolActivity(),
            "\$tool-activity",
            "\$root-a",
        ).messages.single()

        assertEquals(ClientMessageKind.TOOL, message.kind)
        assertEquals("tool-call-2", message.toolGroup?.groupId)
        assertEquals("Search", message.toolGroup?.tools?.single()?.name)
        assertEquals(ToolCategory.UNKNOWN, message.toolGroup?.tools?.single()?.category)
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

        val restored = MatrixCvp3NativeProjection(
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
    fun `active turn id survives durable restore and clears on completion`() {
        val original = projection()
        original.applyGatewayEvent(projectSnapshot(), "\$project", null)
        original.applyGatewayEvent(
            sessionReady("session-a", 1, "Session A", 100),
            "\$root-a",
            "\$root-a",
        )
        original.applyGatewayEvent(turn("started", 2, "working"), "\$started-a", "\$root-a")

        val running = original.snapshot()!!.getValue("sessions").jsonArray.single().jsonObject
        assertEquals("turn-1", running.getValue("active_turn_id").jsonPrimitive.content)

        val restored = MatrixCvp3NativeProjection(
            gatewayId = { "gateway-1" },
            activeDeviceCount = { 2 },
            initialState = original.durableState(),
        )
        val restoredSession = restored.snapshot()!!
            .getValue("sessions").jsonArray.single().jsonObject
        assertEquals("turn-1", restoredSession.getValue("active_turn_id").jsonPrimitive.content)

        restored.applyGatewayEvent(turn("completed", 3, "idle"), "\$completed-a", "\$root-a")
        val completed = restored.snapshot()!!.getValue("sessions").jsonArray.single().jsonObject
        assertFalse("active_turn_id" in completed)
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

    @Test
    fun `workspace capability catalog survives stale events and durable restore`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(workspaceSnapshot(2, "gpt-5.6-sol"), "\$workspace-2", null)
        projection.applyGatewayEvent(workspaceSnapshot(1, "stale-model"), "\$workspace-1", null)

        val model = projection.snapshot()!!
            .getValue("capabilities").jsonObject
            .getValue("models").jsonArray.single().jsonObject
            .getValue("id").jsonPrimitive.content
        assertEquals("gpt-5.6-sol", model)

        val restored = MatrixCvp3NativeProjection(
            gatewayId = { "gateway-1" },
            activeDeviceCount = { 2 },
            initialState = projection.durableState(),
        )
        assertEquals(
            "gpt-5.6-sol",
            restored.snapshot()!!
                .getValue("capabilities").jsonObject
                .getValue("models").jsonArray.single().jsonObject
                .getValue("id").jsonPrimitive.content,
        )
    }

    @Test
    fun `projects extension capabilities defaults and declarative interactions`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(
            sessionReady("session-a", 1, "Session A", 100),
            "\$root-a",
            "\$root-a",
        )
        val interaction = projection.applyGatewayEvent(
            event(
                eventId = "extension-interaction-1",
                projectId = "project-1",
                sessionId = "session-a",
                payload = buildJsonObject {
                    put("type", "extension.interaction.requested")
                    put("requestId", "request-1")
                    put("extension", buildJsonObject {
                        put("id", "prefix-transform")
                        put("name", "Prefix transform")
                        put("version", "1")
                    })
                    put("cancelActionId", "cancel")
                    put("view", buildJsonObject {
                        put("version", 1)
                        put("title", "Review transformed input")
                        put("elements", JsonArray(emptyList()))
                        put("actions", buildJsonArray {
                            add(buildJsonObject { put("id", "continue"); put("label", "Continue") })
                            add(buildJsonObject { put("id", "cancel"); put("label", "Cancel") })
                        })
                    })
                    put("projection", sessionProjection(2, "Session A", "active", "attention", 200))
                },
            ),
            "\$interaction",
            "\$root-a",
        )

        assertEquals("request-1", interaction.messages.single().requestId)
        assertEquals(
            "prefix-transform",
            projection.snapshot()!!.getValue("capabilities").jsonObject
                .getValue("session_extensions").jsonArray.single().jsonObject
                .getValue("id").jsonPrimitive.content,
        )
    }

    @Test
    fun `scratch sessions and workspace inbox files survive durable restore`() {
        val projection = projection()
        projection.applyGatewayEvent(projectSnapshot(), "\$project", null)
        projection.applyGatewayEvent(
            sessionReady(
                "session-scratch",
                1,
                "Temporary",
                100,
                scope = "scratch",
                cwd = "/private/scratch/session",
            ),
            "\$scratch-root",
            "\$scratch-root",
        )
        projection.applyGatewayEvent(workspaceInboxFile(), "\$inbox-file", null)

        val snapshot = projection.snapshot()!!
        val session = snapshot.getValue("sessions").jsonArray.single().jsonObject
        assertEquals("scratch", session.getValue("scope").jsonPrimitive.content)
        assertEquals("Temporary", session.getValue("project_name").jsonPrimitive.content)
        assertEquals(1, snapshot.getValue("inbox_files").jsonArray.size)

        val restored = MatrixCvp3NativeProjection(
            gatewayId = { "gateway-1" },
            activeDeviceCount = { 2 },
            initialState = projection.durableState(),
        )
        assertEquals(1, restored.snapshot()!!.getValue("inbox_files").jsonArray.size)
    }

    private fun projection() = MatrixCvp3NativeProjection(
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
            put("installedExtensions", buildJsonArray {
                add(buildJsonObject {
                    put("id", "prefix-transform")
                    put("name", "Prefix transform")
                    put("description", "Adds a prefix")
                    put("version", "1")
                    put("settings", JsonArray(emptyList()))
                })
            })
            put("defaultExtensions", buildJsonArray {
                add(buildJsonObject { put("id", "prefix-transform") })
            })
            put("extensionDefaultsRevision", 2)
        },
    )

    private fun workspaceSnapshot(snapshotVersion: Long, model: String) = event(
        eventId = "workspace-snapshot-$snapshotVersion",
        projectId = "project-1",
        payload = buildJsonObject {
            put("type", "workspace.snapshot")
            put("protocolMin", 3)
            put("protocolMax", 3)
            put("gatewayKeyId", "gateway-key-1")
            put("snapshotVersion", snapshotVersion)
            put("capabilities", buildJsonObject {
                put("models", buildJsonArray {
                    add(buildJsonObject {
                        put("id", model)
                        put("name", model)
                        put("default_reasoning_level", "high")
                        put("supported_reasoning_levels", buildJsonArray {
                            add(buildJsonObject { put("effort", "high") })
                        })
                    })
                })
                put("permission_modes", buildJsonArray {
                    add(buildJsonObject { put("id", "default"); put("name", "Default") })
                })
                put("can_create_session", true)
                put("can_select_session", false)
                put("can_archive_session", true)
                put("can_delete_session", true)
                put("session_extensions", buildJsonArray {})
                put("web_push", buildJsonObject {
                    put("vapid_public_key", "B".repeat(87))
                })
            })
        },
    )

    private fun sessionReady(
        sessionId: String,
        stateVersion: Long,
        title: String,
        updatedAt: Long,
        scope: String = "project",
        cwd: String = "/workspace/project",
    ) = event(
        eventId = "ready-$sessionId-$stateVersion",
        projectId = "project-1",
        sessionId = sessionId,
        causationCommandId = "create-$sessionId",
        payload = buildJsonObject {
            put("type", "session.ready")
            put("provider", "codex")
            put("permissionMode", "default")
            put("projection", sessionProjection(stateVersion, title, "active", "idle", updatedAt).let {
                JsonObject(it + mapOf(
                    "scope" to kotlinx.serialization.json.JsonPrimitive(scope),
                    "cwd" to kotlinx.serialization.json.JsonPrimitive(cwd),
                ))
            })
        },
    )

    private fun workspaceInboxFile() = event(
        eventId = "workspace-inbox-file-1",
        projectId = "project-1",
        payload = buildJsonObject {
            put("type", "inbox.file.received")
            put("fileId", "workspace-file-1")
            put("caption", "Generated report")
            put("source", buildJsonObject {
                put("kind", "local-cli")
                put("label", "review-agent")
            })
            put("attachment", buildJsonObject {
                put("id", "attachment-1")
                put("name", "report.pdf")
                put("mimeType", "application/pdf")
                put("size", 12)
                put("sha256", "A".repeat(43))
                put("media", buildJsonObject {
                    put("url", "mxc://example.org/report")
                    put("key", "B".repeat(43))
                    put("iv", "C".repeat(16))
                    put("sha256", "D".repeat(43))
                    put("size", 28)
                })
            })
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

    private fun assistant(
        eventId: String,
        messageId: String,
        body: String,
        version: Int = 1,
    ) = event(
        eventId = eventId,
        projectId = "project-1",
        sessionId = "session-a",
        payload = buildJsonObject {
            put("type", "assistant.message")
            put("messageId", messageId)
            put("messageVersion", version)
            put("partIndex", 0)
            put("format", "markdown")
            put("body", body)
        },
    )

    private fun assistantWithToolGroup() = event(
        eventId = "tool-message-event-1",
        projectId = "project-1",
        sessionId = "session-a",
        payload = buildJsonObject {
            put("type", "assistant.message")
            put("messageId", "tool-message-1")
            put("messageVersion", 1)
            put("partIndex", 0)
            put("format", "plain")
            put("body", "Read file")
            put("ui", buildJsonObject {
                put("kind", "tool_group")
                put("version", 1)
                put("groupId", "tool-call-1")
                put("tools", buildJsonArray {
                    add(buildJsonObject {
                        put("id", "tool-call-1")
                        put("name", "Read")
                        put("title", "Read file")
                        put("detail", "/workspace/file.ts")
                        put("category", "read")
                        put("phase", "completed")
                        put("isError", false)
                        put("startedAt", 990)
                        put("updatedAt", 1000)
                    })
                })
            })
        },
    )

    private fun toolActivity() = event(
        eventId = "tool-activity-event-1",
        projectId = "project-1",
        sessionId = "session-a",
        payload = buildJsonObject {
            put("type", "tool.activity")
            put("toolCallId", "tool-call-2")
            put("toolVersion", 1)
            put("name", "Search")
            put("phase", "started")
            put("projection", sessionProjection(2, "Session A", "active", "working", 200))
        },
    )

    private fun turn(stage: String, stateVersion: Long, activity: String) = event(
        eventId = "turn-$stage-$stateVersion",
        projectId = "project-1",
        sessionId = "session-a",
        causationCommandId = "turn-1",
        payload = buildJsonObject {
            put("type", "turn.$stage")
            put("turnId", "turn-1")
            if (stage == "completed") put("outcome", "succeeded")
            put(
                "projection",
                sessionProjection(stateVersion, "Session A", "active", activity, stateVersion * 100),
            )
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
        put("extensions", buildJsonArray {
            add(buildJsonObject {
                put("id", "prefix-transform")
                put("name", "Prefix transform")
                put("version", "1")
            })
        })
        put("extensionRevision", 1)
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
