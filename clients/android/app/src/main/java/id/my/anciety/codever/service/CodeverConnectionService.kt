package id.my.anciety.codever.service

import android.annotation.SuppressLint
import android.app.ForegroundServiceStartNotAllowedException
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Binder
import android.os.IBinder
import android.os.PowerManager
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
import id.my.anciety.codever.matrix.MatrixSdkPlatform
import id.my.anciety.codever.matrix.PublicMatrixSession
import id.my.anciety.codever.web.MainActivity
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext

class CodeverConnectionService : Service() {
    private val binder = LocalBinder()
    private lateinit var preferences: ServicePreferenceStore
    @Volatile private var clientRuntime: NativeClientRuntime? = null
    private val clientRuntimeReady = CompletableDeferred<NativeClientRuntime>()
    private lateinit var diagnostics: NativeDiagnosticLog
    private lateinit var taskNotifier: AgentTaskNotifier
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var foregroundStarted = false
    @Volatile private var uiForeground = false
    private var runtimeWakeLock: PowerManager.WakeLock? = null
    private var powerReceiverRegistered = false
    private val powerReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val reason = when (intent?.action) {
                Intent.ACTION_SCREEN_ON -> "screen_on"
                PowerManager.ACTION_DEVICE_IDLE_MODE_CHANGED -> {
                    val power = getSystemService(PowerManager::class.java)
                    if (power.isDeviceIdleMode) return
                    "device_idle_exit"
                }
                else -> return
            }
            diagnostics.record("service.system_wake", mapOf("reason" to reason))
            serviceScope.launch(Dispatchers.IO) {
                runCatching { awaitClientRuntime().onSystemWake(reason) }
                    .onFailure { error ->
                        diagnostics.record(
                            "service.system_wake_failed",
                            mapOf("error" to error.javaClass.simpleName.take(160)),
                        )
                    }
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        diagnostics = NativeDiagnosticLog.get(this)
        diagnostics.record("service.created")
        preferences = ServicePreferenceStore(this)
        taskNotifier = AgentTaskNotifier(this)
        registerPowerReceiver()
        createNotificationChannel()
        taskNotifier.createChannel()
        initializeClientRuntime()
        if (
            preferences.restoreEnabled &&
            PersistentConnectionPower.isExempt(this)
        ) {
            enterForeground()
            startClientRuntime()
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ServiceActions.E2E_NETWORK_AVAILABILITY) {
            check(BuildConfig.ALLOW_INSECURE_E2E_LOOPBACK) {
                "Synthetic network transitions are available only in E2E builds."
            }
            check(intent.hasExtra(E2E_NETWORK_AVAILABLE_EXTRA)) {
                "The synthetic network transition is incomplete."
            }
            val available = intent.getBooleanExtra(E2E_NETWORK_AVAILABLE_EXTRA, false)
            serviceScope.launch(Dispatchers.IO) {
                awaitClientRuntime().injectNetworkAvailabilityForE2e(available)
            }
            return START_STICKY
        }
        return when (ServiceStartPolicy.decide(intent?.action, preferences.restoreEnabled)) {
            ServiceStartDecision.KEEP_RUNNING -> {
                if (!PersistentConnectionPower.isExempt(this)) {
                    diagnostics.record("service.stop_power_restricted")
                    stopSelf(startId)
                    return START_NOT_STICKY
                }
                diagnostics.record("service.start", mapOf("source" to (intent?.action ?: "sticky")))
                preferences.restoreEnabled = true
                enterForeground()
                startClientRuntime()
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
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onDestroy() {
        diagnostics.record("service.destroyed")
        unregisterPowerReceiver()
        releaseRuntimeWakeLock()
        foregroundStarted = false
        val runtime = clientRuntime
        serviceScope.cancel()
        if (runtime != null) {
            runBlocking(Dispatchers.IO) { runtime.close() }
        } else {
            clientRuntimeReady.cancel()
        }
        super.onDestroy()
    }

    private fun initializeClientRuntime() {
        diagnostics.record("service.runtime_initializing")
        serviceScope.launch(Dispatchers.IO) {
            try {
                MatrixSdkPlatform.initialize(this@CodeverConnectionService)
                val created = NativeClientRuntime(
                    context = this@CodeverConnectionService,
                    foregroundState = { foregroundStarted to foregroundStarted },
                    onCommandCompletion = ::onCommandCompletion,
                )
                if (!currentCoroutineContext().isActive) {
                    withContext(NonCancellable) { created.close() }
                    return@launch
                }
                clientRuntime = created
                clientRuntimeReady.complete(created)
                diagnostics.record("service.runtime_ready")
            } catch (error: Exception) {
                clientRuntimeReady.completeExceptionally(error)
                diagnostics.record(
                    "service.runtime_failed",
                    mapOf("error" to error.javaClass.simpleName.take(160)),
                )
            }
        }
    }

    private suspend fun awaitClientRuntime(): NativeClientRuntime = clientRuntimeReady.await()

    private fun startClientRuntime() {
        serviceScope.launch(Dispatchers.IO) {
            runCatching { awaitClientRuntime().start() }
                .onFailure { error ->
                    diagnostics.record(
                        "service.runtime_start_failed",
                        mapOf("error" to error.javaClass.simpleName.take(160)),
                    )
                }
        }
    }

    private fun enterForeground() {
        if (!foregroundStarted) {
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
        acquireRuntimeWakeLock()
    }

    private fun registerPowerReceiver() {
        if (powerReceiverRegistered) return
        ContextCompat.registerReceiver(
            this,
            powerReceiver,
            IntentFilter().apply {
                addAction(Intent.ACTION_SCREEN_ON)
                addAction(PowerManager.ACTION_DEVICE_IDLE_MODE_CHANGED)
            },
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        powerReceiverRegistered = true
    }

    private fun unregisterPowerReceiver() {
        if (!powerReceiverRegistered) return
        runCatching { unregisterReceiver(powerReceiver) }
        powerReceiverRegistered = false
    }

    @SuppressLint("WakelockTimeout")
    private fun acquireRuntimeWakeLock() {
        if (runtimeWakeLock?.isHeld == true) return
        runCatching {
            val power = getSystemService(PowerManager::class.java)
            power.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "$packageName:matrix-runtime",
            ).apply {
                setReferenceCounted(false)
                acquire()
                runtimeWakeLock = this
            }
        }.onSuccess {
            diagnostics.record("service.wake_lock_acquired")
        }.onFailure { error ->
            diagnostics.record(
                "service.wake_lock_failed",
                mapOf("error" to error.javaClass.simpleName.take(160)),
            )
        }
    }

    private fun releaseRuntimeWakeLock() {
        val wakeLock = runtimeWakeLock ?: return
        runtimeWakeLock = null
        runCatching {
            if (wakeLock.isHeld) wakeLock.release()
        }.onSuccess {
            diagnostics.record("service.wake_lock_released")
        }.onFailure { error ->
            diagnostics.record(
                "service.wake_lock_release_failed",
                mapOf("error" to error.javaClass.simpleName.take(160)),
            )
        }
    }

    private fun disconnectExplicitly() {
        serviceScope.launch {
            try {
                withContext(Dispatchers.IO) { awaitClientRuntime().disconnect(revoke = false) }
            } finally {
                preferences.restoreEnabled = false
                releaseRuntimeWakeLock()
                ServiceCompat.stopForeground(
                    this@CodeverConnectionService,
                    ServiceCompat.STOP_FOREGROUND_REMOVE,
                )
                foregroundStarted = false
                stopSelf()
            }
        }
    }

    private fun onCommandCompletion(operation: CommandOperation, completion: CommandCompletion) {
        val kind = TaskNotificationPolicy.decide(uiForeground, operation, completion.outcome)
        diagnostics.record(
            "notification.task_evaluated",
            mapOf(
                "running" to uiForeground.toString(),
                "action" to operation.wireName,
                "stage" to completion.outcome.wireName,
                "reason" to (kind?.name?.lowercase() ?: "none"),
            ),
        )
        if (kind == null) return
        runCatching { taskNotifier.show(kind, completion) }
            .onSuccess {
                diagnostics.record(
                    "notification.task_posted",
                    mapOf("stage" to completion.outcome.wireName),
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
        fun readyClientRuntime(): NativeClientRuntime? = clientRuntime

        suspend fun clientRuntime(): NativeClientRuntime = awaitClientRuntime()

        suspend fun snapshot(): ClientSnapshot = awaitClientRuntime().snapshot()

        fun setUiForeground(value: Boolean) {
            val becameForeground = value && !uiForeground
            uiForeground = value
            diagnostics.record(
                "service.ui_foreground",
                mapOf("running" to value.toString()),
            )
            if (becameForeground) {
                serviceScope.launch(Dispatchers.IO) {
                    runCatching {
                        awaitClientRuntime().requestAuthoritativeConvergence("ui_foreground")
                    }.onFailure { error ->
                        diagnostics.record(
                            "service.ui_convergence_failed",
                            mapOf("error" to error.javaClass.simpleName.take(160)),
                        )
                    }
                }
            }
        }

        fun startInBackground() {
            preferences.restoreEnabled = true
            enterForeground()
            startClientRuntime()
        }

        suspend fun start(): ClientSnapshot {
            withContext(Dispatchers.Main.immediate) {
                preferences.restoreEnabled = true
                enterForeground()
            }
            return withContext(Dispatchers.IO) { awaitClientRuntime().start() }
        }

        suspend fun bootstrap(input: MatrixBootstrap): Pair<PublicMatrixSession, ClientSnapshot> {
            check(foregroundStarted) { "The persistent native runtime is not active." }
            return withContext(Dispatchers.IO) {
                val runtime = awaitClientRuntime()
                // Service startup schedules runtime restoration asynchronously.
                // A freshly opened WebView may submit bootstrap before that job
                // runs, so make this boundary self-sufficient and idempotent.
                runtime.start()
                runtime.bootstrap(input)
            }
        }

        suspend fun completePairing(
            pairingId: String,
            deviceName: String,
        ): Pair<PublicTrustState.Trusted, ClientSnapshot> = withContext(Dispatchers.IO) {
            awaitClientRuntime().completePairing(pairingId, deviceName)
        }

        suspend fun disconnect(mode: String): ClientSnapshot {
            require(mode == "stop" || mode == "revoke") { "Unsupported disconnect mode." }
            return withContext(NonCancellable) {
                val snapshot = withContext(Dispatchers.IO) {
                    awaitClientRuntime().disconnect(revoke = mode == "revoke")
                }
                withContext(Dispatchers.Main.immediate) {
                    preferences.restoreEnabled = false
                    releaseRuntimeWakeLock()
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
        const val E2E_NETWORK_AVAILABLE_EXTRA = "available"

        fun startFromUser(context: Context) {
            ServicePreferenceStore(context).restoreEnabled = true
            start(context)
        }

        fun restoreIfEnabled(context: Context): Boolean {
            val enabled = ServicePreferenceStore(context).restoreEnabled
            val notificationsAvailable = NotificationManagerCompat.from(context).areNotificationsEnabled()
            val powerExempt = PersistentConnectionPower.isExempt(context)
            if (!ServiceStartPolicy.shouldRestoreAfterBoot(
                    enabled,
                    notificationsAvailable,
                    powerExempt,
                )
            ) return false
            return try {
                start(context)
                true
            } catch (_: ForegroundServiceStartNotAllowedException) {
                // Android can redeliver BOOT_COMPLETED after a package is
                // explicitly un-stopped, outside the boot-time FGS allowance.
                // Keep the durable restore preference and let the next visible
                // Activity start the same service from a user-allowed context.
                NativeDiagnosticLog.get(context).record(
                    "service.restore_deferred",
                    mapOf("reason" to "foreground_start_disallowed"),
                )
                false
            }
        }

        private fun start(context: Context) {
            val intent = Intent(context, CodeverConnectionService::class.java).setAction(ServiceActions.START)
            ContextCompat.startForegroundService(context, intent)
        }
    }
}
