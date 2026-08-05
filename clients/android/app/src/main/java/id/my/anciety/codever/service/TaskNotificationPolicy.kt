package id.my.anciety.codever.service

import id.my.anciety.codever.client.command.CommandOperation
import id.my.anciety.codever.client.command.CommandOutcome

enum class TaskNotificationKind {
    SUCCEEDED,
    FAILED,
    CANCELLED,
}

object TaskNotificationPolicy {
    fun decide(
        uiForeground: Boolean,
        operation: CommandOperation,
        outcome: CommandOutcome,
    ): TaskNotificationKind? {
        if (uiForeground || operation != CommandOperation.PROMPT) return null
        return when (outcome) {
            CommandOutcome.SUCCEEDED -> TaskNotificationKind.SUCCEEDED
            CommandOutcome.FAILED -> TaskNotificationKind.FAILED
            CommandOutcome.CANCELLED -> TaskNotificationKind.CANCELLED
        }
    }
}
