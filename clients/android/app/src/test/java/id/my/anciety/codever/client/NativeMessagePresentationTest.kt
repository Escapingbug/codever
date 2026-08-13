package id.my.anciety.codever.client

import id.my.anciety.codever.client.events.ToolCategory
import id.my.anciety.codever.client.events.ToolPhase
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NativeMessagePresentationTest {
    @Test
    fun `decodes structured tool groups from Matrix message extensions`() {
        val extension = buildJsonObject {
            put("version", 1)
            put("kind", "message")
            put("ui", buildJsonObject {
                put("kind", "tool_group")
                put("version", 1)
                put("groupId", "normal-tool-group:1")
                put("tools", buildJsonArray {
                    add(buildJsonObject {
                        put("id", "read-1")
                        put("name", "Read")
                        put("title", "Read")
                        put("detail", "/repo/src/index.ts")
                        put("category", "read")
                        put("phase", "started")
                        put("isError", false)
                        put("startedAt", 1_000)
                        put("updatedAt", 1_000)
                    })
                })
            })
        }

        val group = decodeMatrixToolGroup(extension)!!

        assertEquals("normal-tool-group:1", group.groupId)
        assertEquals(1, group.tools.size)
        assertEquals("Read", group.tools.single().name)
        assertEquals("/repo/src/index.ts", group.tools.single().detail)
        assertEquals(ToolCategory.READ, group.tools.single().category)
        assertEquals(ToolPhase.STARTED, group.tools.single().phase)
    }

    @Test
    fun `leaves ordinary and malformed Matrix messages without tool presentation`() {
        assertNull(decodeMatrixToolGroup(buildJsonObject {
            put("version", 1)
            put("kind", "message")
        }))
        assertNull(decodeMatrixToolGroup(buildJsonObject {
            put("version", 1)
            put("kind", "message")
            put("ui", buildJsonObject {
                put("kind", "tool_group")
                put("version", 1)
                put("groupId", "broken")
            })
        }))
    }
}
