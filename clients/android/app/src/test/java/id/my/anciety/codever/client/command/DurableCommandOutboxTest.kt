package id.my.anciety.codever.client.command

import java.io.IOException
import java.util.ArrayDeque
import java.util.UUID
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class DurableCommandOutboxTest {
    @Test
    fun `restart recovers a committed command whose send coroutine had not started`() {
        val fixture = fixture()
        val receipt = fixture.outbox.enqueue(UUID.randomUUID().toString(), payload("session.delete"))

        val restored = DurableCommandOutbox(fixture.store, fixture.clock, fixture.ids)
        assertEquals(CommandState.QUEUED, restored.get(receipt.commandId)?.state)
        val transmission = restored.claimForTransmission(receipt.commandId)!!

        assertEquals(receipt.commandId, transmission.commandId)
        assertEquals(receipt.sequence, transmission.sequence)
        assertFalse(transmission.recovery)
    }

    @Test
    fun `duplicate idempotency returns the original operation without reserving a sequence`() {
        val fixture = fixture()
        val key = UUID.randomUUID().toString()

        val first = fixture.outbox.enqueue(key, payload("prompt", "hello"), "session-1")
        val duplicate = fixture.outbox.enqueue(
            key,
            buildJsonObject {
                put("text", "hello")
                put("operation", "prompt")
                put("sessionId", "session-1")
            },
            "session-1",
        )

        assertEquals(first, duplicate)
        assertEquals(1, fixture.outbox.list().size)
        assertThrows(CommandIdempotencyConflictException::class.java) {
            fixture.outbox.enqueue(key, payload("prompt", "different"), "session-1")
        }
    }

    @Test
    fun `restart recovers an uncertain transmission with the same command identity`() {
        val fixture = fixture()
        val receipt = fixture.outbox.enqueue(UUID.randomUUID().toString(), payload("session.create"))
        val firstLease = fixture.outbox.claimForTransmission(receipt.commandId)!!

        val restored = DurableCommandOutbox(fixture.store, fixture.clock, fixture.ids)
        assertEquals(CommandState.RECOVERY_REQUIRED, restored.get(receipt.commandId)?.state)
        val recoveryLease = restored.claimRecovery(receipt.commandId)!!

        assertEquals(firstLease.commandId, recoveryLease.commandId)
        assertEquals(firstLease.operationId, recoveryLease.operationId)
        assertEquals(firstLease.sequence, recoveryLease.sequence)
        assertEquals(firstLease.baseRevision, recoveryLease.baseRevision)
        assertEquals(firstLease.issuedAt, recoveryLease.issuedAt)
        assertEquals(firstLease.nonce, recoveryLease.nonce)
        assertTrue(recoveryLease.recovery)
    }

    @Test
    fun `ack timeout retains identity while an unrelated command can proceed`() {
        val fixture = fixture()
        val receipt = fixture.outbox.enqueue(UUID.randomUUID().toString(), payload("prompt", "one"))
        val transmission = fixture.outbox.claimForTransmission(receipt.commandId)!!

        val timedOut = fixture.outbox.markAcknowledgementTimedOut(receipt.commandId)!!
        assertEquals(CommandState.RECOVERY_REQUIRED, timedOut.state)
        val independent = fixture.outbox.enqueue(
            UUID.randomUUID().toString(),
            payload("prompt", "two"),
        )
        assertNotEquals(receipt.commandId, independent.commandId)
        assertEquals(receipt.sequence + 1, independent.sequence)

        val recovered = fixture.outbox.claimRecovery(receipt.commandId)!!
        assertEquals(transmission.commandId, recovered.commandId)
        assertEquals(transmission.sequence, recovered.sequence)
        assertNull(fixture.outbox.claimRecovery(receipt.commandId))
    }

    @Test
    fun `terminal result before acknowledgement is retained and cannot be downgraded`() {
        val fixture = fixture()
        val receipt = fixture.outbox.enqueue(UUID.randomUUID().toString(), payload("session.create"))
        fixture.outbox.claimForTransmission(receipt.commandId)
        val completion = CommandCompletion(
            commandId = receipt.commandId,
            sequence = receipt.sequence,
            revision = 7,
            outcome = CommandOutcome.SUCCEEDED,
            sessionId = "session-created",
            result = JsonPrimitive("ok"),
        )

        assertTrue(fixture.outbox.recordCompletion(completion))
        assertFalse(fixture.outbox.recordAcknowledgement(receipt.commandId, receipt.sequence, 6))
        assertFalse(fixture.outbox.recordCompletion(completion))
        val view = fixture.outbox.get(receipt.commandId)!!
        assertEquals(CommandState.SUCCEEDED, view.state)
        assertEquals(7L, view.revision)
        assertEquals(completion, view.completion)

        val next = fixture.outbox.enqueue(UUID.randomUUID().toString(), payload("prompt", "next"))
        assertEquals(receipt.sequence + 1, next.sequence)
    }

    @Test
    fun `ack before result survives restart and result completes without retransmission`() {
        val fixture = fixture()
        val receipt = fixture.outbox.enqueue(UUID.randomUUID().toString(), payload("device.invite"))
        fixture.outbox.claimForTransmission(receipt.commandId)
        assertTrue(fixture.outbox.recordAcknowledgement(receipt.commandId, receipt.sequence, 3))

        val restored = DurableCommandOutbox(fixture.store, fixture.clock, fixture.ids)
        assertEquals(CommandState.ACCEPTED, restored.get(receipt.commandId)?.state)
        assertNull(restored.claimRecovery(receipt.commandId))
        assertTrue(
            restored.recordCompletion(
                CommandCompletion(
                    receipt.commandId,
                    receipt.sequence,
                    4,
                    CommandOutcome.SUCCEEDED,
                    result = JsonPrimitive("invite"),
                ),
            ),
        )
        assertEquals(CommandState.SUCCEEDED, restored.get(receipt.commandId)?.state)
    }

    @Test
    fun `accepted command can probe its terminal result with the exact authenticated identity`() {
        val fixture = fixture()
        val receipt = fixture.outbox.enqueue(UUID.randomUUID().toString(), payload("session.create"))
        val original = fixture.outbox.claimForTransmission(receipt.commandId)!!
        assertTrue(fixture.outbox.recordAcknowledgement(receipt.commandId, receipt.sequence, 3))

        val restored = DurableCommandOutbox(fixture.store, fixture.clock, fixture.ids)
        val probe = restored.claimCompletionRecovery(receipt.commandId)!!

        assertEquals(original.commandId, probe.commandId)
        assertEquals(original.operationId, probe.operationId)
        assertEquals(original.sequence, probe.sequence)
        assertEquals(original.baseRevision, probe.baseRevision)
        assertEquals(original.issuedAt, probe.issuedAt)
        assertEquals(original.nonce, probe.nonce)
        assertTrue(probe.recovery)
        assertEquals(CommandState.ACCEPTED, restored.get(receipt.commandId)?.state)
    }

    @Test
    fun `release removes completion but tombstone prevents replay after process restart`() {
        val fixture = fixture()
        val key = UUID.randomUUID().toString()
        val payload = payload("session.create")
        val receipt = fixture.outbox.enqueue(key, payload)
        fixture.outbox.recordCompletion(
            CommandCompletion(receipt.commandId, receipt.sequence, 1, CommandOutcome.SUCCEEDED),
        )

        assertTrue(fixture.outbox.release(receipt.commandId))
        assertNull(fixture.outbox.get(receipt.commandId))
        val restored = DurableCommandOutbox(fixture.store, fixture.clock, fixture.ids)
        assertThrows(ReleasedCommandException::class.java) {
            restored.enqueue(key, payload)
        }
        assertTrue(restored.list().isEmpty())
    }

    @Test
    fun `revision retry rebases same operation and sequence using a fresh command id`() {
        val fixture = fixture()
        val key = UUID.randomUUID().toString()
        val receipt = fixture.outbox.enqueue(key, payload("prompt", "retry"))
        fixture.outbox.claimForTransmission(receipt.commandId)
        val conflict = fixture.outbox.recordRevisionConflict(receipt.commandId, receipt.sequence, 9)!!
        assertEquals(CommandState.NEEDS_REVIEW, conflict.state)

        val retried = fixture.outbox.resolveRevisionConflict(receipt.commandId, RevisionConflictAction.RETRY)
        assertEquals(receipt.operationId, retried.operationId)
        assertEquals(receipt.idempotencyKey, retried.idempotencyKey)
        assertEquals(receipt.sequence, retried.sequence)
        assertNotEquals(receipt.commandId, retried.commandId)
        val lease = fixture.outbox.claimForTransmission(retried.commandId)!!
        assertEquals(9, lease.baseRevision)
        assertFalse(
            fixture.outbox.recordCompletion(
                CommandCompletion(receipt.commandId, receipt.sequence, 9, CommandOutcome.SUCCEEDED),
            ),
        )
        assertTrue(fixture.outbox.recordAcknowledgement(retried.commandId, retried.sequence, 10))
    }

    @Test
    fun `legacy revision review never blocks an independent v3 command`() {
        val fixture = fixture()
        val receipt = fixture.outbox.enqueue(UUID.randomUUID().toString(), payload("session.delete"))
        fixture.outbox.claimForTransmission(receipt.commandId)
        fixture.outbox.recordRevisionConflict(receipt.commandId, receipt.sequence, 9)

        val next = fixture.outbox.enqueue(UUID.randomUUID().toString(), payload("session.create"))

        assertEquals(CommandState.NEEDS_REVIEW, fixture.outbox.get(receipt.commandId)?.state)
        assertEquals(receipt.sequence + 1, next.sequence)
    }

    @Test
    fun `legacy revision discard preserves a monotonic local compatibility sequence`() {
        val fixture = fixture()
        fixture.outbox.reconcileGatewayScope("epoch-1", 1, 0, 212)
        val receipt = fixture.outbox.enqueue(UUID.randomUUID().toString(), payload("prompt", "discard"))
        assertEquals(212L, fixture.outbox.claimForTransmission(receipt.commandId)?.baseRevision)
        fixture.outbox.recordRevisionConflict(receipt.commandId, receipt.sequence, 348)

        val discarded = fixture.outbox.resolveRevisionConflict(receipt.commandId, RevisionConflictAction.DISCARD)
        assertEquals(CommandState.CANCELLED, discarded.state)
        assertEquals(CommandState.CANCELLED, fixture.outbox.get(receipt.commandId)?.state)

        // The conflict response is an authenticated observation of the
        // Gateway's current revision. Discarding the stale intent must retain
        // that observation durably; otherwise every replacement command uses
        // the same stale base and immediately returns to needs_review.
        val restored = DurableCommandOutbox(fixture.store, fixture.clock, fixture.ids)
        val next = restored.enqueue(UUID.randomUUID().toString(), payload("prompt", "replacement"))
        assertEquals(receipt.sequence + 1, next.sequence)
        assertEquals(348L, restored.claimForTransmission(next.commandId)?.baseRevision)
    }

    @Test
    fun `legacy epoch rotation does not reuse a v3 local command identity`() {
        val fixture = fixture()
        fixture.outbox.reconcileGatewayScope("epoch-1", 1, 0, 0)
        val first = fixture.outbox.enqueue(UUID.randomUUID().toString(), payload("prompt", "first"))
        fixture.outbox.claimForTransmission(first.commandId)
        assertTrue(fixture.outbox.recordAcknowledgement(first.commandId, 1, 1))
        assertTrue(
            fixture.outbox.recordCompletion(
                CommandCompletion(first.commandId, 1, 1, CommandOutcome.SUCCEEDED),
            ),
        )

        val reconciliation = fixture.outbox.reconcileGatewayScope("epoch-2", 2, 0, 0)
        val next = fixture.outbox.enqueue(UUID.randomUUID().toString(), payload("prompt", "next"))
        val transmission = fixture.outbox.claimForTransmission(next.commandId)!!

        assertTrue(reconciliation.epochChanged)
        assertTrue(reconciliation.migratedCommands.isEmpty())
        assertEquals(first.sequence + 1, transmission.sequence)
        assertEquals("epoch-2", transmission.revisionEpoch)
        assertEquals(2L, transmission.revisionEpochGeneration)
    }

    @Test
    fun `unacknowledged command receives a fresh identity and signature lease in a higher epoch`() {
        val fixture = fixture()
        fixture.outbox.reconcileGatewayScope("epoch-1", 1, 7, 19)
        val original = fixture.outbox.enqueue(
            UUID.randomUUID().toString(),
            payload("prompt", "survive rotation"),
        )
        val originalTransmission = fixture.outbox.claimForTransmission(original.commandId)!!

        val reconciliation = fixture.outbox.reconcileGatewayScope("epoch-2", 2, 0, 3)
        val migration = reconciliation.migratedCommands.single()
        val migrated = fixture.outbox.get(migration.currentCommandId)!!
        val migratedTransmission = fixture.outbox.claimForTransmission(migrated.commandId)!!

        assertEquals(original.commandId, migration.previousCommandId)
        assertEquals(original.operationId, migrated.operationId)
        assertEquals(original.idempotencyKey, migrated.idempotencyKey)
        assertEquals(CommandState.QUEUED, migrated.state)
        assertEquals(1, migrated.sequence)
        assertEquals(3, migratedTransmission.baseRevision)
        assertEquals("epoch-2", migratedTransmission.revisionEpoch)
        assertEquals(2L, migratedTransmission.revisionEpochGeneration)
        assertNotEquals(originalTransmission.commandId, migratedTransmission.commandId)
        assertNotEquals(originalTransmission.nonce, migratedTransmission.nonce)
        assertFalse(
            fixture.outbox.recordCompletion(
                CommandCompletion(
                    original.commandId,
                    original.sequence,
                    20,
                    CommandOutcome.SUCCEEDED,
                ),
            ),
        )
    }

    @Test
    fun `legacy unscoped accepted command binds in place instead of executing twice`() {
        val fixture = fixture()
        val original = fixture.outbox.enqueue(
            UUID.randomUUID().toString(),
            payload("prompt", "already accepted"),
        )
        val originalTransmission = fixture.outbox.claimForTransmission(original.commandId)!!

        val reconciliation = fixture.outbox.reconcileGatewayScope(
            revisionEpoch = "epoch-current",
            revisionEpochGeneration = 4,
            acknowledgedSequence = original.sequence,
            revision = 9,
        )
        val restored = DurableCommandOutbox(fixture.store, fixture.clock, fixture.ids)
        val recovery = restored.claimRecovery(original.commandId)!!

        assertTrue(reconciliation.epochChanged)
        assertTrue(reconciliation.migratedCommands.isEmpty())
        assertEquals(original.commandId, recovery.commandId)
        assertEquals(originalTransmission.nonce, recovery.nonce)
        assertEquals("epoch-current", recovery.revisionEpoch)
        assertEquals(4L, recovery.revisionEpochGeneration)
    }

    @Test
    fun `legacy unscoped pending command receives a fresh current epoch identity`() {
        val fixture = fixture()
        val original = fixture.outbox.enqueue(
            UUID.randomUUID().toString(),
            payload("prompt", "not accepted"),
        )
        fixture.outbox.claimForTransmission(original.commandId)

        val reconciliation = fixture.outbox.reconcileGatewayScope(
            revisionEpoch = "epoch-current",
            revisionEpochGeneration = 4,
            acknowledgedSequence = 0,
            revision = 3,
        )
        val migration = reconciliation.migratedCommands.single()
        val migrated = fixture.outbox.claimForTransmission(migration.currentCommandId)!!

        assertEquals(original.commandId, migration.previousCommandId)
        assertNotEquals(original.commandId, migrated.commandId)
        assertEquals(
            migration.currentCommandId,
            fixture.outbox.resolveCurrent(original.commandId)?.commandId,
        )
        assertEquals(1L, migrated.sequence)
        assertEquals(3L, migrated.baseRevision)
        assertEquals("epoch-current", migrated.revisionEpoch)
        assertEquals(4L, migrated.revisionEpochGeneration)
    }

    @Test
    fun `completion from a retired accepted epoch cannot cause v3 identity reuse`() {
        val fixture = fixture()
        fixture.outbox.reconcileGatewayScope("epoch-1", 1, 0, 0)
        val accepted = fixture.outbox.enqueue(UUID.randomUUID().toString(), payload("prompt", "old"))
        fixture.outbox.claimForTransmission(accepted.commandId)
        assertTrue(fixture.outbox.recordAcknowledgement(accepted.commandId, 1, 1))

        fixture.outbox.reconcileGatewayScope("epoch-2", 2, 0, 0)
        assertTrue(
            fixture.outbox.recordCompletion(
                CommandCompletion(accepted.commandId, 1, 1, CommandOutcome.SUCCEEDED),
            ),
        )
        val next = fixture.outbox.enqueue(UUID.randomUUID().toString(), payload("prompt", "new"))
        val transmission = fixture.outbox.claimForTransmission(next.commandId)!!

        assertEquals(accepted.sequence + 1, transmission.sequence)
        assertEquals("epoch-2", transmission.revisionEpoch)
    }

    @Test
    fun `stale or conflicting authenticated epoch state cannot replace the current scope`() {
        val fixture = fixture()
        fixture.outbox.reconcileGatewayScope("epoch-2", 2, 4, 8)

        val stale = fixture.outbox.reconcileGatewayScope("epoch-1", 1, 99, 99)
        assertFalse(stale.epochChanged)
        assertThrows(IllegalArgumentException::class.java) {
            fixture.outbox.reconcileGatewayScope("different-epoch", 2, 0, 0)
        }
        assertThrows(IllegalArgumentException::class.java) {
            fixture.outbox.reconcileGatewayScope("epoch-2", 3, 0, 0)
        }

        val next = fixture.outbox.enqueue(UUID.randomUUID().toString(), payload("prompt", "still current"))
        val transmission = fixture.outbox.claimForTransmission(next.commandId)!!
        assertEquals(5, transmission.sequence)
        assertEquals("epoch-2", transmission.revisionEpoch)
        assertEquals(2L, transmission.revisionEpochGeneration)
    }

    @Test
    fun `failed durable save rolls back in memory state`() {
        val store = FailingStore()
        val ids = QueueIds()
        val outbox = DurableCommandOutbox(store, MutableClock(), ids)
        store.failWrites = true

        assertThrows(IOException::class.java) {
            outbox.enqueue(UUID.randomUUID().toString(), payload("prompt", "not saved"))
        }
        assertTrue(outbox.list().isEmpty())

        store.failWrites = false
        val saved = outbox.enqueue(UUID.randomUUID().toString(), payload("prompt", "saved"))
        assertEquals(1, saved.sequence)
        assertEquals(1, outbox.list().size)
    }

    @Test
    fun `sensitive payload and result are redacted from lifecycle toString`() {
        val fixture = fixture()
        val receipt = fixture.outbox.enqueue(
            UUID.randomUUID().toString(),
            payload("prompt", "secret-prompt"),
        )
        val transmission = fixture.outbox.claimForTransmission(receipt.commandId)!!
        assertFalse(transmission.toString().contains("secret-prompt"))

        val completion = CommandCompletion(
            receipt.commandId,
            receipt.sequence,
            1,
            CommandOutcome.SUCCEEDED,
            result = JsonPrimitive("secret-result"),
        )
        assertFalse(completion.toString().contains("secret-result"))
    }

    @Test
    fun `enqueue applies strict protocol validation and session binding`() {
        val fixture = fixture()
        assertThrows(IllegalArgumentException::class.java) {
            fixture.outbox.enqueue(
                UUID.randomUUID().toString(),
                buildJsonObject {
                    put("operation", "prompt")
                    put("sessionId", "session-1")
                    put("text", "hello")
                    put("unexpected", true)
                },
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            fixture.outbox.enqueue(
                UUID.randomUUID().toString(),
                payload("prompt", "hello"),
                sessionId = "different-session",
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            fixture.outbox.enqueue(
                UUID.randomUUID().toString(),
                payload("session.create"),
                sessionId = "unexpected-session",
            )
        }
    }

    private fun fixture(): Fixture {
        val store = InMemoryCommandOutboxStore()
        val clock = MutableClock()
        val ids = QueueIds()
        return Fixture(store, clock, ids, DurableCommandOutbox(store, clock, ids))
    }

    private fun payload(operation: String, text: String? = null) = buildJsonObject {
        put("operation", operation)
        if (operation in setOf("prompt", "cancel", "decision", "session.settings", "session.archive", "session.restore", "session.delete")) {
            put("sessionId", "session-1")
        }
        text?.let { put("text", it) }
    }

    private data class Fixture(
        val store: InMemoryCommandOutboxStore,
        val clock: MutableClock,
        val ids: QueueIds,
        val outbox: DurableCommandOutbox,
    )

    private class MutableClock : CommandClock {
        private var time = 1_000L
        override fun now(): Long = time++
    }

    private class QueueIds : CommandIdFactory {
        private val values = ArrayDeque<String>()
        private var next = 1

        override fun newId(): String = values.pollFirst() ?: "generated-${next++}"
    }

    private class FailingStore : CommandOutboxStore {
        var failWrites = false
        private var snapshot: CommandOutboxSnapshot? = null

        override fun load(): CommandOutboxSnapshot? = snapshot

        override fun save(snapshot: CommandOutboxSnapshot) {
            if (failWrites) throw IOException("injected durable write failure")
            this.snapshot = snapshot
        }

        override fun clear() {
            snapshot = null
        }
    }
}
