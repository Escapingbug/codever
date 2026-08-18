package id.my.anciety.codever.matrix

import java.net.URI
import java.net.URLDecoder
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.matrix.rustcomponents.sdk.SlidingSyncVersion

class MatrixApplicationControlClientTest {
    @Test
    fun `sends only a secure envelope with a stable transaction id and wipes buffers`() =
        runBlocking {
            lateinit var endpoint: URI
            lateinit var requestReference: ByteArray
            lateinit var requestCopy: ByteArray
            var receivedToken: String? = null
            val responseBody = """{"event_id":"${'$'}control-event"}""".toByteArray()
            val client = MatrixApplicationControlClient(
                MatrixApplicationControlTransport { target, accessToken, body ->
                    endpoint = target
                    receivedToken = accessToken
                    requestReference = body
                    requestCopy = body.copyOf()
                    MatrixHttpResponse(200, responseBody)
                },
            )

            val eventId = client.send(
                storedSession(),
                secureContent(),
                "codever.command.ack/command-1",
            )

            assertEquals("\$control-event", eventId)
            assertEquals("secret-access-token", receivedToken)
            assertEquals(
                "https://matrix.example.org/_matrix/client/v3/rooms/" +
                    "%21room%3Aexample.org/send/io.codever.secure_control.v1/" +
                    "codever.command.ack%2Fcommand-1",
                endpoint.toASCIIString(),
            )
            assertEquals(
                "secure_envelope",
                Json.parseToJsonElement(requestCopy.toString(Charsets.UTF_8))
                    .jsonObject.getValue("io.codever").jsonObject
                    .getValue("kind").jsonPrimitive.content,
            )
            assertTrue(requestReference.all { it == 0.toByte() })
            assertTrue(responseBody.all { it == 0.toByte() })
        }

    @Test
    fun `rejects plaintext control content before transport`() = runBlocking {
        var called = false
        val client = MatrixApplicationControlClient(
            MatrixApplicationControlTransport { _, _, _ ->
                called = true
                MatrixHttpResponse(200, "{}".toByteArray())
            },
        )

        val error = runCatching {
            client.send(
                storedSession(),
                """{"msgtype":"m.text","body":"plaintext"}""",
                "rejected-control",
            )
        }.exceptionOrNull()

        assertTrue(error is IllegalArgumentException)
        assertFalse(called)
    }

    @Test
    fun `recognizes only application encrypted control and timeline events`() {
        val event = """
            {
              "type":"io.codever.secure_control.v1",
              "content":${secureContent()}
            }
        """.trimIndent()

        assertTrue(isCodeverApplicationControlEvent(event))
        assertTrue(isCodeverApplicationControlEvent(event.replace(
            "\"kind\":\"secure_envelope\"",
            "\"kind\":\"secure_envelope_bundle\"",
        ).replace(
            "\"secure_envelope\":",
            "\"secure_envelope_bundle\":",
        )))
        assertTrue(isCodeverApplicationControlEvent("""
            {
              "type":"m.room.message",
              "content":${timelineContent()}
            }
        """.trimIndent()))
        assertFalse(isCodeverApplicationControlEvent(secureContent()))
        assertFalse(isCodeverApplicationControlEvent("""
            {
              "type":"m.room.message",
              "content":${secureContent()}
            }
        """.trimIndent()))
        assertFalse(isCodeverApplicationControlEvent("""
            {
              "type":"io.codever.secure_control.v1",
              "content":{"io.codever":{"version":1,"kind":"history_page"}}
            }
        """.trimIndent()))
    }

    @Test
    fun `pairing bootstrap timeline accepts only signed response shaped events`() {
        assertTrue(isCodeverPairingResponseEvent("""
            {
              "type":"m.room.message",
              "content":{"io.codever":{
                "version":1,
                "kind":"pairing_response",
                "pairing_response":{}
              }}
            }
        """.trimIndent()))
        assertTrue(isCodeverPairingResponseEvent("""
            {
              "type":"m.room.message",
              "content":{"io.codever":{
                "version":1,
                "kind":"pairing_rejection",
                "pairing_rejection":{}
              }}
            }
        """.trimIndent()))
        assertFalse(isCodeverPairingResponseEvent("""
            {
              "type":"m.room.message",
              "content":${timelineContent()}
            }
        """.trimIndent()))
        assertFalse(isCodeverPairingResponseEvent("""
            {
              "type":"m.room.message",
              "content":{"io.codever":{
                "version":1,
                "kind":"pairing_request",
                "pairing_request":{}
              }}
            }
        """.trimIndent()))
    }

