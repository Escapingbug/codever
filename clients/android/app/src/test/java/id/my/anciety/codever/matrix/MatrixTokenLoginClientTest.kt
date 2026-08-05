package id.my.anciety.codever.matrix

import java.net.URI
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.matrix.rustcomponents.sdk.SlidingSyncVersion

class MatrixTokenLoginClientTest {
    @Test
    fun `exchanges token only at the restricted Matrix login endpoint and wipes byte buffers`() =
        runBlocking {
            lateinit var endpoint: URI
            lateinit var requestReference: ByteArray
            lateinit var requestCopy: ByteArray
            val responseBody = successResponse().toByteArray()
            val client = MatrixTokenLoginClient(MatrixLoginTransport { target, body ->
                endpoint = target
                requestReference = body
                requestCopy = body.copyOf()
                MatrixHttpResponse(200, responseBody)
            })

            val session = client.exchange(bootstrap())

            assertEquals(
                "https://matrix.example.org/_matrix/client/v3/login",
                endpoint.toASCIIString(),
            )
            val request = Json.parseToJsonElement(requestCopy.toString(Charsets.UTF_8)).jsonObject
            assertEquals("m.login.token", request.getValue("type").jsonPrimitive.content)
            assertEquals(LOGIN_TOKEN, request.getValue("token").jsonPrimitive.content)
            assertEquals("@alice:example.org", session.userId)
            assertEquals("MATRIX-DEVICE", session.deviceId)
            assertEquals(SlidingSyncVersion.NATIVE, session.slidingSyncVersion)
            assertTrue(requestReference.all { it == 0.toByte() })
            assertTrue(responseBody.all { it == 0.toByte() })
        }

    @Test
    fun `rejects a login response for another Matrix user without exposing secrets`() = runBlocking {
        val client = MatrixTokenLoginClient(MatrixLoginTransport { _, _ ->
            MatrixHttpResponse(
                200,
                successResponse(userId = "@mallory:example.org").toByteArray(),
            )
        })

        val error = runCatching { client.exchange(bootstrap()) }.exceptionOrNull()

        assertTrue(error is IllegalArgumentException)
        assertFalse(error.toString().contains(LOGIN_TOKEN))
        assertFalse(error.toString().contains("secret-access-token"))
    }

    @Test
    fun `sanitizes Matrix error bodies and marks server failures retryable`() = runBlocking {
        val client = MatrixTokenLoginClient(MatrixLoginTransport { _, _ ->
            MatrixHttpResponse(
                503,
                """{"errcode":"M_UNAVAILABLE","error":"server echoed $LOGIN_TOKEN"}"""
                    .toByteArray(),
            )
        })

        val error = runCatching { client.exchange(bootstrap()) }.exceptionOrNull()

        assertTrue(error is MatrixLoginException)
        assertTrue((error as MatrixLoginException).retryable)
        assertFalse(error.toString().contains(LOGIN_TOKEN))
    }

    @Test
    fun `fetches one bounded extended profile property without exposing the access token`() =
        runBlocking {
            lateinit var endpoint: URI
            var receivedToken: String? = null
            val responseBody = """
                {
                  "io.codever.gateway_transport": {
                    "version": 1,
                    "signed_snapshot": {"snapshot":{},"signature":{}}
                  }
                }
            """.trimIndent().toByteArray()
            val client = MatrixProfileClient(MatrixProfileTransport { target, accessToken ->
                endpoint = target
                receivedToken = accessToken
                MatrixHttpResponse(200, responseBody)
            })

            val result = client.get(
                storedSession(),
                "@gateway:example.org",
                "io.codever.gateway_transport",
            )

            assertEquals(
                "https://matrix.example.org/_matrix/client/v3/profile/%40gateway%3Aexample.org/io.codever.gateway_transport",
                endpoint.toASCIIString(),
            )
            assertEquals("secret-access-token", receivedToken)
            assertEquals(1, result?.getValue("version")?.jsonPrimitive?.content?.toInt())
            assertTrue(responseBody.all { it == 0.toByte() })
        }

    @Test
    fun `issues one-time login token through the authenticated restricted endpoint`() = runBlocking {
        lateinit var endpoint: URI
        var receivedAccessToken: String? = null
        lateinit var requestReference: ByteArray
        val responseBody = """{"login_token":"issued-once","expires_in_ms":90000}""".toByteArray()
        val client = MatrixLoginTokenIssueClient(
            transport = MatrixLoginTokenTransport { target, accessToken, body ->
                endpoint = target
                receivedAccessToken = accessToken
                requestReference = body
                MatrixHttpResponse(200, responseBody)
            },
            now = { 10_000L },
        )

        val result = client.issue(storedSession())

        assertEquals(
            "https://matrix.example.org/_matrix/client/v1/login/get_token",
            endpoint.toASCIIString(),
        )
        assertEquals("secret-access-token", receivedAccessToken)
        assertEquals(
            MatrixLoginTokenIssueResult.Ready("issued-once", 100_000L),
            result,
        )
        assertTrue(requestReference.all { it == 0.toByte() })
        assertTrue(responseBody.all { it == 0.toByte() })
    }

