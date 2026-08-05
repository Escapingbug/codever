package id.my.anciety.codever.service

import id.my.anciety.codever.client.command.CommandOperation
import id.my.anciety.codever.client.command.CommandOutcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TaskNotificationPolicyTest {
    @Test
    fun `background prompt completion is visible for every terminal outcome`() {
        assertEquals(
            TaskNotificationKind.SUCCEEDED,
            TaskNotificationPolicy.decide(false, CommandOperation.PROMPT, CommandOutcome.SUCCEEDED),
        )
        assertEquals(
            TaskNotificationKind.FAILED,
            TaskNotificationPolicy.decide(false, CommandOperation.PROMPT, CommandOutcome.FAILED),
        )
        assertEquals(
            TaskNotificationKind.CANCELLED,
            TaskNotificationPolicy.decide(false, CommandOperation.PROMPT, CommandOutcome.CANCELLED),
        )
    }

    @Test
    fun `foreground prompt completion is handled in app`() {
        assertNull(
            TaskNotificationPolicy.decide(true, CommandOperation.PROMPT, CommandOutcome.SUCCEEDED),
        )
    }

    @Test
    fun `non prompt commands do not masquerade as agent task completion`() {
        assertNull(
            TaskNotificationPolicy.decide(false, CommandOperation.SESSION_CREATE, CommandOutcome.SUCCEEDED),
        )
        assertNull(
            TaskNotificationPolicy.decide(false, CommandOperation.CANCEL, CommandOutcome.SUCCEEDED),
        )
    }
}
