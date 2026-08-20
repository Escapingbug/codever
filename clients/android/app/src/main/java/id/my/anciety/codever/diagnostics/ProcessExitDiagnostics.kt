package id.my.anciety.codever.diagnostics

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context

/** Records the prior process death on the next start without exporting traces or free-form text. */
object ProcessExitDiagnostics {
    private const val PREFERENCES = "codever-process-exit-diagnostics"
    private const val LAST_RECORDED_TIMESTAMP = "last-recorded-timestamp"
    private const val MAX_HISTORY = 8
    private const val MAX_RECORDED_PER_START = 3

    fun recordPreviousExits(
        context: Context,
        diagnostics: DiagnosticRecorder,
        processStartedAt: Long = System.currentTimeMillis(),
    ) {
        runCatching {
            val manager = context.getSystemService(ActivityManager::class.java)
            val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            val lastRecorded = preferences.getLong(LAST_RECORDED_TIMESTAMP, 0L)
            val unseen = manager
                .getHistoricalProcessExitReasons(context.packageName, 0, MAX_HISTORY)
                .asSequence()
                .filter { it.timestamp > lastRecorded && it.timestamp < processStartedAt }
                .sortedBy(ApplicationExitInfo::getTimestamp)
                .toList()
            unseen.takeLast(MAX_RECORDED_PER_START).forEach { exit ->
                diagnostics.record(
                    "process.previous_exit",
                    mapOf(
                        "reason" to applicationExitReasonLabel(exit.reason),
                        "status" to exit.status.toString(),
                        "importance" to exit.importance.toString(),
                        "pss_kb" to exit.pss.coerceAtLeast(0).toString(),
                        "rss_kb" to exit.rss.coerceAtLeast(0).toString(),
                    ),
                )
            }
            unseen.maxOfOrNull(ApplicationExitInfo::getTimestamp)?.let { newest ->
                preferences.edit().putLong(LAST_RECORDED_TIMESTAMP, newest).apply()
            }
        }.onFailure { error ->
            diagnostics.record(
                "process.exit_history_failed",
                mapOf("error" to error.javaClass.simpleName.take(160)),
            )
        }
    }
}

internal fun applicationExitReasonLabel(reason: Int): String = when (reason) {
    ApplicationExitInfo.REASON_EXIT_SELF -> "exit_self"
    ApplicationExitInfo.REASON_SIGNALED -> "signaled"
    ApplicationExitInfo.REASON_LOW_MEMORY -> "low_memory"
    ApplicationExitInfo.REASON_CRASH -> "java_crash"
    ApplicationExitInfo.REASON_CRASH_NATIVE -> "native_crash"
    ApplicationExitInfo.REASON_ANR -> "anr"
    ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "initialization_failure"
    ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "permission_change"
    ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "excessive_resource_usage"
    ApplicationExitInfo.REASON_USER_REQUESTED -> "user_requested"
    ApplicationExitInfo.REASON_USER_STOPPED -> "user_stopped"
    ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "dependency_died"
    ApplicationExitInfo.REASON_OTHER -> "other"
    ApplicationExitInfo.REASON_FREEZER -> "freezer"
    ApplicationExitInfo.REASON_PACKAGE_STATE_CHANGE -> "package_state_change"
    ApplicationExitInfo.REASON_PACKAGE_UPDATED -> "package_updated"
    else -> "unknown"
}
