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
