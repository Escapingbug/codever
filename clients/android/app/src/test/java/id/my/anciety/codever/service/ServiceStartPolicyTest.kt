package id.my.anciety.codever.service

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ServiceStartPolicyTest {
    @Test
    fun `user start always enables the foreground host`() {
        assertEquals(
            ServiceStartDecision.KEEP_RUNNING,
            ServiceStartPolicy.decide(ServiceActions.START, restoreEnabled = false),
        )
    }

    @Test
    fun `sticky restart only runs when restoration remains enabled`() {
        assertEquals(
            ServiceStartDecision.KEEP_RUNNING,
            ServiceStartPolicy.decide(action = null, restoreEnabled = true),
        )
        assertEquals(
            ServiceStartDecision.STOP_DISABLED,
            ServiceStartPolicy.decide(action = null, restoreEnabled = false),
        )
    }

    @Test
    fun `explicit disconnect wins over persisted state`() {
        assertEquals(
            ServiceStartDecision.STOP_EXPLICITLY,
            ServiceStartPolicy.decide(ServiceActions.DISCONNECT, restoreEnabled = true),
        )
    }

    @Test
    fun `boot restore requires both opt in and visible notifications`() {
        assertTrue(ServiceStartPolicy.shouldRestoreAfterBoot(true, true))
        assertFalse(ServiceStartPolicy.shouldRestoreAfterBoot(true, false))
        assertFalse(ServiceStartPolicy.shouldRestoreAfterBoot(false, true))
    }

    @Test
    fun `activity never turns an explicitly disconnected host back on`() {
        assertEquals(
            ActivityLaunchDecision.BIND_ONLY,
            ServiceStartPolicy.activityLaunch(
                restoreEnabled = false,
                restorePreferenceExists = true,
                notificationsAvailable = true,
            ),
        )
        assertEquals(
            ActivityLaunchDecision.BIND_ONLY,
            ServiceStartPolicy.activityLaunch(
                restoreEnabled = false,
                restorePreferenceExists = true,
                notificationsAvailable = false,
            ),
        )
    }

    @Test
    fun `enabled host restores only with a visible notification`() {
        assertEquals(
            ActivityLaunchDecision.RESTORE_FOREGROUND,
            ServiceStartPolicy.activityLaunch(true, true, true),
        )
        assertEquals(
            ActivityLaunchDecision.WAIT_FOR_NOTIFICATION,
            ServiceStartPolicy.activityLaunch(true, true, false),
        )
    }

    @Test
    fun `first launch always enters the persistent notification flow`() {
        assertEquals(
            ActivityLaunchDecision.RESTORE_FOREGROUND,
            ServiceStartPolicy.activityLaunch(
                restoreEnabled = false,
                restorePreferenceExists = false,
                notificationsAvailable = true,
            ),
        )
        assertEquals(
            ActivityLaunchDecision.WAIT_FOR_NOTIFICATION,
            ServiceStartPolicy.activityLaunch(
                restoreEnabled = false,
                restorePreferenceExists = false,
                notificationsAvailable = false,
            ),
        )
    }
}
