package id.my.anciety.codever.matrix

enum class MatrixRuntimePhase {
    STOPPED,
    WAITING_FOR_SESSION,
    BOOTSTRAPPING,
    RESTORING,
    CONNECTING,
    SYNCING,
    OFFLINE,
    RETRY_WAIT,
    BLOCKED,
}

data class MatrixRuntimeStatus(
    val phase: MatrixRuntimePhase,
    val since: Long,
    val detailCode: String,
)

sealed interface MatrixRuntimeEvent {
    data class Start(val hasSession: Boolean, val networkAvailable: Boolean) : MatrixRuntimeEvent

    data object BootstrapStarted : MatrixRuntimeEvent

    data class SessionReady(val networkAvailable: Boolean) : MatrixRuntimeEvent

    data object SyncStarted : MatrixRuntimeEvent

    data object SyncUpdated : MatrixRuntimeEvent

    data object NetworkLost : MatrixRuntimeEvent

    data object NetworkAvailable : MatrixRuntimeEvent

    data object RetryScheduled : MatrixRuntimeEvent

    data class Failed(val detailCode: String, val blocked: Boolean) : MatrixRuntimeEvent

    data object Stop : MatrixRuntimeEvent
}

class MatrixRuntimeStateMachine(
    private val now: () -> Long = System::currentTimeMillis,
) {
    @Volatile
    var status = MatrixRuntimeStatus(
        phase = MatrixRuntimePhase.STOPPED,
        since = now(),
        detailCode = "native_stopped",
    )
        private set

    @Synchronized
    fun accept(event: MatrixRuntimeEvent): MatrixRuntimeStatus {
        val next = when (event) {
            is MatrixRuntimeEvent.Start -> when {
                !event.hasSession -> state(MatrixRuntimePhase.WAITING_FOR_SESSION, "matrix_session_required")
                !event.networkAvailable -> state(MatrixRuntimePhase.OFFLINE, "network_unavailable")
                else -> state(MatrixRuntimePhase.RESTORING, "matrix_session_restoring")
            }
            MatrixRuntimeEvent.BootstrapStarted ->
                state(MatrixRuntimePhase.BOOTSTRAPPING, "matrix_token_exchange")
            is MatrixRuntimeEvent.SessionReady -> if (event.networkAvailable) {
                state(MatrixRuntimePhase.CONNECTING, "matrix_driver_starting")
            } else {
                state(MatrixRuntimePhase.OFFLINE, "network_unavailable")
            }
            MatrixRuntimeEvent.SyncStarted ->
                state(MatrixRuntimePhase.CONNECTING, "matrix_first_sync_waiting")
            MatrixRuntimeEvent.SyncUpdated ->
                state(MatrixRuntimePhase.SYNCING, "matrix_sync_active")
            MatrixRuntimeEvent.NetworkLost -> if (
                status.phase == MatrixRuntimePhase.STOPPED ||
                status.phase == MatrixRuntimePhase.WAITING_FOR_SESSION
            ) {
                status
            } else {
                state(MatrixRuntimePhase.OFFLINE, "network_unavailable")
            }
            MatrixRuntimeEvent.NetworkAvailable -> when (status.phase) {
                MatrixRuntimePhase.OFFLINE,
                MatrixRuntimePhase.RETRY_WAIT,
                -> state(MatrixRuntimePhase.CONNECTING, "matrix_sync_reconnecting")
                else -> status
            }
            MatrixRuntimeEvent.RetryScheduled ->
                state(MatrixRuntimePhase.RETRY_WAIT, "matrix_sync_retry_wait")
            is MatrixRuntimeEvent.Failed -> state(
                if (event.blocked) MatrixRuntimePhase.BLOCKED else MatrixRuntimePhase.RETRY_WAIT,
                event.detailCode,
            )
            MatrixRuntimeEvent.Stop -> state(MatrixRuntimePhase.STOPPED, "native_stopped")
        }
        status = next
        return next
    }

    private fun state(phase: MatrixRuntimePhase, detailCode: String): MatrixRuntimeStatus {
        if (status.phase == phase && status.detailCode == detailCode) return status
        return MatrixRuntimeStatus(phase, now(), detailCode)
    }
}
