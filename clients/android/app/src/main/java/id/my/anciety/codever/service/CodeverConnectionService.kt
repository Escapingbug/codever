package id.my.anciety.codever.service

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Binder
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import id.my.anciety.codever.BuildConfig
import id.my.anciety.codever.R
import id.my.anciety.codever.client.NativeClientRuntime
import id.my.anciety.codever.client.command.CommandCompletion
import id.my.anciety.codever.client.command.CommandOperation
import id.my.anciety.codever.client.events.ClientSnapshot
import id.my.anciety.codever.client.events.PublicTrustState
import id.my.anciety.codever.diagnostics.NativeDiagnosticLog
import id.my.anciety.codever.matrix.MatrixBootstrap
import id.my.anciety.codever.matrix.PublicMatrixSession
import id.my.anciety.codever.web.MainActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext

class CodeverConnectionService : Service() {
    private val binder = LocalBinder()
    private lateinit var preferences: ServicePreferenceStore
    private lateinit var clientRuntime: NativeClientRuntime
    private lateinit var diagnostics: NativeDiagnosticLog
    private lateinit var taskNotifier: AgentTaskNotifier
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var foregroundStarted = false
    @Volatile private var uiForeground = false

    override fun onCreate() {
        super.onCreate()
        diagnostics = NativeDiagnosticLog.get(this)
        diagnostics.record("service.created")
        preferences = ServicePreferenceStore(this)
        taskNotifier = AgentTaskNotifier(this)
        clientRuntime = NativeClientRuntime(
            context = this,
            foregroundState = { foregroundStarted to foregroundStarted },
            onCommandCompletion = ::onCommandCompletion,
        )
        createNotificationChannel()
        taskNotifier.createChannel()
        if (preferences.restoreEnabled) {
            enterForeground()
            clientRuntime.start()
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int =
        when (ServiceStartPolicy.decide(intent?.action, preferences.restoreEnabled)) {
            ServiceStartDecision.KEEP_RUNNING -> {
                diagnostics.record("service.start", mapOf("source" to (intent?.action ?: "sticky")))
                preferences.restoreEnabled = true
                enterForeground()
                clientRuntime.start()
                START_STICKY
            }
            ServiceStartDecision.STOP_EXPLICITLY -> {
                diagnostics.record("service.disconnect")
                disconnectExplicitly()
                START_NOT_STICKY
            }
            ServiceStartDecision.STOP_DISABLED -> {
                diagnostics.record("service.stop_disabled")
                stopSelf(startId)
                START_NOT_STICKY
            }
        }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onDestroy() {
        diagnostics.record("service.destroyed")
        foregroundStarted = false
        runBlocking(Dispatchers.IO) { clientRuntime.close() }
        serviceScope.cancel()
        super.onDestroy()
    }

    private fun enterForeground() {
        if (foregroundStarted) return
        diagnostics.record("service.foreground_started")
        val foregroundServiceType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
        } else {
            0
        }
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            buildNotification(),
            foregroundServiceType,
        )
        foregroundStarted = true
    }

    private fun disconnectExplicitly() {
        serviceScope.launch {
            withContext(Dispatchers.IO) { clientRuntime.disconnect(revoke = false) }
            preferences.restoreEnabled = false
            ServiceCompat.stopForeground(
                this@CodeverConnectionService,
                ServiceCompat.STOP_FOREGROUND_REMOVE,
            )
            foregroundStarted = false
            stopSelf()
        }
    }

    private fun snapshot(): ClientSnapshot = clientRuntime.snapshot()

