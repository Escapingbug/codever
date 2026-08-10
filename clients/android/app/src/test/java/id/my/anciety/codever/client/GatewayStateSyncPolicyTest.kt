package id.my.anciety.codever.client

import id.my.anciety.codever.client.command.CommandCompletion
import id.my.anciety.codever.client.command.CommandOutcome
import id.my.anciety.codever.client.command.CommandOperation
import id.my.anciety.codever.client.command.CommandState
import id.my.anciety.codever.client.command.CommandView
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class GatewayStateSyncPolicyTest {
    @Test
    fun `Matrix pagination reports reached start rather than has more`() {
        assertEquals(true, matrixRoomHistoryHasMore(reachedStart = false))
        assertEquals(false, matrixRoomHistoryHasMore(reachedStart = true))
    }

    @Test
    fun `native timeline backfill continues until Matrix reaches the start`() = runBlocking {
        val results = ArrayDeque(listOf(false, false, true))
        val backfill = paginateMatrixTimelineToStart(maxPages = 10) {
            results.removeFirst()
        }

        assertEquals(MatrixTimelineBackfillResult(pages = 3, reachedStart = true), backfill)
        assertEquals(0, results.size)
    }

    @Test
    fun `native timeline backfill is bounded when Matrix never reaches the start`() = runBlocking {
        var calls = 0
        val backfill = paginateMatrixTimelineToStart(maxPages = 4) {
            calls += 1
            false
        }

        assertEquals(MatrixTimelineBackfillResult(pages = 4, reachedStart = false), backfill)
        assertEquals(4, calls)
    }

    @Test
    fun `gateway state retries back off to one request per minute`() {
        assertEquals(5_000L, gatewayStateRetryDelayMs(0))
        assertEquals(15_000L, gatewayStateRetryDelayMs(1))
        assertEquals(30_000L, gatewayStateRetryDelayMs(2))
        assertEquals(60_000L, gatewayStateRetryDelayMs(3))
        assertEquals(60_000L, gatewayStateRetryDelayMs(100))
    }

    @Test
    fun `gateway state retry count cannot move backwards`() {
        assertThrows(IllegalArgumentException::class.java) {
            gatewayStateRetryDelayMs(-1)
        }
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
        assertEquals(false, shouldAutomaticallyRetryRevisionConflict(CommandOperation.PROMPT))
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
