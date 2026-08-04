package id.my.anciety.codever.matrix

enum class MatrixSyncRestartReason(val detailCode: String) {
    TASK_STOPPED("matrix_sync_task_stopped"),
    FIRST_SYNC_TIMEOUT("matrix_first_sync_timeout"),
    SYNC_STALE("matrix_sync_stale"),
}

class MatrixSyncLiveness(
    private val now: () -> Long = System::currentTimeMillis,
    private val firstSyncTimeoutMs: Long = 45_000L,
    private val activeSyncTimeoutMs: Long = 75_000L,
) {
    private var attemptStartedAt: Long? = null
    private var lastSyncUpdateAt: Long? = null

    @Synchronized
    fun connectionStarted() {
        attemptStartedAt = now()
        lastSyncUpdateAt = null
    }

    @Synchronized
    fun syncUpdated() {
        lastSyncUpdateAt = now()
    }

    @Synchronized
    fun networkResumed() {
        attemptStartedAt = now()
    }

    @Synchronized
    fun reset() {
        attemptStartedAt = null
        lastSyncUpdateAt = null
    }

    @Synchronized
    fun restartReason(
        syncTaskRunning: Boolean,
        phase: MatrixRuntimePhase,
    ): MatrixSyncRestartReason? {
        if (phase != MatrixRuntimePhase.CONNECTING && phase != MatrixRuntimePhase.SYNCING) return null
        if (!syncTaskRunning) return MatrixSyncRestartReason.TASK_STOPPED
        val currentTime = now()
        return when (phase) {
            MatrixRuntimePhase.CONNECTING -> attemptStartedAt
                ?.takeIf { currentTime - it >= firstSyncTimeoutMs }
                ?.let { MatrixSyncRestartReason.FIRST_SYNC_TIMEOUT }
            MatrixRuntimePhase.SYNCING -> lastSyncUpdateAt
                ?.takeIf { currentTime - it >= activeSyncTimeoutMs }
                ?.let { MatrixSyncRestartReason.SYNC_STALE }
            else -> null
        }
    }
}
