package id.my.anciety.codever.service

object ServiceActions {
    const val START = "id.my.anciety.codever.action.START"
    const val DISCONNECT = "id.my.anciety.codever.action.DISCONNECT"
}

enum class ServiceStartDecision {
    KEEP_RUNNING,
    STOP_EXPLICITLY,
    STOP_DISABLED,
}

enum class ActivityLaunchDecision {
    BIND_ONLY,
    RESTORE_FOREGROUND,
    WAIT_FOR_NOTIFICATION,
}

object ServiceStartPolicy {
    fun decide(action: String?, restoreEnabled: Boolean): ServiceStartDecision = when {
        action == ServiceActions.DISCONNECT -> ServiceStartDecision.STOP_EXPLICITLY
        action == ServiceActions.START -> ServiceStartDecision.KEEP_RUNNING
        restoreEnabled -> ServiceStartDecision.KEEP_RUNNING
        else -> ServiceStartDecision.STOP_DISABLED
    }

    fun shouldRestoreAfterBoot(restoreEnabled: Boolean, notificationsAvailable: Boolean): Boolean =
        restoreEnabled && notificationsAvailable

    fun activityLaunch(
        restoreEnabled: Boolean,
        restorePreferenceExists: Boolean,
        notificationsAvailable: Boolean,
    ): ActivityLaunchDecision = when {
        !notificationsAvailable && (restoreEnabled || !restorePreferenceExists) ->
            ActivityLaunchDecision.WAIT_FOR_NOTIFICATION
        !restorePreferenceExists || restoreEnabled -> ActivityLaunchDecision.RESTORE_FOREGROUND
        else -> ActivityLaunchDecision.BIND_ONLY
    }
}
