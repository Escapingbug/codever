package id.my.anciety.codever.client

import id.my.anciety.codever.client.command.CommandCompletion
import id.my.anciety.codever.client.command.CommandOutcome
import id.my.anciety.codever.client.command.CommandOperation
import id.my.anciety.codever.client.command.CommandState
import id.my.anciety.codever.client.command.CommandView
import id.my.anciety.codever.security.codever.MatrixTransportBinding
import id.my.anciety.codever.security.codever.PairingOperation
import id.my.anciety.codever.security.codever.PairingPublicKey
import id.my.anciety.codever.security.codever.PairingRequest
import id.my.anciety.codever.security.codever.SignedPairingRequest
import id.my.anciety.codever.security.codever.TestP256Identity
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class GatewayStateSyncPolicyTest {
    @Test
    fun `only a complete authoritative batch with one Gateway entity unlocks commands`() {
        assertEquals(true, authoritativeRoomStateReady(listOf("gateway_state")))
        assertEquals(
            true,
            authoritativeRoomStateReady(
                listOf("gateway_state", "session_state", "session_state"),
            ),
        )
        assertEquals(false, authoritativeRoomStateReady(emptyList()))
        assertEquals(false, authoritativeRoomStateReady(listOf("session_state")))
        assertEquals(
            false,
            authoritativeRoomStateReady(listOf("gateway_state", "gateway_state")),
        )
    }

    @Test
    fun `canonical Matrix revision suppresses command completion fallback`() {
        assertEquals(true, requiresGatewayConvergence(null, 4))
        assertEquals(true, requiresGatewayConvergence(3, 4))
        assertEquals(false, requiresGatewayConvergence(4, 4))
        assertEquals(false, requiresGatewayConvergence(5, 4))
        assertThrows(IllegalArgumentException::class.java) {
            requiresGatewayConvergence(0, -1)
        }
    }

    @Test
    fun `canonical Matrix state only completes its matching session command`() {
        assertEquals(true, canonicalStateCompletesCommand(
            CommandOperation.SESSION_CREATE,
            "session_root",
            null,
        ))
        assertEquals(true, canonicalStateCompletesCommand(
            CommandOperation.SESSION_CREATE,
            "session_state",
            "active",
        ))
        assertEquals(true, canonicalStateCompletesCommand(
            CommandOperation.SESSION_SETTINGS,
            "session_update",
            null,
        ))
        assertEquals(true, canonicalStateCompletesCommand(
            CommandOperation.SESSION_ARCHIVE,
            "session_lifecycle",
            "archived",
        ))
        assertEquals(true, canonicalStateCompletesCommand(
            CommandOperation.SESSION_RESTORE,
            "session_lifecycle",
            "idle",
        ))
        assertEquals(true, canonicalStateCompletesCommand(
            CommandOperation.SESSION_DELETE,
            "session_lifecycle",
            "deleted",
        ))
        assertEquals(true, canonicalStateCompletesCommand(
            CommandOperation.SESSION_DELETE,
            "session_state",
            "deleted",
        ))
        assertEquals(false, canonicalStateCompletesCommand(
            CommandOperation.PROMPT,
            "session_update",
            null,
        ))
        assertEquals(false, canonicalStateCompletesCommand(
            CommandOperation.SESSION_DELETE,
            "session_lifecycle",
            "archived",
        ))
        assertEquals(false, canonicalStateCompletesCommand(
            CommandOperation.SESSION_RESTORE,
            "gateway_revision",
            null,
        ))
    }

    @Test
    fun `command recovery retries use bounded backoff`() {
        assertEquals(5_000L, commandRecoveryDelayMs(0))
        assertEquals(15_000L, commandRecoveryDelayMs(1))
        assertEquals(30_000L, commandRecoveryDelayMs(2))
        assertEquals(60_000L, commandRecoveryDelayMs(3))
        assertEquals(60_000L, commandRecoveryDelayMs(100))
        assertThrows(IllegalArgumentException::class.java) {
            commandRecoveryDelayMs(-1)
        }
    }

    @Test
    fun `authoritative state convergence retries quickly then settles at a bounded interval`() {
        assertEquals(1_000L, authoritativeStateRefreshDelayMs(0))
        assertEquals(2_000L, authoritativeStateRefreshDelayMs(1))
        assertEquals(5_000L, authoritativeStateRefreshDelayMs(2))
        assertEquals(10_000L, authoritativeStateRefreshDelayMs(3))
        assertEquals(30_000L, authoritativeStateRefreshDelayMs(4))
        assertEquals(30_000L, authoritativeStateRefreshDelayMs(100))
        assertThrows(IllegalArgumentException::class.java) {
            authoritativeStateRefreshDelayMs(-1)
        }
    }

    @Test
    fun `pairing transaction retries the identical request on a bounded schedule`() {
        assertEquals(2_000L, pairingRequestRetryDelayMs(0))
        assertEquals(5_000L, pairingRequestRetryDelayMs(1))
        assertEquals(10_000L, pairingRequestRetryDelayMs(2))
        assertEquals(10_000L, pairingRequestRetryDelayMs(100))
        assertThrows(IllegalArgumentException::class.java) {
            pairingRequestRetryDelayMs(-1)
        }
    }

    @Test
    fun `confirmed pairing recovery follows the durable authorization lifetime`() {
        val identity = TestP256Identity.generate()
        val request = SignedPairingRequest(
            PairingRequest(
                requestId = "request-one",
                offerId = "offer-one",
                offerDigest = "A".repeat(43),
                gatewayId = "gateway-one",
                deviceId = identity.publicIdentity.keyId,
                deviceName = "Phone",
                deviceKey = identity.publicIdentity,
                deviceTransport = MatrixTransportBinding(
                    "https://matrix.example.org",
                    "!room:example.org",
                    "@phone:example.org",
                    "PHONE",
                    "A".repeat(43),
                ),
                requestedOperations = listOf(PairingOperation.PROMPT),
                issuedAt = 1_800_000_000_000L,
                expiresAt = 1_800_000_120_000L,
            ),
            id.my.anciety.codever.security.codever.PairingSignature(
                identity.publicIdentity.keyId,
                "A".repeat(86),
            ),
        )

        assertEquals(
            1_800_000_000_000L + 366L * 24 * 60 * 60_000,
            pairingRecoveryExpiresAt(request),
        )
    }

    @Test
    fun `only recovery-required commands are resumed in sequence order`() {
        val commands = listOf(
            command("accepted", 2, CommandState.ACCEPTED),
            command("later", 3, CommandState.RECOVERY_REQUIRED),
            command("earlier", 1, CommandState.RECOVERY_REQUIRED),
            command("done", 4, CommandState.SUCCEEDED),
        )

        assertEquals(listOf("earlier", "later"), recoverableCommandIds(commands))
    }

    @Test
    fun `desired-state session operations retry revision conflicts without review`() {
        assertEquals(true, shouldAutomaticallyRetryRevisionConflict(CommandOperation.SESSION_CREATE))
        assertEquals(true, shouldAutomaticallyRetryRevisionConflict(CommandOperation.SESSION_ARCHIVE))
        assertEquals(true, shouldAutomaticallyRetryRevisionConflict(CommandOperation.SESSION_RESTORE))
        assertEquals(true, shouldAutomaticallyRetryRevisionConflict(CommandOperation.SESSION_DELETE))
        assertEquals(true, shouldAutomaticallyRetryRevisionConflict(CommandOperation.PROMPT))
        assertEquals(false, shouldAutomaticallyRetryRevisionConflict(CommandOperation.SESSION_SETTINGS))
        assertEquals(false, shouldAutomaticallyRetryRevisionConflict(CommandOperation.DECISION))
        assertEquals(false, shouldAutomaticallyRetryRevisionConflict(CommandOperation.DEVICE_INVITE))
        assertEquals(false, shouldAutomaticallyRetryRevisionConflict(null))
    }

    private fun command(id: String, sequence: Long, state: CommandState): CommandView {
        val completion = if (state.isTerminal) {
            CommandCompletion(id, sequence, 4, CommandOutcome.SUCCEEDED)
        } else {
            null
        }
        return CommandView(
            operationId = "operation-$id",
            commandId = id,
            idempotencyKey = UUID.randomUUID().toString(),
            state = state,
            submittedAt = 1,
            updatedAt = 1,
            sequence = sequence,
            revision = if (state == CommandState.ACCEPTED || state.isTerminal) 4 else null,
            completion = completion,
        )
    }
}
