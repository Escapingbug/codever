package id.my.anciety.codever.matrix

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidNetworkMonitorTest {
    @Test
    fun `an internet-capable network may attempt Matrix without public validation`() {
        assertTrue(hasUsableMatrixNetwork(hasInternetCapability = true))
    }

    @Test
    fun `a network without internet capability remains unavailable`() {
        assertFalse(hasUsableMatrixNetwork(hasInternetCapability = false))
    }
}
