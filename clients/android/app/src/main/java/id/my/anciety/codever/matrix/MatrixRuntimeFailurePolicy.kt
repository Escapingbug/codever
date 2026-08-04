package id.my.anciety.codever.matrix

import org.matrix.rustcomponents.sdk.InternalException

internal data class MatrixRuntimeFailureDecision(
    val detailCode: String,
    val blocked: Boolean,
)

internal object MatrixRuntimeFailurePolicy {
    fun decide(error: Throwable): MatrixRuntimeFailureDecision = when (error) {
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
