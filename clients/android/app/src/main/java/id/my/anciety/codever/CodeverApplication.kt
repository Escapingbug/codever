package id.my.anciety.codever

import android.app.Application
import id.my.anciety.codever.diagnostics.NativeDiagnosticLog
import id.my.anciety.codever.diagnostics.ProcessExitDiagnostics

/** Lightweight process entry point; durable runtime initialization belongs to the service IO scope. */
class CodeverApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        ProcessExitDiagnostics.recordPreviousExits(
            context = this,
            diagnostics = NativeDiagnosticLog.get(this),
        )
    }
}
