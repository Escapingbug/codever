package id.my.anciety.codever.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test

class GatewayHistoryConvergenceTest {
    @Test
    fun `more than one hundred completely dropped events converge to the previous Gateway head`() {
        val convergence = GatewayHistoryConvergence(previousHeadEventId = eventId(100))

        val first = convergence.accept(page(
            head = eventId(250),
            range = 151..250,
            nextBefore = eventId(151),
            complete = false,
        ))
        assertEquals(
            GatewayHistoryConvergenceDecision.Continue(eventId(151)),
            first,
        )

        val second = convergence.accept(page(
            head = eventId(250),
            range = 51..150,
            nextBefore = eventId(51),
            complete = false,
        ))
        assertEquals(
            GatewayHistoryConvergenceDecision.Complete(eventId(250)),
            second,
        )
    }

    @Test
    fun `newest retained timeline events cannot hide a missing middle gap`() {
        val convergence = GatewayHistoryConvergence(previousHeadEventId = eventId(10))

        // These newest events may already exist locally after a limited sync,
        // but none is the persisted Gateway checkpoint from before the gap.
        val decision = convergence.accept(page(
            head = eventId(210),
            range = 111..210,
            nextBefore = eventId(111),
            complete = false,
        ))

        assertTrue(decision is GatewayHistoryConvergenceDecision.Continue)
    }

    @Test
    fun `first synchronization establishes a baseline without downloading all old history`() {
        val convergence = GatewayHistoryConvergence(previousHeadEventId = null)

        assertEquals(
            GatewayHistoryConvergenceDecision.Complete(eventId(500)),
            convergence.accept(page(
                head = eventId(500),
                range = 401..500,
                nextBefore = eventId(401),
                complete = false,
            )),
        )
    }

    @Test
    fun `an upgraded cache without a checkpoint scans all history before establishing a baseline`() {
        val convergence = GatewayHistoryConvergence(
            previousHeadEventId = null,
            requireCompleteWithoutCheckpoint = true,
        )

        assertEquals(
            GatewayHistoryConvergenceDecision.Continue(eventId(401)),
            convergence.accept(page(
                head = eventId(500),
                range = 401..500,
                nextBefore = eventId(401),
                complete = false,
            )),
        )
        assertEquals(
            GatewayHistoryConvergenceDecision.Complete(eventId(500)),
            convergence.accept(page(
                head = eventId(500),
                range = 1..400,
                nextBefore = eventId(1),
                complete = true,
            )),
        )
    }

    @Test
    fun `a legacy Gateway without a head remains usable during a rolling upgrade`() {
        val convergence = GatewayHistoryConvergence(
            previousHeadEventId = null,
            requireCompleteWithoutCheckpoint = true,
        )

        assertEquals(
            GatewayHistoryConvergenceDecision.Complete(null),
            convergence.accept(GatewayHistoryPagePosition(
                headEventId = null,
                eventIds = setOf(eventId(500)),
                nextBefore = eventId(500),
                complete = false,
            )),
        )
    }

    @Test
    fun `a rolled back legacy Gateway does not scan all history from a newer checkpoint`() {
        val convergence = GatewayHistoryConvergence(previousHeadEventId = eventId(400))

        assertEquals(
            GatewayHistoryConvergenceDecision.Complete(null),
            convergence.accept(GatewayHistoryPagePosition(
                headEventId = null,
                eventIds = setOf(eventId(500)),
                nextBefore = eventId(500),
                complete = false,
            )),
        )
    }

    @Test
    fun `incomplete history cannot silently advance the checkpoint without a cursor`() {
        val convergence = GatewayHistoryConvergence(previousHeadEventId = eventId(1))

        assertThrows(IllegalStateException::class.java) {
            convergence.accept(GatewayHistoryPagePosition(
                headEventId = eventId(200),
                eventIds = setOf(eventId(200)),
                nextBefore = null,
                complete = false,
            ))
        }
    }

    @Test
    fun `repeated continuation cursor cannot loop forever`() {
        val convergence = GatewayHistoryConvergence(previousHeadEventId = eventId(1))
        val repeated = eventId(101)

        convergence.accept(page(
            head = eventId(200),
            range = 101..200,
            nextBefore = repeated,
            complete = false,
        ))
        assertThrows(IllegalStateException::class.java) {
            convergence.accept(page(
                head = eventId(200),
                range = 101..200,
                nextBefore = repeated,
                complete = false,
            ))
        }
    }

    private fun page(
        head: String,
        range: IntRange,
        nextBefore: String,
        complete: Boolean,
    ) = GatewayHistoryPagePosition(
        headEventId = head,
        eventIds = range.mapTo(mutableSetOf(), ::eventId),
        nextBefore = nextBefore,
        complete = complete,
    )

    private fun eventId(value: Int): String = value.toString(36).padStart(43, '0')
}
