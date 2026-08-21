package id.my.anciety.codever.client.command

import id.my.anciety.codever.security.codever.PairingOperation
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class CommandPayloadValidatorTest {
    @Test
    fun `validates every protocol command operation into a typed payload`() {
        val payloads = listOf(
            buildJsonObject {
                put("operation", "prompt")
                put("sessionId", "session-1")
                put("text", "hello")
            },
            buildJsonObject {
                put("operation", "cancel")
                put("sessionId", "session-1")
                put("targetCommandId", "command-1")
            },
            buildJsonObject {
                put("operation", "decision")
                put("sessionId", "session-1")
                put("requestId", "request-1")
                put("decision", "allow_session")
            },
            buildJsonObject {
                put("operation", "session.settings")
                put("sessionId", "session-1")
                put("model", "gpt-5")
                put("provider", "cursor")
                put("reasoningEffort", "high")
                put("permissionMode", "accept_edits")
                put("cwd", "/workspace")
                put("projectName", "Project")
            },
            buildJsonObject { put("operation", "session.create") },
            lifecycle("session.archive"),
            lifecycle("session.restore"),
            lifecycle("session.delete"),
            buildJsonObject {
                put("operation", "device.invite")
                put("lifetimeMs", 30_000)
            },
        )

        assertEquals(CommandOperation.entries, payloads.map { CommandPayloadValidator.validate(it).operation })
        assertTrue(CommandPayloadValidator.validate(payloads[0]) is PromptCommandPayload)
        assertTrue(CommandPayloadValidator.validate(payloads[4]) is SessionCreateCommandPayload)
        assertTrue(CommandPayloadValidator.validate(payloads[5]) is SessionLifecycleCommandPayload)
    }

    @Test
    fun `rejects unknown missing extra and incorrectly typed fields`() {
        assertInvalid(buildJsonObject { put("operation", "session.select") })
        assertInvalid(buildJsonObject {
            put("operation", "prompt")
            put("text", "missing session")
        })
        assertInvalid(buildJsonObject {
            put("operation", "cancel")
            put("sessionId", "session-1")
            put("extra", true)
        })
        assertInvalid(buildJsonObject {
            put("operation", "decision")
            put("sessionId", "session-1")
            put("requestId", 1)
            put("decision", "deny")
        })
        assertInvalid(buildJsonObject {
            put("operation", "session.archive")
            put("sessionId", "x".repeat(257))
        })
    }

    @Test
    fun `decision accepts bounded extension action ids`() {
        val parsed = CommandPayloadValidator.validate(buildJsonObject {
            put("operation", "decision")
            put("sessionId", "session-1")
            put("requestId", "interaction-1")
            put("decision", "continue.safe")
        }) as DecisionCommandPayload
        assertEquals("continue.safe", parsed.decision)
        assertInvalid(buildJsonObject {
            put("operation", "decision")
            put("sessionId", "session-1")
            put("requestId", "interaction-1")
            put("decision", "Unsafe action")
        })
    }

    @Test
    fun `prompt requires content and enforces attachment count and aggregate bytes`() {
        assertInvalid(buildJsonObject {
            put("operation", "prompt")
            put("sessionId", "session-1")
            put("text", "")
        })

        val attachmentOnly = buildJsonObject {
            put("operation", "prompt")
            put("sessionId", "session-1")
            put("text", "")
            put("attachments", buildJsonArray { add(attachment("one", 1)) })
        }
        val parsed = CommandPayloadValidator.validate(attachmentOnly) as PromptCommandPayload
        assertEquals(1, parsed.attachments.size)

        assertInvalid(buildJsonObject {
            put("operation", "prompt")
            put("sessionId", "session-1")
            put("text", "ok")
            put("attachments", buildJsonArray {
                repeat(11) { add(attachment("item-$it", 1)) }
            })
        })
        assertInvalid(buildJsonObject {
            put("operation", "prompt")
            put("sessionId", "session-1")
            put("text", "ok")
            put("attachments", buildJsonArray {
                repeat(3) { add(attachment("large-$it", 40L * 1024 * 1024)) }
            })
        })
    }

    @Test
    fun `attachment validation is strict and bounded`() {
        assertInvalid(promptWith(attachment("too-large", CommandPayloadValidator.MAX_ATTACHMENT_BYTES + 1)))
        assertInvalid(promptWith(attachment("bad-hash", 1, sha256 = "not-base64url")))
        assertInvalid(promptWith(attachment("bad-url", 1, url = "https://matrix.example/media")))
        assertInvalid(promptWith(attachment("bad-media-size", 1, mediaSize = 0)))
        assertInvalid(promptWith(attachment("extra", 1, extra = true)))
    }

    @Test
    fun `session settings require at least one valid bounded setting`() {
        assertInvalid(buildJsonObject {
            put("operation", "session.settings")
            put("sessionId", "session-1")
        })
        assertInvalid(buildJsonObject {
            put("operation", "session.settings")
            put("sessionId", "session-1")
            put("model", "")
        })
        assertInvalid(buildJsonObject {
            put("operation", "session.settings")
            put("sessionId", "session-1")
            put("cwd", "x".repeat(4_097))
        })
        assertInvalid(buildJsonObject {
            put("operation", "session.settings")
            put("sessionId", "session-1")
            put("permissionMode", "always_allow")
        })
        assertTrue(
            CommandPayloadValidator.validate(
                buildJsonObject {
                    put("operation", "session.settings")
                    put("sessionId", "session-1")
                    put("reasoningEffort", "x".repeat(64))
                },
            ) is SessionSettingsCommandPayload,
        )
    }

    @Test
    fun `session create accepts bounded declarative extension bindings`() {
        val payload = buildJsonObject {
            put("operation", "session.create")
            put("scope", "scratch")
            put("extensions", buildJsonArray {
                add(buildJsonObject {
                    put("id", "has-privacy")
                    put("config", buildJsonObject {
                        put("contextId", "metapp-payroll")
                        put("reviewRequired", true)
                    })
                })
            })
        }
        val parsed = CommandPayloadValidator.validate(payload) as SessionCreateCommandPayload

        assertEquals("scratch", parsed.scope)
        assertEquals(1, parsed.extensions.size)
        assertEquals("has-privacy", parsed.extensions.single().id)
        assertEquals("metapp-payroll", parsed.extensions.single().config?.get("contextId")?.let {
            (it as JsonPrimitive).content
        })
        assertFalse(parsed.toString().contains("metapp-payroll"))

        assertInvalid(buildJsonObject {
            put("operation", "session.create")
            put("extensions", buildJsonArray {
                repeat(9) { index -> add(extension("extension-$index")) }
            })
        })
        assertInvalid(buildJsonObject {
            put("operation", "session.create")
            put("extensions", buildJsonArray {
                add(extension("duplicate"))
                add(extension("duplicate"))
            })
        })
        assertInvalid(buildJsonObject {
            put("operation", "session.create")
            put("extensions", buildJsonArray {
                add(buildJsonObject {
                    put("id", "too-many-settings")
                    put("config", buildJsonObject {
                        repeat(33) { index -> put("setting-$index", true) }
                    })
                })
            })
        })
    }

    @Test
    fun `device invitation accepts only bounded integer lifetime`() {
        for (lifetime in listOf(30_000L, 600_000L)) {
            val parsed = CommandPayloadValidator.validate(
                buildJsonObject {
                    put("operation", "device.invite")
                    put("lifetimeMs", lifetime)
                },
            ) as DeviceInviteCommandPayload
            assertEquals(lifetime, parsed.lifetimeMs)
        }
        assertInvalid(buildJsonObject {
            put("operation", "device.invite")
            put("lifetimeMs", 29_999)
        })
        assertInvalid(buildJsonObject {
            put("operation", "device.invite")
            put("lifetimeMs", JsonPrimitive(30_000.5))
        })
    }

    @Test
    fun `authorization is exactly the signed certificate grant set`() {
        assertEquals(
            CommandAuthorizationSource.CERTIFICATE_GRANT,
            CommandAuthorizationPolicy.evaluate(
                CommandOperation.PROMPT,
                listOf(PairingOperation.PROMPT),
            ).source,
        )
        assertEquals(
            CommandAuthorizationSource.CERTIFICATE_GRANT,
            CommandAuthorizationPolicy.evaluate(
                CommandOperation.SESSION_ARCHIVE,
                listOf(PairingOperation.SESSION_ARCHIVE),
            ).source,
        )
        assertEquals(
            CommandAuthorizationSource.CERTIFICATE_GRANT,
            CommandAuthorizationPolicy.evaluate(
                CommandOperation.DEVICE_INVITE,
                listOf(PairingOperation.DEVICE_INVITE),
            ).source,
        )

        val denied = CommandAuthorizationPolicy.evaluate(
            CommandOperation.SESSION_DELETE,
            listOf(PairingOperation.PROMPT),
        )
        assertFalse(denied.authorized)
        assertEquals(CommandAuthorizationSource.DENIED, denied.source)
        assertFalse(
            CommandAuthorizationPolicy.evaluate(
                CommandOperation.DEVICE_INVITE,
                emptyList(),
            ).authorized,
        )
    }

    @Test
    fun `validated sensitive payloads redact prompt and encrypted media secrets`() {
        val parsed = CommandPayloadValidator.validate(
            promptWith(
                attachment("attachment-1", 1, name = "secret-name"),
                text = "secret-prompt",
            ),
        )
        val rendered = parsed.toString()
        assertFalse(rendered.contains("secret-prompt"))
        assertFalse(rendered.contains("secret-name"))
        assertFalse(rendered.contains("a".repeat(43)))
    }

    private fun lifecycle(operation: String) = buildJsonObject {
        put("operation", operation)
        put("sessionId", "session-1")
    }

    private fun extension(id: String) = buildJsonObject {
        put("id", id)
        put("config", buildJsonObject { put("enabled", true) })
    }

    private fun promptWith(
        attachment: kotlinx.serialization.json.JsonObject,
        text: String = "ok",
    ) = buildJsonObject {
        put("operation", "prompt")
        put("sessionId", "session-1")
        put("text", text)
        put("attachments", buildJsonArray { add(attachment) })
    }

    private fun attachment(
        id: String,
        size: Long,
        sha256: String = "a".repeat(43),
        url: String = "mxc://matrix.example/media-id",
        mediaSize: Long = size + 16,
        extra: Boolean = false,
        name: String = "name-$id",
    ) = buildJsonObject {
        put("id", id)
        put("name", name)
        put("mimeType", "application/octet-stream")
        put("size", size)
        put("sha256", sha256)
        put("media", buildJsonObject {
            put("url", url)
            put("key", "b".repeat(43))
            put("iv", "c".repeat(16))
            put("sha256", "d".repeat(43))
            put("size", mediaSize)
        })
        if (extra) put("unexpected", true)
    }

    private fun assertInvalid(payload: kotlinx.serialization.json.JsonObject) {
        assertThrows(IllegalArgumentException::class.java) {
            CommandPayloadValidator.validate(payload)
        }
    }
}