    @Test
    fun `reports supported password reauthentication without requesting a second token`() = runBlocking {
        var requests = 0
        val responseBody = """
            {
              "session":"uia-session",
              "flows":[{"stages":["m.login.password"]}]
            }
        """.trimIndent().toByteArray()
        val client = MatrixLoginTokenIssueClient(MatrixLoginTokenTransport { _, _, _ ->
            requests += 1
            MatrixHttpResponse(401, responseBody)
        })

        val result = client.issue(storedSession())

        assertEquals(MatrixLoginTokenIssueResult.ReauthenticationRequired(true), result)
        assertEquals(1, requests)
        assertTrue(responseBody.all { it == 0.toByte() })
    }

    @Test
    fun `completes password reauthentication without retaining password request bytes`() = runBlocking {
        val requestReferences = mutableListOf<ByteArray>()
        val requestCopies = mutableListOf<ByteArray>()
        var requests = 0
        val client = MatrixLoginTokenIssueClient(
            MatrixLoginTokenTransport { _, _, body ->
                requestReferences += body
                requestCopies += body.copyOf()
                requests += 1
                if (requests == 1) {
                    MatrixHttpResponse(
                        401,
                        """{"session":"uia-session","flows":[{"stages":["m.login.password"]}]}"""
                            .toByteArray(),
                    )
                } else {
                    MatrixHttpResponse(200, """{"login_token":"issued-after-uia"}""".toByteArray())
                }
            },
            now = { 100L },
        )

        val result = client.issue(storedSession(), "private-password")

        assertEquals(
            MatrixLoginTokenIssueResult.Ready("issued-after-uia", 120_100L),
            result,
        )
        val auth = Json.parseToJsonElement(
            requestCopies[1].toString(Charsets.UTF_8),
        ).jsonObject.getValue("auth").jsonObject
        assertEquals("private-password", auth.getValue("password").jsonPrimitive.content)
        assertEquals("uia-session", auth.getValue("session").jsonPrimitive.content)
        assertTrue(requestReferences.all { bytes -> bytes.all { it == 0.toByte() } })
    }

    @Test
    fun `surfaces Matrix login-token retry interval without echoing response`() = runBlocking {
        val responseBody = """{"errcode":"M_LIMIT_EXCEEDED","retry_after_ms":12000}""".toByteArray()
        val client = MatrixLoginTokenIssueClient(MatrixLoginTokenTransport { _, _, _ ->
            MatrixHttpResponse(429, responseBody)
        })

        val error = assertThrows(MatrixLoginTokenRateLimitException::class.java) {
            runBlocking { client.issue(storedSession()) }
        }

        assertEquals(12_000L, error.retryAfterMs)
        assertTrue(responseBody.all { it == 0.toByte() })
    }

    private fun bootstrap() = MatrixBootstrap(
        homeserver = "https://matrix.example.org/",
        oneTimeLoginToken = LOGIN_TOKEN,
        expectedUserId = "@alice:example.org",
        deviceName = "Codever Android",
        roomBinding = MatrixRoomBinding(
            roomId = "!room:example.org",
            gatewayId = "gateway-1",
            conversationId = "conversation-1",
            gatewayUserId = "@gateway:example.org",
            gatewayDeviceId = "GATEWAY-DEVICE",
            gatewayDeviceEd25519 = "A".repeat(43),
        ),
    )

    private fun successResponse(userId: String = "@alice:example.org") = """
        {
          "access_token":"secret-access-token",
          "refresh_token":"secret-refresh-token",
          "user_id":"$userId",
          "device_id":"MATRIX-DEVICE"
        }
    """.trimIndent()

    private fun storedSession() = StoredMatrixSession(
        accessToken = "secret-access-token",
        refreshToken = null,
        userId = "@alice:example.org",
        deviceId = "MATRIX-DEVICE",
        homeserverUrl = "https://matrix.example.org",
        oauthData = null,
        slidingSyncVersion = SlidingSyncVersion.NONE,
        roomBinding = bootstrap().roomBinding,
    )

    private companion object {
        const val LOGIN_TOKEN = "one-time-secret-login-token"
    }
}
