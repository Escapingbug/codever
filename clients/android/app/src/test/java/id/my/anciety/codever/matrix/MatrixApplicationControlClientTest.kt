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
                "codever.history.request/request-1",
            )

            assertEquals("\$control-event", eventId)
            assertEquals("secret-access-token", receivedToken)
            assertEquals(
                "https://matrix.example.org/_matrix/client/v3/rooms/" +
                    "%21room%3Aexample.org/send/io.codever.secure_control.v1/" +
                    "codever.history.request%2Frequest-1",
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
    fun `recognizes only raw application control events with secure envelopes`() {
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
        assertFalse(isCodeverApplicationControlEvent(secureContent()))
        assertFalse(isCodeverApplicationControlEvent("""
            {
              "type":"io.codever.secure_control.v1",
              "content":{"io.codever":{"version":1,"kind":"history_page"}}
            }
        """.trimIndent()))
    }

    @Test
    fun `sync receives raw application control events for the bound room`() = runBlocking {
        lateinit var endpoint: URI
        val responseBody = """
            {
              "next_batch":"s-next",
              "rooms":{"join":{"!room:example.org":{"timeline":{"limited":true,"events":[{
                "type":"io.codever.secure_control.v1",
                "event_id":"${'$'}control-response",
                "sender":"@gateway:example.org",
                "origin_server_ts":1234,
                "content":${secureContent()}
              }]}}}}
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
        assertEquals(1, batch.events.size)
        assertEquals("\$control-response", batch.events.single().eventId)
        assertEquals("@gateway:example.org", batch.events.single().sender)
        assertEquals(1234L, batch.events.single().timestamp)
        assertTrue(batch.limited)
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
        assertEquals(100, timeline.getValue("limit").jsonPrimitive.content.toInt())
        assertTrue(responseBody.all { it == 0.toByte() })
    }

    @Test
    fun `initial sync catches up control events instead of only establishing a cursor`() = runBlocking {
        lateinit var endpoint: URI
        val responseBody = """
            {
              "next_batch":"s-catchup",
              "rooms":{"join":{"!room:example.org":{"timeline":{"events":[{
                "type":"io.codever.secure_control.v1",
                "event_id":"${'$'}offline-result",
                "sender":"@gateway:example.org",
                "origin_server_ts":1234,
                "content":${secureContent()}
              }]}}}}
            }
        """.trimIndent().toByteArray()
        val client = MatrixApplicationControlSyncClient(
            MatrixApplicationControlSyncTransport { target, _ ->
                endpoint = target
                MatrixHttpResponse(200, responseBody)
            },
        )

        val batch = client.sync(storedSession(), since = null)

        assertEquals(listOf("\$offline-result"), batch.events.map { it.eventId })
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
        assertEquals(100, timeline.getValue("limit").jsonPrimitive.content.toInt())
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
