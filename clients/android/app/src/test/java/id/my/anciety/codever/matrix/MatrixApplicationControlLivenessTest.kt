package id.my.anciety.codever.matrix

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MatrixApplicationControlLivenessTest {
    @Test
    fun `missing receiver receives the same bounded startup window`() {
        assertFalse(
            applicationControlReceiverIsStale(
                lastProgressAt = 1_000,
                now = 1_001,
                timeoutMs = 90_000,
            ),
        )
        assertFalse(
            applicationControlReceiverIsStale(
                lastProgressAt = 0,
                now = 1_001,
                timeoutMs = 90_000,
            ),
        )
        assertTrue(
            applicationControlReceiverIsStale(
                lastProgressAt = 1_000,
                now = 91_000,
                timeoutMs = 90_000,
            ),
        )
    }

    @Test
    fun `active receiver becomes stale only at its deadline`() {
        assertFalse(
            applicationControlReceiverIsStale(
                lastProgressAt = 1_000,
                now = 90_999,
                timeoutMs = 90_000,
            ),
        )
        assertTrue(
            applicationControlReceiverIsStale(
                lastProgressAt = 1_000,
                now = 91_000,
                timeoutMs = 90_000,
            ),
        )
    }
}
