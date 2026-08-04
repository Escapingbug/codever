package id.my.anciety.codever.matrix

import android.content.Context
import id.my.anciety.codever.BuildConfig
import id.my.anciety.codever.diagnostics.MatrixSdkTraceLog
import id.my.anciety.codever.diagnostics.NativeDiagnosticLog
import org.matrix.rustcomponents.sdk.LogLevel
import org.matrix.rustcomponents.sdk.TraceLogPacks
import org.matrix.rustcomponents.sdk.TracingConfiguration
import org.matrix.rustcomponents.sdk.initPlatform

/** Process-wide Matrix FFI initialization that must precede every SDK client. */
object MatrixSdkPlatform {
    @Volatile
    private var initialized = false

    fun initialize(context: Context) {
        if (initialized) return
        synchronized(this) {
            if (initialized) return
            val applicationContext = context.applicationContext
            val diagnostics = NativeDiagnosticLog.get(applicationContext)
            diagnostics.record("matrix.platform.initializing")
            try {
                initPlatform(
                    config = TracingConfiguration(
                        logLevel = LogLevel.DEBUG,
                        traceLogPacks = listOf(TraceLogPacks.SYNC_PROFILING),
                        extraTargets = emptyList(),
                        writeToStdoutOrSystem = BuildConfig.DEBUG,
                        writeToFiles = MatrixSdkTraceLog.configuration(applicationContext),
                        sentryConfig = null,
                    ),
                    // The persistent connection service is the primary process,
                    // not a memory-constrained notification extension.
                    useLightweightTokioRuntime = false,
                )
                initialized = true
                diagnostics.record(
                    "matrix.platform.initialized",
                    mapOf("stage" to "MULTITHREADED_SINGLE_PROCESS_HOST"),
                )
            } catch (error: Exception) {
                diagnostics.record(
                    "matrix.platform.failure",
                    mapOf("error" to safeErrorName(error)),
                )
                throw error
            }
        }
    }

    private fun safeErrorName(error: Throwable): String = error.javaClass.simpleName
        .replace(Regex("[^A-Za-z0-9._:+/-]"), "_")
        .take(160)
}
