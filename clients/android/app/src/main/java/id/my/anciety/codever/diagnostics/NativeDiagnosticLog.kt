package id.my.anciety.codever.diagnostics

import android.content.Context
import android.os.Build
import id.my.anciety.codever.BuildConfig
import java.io.File
import java.time.Instant

class NativeDiagnosticLog private constructor(
    context: Context,
    private val now: () -> Long = System::currentTimeMillis,
) : DiagnosticRecorder {
    private val lock = Any()
    private val directory = File(context.filesDir, "diagnostics")
    private val current = File(directory, "native-current.log")
    private val previous = File(directory, "native-previous.log")
    private val exportDirectory = File(context.cacheDir, "diagnostics")

    override fun record(event: String, attributes: Map<String, String>) {
        val line = runCatching {
            DiagnosticLine.encode(Instant.ofEpochMilli(now()).toString(), event, attributes) + "\n"
        }.getOrNull() ?: return
        synchronized(lock) {
            runCatching {
                directory.mkdirs()
                rotateIfNeeded(line.toByteArray(Charsets.UTF_8).size)
                current.appendText(line, Charsets.UTF_8)
            }
        }
    }

    fun export(): File = synchronized(lock) {
        exportDirectory.mkdirs()
        exportDirectory.listFiles()?.forEach { candidate ->
            if (candidate.isFile && candidate.name != EXPORT_FILE_NAME) candidate.delete()
        }
        val destination = File(exportDirectory, EXPORT_FILE_NAME)
        destination.bufferedWriter(Charsets.UTF_8).use { output ->
            output.appendLine("Codever native diagnostics")
            output.appendLine("exported_at=${Instant.ofEpochMilli(now())}")
            output.appendLine("version_name=${BuildConfig.VERSION_NAME}")
            output.appendLine("native_build=${BuildConfig.NATIVE_BUILD_ID}")
            output.appendLine("android_sdk=${Build.VERSION.SDK_INT}")
            output.appendLine("device=${safeDeviceLabel()}")
            output.appendLine("privacy=No_tokens_message_content_room_ids_user_ids_or_key_material")
            output.appendLine()
            appendFile(previous, output)
            appendFile(current, output)
        }
        destination
    }

    private fun rotateIfNeeded(incomingBytes: Int) {
        if (current.length() + incomingBytes <= MAX_FILE_BYTES) return
        previous.delete()
        if (!current.renameTo(previous)) current.delete()
    }

    private fun appendFile(source: File, output: Appendable) {
        if (!source.isFile) return
        source.forEachLine(Charsets.UTF_8) { line -> output.appendLine(line) }
    }

    private fun safeDeviceLabel(): String = listOf(Build.MANUFACTURER, Build.MODEL)
        .joinToString("-")
        .lowercase()
        .replace(Regex("[^a-z0-9._+-]"), "_")
        .take(160)
        .ifEmpty { "unknown" }

    companion object {
        private const val MAX_FILE_BYTES = 256L * 1024L
        private const val EXPORT_FILE_NAME = "codever-native-diagnostics.txt"
        @Volatile private var instance: NativeDiagnosticLog? = null

        fun get(context: Context): NativeDiagnosticLog = instance ?: synchronized(this) {
            instance ?: NativeDiagnosticLog(context.applicationContext).also { created ->
                instance = created
            }
        }
    }
}
