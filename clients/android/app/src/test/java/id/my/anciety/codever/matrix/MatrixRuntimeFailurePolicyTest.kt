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
}
