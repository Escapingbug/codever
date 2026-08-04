package id.my.anciety.codever.diagnostics

import android.content.Context
import java.io.File
import org.matrix.rustcomponents.sdk.TracingFileConfiguration

/** Private, bounded Rust SDK trace storage with a content-free export summary. */
object MatrixSdkTraceLog {
    fun configuration(context: Context) = TracingFileConfiguration(
        path = directory(context).absolutePath,
        filePrefix = FILE_PREFIX,
        fileSuffix = FILE_SUFFIX,
        maxTotalSizeBytes = MAX_TOTAL_SIZE_BYTES.toULong(),
        maxAgeSeconds = MAX_AGE_SECONDS.toULong(),
    )

    fun appendSanitizedSummary(context: Context, output: Appendable) {
        val summaries = ArrayDeque<String>(MAX_EXPORTED_LINES)
        directory(context).listFiles()
            .orEmpty()
            .asSequence()
            .filter { it.isFile && it.name.startsWith(FILE_PREFIX) && it.name.endsWith(FILE_SUFFIX) }
            .sortedBy { it.lastModified() }
            .forEach { source ->
                source.forEachLine(Charsets.UTF_8) { line ->
                    MatrixSdkTraceSummary.summarize(line)?.let { summary ->
                        if (summaries.size == MAX_EXPORTED_LINES) summaries.removeFirst()
                        summaries.addLast(summary)
                    }
                }
            }
        if (summaries.isEmpty()) return
        output.appendLine()
        output.appendLine("Matrix SDK trace summary (content-free)")
        summaries.forEach(output::appendLine)
    }

    private fun directory(context: Context): File =
        File(context.noBackupFilesDir, DIRECTORY_NAME).apply {
            check(isDirectory || mkdirs()) { "Matrix SDK trace directory could not be created." }
        }

    private const val DIRECTORY_NAME = "matrix-sdk-trace-v1"
    private const val FILE_PREFIX = "matrix-sdk-"
    private const val FILE_SUFFIX = ".log"
    private const val MAX_TOTAL_SIZE_BYTES = 2L * 1024L * 1024L
    private const val MAX_AGE_SECONDS = 3L * 24L * 60L * 60L
    private const val MAX_EXPORTED_LINES = 1_000
}

internal object MatrixSdkTraceSummary {
    private val header = Regex(
        """^\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+([A-Za-z0-9_:.-]{1,160}):\s*(.*)$""",
    )
    private val httpStatus = Regex("""(?i)\bstatus(?:_code)?\s*[=:]\s*([1-5][0-9]{2})\b""")

    fun summarize(line: String): String? {
        val match = header.matchEntire(line.take(MAX_INPUT_LENGTH)) ?: return null
        val level = match.groupValues[1]
        val target = match.groupValues[2]
        if (target !in allowedTargets) return null
        val message = match.groupValues[3]
        val category = category(level, target, message) ?: return null
        val status = httpStatus.find(message)?.groupValues?.get(1)
        return buildString {
            append("sdk_trace level=")
            append(level)
            append(" target=")
            append(target)
            append(" category=")
            append(category)
            if (status != null) {
                append(" status=")
                append(status)
            }
        }
    }

    private fun category(level: String, target: String, message: String): String? {
        val normalized = message.lowercase()
        return when {
            "panicked" in normalized || "panic" in normalized -> "BACKGROUND_TASK_PANIC"
            target == "matrix_sdk_common::cross_process_lock" &&
                ("couldn't obtain" in normalized || "waiting" in normalized) -> "LOCK_WAIT"
            target == "matrix_sdk_common::cross_process_lock" &&
                ("lock obtained" in normalized || "obtained the lock" in normalized) -> "LOCK_ACQUIRED"
            target == "matrix_sdk_common::cross_process_lock" && "dirty" in normalized -> "LOCK_DIRTY"
            "terminated" in normalized -> "SYNC_TERMINATED"
            "offline" in normalized -> "SYNC_OFFLINE"
            "response" in normalized -> "HTTP_RESPONSE"
            "request" in normalized -> "HTTP_REQUEST"
            "sliding" in normalized && ("start" in normalized || "sync" in normalized) ->
                "SLIDING_SYNC_PROGRESS"
            "error" in normalized || "failed" in normalized || level == "ERROR" -> "SDK_ERROR"
            level == "WARN" -> "SDK_WARNING"
            else -> null
        }
    }

    private val allowedTargets = setOf(
        "matrix_sdk::client",
        "matrix_sdk::http_client",
        "matrix_sdk::sliding_sync",
        "matrix_sdk_base::sliding_sync",
        "matrix_sdk_base::response_processors",
        "matrix_sdk_common::cross_process_lock",
        "matrix_sdk_crypto",
        "matrix_sdk_ui",
        "matrix_sdk_ui::sync_service",
    )
    private const val MAX_INPUT_LENGTH = 8 * 1024
}
