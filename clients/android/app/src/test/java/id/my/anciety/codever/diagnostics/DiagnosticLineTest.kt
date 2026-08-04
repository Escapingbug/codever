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
