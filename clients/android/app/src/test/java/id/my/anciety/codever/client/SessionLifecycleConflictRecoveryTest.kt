package id.my.anciety.codever.client

import id.my.anciety.codever.client.command.CommandClock
import id.my.anciety.codever.client.command.CommandCompletion
import id.my.anciety.codever.client.command.CommandIdFactory
import id.my.anciety.codever.client.command.CommandOperation
import id.my.anciety.codever.client.command.CommandOutcome
import id.my.anciety.codever.client.command.CommandState
import id.my.anciety.codever.client.command.DurableCommandOutbox
import id.my.anciety.codever.client.command.InMemoryCommandOutboxStore
import id.my.anciety.codever.client.command.RevisionConflictAction
import java.util.UUID
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionLifecycleConflictRecoveryTest {
    @Test
    fun `stale deletion rebases after restart and does not block the next session creation`() {
        val store = InMemoryCommandOutboxStore()
        val clock = IncrementingClock()
        val ids = IncrementingIds()
        var outbox = DurableCommandOutbox(store, clock, ids)

        val deletion = outbox.enqueue(
            UUID.randomUUID().toString(),
            buildJsonObject {
                put("operation", "session.delete")
                put("sessionId", "existing-session")
            },
        )
        outbox.claimForTransmission(deletion.commandId)
        val conflicted = outbox.recordRevisionConflict(
            deletion.commandId,
            deletion.sequence,
            expectedRevision = 1,
        )!!
        assertEquals(CommandState.NEEDS_REVIEW, conflicted.state)

        // Recreate the durable outbox to exercise the real process-restart
        // path that previously left the APK permanently blocked.
        outbox = DurableCommandOutbox(store, clock, ids)
        val restored = outbox.get(deletion.commandId)!!
        assertEquals(CommandState.NEEDS_REVIEW, restored.state)
        assertTrue(shouldAutomaticallyRetryRevisionConflict(outbox.operation(restored.commandId)))

        val rebased = outbox.resolveRevisionConflict(
            restored.commandId,
            RevisionConflictAction.RETRY,
        )
        assertEquals(deletion.operationId, rebased.operationId)
        assertEquals(deletion.idempotencyKey, rebased.idempotencyKey)
        assertEquals(deletion.sequence, rebased.sequence)
        assertNotEquals(deletion.commandId, rebased.commandId)
        val transmission = outbox.claimForTransmission(rebased.commandId)!!
        assertEquals(1L, transmission.baseRevision)

        assertTrue(outbox.recordAcknowledgement(
            transmission.commandId,
            transmission.sequence,
            revision = 2,
        ))
        assertTrue(outbox.recordCompletion(CommandCompletion(
            commandId = transmission.commandId,
            sequence = transmission.sequence,
            revision = 2,
            outcome = CommandOutcome.SUCCEEDED,
            sessionId = "existing-session",
        )))

        // A second restart proves that terminal deletion state is durable and
        // no longer occupies the outbox's single active-command slot.
        outbox = DurableCommandOutbox(store, clock, ids)
        val creation = outbox.enqueue(
            UUID.randomUUID().toString(),
            buildJsonObject { put("operation", "session.create") },
        )
        assertEquals(2L, creation.sequence)
        val creationTransmission = outbox.claimForTransmission(creation.commandId)!!
        assertEquals(2L, creationTransmission.baseRevision)
        assertEquals(CommandOperation.SESSION_CREATE, outbox.operation(creation.commandId))
    }

    private class IncrementingClock : CommandClock {
        private var current = 1_000L
        override fun now(): Long = current++
    }

    private class IncrementingIds : CommandIdFactory {
        private var next = 1
        override fun newId(): String = "lifecycle-${next++}"
    }
}
