package id.my.anciety.codever.matrix

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class MatrixApplicationEventBatchTest {
    @Test
    fun `one poison event cannot block later command completion in the same page`() = runBlocking {
        val poison = event("\$poison", "poison")
        val completion = event("\$completion", "completion")
        val committed = mutableListOf<String>()
        val quarantined = mutableListOf<String>()

        val result = processMatrixApplicationEventBatch(
            events = listOf(poison, completion),
            onEvent = { event ->
                if (event.eventId == poison.eventId) throw IllegalArgumentException("old protocol")
            },
            onCommitted = { committed += it.eventId },
            onQuarantined = { event, _ -> quarantined += event.eventId },
        )

        assertEquals(MatrixApplicationEventBatchResult(committed = 1, quarantined = 1), result)
        assertEquals(listOf(completion.eventId), committed)
        assertEquals(listOf(poison.eventId), quarantined)
    }

    @Test
    fun `an event that depends on later page state is retried before quarantine`() = runBlocking {
        val dependent = event("\$dependent", "dependent")
        val state = event("\$state", "state")
        var stateReady = false
        val committed = mutableListOf<String>()

        val result = processMatrixApplicationEventBatch(
            events = listOf(dependent, state),
            onEvent = { event ->
                when (event.eventId) {
                    dependent.eventId -> check(stateReady)
                    state.eventId -> stateReady = true
                }
            },
            onCommitted = { committed += it.eventId },
        )

        assertEquals(MatrixApplicationEventBatchResult(committed = 2, quarantined = 0), result)
        assertEquals(listOf(state.eventId, dependent.eventId), committed)
    }

    @Test
    fun `diagnostic fingerprint is stable and content opaque`() {
        val first = event("\$one", "secret-one")
        val same = event("\$different-transport-id", "secret-one")
        val second = event("\$two", "secret-two")

        assertEquals(matrixApplicationEventFingerprint(first), matrixApplicationEventFingerprint(first))
        assertNotEquals(matrixApplicationEventFingerprint(first), matrixApplicationEventFingerprint(same))
        assertNotEquals(matrixApplicationEventFingerprint(first), matrixApplicationEventFingerprint(second))
        assertEquals(16, matrixApplicationEventFingerprint(first).length)
    }

    private fun event(eventId: String, marker: String) = MatrixDecryptedEvent(
        roomId = "!room:example.org",
        eventId = eventId,
        sender = "@gateway:example.org",
        timestamp = 1,
        rawJson = """{"event_id":"$eventId","content":{"marker":"$marker"}}""",
    )
}
