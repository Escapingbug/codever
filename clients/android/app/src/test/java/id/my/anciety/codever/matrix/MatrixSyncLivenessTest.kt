package id.my.anciety.codever.matrix

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MatrixSyncLivenessTest {
    private var now = 1_000L
    private val liveness = MatrixSyncLiveness(
        now = { now },
        firstSyncTimeoutMs = 100L,
        activeSyncTimeoutMs = 200L,
    )

    @Test
    fun `externally supervised task without first response is restarted after deadline`() {
        liveness.connectionStarted()
        now += 99
        assertNull(liveness.restartReason(true, MatrixRuntimePhase.CONNECTING))
        now += 1
        assertEquals(
            MatrixSyncRestartReason.FIRST_SYNC_TIMEOUT,
            liveness.restartReason(true, MatrixRuntimePhase.CONNECTING),
        )
    }

    @Test
    fun `internally supervised task can wait for its first response`() {
        liveness.connectionStarted()
        now += 101

        assertNull(
            liveness.restartReason(
                true,
                MatrixRuntimePhase.CONNECTING,
                internallySupervised = true,
            ),
        )
    }

    @Test
    fun `active sync is restarted when responses become stale`() {
        liveness.connectionStarted()
        now += 50
        liveness.syncUpdated()
        now += 199
        assertNull(liveness.restartReason(true, MatrixRuntimePhase.SYNCING))
        now += 1
        assertEquals(
            MatrixSyncRestartReason.SYNC_STALE,
            liveness.restartReason(true, MatrixRuntimePhase.SYNCING),
        )
    }

    @Test
    fun `internally supervised sync does not require external response heartbeats`() {
        liveness.connectionStarted()
        liveness.syncUpdated()
        now += 201

        assertNull(
            liveness.restartReason(
                true,
                MatrixRuntimePhase.SYNCING,
                internallySupervised = true,
            ),
        )
    }

    @Test
    fun `stopped task restarts immediately but inactive phases do not`() {
        liveness.connectionStarted()
        assertEquals(
            MatrixSyncRestartReason.TASK_STOPPED,
            liveness.restartReason(false, MatrixRuntimePhase.CONNECTING),
        )
        assertNull(liveness.restartReason(false, MatrixRuntimePhase.OFFLINE))
        assertNull(liveness.restartReason(false, MatrixRuntimePhase.RETRY_WAIT))
    }

    @Test
    fun `network resume gives an existing sync a fresh first response window`() {
        liveness.connectionStarted()
        now += 100
        liveness.networkResumed()
        assertNull(liveness.restartReason(true, MatrixRuntimePhase.CONNECTING))
    }
}