    private fun onCommandCompletion(operation: CommandOperation, completion: CommandCompletion) {
        val kind = TaskNotificationPolicy.decide(uiForeground, operation, completion.outcome)
            ?: return
        runCatching { taskNotifier.show(kind, completion) }
            .onSuccess {
                diagnostics.record(
                    "notification.task_posted",
                    mapOf("outcome" to completion.outcome.wireName),
                )
            }
            .onFailure { error ->
                diagnostics.record(
                    "notification.task_failed",
                    mapOf("error" to error.javaClass.simpleName.take(160)),
                )
            }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                NOTIFICATION_CHANNEL_ID,
                getString(R.string.notification_channel_name),
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = getString(R.string.notification_channel_description)
                setShowBadge(false)
            },
        )
    }

    private fun buildNotification() =
        getString(R.string.notification_runtime_version, BuildConfig.NATIVE_BUILD_ID).let { runtimeText ->
            NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_codever_notification)
                .setContentTitle(getString(R.string.notification_title))
                .setContentText(runtimeText)
                .setStyle(NotificationCompat.BigTextStyle().bigText(runtimeText))
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setOnlyAlertOnce(true)
                .setOngoing(true)
                .setContentIntent(
                    PendingIntent.getActivity(
                        this,
                        0,
                        Intent(this, MainActivity::class.java)
                            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                    ),
                )
                .addAction(
                    0,
                    getString(R.string.notification_export_logs),
                    PendingIntent.getActivity(
                        this,
                        2,
                        Intent(this, MainActivity::class.java)
                            .setAction(MainActivity.ACTION_EXPORT_DIAGNOSTICS)
                            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                    ),
                )
                .addAction(
                    0,
                    getString(R.string.notification_disconnect),
                    PendingIntent.getService(
                        this,
                        1,
                        Intent(this, CodeverConnectionService::class.java).setAction(ServiceActions.DISCONNECT),
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                    ),
                )
                .build()
        }

    inner class LocalBinder : Binder() {
        fun clientRuntime(): NativeClientRuntime = this@CodeverConnectionService.clientRuntime

        fun snapshot(): ClientSnapshot = this@CodeverConnectionService.snapshot()

        fun setUiForeground(value: Boolean) {
            uiForeground = value
        }

        fun start(): ClientSnapshot {
            preferences.restoreEnabled = true
            enterForeground()
            return clientRuntime.start()
        }

        suspend fun bootstrap(input: MatrixBootstrap): Pair<PublicMatrixSession, ClientSnapshot> {
            check(foregroundStarted) { "The persistent native runtime is not active." }
            return withContext(Dispatchers.IO) { clientRuntime.bootstrap(input) }
        }

        suspend fun completePairing(
            pairingId: String,
            deviceName: String,
        ): Pair<PublicTrustState.Trusted, ClientSnapshot> = withContext(Dispatchers.IO) {
            clientRuntime.completePairing(pairingId, deviceName)
        }

        suspend fun disconnect(mode: String): ClientSnapshot {
            require(mode == "stop" || mode == "revoke") { "Unsupported disconnect mode." }
            return withContext(NonCancellable) {
                val snapshot = withContext(Dispatchers.IO) {
                    clientRuntime.disconnect(revoke = mode == "revoke")
                }
                withContext(Dispatchers.Main.immediate) {
                    preferences.restoreEnabled = false
                    ServiceCompat.stopForeground(
                        this@CodeverConnectionService,
                        ServiceCompat.STOP_FOREGROUND_REMOVE,
                    )
                    foregroundStarted = false
                    stopSelf()
                }
                snapshot
            }
        }
    }

    companion object Controller {
        private const val NOTIFICATION_CHANNEL_ID = "codever-connection"
        private const val NOTIFICATION_ID = 1101

        fun startFromUser(context: Context) {
            ServicePreferenceStore(context).restoreEnabled = true
            start(context)
        }

        fun restoreIfEnabled(context: Context): Boolean {
            val enabled = ServicePreferenceStore(context).restoreEnabled
            val notificationsAvailable = NotificationManagerCompat.from(context).areNotificationsEnabled()
            if (!ServiceStartPolicy.shouldRestoreAfterBoot(enabled, notificationsAvailable)) return false
            start(context)
            return true
        }

        private fun start(context: Context) {
            val intent = Intent(context, CodeverConnectionService::class.java).setAction(ServiceActions.START)
            ContextCompat.startForegroundService(context, intent)
        }
    }
}
