package id.my.anciety.codever.matrix

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.matrix.rustcomponents.sdk.InternalException

class MatrixRuntimeFailurePolicyTest {
    @Test
    fun `Rust panic is blocked instead of entering a retry storm`() {
        val decision = MatrixRuntimeFailurePolicy.decide(InternalException("redacted panic"))

        assertTrue(decision.blocked)
        assertEquals("matrix_sdk_internal_failure", decision.detailCode)
    }

    @Test
    fun `ordinary runtime failures remain retryable`() {
        val decision = MatrixRuntimeFailurePolicy.decide(IllegalStateException("offline"))

        assertFalse(decision.blocked)
        assertEquals("matrix_runtime_failed", decision.detailCode)
    }

    @Test
    fun `running supervisor without a first response is blocked instead of retrying forever`() {
        val decision = MatrixSyncRestartPolicy.decide(
            MatrixSyncRestartReason.FIRST_SYNC_TIMEOUT,
            syncTaskRunning = true,
        )

        assertTrue(decision.blocked)
        assertEquals("matrix_first_sync_timeout", decision.detailCode)
    }

    @Test
    fun `stopped and stale tasks remain retryable`() {
        listOf(
            MatrixSyncRestartReason.TASK_STOPPED to false,
            MatrixSyncRestartReason.SYNC_STALE to true,
        ).forEach { (reason, running) ->
            assertFalse(MatrixSyncRestartPolicy.decide(reason, running).blocked)
        }
    }
}
