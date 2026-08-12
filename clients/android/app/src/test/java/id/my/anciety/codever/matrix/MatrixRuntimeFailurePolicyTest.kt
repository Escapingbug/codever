package id.my.anciety.codever.matrix

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.matrix.rustcomponents.sdk.InternalException

class MatrixRuntimeFailurePolicyTest {
    @Test
    fun `sync service build failures are blocked instead of retried`() {
        val decision = MatrixRuntimeFailurePolicy.decide(
            MatrixSyncServiceBuildException(IllegalArgumentException("invalid connection id")),
        )

        assertTrue(decision.blocked)
        assertEquals("matrix_sync_service_build_failed", decision.detailCode)
    }

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
    fun `first response timeouts remain retryable for external supervisors`() {
        val decision = MatrixSyncRestartPolicy.decide(MatrixSyncRestartReason.FIRST_SYNC_TIMEOUT)

        assertFalse(decision.blocked)
        assertEquals("matrix_first_sync_timeout", decision.detailCode)
    }

    @Test
    fun `stopped and stale tasks remain retryable`() {
        listOf(
            MatrixSyncRestartReason.TASK_STOPPED,
            MatrixSyncRestartReason.SYNC_STALE,
        ).forEach { reason ->
            assertFalse(MatrixSyncRestartPolicy.decide(reason).blocked)
        }
    }
}
