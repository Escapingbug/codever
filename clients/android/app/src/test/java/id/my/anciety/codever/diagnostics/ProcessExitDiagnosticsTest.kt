package id.my.anciety.codever.diagnostics

import android.app.ApplicationExitInfo
import org.junit.Assert.assertEquals
import org.junit.Test

class ProcessExitDiagnosticsTest {
    @Test
    fun `exit reason labels distinguish crashes system kills and package updates`() {
        assertEquals("java_crash", applicationExitReasonLabel(ApplicationExitInfo.REASON_CRASH))
        assertEquals("native_crash", applicationExitReasonLabel(ApplicationExitInfo.REASON_CRASH_NATIVE))
        assertEquals("low_memory", applicationExitReasonLabel(ApplicationExitInfo.REASON_LOW_MEMORY))
        assertEquals("freezer", applicationExitReasonLabel(ApplicationExitInfo.REASON_FREEZER))
        assertEquals("package_updated", applicationExitReasonLabel(ApplicationExitInfo.REASON_PACKAGE_UPDATED))
        assertEquals("unknown", applicationExitReasonLabel(Int.MAX_VALUE))
    }
}
