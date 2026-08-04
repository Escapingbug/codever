package id.my.anciety.codever.matrix

import java.util.concurrent.atomic.AtomicBoolean
import org.matrix.rustcomponents.sdk.RoomListServiceState
import org.matrix.rustcomponents.sdk.SyncServiceState

internal class MatrixSyncServiceFailure(
    val stage: String,
) : IllegalStateException("The Matrix sync service stopped at $stage.")

/**
 * Converts the two Matrix SyncService state streams into the smaller lifecycle
 * contract needed by the persistent Android runtime.
 */
internal class MatrixSyncServiceLifecycle(
    private val onRoomListProgress: () -> Unit,
    private val onFailure: (MatrixSyncServiceFailure) -> Unit,
) {
    private val active = AtomicBoolean(false)
    private val running = AtomicBoolean(false)
    private val failurePublished = AtomicBoolean(false)

    fun activate() {
        check(active.compareAndSet(false, true)) { "Matrix sync service lifecycle is already active." }
        running.set(false)
        failurePublished.set(false)
    }

    fun markStarted() {
        if (!active.get() || failurePublished.get()) return
        running.set(true)
    }

    fun onServiceState(state: SyncServiceState) {
        if (!active.get()) return
        when (state) {
            SyncServiceState.RUNNING,
            SyncServiceState.OFFLINE,
            -> running.set(true)
            SyncServiceState.ERROR,
            SyncServiceState.TERMINATED,
            -> fail("SYNC_SERVICE_${state.name}")
            // The state observer can deliver its initial IDLE value after
            // start() has already returned. ERROR and TERMINATED are the
            // authoritative unexpected-stop signals.
            SyncServiceState.IDLE -> Unit
        }
    }

    fun onRoomListState(state: RoomListServiceState) {
        if (!active.get()) return
        when (state) {
            RoomListServiceState.SETTING_UP,
            RoomListServiceState.RUNNING,
            -> onRoomListProgress()
            RoomListServiceState.ERROR,
            RoomListServiceState.TERMINATED,
            -> fail("ROOM_LIST_${state.name}")
            RoomListServiceState.INITIAL,
            RoomListServiceState.RECOVERING,
            -> Unit
        }
    }

    fun isRunning(): Boolean = active.get() && running.get() && !failurePublished.get()

    fun deactivate() {
        active.set(false)
        running.set(false)
    }

    private fun fail(stage: String) {
        running.set(false)
        if (failurePublished.compareAndSet(false, true)) {
            onFailure(MatrixSyncServiceFailure(stage))
        }
    }
}
