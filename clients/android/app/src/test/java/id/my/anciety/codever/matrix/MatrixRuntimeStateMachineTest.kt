package id.my.anciety.codever.matrix

import org.junit.Assert.assertEquals
import org.junit.Test

class MatrixRuntimeStateMachineTest {
    private var now = 100L
    private val machine = MatrixRuntimeStateMachine { now++ }

    @Test
    fun `restored session reconnects through offline and syncing states`() {
        assertPhase(MatrixRuntimePhase.OFFLINE, MatrixRuntimeEvent.Start(true, false))
        assertPhase(MatrixRuntimePhase.CONNECTING, MatrixRuntimeEvent.NetworkAvailable)
        assertPhase(MatrixRuntimePhase.SYNCING, MatrixRuntimeEvent.SyncUpdated)
        assertPhase(MatrixRuntimePhase.OFFLINE, MatrixRuntimeEvent.NetworkLost)
        assertPhase(MatrixRuntimePhase.CONNECTING, MatrixRuntimeEvent.NetworkAvailable)
    }

    @Test
    fun `missing session waits for bootstrap and explicit stop wins`() {
        assertPhase(MatrixRuntimePhase.WAITING_FOR_SESSION, MatrixRuntimeEvent.Start(false, true))
        assertPhase(MatrixRuntimePhase.BOOTSTRAPPING, MatrixRuntimeEvent.BootstrapStarted)
        assertPhase(MatrixRuntimePhase.CONNECTING, MatrixRuntimeEvent.SessionReady(true))
        assertPhase(MatrixRuntimePhase.STOPPED, MatrixRuntimeEvent.Stop)
    }

    @Test
    fun `fatal storage failure is visibly blocked`() {
        assertPhase(
            MatrixRuntimePhase.BLOCKED,
            MatrixRuntimeEvent.Failed("matrix_storage_failed", blocked = true),
        )
        assertEquals("matrix_storage_failed", machine.status.detailCode)
    }

    private fun assertPhase(expected: MatrixRuntimePhase, event: MatrixRuntimeEvent) {
        assertEquals(expected, machine.accept(event).phase)
    }
}
