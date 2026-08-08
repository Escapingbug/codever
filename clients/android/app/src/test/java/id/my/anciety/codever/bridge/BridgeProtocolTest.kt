package id.my.anciety.codever.bridge

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.coroutines.runBlocking
import id.my.anciety.codever.client.NativeClientRuntime
import id.my.anciety.codever.client.events.ClientLifecycle
import id.my.anciety.codever.client.events.ClientSnapshot
import id.my.anciety.codever.client.events.ForegroundServiceState
import id.my.anciety.codever.client.events.LifecyclePhase
import id.my.anciety.codever.client.events.PublicTrustState
import id.my.anciety.codever.matrix.MatrixBootstrap
import id.my.anciety.codever.matrix.MatrixLoginTokenIssueResult
import id.my.anciety.codever.matrix.MatrixRoomBinding
import id.my.anciety.codever.matrix.PublicMatrixSession
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeProtocolTest {
    private val json = Json

    @Test
    fun `strictly parses a shared JSON RPC hello request`() {
        val parsed = BridgeProtocol.parse(helloRequest())

        assertTrue(parsed is BridgeParseResult.Valid)
        val request = (parsed as BridgeParseResult.Valid).request
        assertEquals("hello-1", request.id)
        assertEquals("codever.bridge.hello", request.method)
    }

    @Test
    fun `uses shared JSON RPC failures for parse envelope and method errors`() {
        assertInvalid("not-json", BridgeError.PARSE_ERROR)
        assertInvalid(
            """{"jsonrpc":"1.0","id":"1","method":"codever.bridge.hello","params":{}}""",
            BridgeError.INVALID_REQUEST,
        )
        assertInvalid(
            """{"jsonrpc":"2.0","id":"1","method":"codever.native.eval","params":{}}""",
            BridgeError.METHOD_NOT_FOUND,
        )

        val response = json.parseToJsonElement(
            BridgeProtocol.failure("1", BridgeError.METHOD_NOT_FOUND, "No such method."),
        ).jsonObject
        assertEquals("2.0", response.getValue("jsonrpc").jsonPrimitive.content)
        val error = response.getValue("error").jsonObject
        assertEquals(-32601, error.getValue("code").jsonPrimitive.int)
        assertEquals(
            "METHOD_NOT_FOUND",
            error.getValue("data").jsonObject.getValue("errorCode").jsonPrimitive.content,
        )
    }

    @Test
    fun `rejects oversized and deeply nested messages`() {
        val oversized = "x".repeat(BridgeProtocol.MAX_MESSAGE_BYTES + 1)
        assertInvalid(oversized, BridgeError.INVALID_REQUEST)

        var nested = "\"leaf\""
        repeat(BridgeProtocol.MAX_JSON_DEPTH + 2) { nested = "[$nested]" }
        assertInvalid(nested, BridgeError.INVALID_REQUEST)
    }

    @Test
    fun `hello negotiates every implemented requested capability`() {
        val runtime = FakeRuntime()
        val dispatcher = BridgeDispatcher(runtime, BRIDGE_SESSION_ID)
        val response = successResult(
            dispatch(dispatcher,
                helloRequest(
                    optionalCapabilities = """
                        [
                          {"name":"background.foreground-service","versions":[1]},
                          {"name":"trust.native","versions":[1]},
                          {"name":"commands.durable","versions":[1]}
                        ]
                    """.trimIndent(),
                ),
            ),
        )
        val capabilities = response.getValue("capabilities").jsonObject

        assertEquals(
            setOf("background.foreground-service", "trust.native", "commands.durable"),
            capabilities.keys,
        )
        assertEquals(
            1,
            capabilities.getValue("background.foreground-service").jsonObject
                .getValue("version").jsonPrimitive.int,
        )
        assertFalse(response.toString().contains("matrix", ignoreCase = true))
        assertTrue(response.toString().contains("durable", ignoreCase = true))
        assertEquals(BRIDGE_SESSION_ID, response.getValue("bridgeSessionId").jsonPrimitive.content)
    }

    @Test
    fun `hello fails closed when an unavailable capability is required`() {
        val dispatcher = BridgeDispatcher(FakeRuntime(), BRIDGE_SESSION_ID)
        val response = failure(
            dispatch(dispatcher,
                helloRequest(
                    requiredCapabilities =
                        """[{"name":"background.unavailable","versions":[1]}]""",
                ),
            ),
        )

        assertEquals(-32003, response.getValue("code").jsonPrimitive.int)
        assertEquals(
            "CAPABILITY_UNAVAILABLE",
            response.getValue("data").jsonObject.getValue("errorCode").jsonPrimitive.content,
        )
    }

    @Test
    fun `snapshot requires hello and the negotiated bridge context`() {
        val dispatcher = BridgeDispatcher(FakeRuntime(), BRIDGE_SESSION_ID)
        val beforeHello = failure(dispatch(dispatcher, snapshotRequest("before", BRIDGE_SESSION_ID)))
        assertEquals("BRIDGE_NOT_READY", beforeHello.getValue("data").jsonObject
            .getValue("errorCode").jsonPrimitive.content)

        successResult(dispatch(dispatcher, helloRequest()))
        val stale = failure(dispatch(dispatcher, snapshotRequest("stale", "other-session")))
        assertEquals("STALE_WEB_INSTANCE", stale.getValue("data").jsonObject
            .getValue("errorCode").jsonPrimitive.content)

        val snapshot = successResult(
            dispatch(dispatcher, snapshotRequest("snapshot", BRIDGE_SESSION_ID)),
        )
        assertEquals(1, snapshot.getValue("schemaVersion").jsonPrimitive.int)
        assertEquals("unpaired", snapshot.getValue("lifecycle").jsonObject
            .getValue("phase").jsonPrimitive.content)
        assertEquals("unpaired", snapshot.getValue("trust").jsonObject
            .getValue("state").jsonPrimitive.content)
    }

    @Test
    fun `start and disconnect use shared context and UUID idempotency shape`() {
        val runtime = FakeRuntime()
        val dispatcher = BridgeDispatcher(runtime, BRIDGE_SESSION_ID)
        successResult(dispatch(dispatcher, helloRequest()))

        val missingKey = failure(dispatch(dispatcher,
            """{"jsonrpc":"2.0","id":"start-bad","method":"codever.client.start","params":{"context":{"bridgeSessionId":"$BRIDGE_SESSION_ID"}}}""",
        ))
        assertEquals("INVALID_PARAMS", missingKey.getValue("data").jsonObject
            .getValue("errorCode").jsonPrimitive.content)

        val started = successResult(dispatch(dispatcher,
            """{"jsonrpc":"2.0","id":"start","method":"codever.client.start","params":{"context":{"bridgeSessionId":"$BRIDGE_SESSION_ID"},"idempotencyKey":"$IDEMPOTENCY_KEY"}}""",
        ))
        assertTrue(started.getValue("snapshot").jsonObject.getValue("foregroundService").jsonObject
            .getValue("active").jsonPrimitive.content.toBoolean())
        assertEquals(1, runtime.starts)

        val stopped = successResult(dispatch(dispatcher,
            """{"jsonrpc":"2.0","id":"stop","method":"codever.client.disconnect","params":{"context":{"bridgeSessionId":"$BRIDGE_SESSION_ID"},"idempotencyKey":"$DISCONNECT_IDEMPOTENCY_KEY","mode":"stop"}}""",
        ))
        assertFalse(stopped.getValue("snapshot").jsonObject.getValue("foregroundService").jsonObject
            .getValue("active").jsonPrimitive.content.toBoolean())
        assertEquals(listOf("stop"), runtime.disconnects)
    }

    @Test
    fun `revoke reaches the native runtime`() {
        val runtime = FakeRuntime()
        val dispatcher = BridgeDispatcher(runtime, BRIDGE_SESSION_ID)
        successResult(dispatch(dispatcher, helloRequest()))
        val response = successResult(dispatch(dispatcher,
            """{"jsonrpc":"2.0","id":"revoke","method":"codever.client.disconnect","params":{"context":{"bridgeSessionId":"$BRIDGE_SESSION_ID"},"idempotencyKey":"$IDEMPOTENCY_KEY","mode":"revoke"}}""",
        ))
        assertFalse(response.getValue("snapshot").jsonObject.getValue("foregroundService")
            .jsonObject.getValue("active").jsonPrimitive.content.toBoolean())
        assertEquals(listOf("revoke"), runtime.disconnects)
    }

    @Test
    fun `bootstrap is capability gated idempotent and never returns the login token`() {
        val runtime = FakeRuntime()
        val dispatcher = BridgeDispatcher(runtime, BRIDGE_SESSION_ID)
        val hello = helloRequest(
            optionalCapabilities = """
                [
                  {"name":"background.foreground-service","versions":[1]},
                  {"name":"matrix.session-bootstrap","versions":[1]}
                ]
            """.trimIndent(),
        )
        val capabilities = successResult(dispatch(dispatcher, hello))
            .getValue("capabilities").jsonObject
        assertEquals(
            setOf("background.foreground-service", "matrix.session-bootstrap"),
            capabilities.keys,
        )

        val first = dispatch(dispatcher, bootstrapRequest("bootstrap-1", IDEMPOTENCY_KEY))
        val second = dispatch(dispatcher, bootstrapRequest("bootstrap-2", IDEMPOTENCY_KEY))

        assertEquals(successResult(first), successResult(second))
        assertEquals(1, runtime.bootstraps)
        assertFalse(first.contains("one-time-secret-token"))
        assertFalse(first.contains("accessToken", ignoreCase = true))
        assertEquals(
            "MATRIX-DEVICE",
            successResult(first).getValue("session").jsonObject
                .getValue("matrixDeviceId").jsonPrimitive.content,
        )

        val conflict = failure(dispatch(
            dispatcher,
            bootstrapRequest("bootstrap-3", IDEMPOTENCY_KEY, deviceName = "Different device"),
        ))
        assertEquals(
            "IDEMPOTENCY_CONFLICT",
            conflict.getValue("data").jsonObject.getValue("errorCode").jsonPrimitive.content,
        )
    }

    @Test
    fun `login token is capability gated bound to an invitation and idempotent in memory`() {
        val runtime = FakeRuntime()
        val dispatcher = BridgeDispatcher(runtime, BRIDGE_SESSION_ID)
        successResult(dispatch(
            dispatcher,
            helloRequest(
                optionalCapabilities =
                    """[{"name":"matrix.login-token","versions":[1]}]""",
            ),
        ))

        val first = dispatch(dispatcher, loginTokenRequest("token-1", IDEMPOTENCY_KEY))
        val second = dispatch(dispatcher, loginTokenRequest("token-2", IDEMPOTENCY_KEY))

        assertEquals(successResult(first), successResult(second))
        assertEquals("ready", successResult(first).getValue("status").jsonPrimitive.content)
        assertEquals("single-use-secret", successResult(first).getValue("loginToken").jsonPrimitive.content)
        assertEquals(1, runtime.loginTokenIssues)
        assertEquals(listOf("invite-command-1" to null), runtime.loginTokenInputs)

        val conflict = failure(dispatch(
            dispatcher,
            loginTokenRequest("token-3", IDEMPOTENCY_KEY, password = "different"),
        ))
        assertEquals(
            "IDEMPOTENCY_CONFLICT",
            conflict.getValue("data").jsonObject.getValue("errorCode").jsonPrimitive.content,
        )
    }

    @Test
    fun `login-token rate limit exposes only bounded retry metadata`() {
        val response = json.parseToJsonElement(
            BridgeProtocol.failure(
                "token",
                BridgeError.RATE_LIMITED,
                "Try later.",
                retryable = true,
                userAction = "retry",
                retryAfterMs = 12_000,
            ),
        ).jsonObject.getValue("error").jsonObject

        val data = response.getValue("data").jsonObject
        assertEquals("RATE_LIMITED", data.getValue("errorCode").jsonPrimitive.content)
        assertEquals(12_000, data.getValue("retryAfterMs").jsonPrimitive.int)
        assertFalse(response.toString().contains("single-use-secret"))
    }

    @Test
    fun `command blocking details remain structured and bounded`() {
        val response = json.parseToJsonElement(
            BridgeProtocol.failure(
                "command",
                BridgeError.INVALID_STATE,
                "The previous Codever action needs review before another action can start.",
                details = buildJsonObject {
                    put("kind", "command_blocked")
                    put("commandId", "command-1")
                    put("state", "needs_review")
                    put("operation", "session.delete")
                    put("expectedRevision", 9)
                },
            ),
        ).jsonObject.getValue("error").jsonObject

        val details = response.getValue("data").jsonObject.getValue("details").jsonObject
        assertEquals("command_blocked", details.getValue("kind").jsonPrimitive.content)
        assertEquals("command-1", details.getValue("commandId").jsonPrimitive.content)
        assertEquals("needs_review", details.getValue("state").jsonPrimitive.content)
        assertEquals("session.delete", details.getValue("operation").jsonPrimitive.content)
        assertEquals(9, details.getValue("expectedRevision").jsonPrimitive.int)
    }

    private fun helloRequest(
        requiredCapabilities: String = "[]",
        optionalCapabilities: String =
            """[{"name":"background.foreground-service","versions":[1]}]""",
    ): String = """
        {
          "jsonrpc":"2.0",
          "id":"hello-1",
          "method":"codever.bridge.hello",
          "params":{
            "application":"codever-web",
            "webBuild":"test-build",
            "webInstanceId":"550e8400-e29b-41d4-a716-446655440001",
            "supportedProtocolVersions":[1],
            "requiredCapabilities":$requiredCapabilities,
            "optionalCapabilities":$optionalCapabilities
          }
        }
    """.trimIndent()

    private fun snapshotRequest(id: String, sessionId: String): String =
        """{"jsonrpc":"2.0","id":"$id","method":"codever.client.snapshot","params":{"context":{"bridgeSessionId":"$sessionId"}}}"""

    private fun bootstrapRequest(
        id: String,
        idempotencyKey: String,
        deviceName: String = "Codever Android",
    ): String = """
        {
          "jsonrpc":"2.0",
          "id":"$id",
          "method":"codever.client.bootstrap",
          "params":{
            "context":{"bridgeSessionId":"$BRIDGE_SESSION_ID"},
            "idempotencyKey":"$idempotencyKey",
            "homeserver":"https://matrix.example.org",
            "oneTimeLoginToken":"one-time-secret-token",
            "expectedUserId":"@alice:example.org",
            "deviceName":"$deviceName",
            "roomBinding":{
              "roomId":"!room:example.org",
              "gatewayId":"gateway-1",
              "conversationId":"conversation-1",
              "gatewayUserId":"@gateway:example.org",
              "gatewayDeviceId":"GATEWAY-DEVICE",
              "gatewayDeviceEd25519":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
            }
          }
        }
    """.trimIndent()

    private fun loginTokenRequest(
        id: String,
        idempotencyKey: String,
        password: String? = null,
    ): String = """
        {
          "jsonrpc":"2.0",
          "id":"$id",
          "method":"codever.matrix.loginToken",
          "params":{
            "context":{"bridgeSessionId":"$BRIDGE_SESSION_ID"},
            "idempotencyKey":"$idempotencyKey",
            "invitationId":"invite-command-1"
            ${if (password == null) "" else ",\"password\":\"$password\""}
          }
        }
    """.trimIndent()

    private fun successResult(raw: String) = json.parseToJsonElement(raw).jsonObject
        .getValue("result").jsonObject

    private fun dispatch(dispatcher: BridgeDispatcher, raw: String): String =
        runBlocking { dispatcher.dispatch(raw) }

    private fun failure(raw: String) = json.parseToJsonElement(raw).jsonObject
        .getValue("error").jsonObject

    private fun assertInvalid(raw: String, expectedError: BridgeError) {
        val parsed = BridgeProtocol.parse(raw)
        assertTrue(parsed is BridgeParseResult.Invalid)
        assertEquals(expectedError, (parsed as BridgeParseResult.Invalid).error)
    }

    private class FakeRuntime : BridgeRuntime {
        override val runtimeVersion = "test"
        override val runtimeBuild = "test-build"
        override val nativeDeviceId = "native-device-1"
        var starts = 0
        var bootstraps = 0
        var loginTokenIssues = 0
        val loginTokenInputs = mutableListOf<Pair<String, String?>>()
        val disconnects = mutableListOf<String>()
        private var active = true

        override suspend fun client(): NativeClientRuntime = error("Not used by this protocol fixture.")

        override suspend fun snapshot() = ClientSnapshot(
            deviceId = nativeDeviceId,
            cursor = "cursor-1",
            generatedAt = 100,
            lifecycle = ClientLifecycle(
                phase = if (active) LifecyclePhase.UNPAIRED else LifecyclePhase.STOPPED,
                since = 100,
            ),
            foregroundService = ForegroundServiceState(
                active = active,
                notificationVisible = active,
            ),
            trust = PublicTrustState.Unpaired,
        )

        override suspend fun start(): ClientSnapshot {
            starts += 1
            active = true
            return snapshot()
        }

        override suspend fun bootstrap(
            input: MatrixBootstrap,
        ): Pair<PublicMatrixSession, ClientSnapshot> {
            bootstraps += 1
            return PublicMatrixSession(
                homeserver = input.homeserver,
                userId = input.expectedUserId,
                matrixDeviceId = "MATRIX-DEVICE",
                roomBinding = input.roomBinding,
            ) to snapshot()
        }

        override suspend fun issueMatrixLoginToken(
            invitationId: String,
            password: String?,
        ): MatrixLoginTokenIssueResult {
            loginTokenIssues += 1
            loginTokenInputs += invitationId to password
            return MatrixLoginTokenIssueResult.Ready("single-use-secret", 120_000)
        }

        override suspend fun completePairing(
            pairingId: String,
            deviceName: String,
        ): Pair<PublicTrustState.Trusted, ClientSnapshot> = error("Not used by this fixture.")

        override suspend fun disconnect(mode: String): ClientSnapshot {
            disconnects += mode
            active = false
            return snapshot()
        }
    }

    private companion object {
        const val BRIDGE_SESSION_ID = "bridge-session-1"
        const val IDEMPOTENCY_KEY = "550e8400-e29b-41d4-a716-446655440000"
        const val DISCONNECT_IDEMPOTENCY_KEY = "550e8400-e29b-41d4-a716-446655440002"
    }
}
