package id.my.anciety.codever.matrix

import org.matrix.rustcomponents.sdk.InternalException

internal data class MatrixRuntimeFailureDecision(
    val detailCode: String,
    val blocked: Boolean,
)

internal class MatrixSyncServiceBuildException(cause: Throwable) :
    IllegalStateException("The Matrix sync service configuration is invalid.", cause)

internal object MatrixRuntimeFailurePolicy {
    fun decide(error: Throwable): MatrixRuntimeFailureDecision = when (error) {
        is MatrixSyncServiceBuildException -> MatrixRuntimeFailureDecision(
            detailCode = "matrix_sync_service_build_failed",
            blocked = true,
        )
        is InternalException -> MatrixRuntimeFailureDecision(
            detailCode = "matrix_sdk_internal_failure",
            blocked = true,
        )
        else -> MatrixRuntimeFailureDecision(
            detailCode = "matrix_runtime_failed",
            blocked = false,
        )
    }
}

internal object MatrixSyncRestartPolicy {
    fun decide(
        reason: MatrixSyncRestartReason,
        syncTaskRunning: Boolean,
    ): MatrixRuntimeFailureDecision = when {
        reason == MatrixSyncRestartReason.FIRST_SYNC_TIMEOUT && syncTaskRunning ->
            MatrixRuntimeFailureDecision(reason.detailCode, blocked = true)
        else -> MatrixRuntimeFailureDecision(reason.detailCode, blocked = false)
    }
}
