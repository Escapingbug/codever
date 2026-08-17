package id.my.anciety.codever.e2e

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.AtomicFile
import id.my.anciety.codever.BuildConfig
import java.io.File

/**
 * Reproduces the field failure where Codever trust survives but the local
 * Matrix login does not. This receiver is compiled only into the isolated E2E
 * APK and cannot be invoked in production builds.
 */
class MatrixSessionFaultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        check(BuildConfig.ALLOW_INSECURE_E2E_LOOPBACK) {
            "The Matrix session fault fixture is available only in E2E builds."
        }
        val root = File(context.noBackupFilesDir, "matrix-native-v2")
        val sessions = root.listFiles().orEmpty().filter { file ->
            file.isFile && SESSION_FILE.matches(file.name)
        }
        check(sessions.size == 1) {
            "The fixture requires exactly one persisted Matrix session."
        }
        AtomicFile(sessions.single()).delete()
        check(root.listFiles().orEmpty().none { SESSION_FILE.matches(it.name) }) {
            "The persisted Matrix session could not be removed."
        }
        resultCode = Activity.RESULT_OK
        resultData = "matrix-session-removed"
    }

    private companion object {
        val SESSION_FILE = Regex("^session-[0-9a-f]{64}\\.enc$")
    }
}
