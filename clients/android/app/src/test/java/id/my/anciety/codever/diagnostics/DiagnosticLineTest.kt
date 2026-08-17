package id.my.anciety.codever.diagnostics

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DiagnosticLineTest {
    @Test
    fun `diagnostic fields are stable and sorted`() {
        assertEquals(
            "2026-08-04T12:00:00Z matrix.state detail=matrix_sync_active phase=SYNCING",
            DiagnosticLine.encode(
                "2026-08-04T12:00:00Z",
                "matrix.state",
                mapOf("phase" to "SYNCING", "detail" to "matrix_sync_active"),
            ),
        )
    }

    @Test
    fun `service binding diagnostics use approved fields`() {
        assertEquals(
            "2026-08-04T12:00:00Z activity.service_connected available=true stage=reload",
            DiagnosticLine.encode(
                "2026-08-04T12:00:00Z",
                "activity.service_connected",
                mapOf("stage" to "reload", "available" to "true"),
            ),
        )
    }

    @Test
    fun `task notification diagnostics use approved privacy safe fields`() {
        assertEquals(
            "2026-08-04T12:00:00Z notification.task_evaluated action=prompt reason=succeeded running=false stage=succeeded",
            DiagnosticLine.encode(
                "2026-08-04T12:00:00Z",
                "notification.task_evaluated",
                mapOf(
                    "running" to "false",
                    "action" to "prompt",
                    "stage" to "succeeded",
                    "reason" to "succeeded",
                ),
            ),
        )
    }

    @Test
    fun `matrix event diagnostics allow only counts and security codes`() {
        assertEquals(
            "2026-08-04T12:00:00Z matrix.native_event.rejected " +
                "accepted=2 appended=1 candidates=3 code=BINDING_MISMATCH kind=timeline_envelope",
            DiagnosticLine.encode(
                "2026-08-04T12:00:00Z",
                "matrix.native_event.rejected",
                mapOf(
                    "candidates" to "3",
                    "accepted" to "2",
                    "appended" to "1",
                    "code" to "BINDING_MISMATCH",
                    "kind" to "timeline_envelope",
                ),
            ),
        )
    }

    @Test
    fun `recovery diagnostics retain bounded progress evidence`() {
        assertEquals(
            "2026-08-04T12:00:00Z pairing.transaction.restored " +
                "attempt=2 request=true transport_ready=false",
            DiagnosticLine.encode(
                "2026-08-04T12:00:00Z",
                "pairing.transaction.restored",
                mapOf(
                    "request" to "true",
                    "attempt" to "2",
                    "transport_ready" to "false",
                ),
            ),
        )
    }

    @Test
    fun `outbox migration diagnostics retain only schema and aggregate quarantine count`() {
        assertEquals(
            "2026-08-04T12:00:00Z command.outbox.migrated quarantined=1 schema=2",
            DiagnosticLine.encode(
                "2026-08-04T12:00:00Z",
                "command.outbox.migrated",
                mapOf("schema" to "2", "quarantined" to "1"),
            ),
        )
    }

    @Test
    fun `diagnostic output rejects free form secrets and multiline content`() {
        listOf(
            mapOf("detail" to "Bearer secret-token"),
            mapOf("detail" to "message body\nnext line"),
            mapOf("access_token" to "secret-token"),
        ).forEach { attributes ->
            assertTrue(
                runCatching {
                    DiagnosticLine.encode("2026-08-04T12:00:00Z", "matrix.failure", attributes)
                }.isFailure,
            )
        }
    }
}