    @Test
    fun `diagnostics expose only the bounded application event kind`() {
        assertEquals(
            "timeline_envelope",
            codeverApplicationEventKind("""
                {
                  "type":"m.room.message",
                  "content":${timelineContent()}
                }
            """.trimIndent()),
        )
        assertEquals(
            "unknown",
            codeverApplicationEventKind("""
                {"content":{"io.codever":{"kind":"Secret value must not become a diagnostic"}}}
            """.trimIndent()),
        )
        assertEquals("unknown", codeverApplicationEventKind("not-json"))
    }

    @Test
    fun `sync receives raw application control events for the bound room`() = runBlocking {
        lateinit var endpoint: URI
        val responseBody = """
            {
              "next_batch":"s-next",
              "rooms":{"join":{"!room:example.org":{"timeline":{"limited":true,"prev_batch":"s-gap-start","events":[
                {
                  "type":"io.codever.secure_control.v1",
                  "event_id":"${'$'}control-response",
                  "sender":"@gateway:example.org",
                  "origin_server_ts":1234,
                  "content":${secureContent()}
                },
                {
                  "type":"m.room.message",
                  "event_id":"${'$'}timeline-response",
                  "sender":"@gateway:example.org",
                  "origin_server_ts":1235,
                  "content":${timelineContent()}
                },
                {
                  "type":"io.codever.session.current.v2",
                  "state_key":"session-live",
                  "event_id":"${'$'}live-session-state",
                  "sender":"@gateway:example.org",
                  "origin_server_ts":1236,
                  "content":{"version":2,"kind":"state_envelope","state_envelope":{}}
                }
              ]}}}}
            }
        """.trimIndent().toByteArray()
        val client = MatrixApplicationControlSyncClient(
            MatrixApplicationControlSyncTransport { target, accessToken ->
                endpoint = target
                assertEquals("secret-access-token", accessToken)
                MatrixHttpResponse(200, responseBody)
            },
        )

        val batch = client.sync(storedSession(), "s-current")

        assertEquals("s-next", batch.nextBatch)
        assertEquals(
            listOf("\$control-response", "\$timeline-response", "\$live-session-state"),
            batch.events.map { it.eventId },
        )
        assertEquals("@gateway:example.org", batch.events.first().sender)
        assertEquals(1234L, batch.events.first().timestamp)
        assertTrue(batch.limited)
        assertEquals("s-gap-start", batch.prevBatch)
        assertTrue(endpoint.rawQuery.contains("since=s-current"))
        assertTrue(endpoint.rawQuery.contains("filter="))
        val encodedFilter = endpoint.rawQuery
            .split("&")
            .single { it.startsWith("filter=") }
            .substringAfter("filter=")
        val filter = Json.parseToJsonElement(
            URLDecoder.decode(encodedFilter, Charsets.UTF_8.name()),
        ).jsonObject
        val timeline = filter.getValue("room").jsonObject
            .getValue("timeline").jsonObject
        assertEquals(
            "@gateway:example.org",
            timeline.getValue("senders").jsonArray.single().jsonPrimitive.content,
        )
        assertEquals(
            setOf(
                "io.codever.secure_control.v1",
                "m.room.message",
                "io.codever.gateway.current.v2",
                "io.codever.session.current.v2",
            ),
            timeline.getValue("types").jsonArray.map { it.jsonPrimitive.content }.toSet(),
        )
        assertEquals(32, timeline.getValue("limit").jsonPrimitive.content.toInt())
        assertTrue(
            filter.getValue("room").jsonObject
                .getValue("state").jsonObject
                .getValue("types").jsonArray.isEmpty(),
        )
        assertTrue(responseBody.all { it == 0.toByte() })
    }

    @Test
    fun `cursor failures never discard an unproven offline boundary`() {
        assertEquals(
            null,
            applicationControlCursorResetReason(
                MatrixApplicationControlResponseTooLargeException(2 * 1024 * 1024),
                "s-stale",
            ),
        )
        assertEquals(
            "server_rejected_after_authoritative_rebuild",
            applicationControlCursorResetReason(
                MatrixApplicationControlSyncException(400, null),
                "s-invalid",
            ),
        )
        assertEquals(
            null,
            applicationControlCursorResetReason(
                MatrixApplicationControlResponseTooLargeException(2 * 1024 * 1024),
                since = null,
            ),
        )
    }

