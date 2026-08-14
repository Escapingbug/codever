package id.my.anciety.codever.bridge

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URI

class TrustedWebOriginTest {
    @Test
    fun `accepts only the exact configured origin`() {
        val configured = URI(TrustedWebOrigin.APP_ORIGIN)
        val otherScheme = if (configured.scheme == "https") "http" else "https"
        val otherPort = if (configured.port == 8443) 8444 else 8443

        assertTrue(TrustedWebOrigin.isTrustedOrigin(TrustedWebOrigin.APP_ORIGIN))
        assertTrue(TrustedWebOrigin.isTrustedOrigin("${TrustedWebOrigin.APP_ORIGIN}/"))

        assertFalse(TrustedWebOrigin.isTrustedOrigin("$otherScheme://${configured.authority}"))
        assertFalse(TrustedWebOrigin.isTrustedOrigin("${configured.scheme}://evil.${configured.host}:${configured.port}"))
        assertFalse(TrustedWebOrigin.isTrustedOrigin("${configured.scheme}://${configured.host}:$otherPort"))
        assertFalse(TrustedWebOrigin.isTrustedOrigin("${configured.scheme}://user@${configured.authority}"))
        assertFalse(TrustedWebOrigin.isTrustedOrigin("${TrustedWebOrigin.APP_ORIGIN}/app"))
        assertFalse(TrustedWebOrigin.isTrustedOrigin("not a uri"))
    }

    @Test
    fun `navigation allows configured paths but rejects lookalikes`() {
        val configured = URI(TrustedWebOrigin.APP_ORIGIN)

        assertTrue(TrustedWebOrigin.isTrustedUrl("${TrustedWebOrigin.APP_ORIGIN}/session/123?native=1#message"))
        assertFalse(
            TrustedWebOrigin.isTrustedUrl(
                "${configured.scheme}://${configured.host}.evil.example/session/123",
            ),
        )
        assertFalse(
            TrustedWebOrigin.isTrustedUrl(
                "${configured.scheme}://${configured.authority}@evil.example/session/123",
            ),
        )
    }
}
