package id.my.anciety.codever.web

import org.junit.Assert.assertEquals
import org.junit.Test

class WebHostBindingPolicyTest {
    @Test
    fun `cold launch creates the web host before service connection`() {
        assertEquals(
            WebHostBindingAction.CREATE,
            webHostActionAfterServiceConnected(hasExistingWebHost = false),
        )
    }

    @Test
    fun `initial service connection keeps an already loading web host`() {
        assertEquals(
            WebHostBindingAction.KEEP,
            webHostActionAfterServiceConnected(
                hasExistingWebHost = true,
                recoveringFromDisconnect = false,
            ),
        )
    }

    @Test
    fun `service reconnection reloads a retained web host`() {
        assertEquals(
            WebHostBindingAction.RELOAD,
            webHostActionAfterServiceConnected(
                hasExistingWebHost = true,
                recoveringFromDisconnect = true,
            ),
        )
    }
}
