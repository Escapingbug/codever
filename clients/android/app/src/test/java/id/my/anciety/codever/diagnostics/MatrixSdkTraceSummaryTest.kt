package id.my.anciety.codever.diagnostics

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class MatrixSdkTraceSummaryTest {
    @Test
    fun `summary keeps only approved sync category and numeric status`() {
        val summary = MatrixSdkTraceSummary.summarize(
            "2026-08-04T10:37:05Z DEBUG matrix_sdk::http_client: " +
                "request failed status=429 room=!private:example.org body=private-message",
        )

        assertEquals(
            "sdk_trace level=DEBUG target=matrix_sdk::http_client category=HTTP_REQUEST status=429",
            summary,
        )
        assertFalse(summary.orEmpty().contains("private"))
        assertFalse(summary.orEmpty().contains("example.org"))
    }

    @Test
    fun `summary identifies a background panic without exporting its message`() {
        val summary = MatrixSdkTraceSummary.summarize(
            "2026-08-04T10:37:05Z ERROR matrix_sdk::sliding_sync: " +
                "task panicked access_token=secret-value",
        )

        assertEquals(
            "sdk_trace level=ERROR target=matrix_sdk::sliding_sync category=BACKGROUND_TASK_PANIC",
            summary,
        )
        assertFalse(summary.orEmpty().contains("secret"))
    }

    @Test
    fun `summary drops unrelated and malformed lines`() {
        assertNull(
            MatrixSdkTraceSummary.summarize(
                "2026-08-04T10:37:05Z INFO unknown_target: user content",
            ),
        )
        assertNull(MatrixSdkTraceSummary.summarize("raw message content"))
    }
}
