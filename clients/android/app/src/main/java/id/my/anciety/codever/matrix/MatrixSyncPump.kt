package id.my.anciety.codever.matrix

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Owns the cancellable Kotlin side of the Matrix sync loop.
 *
 * The Matrix FFI `syncV2` helper only exposes failures through Rust tracing,
 * so a finished TaskHandle cannot tell the runtime why synchronization ended.
 * Driving `syncOnceV2` from Kotlin keeps the failure observable and lets the
 * connection runtime make an explicit retry decision.
 */
internal class MatrixSyncPump(
    private val scope: CoroutineScope,
    private val syncOnce: suspend () -> Unit,
    private val onFailure: (Throwable) -> Unit,
) {
    @Volatile
    private var job: Job? = null

    @Synchronized
    fun start() {
        check(job == null) { "Matrix sync pump is already started." }
        job = scope.launch {
            try {
                while (isActive) syncOnce()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                onFailure(error)
            }
        }
    }

    fun isRunning(): Boolean = job?.isActive == true

    suspend fun stop() {
        val current = synchronized(this) {
            val value = job
            job = null
            value
        }
        current?.cancelAndJoin()
    }
}
