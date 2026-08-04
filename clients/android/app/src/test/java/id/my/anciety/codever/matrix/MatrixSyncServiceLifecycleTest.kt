package id.my.anciety.codever.matrix

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.matrix.rustcomponents.sdk.RoomListServiceState
import org.matrix.rustcomponents.sdk.SyncServiceState

class MatrixSyncServiceLifecycleTest {
    @Test
    fun `room list setup and running publish sync progress`() {
        var readyCount = 0
        val failures = mutableListOf<MatrixSyncServiceFailure>()
        val lifecycle = MatrixSyncServiceLifecycle(
            onRoomListProgress = { readyCount += 1 },
            onFailure = failures::add,
        )

        lifecycle.activate()
        lifecycle.onServiceState(SyncServiceState.IDLE)
        lifecycle.onServiceState(SyncServiceState.RUNNING)
        lifecycle.markStarted()
        lifecycle.onServiceState(SyncServiceState.IDLE)
        lifecycle.onRoomListState(RoomListServiceState.SETTING_UP)
        lifecycle.onRoomListState(RoomListServiceState.RUNNING)

        assertTrue(lifecycle.isRunning())
        assertEquals(2, readyCount)
        assertTrue(failures.isEmpty())
    }

    @Test
    fun `terminal service state stops lifecycle and publishes one failure`() {
        val failures = mutableListOf<MatrixSyncServiceFailure>()
        val lifecycle = MatrixSyncServiceLifecycle({}, failures::add)
        lifecycle.activate()
        lifecycle.markStarted()

        lifecycle.onServiceState(SyncServiceState.ERROR)
        lifecycle.onRoomListState(RoomListServiceState.TERMINATED)

        assertFalse(lifecycle.isRunning())
        assertEquals(listOf("SYNC_SERVICE_ERROR"), failures.map { it.stage })
    }

    @Test
    fun `explicit deactivation ignores idle and terminated callbacks`() {
        val failures = mutableListOf<MatrixSyncServiceFailure>()
        val lifecycle = MatrixSyncServiceLifecycle({}, failures::add)
        lifecycle.activate()
        lifecycle.markStarted()
        lifecycle.deactivate()

        lifecycle.onServiceState(SyncServiceState.IDLE)
        lifecycle.onRoomListState(RoomListServiceState.TERMINATED)

        assertFalse(lifecycle.isRunning())
        assertTrue(failures.isEmpty())
    }
}