    @Test
    fun `limited incremental sync without prev batch is rejected before cursor commit`() = runBlocking {
        val responseBody = """
            {
              "next_batch":"s-next",
              "rooms":{"join":{"!room:example.org":{"timeline":{"limited":true,"events":[]}}}}
            }
        """.trimIndent().toByteArray()
        val client = MatrixApplicationControlSyncClient(
            MatrixApplicationControlSyncTransport { _, _ ->
                MatrixHttpResponse(200, responseBody)
            },
        )

        val error = runCatching {
            client.sync(storedSession(), since = "s-current")
        }.exceptionOrNull()

        assertTrue(error is MatrixApplicationControlPayloadException)
        assertTrue(error?.message?.contains("gap boundary") == true)
        assertTrue(responseBody.all { it == 0.toByte() })
    }

    @Test
    fun `gap page uses sync boundaries and returns a resumable cursor`() = runBlocking {
        lateinit var endpoint: URI
        val responseBody = """
            {
              "start":"s-before",
              "end":"s-page-2",
              "chunk":[
                {
                  "type":"m.room.message",
                  "event_id":"${'$'}gap-event",
                  "sender":"@gateway:example.org",
                  "origin_server_ts":1235,
                  "content":${timelineContent()}
                },
                {
                  "type":"m.room.message",
                  "event_id":"${'$'}untrusted-gap-event",
                  "sender":"@attacker:example.org",
                  "origin_server_ts":1236,
                  "content":${timelineContent()}
                }
              ]
            }
        """.trimIndent().toByteArray()
        val client = MatrixApplicationTimelineClient(
            MatrixApplicationControlSyncTransport { target, _ ->
                endpoint = target
                MatrixHttpResponse(200, responseBody)
            },
        )

        val page = client.page(storedSession(), "s-before", "s-gap-end")

        assertEquals(listOf("\$gap-event"), page.events.map { it.eventId })
        assertEquals("s-page-2", page.nextFrom)
        assertEquals(2, page.candidateEventCount)
        assertEquals(
            "/_matrix/client/v3/rooms/%21room%3Aexample.org/messages",
            endpoint.rawPath,
        )
        val query = endpoint.rawQuery.split("&").associate { part ->
            val (key, value) = part.split("=", limit = 2)
            key to URLDecoder.decode(value, Charsets.UTF_8.name())
        }
        assertEquals("f", query["dir"])
        assertEquals("s-before", query["from"])
        assertEquals("s-gap-end", query["to"])
        assertEquals("32", query["limit"])
        assertTrue(responseBody.all { it == 0.toByte() })
    }

    @Test
    fun `initial sync establishes a live cursor without room-wide history catchup`() = runBlocking {
        lateinit var endpoint: URI
        val responseBody = """
            {
              "next_batch":"s-catchup",
              "rooms":{"join":{"!room:example.org":{"timeline":{"events":[]}}}}
            }
        """.trimIndent().toByteArray()
        val client = MatrixApplicationControlSyncClient(
            MatrixApplicationControlSyncTransport { target, _ ->
                endpoint = target
                MatrixHttpResponse(200, responseBody)
            },
        )

        val batch = client.sync(storedSession(), since = null)

        assertTrue(batch.events.isEmpty())
        assertFalse(batch.limited)
        assertFalse(endpoint.rawQuery.contains("since="))
        assertTrue(endpoint.rawQuery.contains("timeout=0"))
        val encodedFilter = endpoint.rawQuery
            .split("&")
            .single { it.startsWith("filter=") }
            .substringAfter("filter=")
        val timeline = Json.parseToJsonElement(
            URLDecoder.decode(encodedFilter, Charsets.UTF_8.name()),
        ).jsonObject.getValue("room").jsonObject
            .getValue("timeline").jsonObject
        assertEquals(0, timeline.getValue("limit").jsonPrimitive.content.toInt())
    }

