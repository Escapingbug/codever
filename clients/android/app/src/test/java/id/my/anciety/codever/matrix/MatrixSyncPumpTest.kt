package id.my.anciety.codever.matrix

import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class MatrixSyncPumpTest {
    @Test
    fun `successful sync responses keep the pump alive until explicit stop`() = runBlocking {
        val calls = AtomicInteger()
        val secondCall = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val failures = mutableListOf<Throwable>()
        val pump = MatrixSyncPump(
            scope = this,
            syncOnce = {
                if (calls.incrementAndGet() == 2) {
                    secondCall.complete(Unit)
                    release.await()
                }
            },
            onFailure = failures::add,
        )

        pump.start()
        withTimeout(1_000) { secondCall.await() }

        assertTrue(pump.isRunning())
        pump.stop()
        assertFalse(pump.isRunning())
        assertTrue(failures.isEmpty())
    }

    @Test
    fun `terminal sync exception is observable and stops the pump`() = runBlocking {
        val expected = IllegalStateException("sync failed")
        val failure = CompletableDeferred<Throwable>()
        val pump = MatrixSyncPump(
            scope = this,
            syncOnce = { throw expected },
            onFailure = failure::complete,
        )

        pump.start()

        assertSame(expected, withTimeout(1_000) { failure.await() })
        withTimeout(1_000) {
            while (pump.isRunning()) delay(1)
        }
        assertEquals(false, pump.isRunning())
    }

    @Test
    fun `explicit cancellation does not look like a sync failure`() = runBlocking {
        val entered = CompletableDeferred<Unit>()
        val never = CompletableDeferred<Unit>()
        val failures = mutableListOf<Throwable>()
        val pump = MatrixSyncPump(
            scope = this,
            syncOnce = {
                entered.complete(Unit)
                never.await()
            },
            onFailure = failures::add,
        )

        pump.start()
        withTimeout(1_000) { entered.await() }
        pump.stop()

        assertFalse(pump.isRunning())
        assertTrue(failures.isEmpty())
    }
}
