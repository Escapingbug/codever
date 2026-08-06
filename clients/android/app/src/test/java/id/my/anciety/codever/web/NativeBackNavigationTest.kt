package id.my.anciety.codever.web

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeBackNavigationTest {
    @Test
    fun `only an explicit javascript true consumes native Back`() {
        assertTrue(nativeBackWasHandled("true"))
        assertTrue(nativeBackWasHandled("  true  "))
        assertFalse(nativeBackWasHandled("false"))
        assertFalse(nativeBackWasHandled("null"))
        assertFalse(nativeBackWasHandled(null))
    }

    @Test
    fun `dispatch script sends a cancelable stable event`() {
        assertTrue(NATIVE_BACK_DISPATCH_SCRIPT.contains("codever:native-back"))
        assertTrue(NATIVE_BACK_DISPATCH_SCRIPT.contains("cancelable: true"))
        assertTrue(NATIVE_BACK_DISPATCH_SCRIPT.contains("event.defaultPrevented"))
    }

    @Test
    fun `real web history precedes putting the root task in background`() {
        assertEquals(
            NativeBackFallbackAction.WEB_HISTORY,
            nativeBackFallbackAction(canGoBack = true),
        )
        assertEquals(
            NativeBackFallbackAction.BACKGROUND_TASK,
            nativeBackFallbackAction(canGoBack = false),
        )
    }
}