    @Test
    fun `current Room State fetches only the committed directly addressed directory pages`() =
        runBlocking {
            val endpoints = mutableListOf<URI>()
            val responseBodies = mutableListOf<ByteArray>()
            val client = MatrixApplicationRoomStateClient(
                MatrixApplicationControlSyncTransport { target, _ ->
                    endpoints += target
                    val body = if (target.rawPath.endsWith("/state/io.codever.gateway.current.v2/gateway-1")) {
                        """{"version":2,"kind":"state_envelope","state_envelope":{}}"""
                    } else {
                        """{"version":2,"kind":"state_envelope","state_envelope":{}}"""
                    }.toByteArray()
                    responseBodies += body
                    MatrixHttpResponse(200, body)
                },
            )

            val gateway = client.currentGateway(storedSession())
            val batch = client.currentDirectory(
                storedSession(),
                MatrixSessionDirectoryLocator(
                    generation = 7,
                    stateVersion = 9,
                    slot = 1,
                    pageCount = 2,
                    stateKeyPrefix = "codever.directory",
                    digest = "RBNvo1WzZ4oRRq0W9-hknpT7T8If536DEMBg9hyq_4o",
                ),
            )

            assertTrue(gateway.eventId.startsWith("\$codever-current-"))
            assertEquals(2, batch.events.size)
            assertEquals(2, batch.candidateEventCount)
            assertEquals(
                "https://matrix.example.org/_matrix/client/v3/rooms/%21room%3Aexample.org/state/" +
                    "io.codever.gateway.current.v2/gateway-1",
                endpoints.first().toASCIIString(),
            )
            assertEquals(
                "/_matrix/client/v3/rooms/%21room%3Aexample.org/state/" +
                    "io.codever.session.directory.v2/codever.directory.1.1",
                endpoints.last().rawPath,
            )
            assertTrue(responseBodies.all { body -> body.all { it == 0.toByte() } })
        }

    @Test
    fun `current Room State rejects a malformed directly addressed directory page`() = runBlocking {
        val responseBodies = mutableListOf<ByteArray>()
        val client = MatrixApplicationRoomStateClient(
            MatrixApplicationControlSyncTransport { target, _ ->
                val body = """{"version":2,"kind":"state_envelope"}""".toByteArray()
                responseBodies += body
                MatrixHttpResponse(200, body)
            },
        )

        val error = runCatching {
            client.currentDirectory(
                storedSession(),
                MatrixSessionDirectoryLocator(
                    1, 1, 0, 1, "codever.directory",
                    "RBNvo1WzZ4oRRq0W9-hknpT7T8If536DEMBg9hyq_4o",
                ),
            )
        }.exceptionOrNull()

        assertTrue(error is MatrixApplicationControlPayloadException)
        assertTrue(error?.message?.contains("invalid envelope shape") == true)
        assertTrue(responseBodies.all { body -> body.all { it == 0.toByte() } })
    }

    @Test
    fun `thread history pages only one session relation and filters untrusted senders`() =
        runBlocking {
            lateinit var endpoint: URI
            val responseBody = """
                {
                  "chunk":[
                    {
                      "type":"m.room.message",
                      "event_id":"${'$'}trusted-history",
                      "sender":"@gateway:example.org",
                      "origin_server_ts":1235,
                      "content":${timelineContent()}
                    },
                    {
                      "type":"m.room.message",
                      "event_id":"${'$'}attacker-history",
                      "sender":"@attacker:example.org",
                      "origin_server_ts":1236,
                      "content":${timelineContent()}
                    }
                  ],
                  "next_batch":"relations-next"
                }
            """.trimIndent().toByteArray()
            val client = MatrixThreadHistoryClient(
                MatrixApplicationControlSyncTransport { target, token ->
                    endpoint = target
                    assertEquals("secret-access-token", token)
                    MatrixHttpResponse(200, responseBody)
                },
            )

            val batch = client.page(
                storedSession(),
                threadRootEventId = "\$thread/root",
                from = "relations/current",
                limit = 37,
            )

            assertEquals(listOf("\$trusted-history"), batch.events.map { it.eventId })
            assertEquals("relations-next", batch.nextBatch)
            assertEquals(
                "/_matrix/client/v1/rooms/%21room%3Aexample.org/relations/" +
                    "%24thread%2Froot/m.thread",
                endpoint.rawPath,
            )
            val query = endpoint.rawQuery.split("&").associate { part ->
                val (key, value) = part.split("=", limit = 2)
                key to URLDecoder.decode(value, Charsets.UTF_8.name())
            }
            assertFalse(query.containsKey("rel_type"))
            assertEquals("b", query["dir"])
            assertEquals("true", query["recurse"])
            assertEquals("32", query["limit"])
            assertEquals("relations/current", query["from"])
            assertTrue(responseBody.all { it == 0.toByte() })
        }

    @Test
    fun `receiver readiness check does not long poll a persisted cursor`() = runBlocking {
        lateinit var endpoint: URI
        val responseBody = """
            {"next_batch":"s-ready","rooms":{"join":{}}}
        """.trimIndent().toByteArray()
        val client = MatrixApplicationControlSyncClient(
            MatrixApplicationControlSyncTransport { target, _ ->
                endpoint = target
                MatrixHttpResponse(200, responseBody)
            },
        )

        client.sync(storedSession(), since = "s-current", longPoll = false)

        assertTrue(endpoint.rawQuery.contains("since=s-current"))
        assertTrue(endpoint.rawQuery.contains("timeout=0"))
    }

