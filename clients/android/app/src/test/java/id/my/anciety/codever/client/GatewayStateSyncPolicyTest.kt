package id.my.anciety.codever.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class GatewayStateSyncPolicyTest {
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
}
