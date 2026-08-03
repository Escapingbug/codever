package id.my.anciety.codever.bridge

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TrustedWebOriginTest {
    @Test
    fun `accepts only the exact production https origin`() {
        assertTrue(TrustedWebOrigin.isTrustedOrigin("https://rd.anciety.my.id"))
        assertTrue(TrustedWebOrigin.isTrustedOrigin("https://rd.anciety.my.id/"))
        assertTrue(TrustedWebOrigin.isTrustedOrigin("https://RD.ANCIETY.MY.ID:443"))

        assertFalse(TrustedWebOrigin.isTrustedOrigin("http://rd.anciety.my.id"))
        assertFalse(TrustedWebOrigin.isTrustedOrigin("https://evil.rd.anciety.my.id"))
        assertFalse(TrustedWebOrigin.isTrustedOrigin("https://rd.anciety.my.id:8443"))
        assertFalse(TrustedWebOrigin.isTrustedOrigin("https://user@rd.anciety.my.id"))
        assertFalse(TrustedWebOrigin.isTrustedOrigin("https://rd.anciety.my.id/app"))
        assertFalse(TrustedWebOrigin.isTrustedOrigin("not a uri"))
    }

    @Test
    fun `navigation allows production paths but rejects lookalikes`() {
        assertTrue(TrustedWebOrigin.isTrustedUrl("https://rd.anciety.my.id/session/123?native=1#message"))
        assertFalse(TrustedWebOrigin.isTrustedUrl("https://rd.anciety.my.id.evil.example/session/123"))
        assertFalse(TrustedWebOrigin.isTrustedUrl("https://rd.anciety.my.id@evil.example/session/123"))
    }
}