    @Test
    fun `sync tolerates null optional room sections without poisoning its cursor`() = runBlocking {
        val responseBody = """
            {
              "next_batch":"s-after-null-sections",
              "rooms":{"join":{"!room:example.org":{
                "state":null,
                "timeline":{"limited":null,"events":null}
              }}}
            }
        """.trimIndent().toByteArray()
        val client = MatrixApplicationControlSyncClient(
            MatrixApplicationControlSyncTransport { _, _ ->
                MatrixHttpResponse(200, responseBody)
            },
        )

        val batch = client.sync(storedSession(), since = "s-before-null-sections")

        assertEquals("s-after-null-sections", batch.nextBatch)
        assertTrue(batch.events.isEmpty())
        assertEquals(0, batch.candidateEventCount)
        assertFalse(batch.limited)
        assertTrue(responseBody.all { it == 0.toByte() })
    }

    @Test
    fun `sync isolates malformed optional candidates and still advances its cursor`() = runBlocking {
        val responseBody = """
            {
              "next_batch":"s-after-malformed-candidates",
              "rooms":{"join":{"!room:example.org":{"state":{"events":[
                null,
                {"type":null,"sender":{"unexpected":true}},
                {
                  "type":"m.room.message",
                  "event_id":"${'$'}trusted-after-malformed",
                  "sender":"@gateway:example.org",
                  "origin_server_ts":2345,
                  "content":${timelineContent()}
                }
              ]},"timeline":{"events":[]}}}}
            }
        """.trimIndent().toByteArray()
        val client = MatrixApplicationControlSyncClient(
            MatrixApplicationControlSyncTransport { _, _ ->
                MatrixHttpResponse(200, responseBody)
            },
        )

        val batch = client.sync(storedSession(), since = "s-before-malformed-candidates")

        assertEquals("s-after-malformed-candidates", batch.nextBatch)
        assertEquals(listOf("\$trusted-after-malformed"), batch.events.map { it.eventId })
        assertEquals(3, batch.candidateEventCount)
    }

    @Test
    fun `sync reports a malformed envelope as a bounded protocol failure`() = runBlocking {
        val responseBody = "[]".toByteArray()
        val client = MatrixApplicationControlSyncClient(
            MatrixApplicationControlSyncTransport { _, _ ->
                MatrixHttpResponse(200, responseBody)
            },
        )

        val error = runCatching {
            client.sync(storedSession(), since = "s-before-invalid-envelope")
        }.exceptionOrNull()

        assertTrue(error is MatrixApplicationControlPayloadException)
        assertTrue(responseBody.all { it == 0.toByte() })
    }

    @Test
    fun `sync reports invalid JSON as a bounded protocol failure`() = runBlocking {
        val responseBody = "{".toByteArray()
        val client = MatrixApplicationControlSyncClient(
            MatrixApplicationControlSyncTransport { _, _ ->
                MatrixHttpResponse(200, responseBody)
            },
        )

        val error = runCatching {
            client.sync(storedSession(), since = "s-before-invalid-json")
        }.exceptionOrNull()

        assertTrue(error is MatrixApplicationControlPayloadException)
        assertTrue(responseBody.all { it == 0.toByte() })
    }

    private fun secureContent() = """
        {
          "msgtype":"m.notice",
          "body":"Encrypted Codever message",
          "io.codever":{
            "version":1,
            "kind":"secure_envelope",
            "secure_envelope":{"envelope":{},"signature":{}}
          }
        }
    """.trimIndent()

    private fun timelineContent() = """
        {
          "msgtype":"m.notice",
          "body":"Encrypted Codever timeline event",
          "io.codever":{
            "version":2,
            "kind":"timeline_envelope",
            "timeline_envelope":{"envelope":{},"signature":{}},
            "timeline_key_ring_bundle":{"bundle":{},"signature":{}}
          }
        }
    """.trimIndent()

    private fun storedSession() = StoredMatrixSession(
        accessToken = "secret-access-token",
        refreshToken = null,
        userId = "@alice:example.org",
        deviceId = "MATRIX-DEVICE",
        homeserverUrl = "https://matrix.example.org",
        oauthData = null,
        slidingSyncVersion = SlidingSyncVersion.NATIVE,
        roomBinding = MatrixRoomBinding(
            roomId = "!room:example.org",
            gatewayId = "gateway-1",
            conversationId = "conversation-1",
            gatewayUserId = "@gateway:example.org",
            gatewayDeviceId = "GATEWAY-DEVICE",
            gatewayDeviceEd25519 = "A".repeat(43),
        ),
    )
}
