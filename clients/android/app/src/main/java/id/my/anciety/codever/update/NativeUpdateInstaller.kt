package id.my.anciety.codever.update

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking

internal class NativeUpdateInstaller(private val context: Context) {
    fun install(apk: File, release: NativeClientRelease) {
        val installer = context.packageManager.packageInstaller
        val parameters = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            setSize(release.artifact.size)
            setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val sessionId = installer.createSession(parameters)
        try {
            installer.openSession(sessionId).use { session ->
                apk.inputStream().use { input ->
                    session.openWrite(APK_NAME, 0, release.artifact.size).use { output ->
                        input.copyTo(output)
                        session.fsync(output)
                    }
                }
                val callback = PendingIntent.getBroadcast(
                    context,
                    sessionId,
                    Intent(context, NativeUpdateInstallReceiver::class.java)
                        .setAction(NativeUpdateInstallReceiver.ACTION_INSTALL_RESULT),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
                )
                session.commit(callback.intentSender)
            }
        } catch (error: Exception) {
            runCatching { installer.abandonSession(sessionId) }
            throw error
        }
    }

    private companion object {
        const val APK_NAME = "codever-update.apk"
    }
}

class NativeUpdateInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_INSTALL_RESULT) return
        val status = intent.getIntExtra(
            PackageInstaller.EXTRA_STATUS,
            PackageInstaller.STATUS_FAILURE,
        )
        val confirmation = intent.parcelableIntentExtra(Intent.EXTRA_INTENT)
        runCatching {
            runBlocking(Dispatchers.IO) {
                NativeUpdateManager.get(context).onInstallResult(
                    status = status,
                    confirmation = confirmation,
                    detailCode = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE),
                )
            }
        }.onFailure { error ->
            id.my.anciety.codever.diagnostics.NativeDiagnosticLog.get(context).record(
                "update.install_result_unavailable",
                mapOf("error" to error.javaClass.simpleName.take(160)),
            )
        }
    }

    companion object {
        const val ACTION_INSTALL_RESULT = "id.my.anciety.codever.action.NATIVE_UPDATE_INSTALL_RESULT"
    }
}

@Suppress("DEPRECATION")
private fun Intent.parcelableIntentExtra(name: String): Intent? =
    if (android.os.Build.VERSION.SDK_INT >= 33) {
        getParcelableExtra(name, Intent::class.java)
    } else {
        getParcelableExtra(name) as? Intent
    }
