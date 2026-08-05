package id.my.anciety.codever.web

import org.junit.Assert.assertEquals
import org.junit.Test

class WebHostBindingPolicyTest {
    @Test
    fun `cold service connection creates the web host`() {
        assertEquals(
            WebHostBindingAction.CREATE,
            webHostActionAfterServiceConnected(hasExistingWebHost = false),
        )
    }

    @Test
    fun `service reconnection reloads a retained web host`() {
        assertEquals(
            WebHostBindingAction.RELOAD,
            webHostActionAfterServiceConnected(hasExistingWebHost = true),
        )
    }
}
