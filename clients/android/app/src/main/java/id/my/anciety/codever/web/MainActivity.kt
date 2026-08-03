package id.my.anciety.codever.web

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import id.my.anciety.codever.BuildConfig
import id.my.anciety.codever.bridge.BridgeRuntime
import id.my.anciety.codever.bridge.BridgeError
import id.my.anciety.codever.bridge.BridgeRuntimeFailure
import id.my.anciety.codever.bridge.NativeWebBridge
import id.my.anciety.codever.bridge.TrustedWebOrigin
import id.my.anciety.codever.client.NativeClientRuntime
import id.my.anciety.codever.client.NativePairingRejectedException
import id.my.anciety.codever.client.events.ClientSnapshot
import id.my.anciety.codever.client.events.PublicTrustState
import id.my.anciety.codever.service.CodeverConnectionService
import id.my.anciety.codever.service.ActivityLaunchDecision
import id.my.anciety.codever.service.ServicePreferenceStore
import id.my.anciety.codever.service.ServiceStartPolicy
import id.my.anciety.codever.matrix.MatrixBootstrap
import id.my.anciety.codever.matrix.PublicMatrixSession
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlin.coroutines.resume

class MainActivity : ComponentActivity() {
    private var serviceBinder: CodeverConnectionService.LocalBinder? = null
    private var serviceBound = false
    private var bindingRequested = false
    private var webView: WebView? = null
    private var nativeBridge: NativeWebBridge? = null
    private var foreground = false
    private var pendingForegroundStart = false

    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        preferences.edit().putBoolean(KEY_NOTIFICATION_REQUESTED, true).apply()
        if (granted && notificationsAvailable()) {
            startForegroundAndBind()
        } else {
            showNotificationGate()
        }
    }

    private val serviceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, service: IBinder) {
            bindingRequested = false
            serviceBound = true
            serviceBinder = service as CodeverConnectionService.LocalBinder
            if (pendingForegroundStart && notificationsAvailable()) {
                serviceBinder?.start()
                pendingForegroundStart = false
            }
            showWebHost()
        }

        override fun onServiceDisconnected(name: ComponentName) {
            serviceBinder = null
            serviceBound = false
            bindingRequested = false
            if (foreground && notificationsAvailable()) {
                showRecoveryPage("The native host stopped unexpectedly.")
            }
        }
    }

    private val preferences by lazy {
        getSharedPreferences("codever-native-host-ui", Context.MODE_PRIVATE)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val current = webView
                if (current?.canGoBack() == true) current.goBack() else finish()
            }
        })
        ensureHostBound()
    }

    override fun onStart() {
        super.onStart()
        foreground = true
        if (pendingForegroundStart && notificationsAvailable()) {
            startForegroundAndBind()
        } else {
            ensureHostBound()
        }
    }

    override fun onResume() {
        super.onResume()
        if (pendingForegroundStart && notificationsAvailable()) {
            startForegroundAndBind()
        } else {
            ensureHostBound()
        }
    }

    override fun onStop() {
        foreground = false
        if (serviceBound || bindingRequested) {
            runCatching { unbindService(serviceConnection) }
            serviceBound = false
            bindingRequested = false
            serviceBinder = null
        }
        super.onStop()
    }

    override fun onDestroy() {
        nativeBridge?.close()
        nativeBridge = null
        webView?.apply {
            stopLoading()
            loadUrl("about:blank")
            clearHistory()
            removeAllViews()
            destroy()
        }
        webView = null
        super.onDestroy()
    }

    private fun notificationsAvailable(): Boolean {
        val permissionGranted = Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        return permissionGranted && NotificationManagerCompat.from(this).areNotificationsEnabled()
    }

    private fun ensureHostBound() {
        if (serviceBound || bindingRequested) return
        val servicePreferences = ServicePreferenceStore(this)
        val restoreEnabled = servicePreferences.restoreEnabled
        val restorePreferenceExists = servicePreferences.hasRestorePreference
        when (ServiceStartPolicy.activityLaunch(
            restoreEnabled,
            restorePreferenceExists,
            notificationsAvailable(),
        )) {
            ActivityLaunchDecision.BIND_ONLY -> bindHostOnly()
            ActivityLaunchDecision.RESTORE_FOREGROUND -> {
                if (restorePreferenceExists) {
                    CodeverConnectionService.restoreIfEnabled(this)
                } else {
                    CodeverConnectionService.startFromUser(this)
                }
                bindHostOnly()
            }
            ActivityLaunchDecision.WAIT_FOR_NOTIFICATION -> {
                pendingForegroundStart = true
                showNotificationGate()
            }
        }
    }

    private fun bindHostOnly() {
        if (serviceBound || bindingRequested) return
        bindingRequested = bindService(
            Intent(this, CodeverConnectionService::class.java),
            serviceConnection,
            Context.BIND_AUTO_CREATE,
        )
        if (!bindingRequested) showRecoveryPage("The native host service could not be bound.")
    }

    private fun startForegroundAndBind() {
        pendingForegroundStart = true
        if (!notificationsAvailable()) {
            showNotificationGate()
            return
        }
        CodeverConnectionService.startFromUser(this)
        serviceBinder?.let {
            it.start()
            pendingForegroundStart = false
            showWebHost()
            return
        }
        bindHostOnly()
    }

    private fun showNotificationGate() {
        val requested = preferences.getBoolean(KEY_NOTIFICATION_REQUESTED, false)
        val canRequest = Build.VERSION.SDK_INT >= 33 &&
            (!requested || shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS))
        setContentView(messageView(
            title = "Persistent notification required",
            detail = "Codever needs a visible notification before its persistent native connection can start. Denying this permission leaves the native connection stopped.",
            action = if (canRequest) "Allow notification" else "Open notification settings",
        ) {
            if (canRequest) {
                notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            } else {
                openNotificationSettings()
            }
        })
    }

    private fun openNotificationSettings() {
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
        } else {
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                .setData(Uri.parse("package:$packageName"))
        }
        runCatching { startActivity(intent) }
            .onFailure {
                startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                        .setData(Uri.parse("package:$packageName")),
                )
            }
    }

    private fun showWebHost() {
        val existing = webView
        if (existing != null) {
            setContentView(existing)
            return
        }

        val created = WebView(this)
        webView = created
        configureWebView(created)
        val bridge = NativeWebBridge(created, ActivityBridgeRuntime())
        if (!bridge.install()) {
            created.destroy()
            webView = null
            showRecoveryPage("This Android System WebView does not support the secure Codever bridge. Update Android System WebView and retry.")
            return
        }
        nativeBridge = bridge
        setContentView(created)
        created.loadUrl(TrustedWebOrigin.APP_URL)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView(view: WebView) {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mediaPlaybackRequiresUserGesture = true
            userAgentString = "$userAgentString CodeverNative/${BuildConfig.VERSION_NAME}"
        }
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (!request.isForMainFrame) return false
                val url = request.url.toString()
                if (TrustedWebOrigin.isTrustedUrl(url)) return false
                openExternalUrl(request.url)
                return true
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) showRecoveryPage("The online Codever UI could not be loaded.")
            }

            override fun onReceivedHttpError(
                view: WebView,
                request: WebResourceRequest,
                errorResponse: WebResourceResponse,
            ) {
                if (request.isForMainFrame && errorResponse.statusCode >= 400) {
                    showRecoveryPage("The online Codever UI returned HTTP ${errorResponse.statusCode}.")
                }
            }

            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                handler.cancel()
                showRecoveryPage("The Codever server certificate could not be verified.")
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                nativeBridge?.close()
                nativeBridge = null
                webView = null
                view.destroy()
                showRecoveryPage("Android System WebView stopped. The native service is still running.")
                return true
            }
        }
    }

    private fun openExternalUrl(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: ActivityNotFoundException) {
            showRecoveryPage("No application can open this external link.")
        }
    }

    private fun showRecoveryPage(detail: String) {
        setContentView(messageView(
            title = "Codever is temporarily unavailable",
            detail = detail,
            action = "Retry",
        ) {
            if (serviceBinder == null) {
                ensureHostBound()
            } else {
                webView?.reload() ?: showWebHost()
            }
        })
    }

    private fun showDisconnectedPage() {
        setContentView(messageView(
            title = "Codever is disconnected",
            detail = "The persistent native host has stopped and will not restart after reboot.",
            action = "Reconnect",
        ) {
            startForegroundAndBind()
        })
    }

    private fun messageView(
        title: String,
        detail: String,
        action: String,
        onAction: () -> Unit,
    ): View = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
        setPadding(dp(32), dp(32), dp(32), dp(32))
        setBackgroundColor(0xFFF4F6FA.toInt())
        addView(TextView(context).apply {
            text = title
            textSize = 22f
            setTextColor(0xFF111827.toInt())
            gravity = Gravity.CENTER
        }, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ))
        addView(TextView(context).apply {
            text = detail
            textSize = 15f
            setTextColor(0xFF4B5563.toInt())
            gravity = Gravity.CENTER
            setPadding(0, dp(16), 0, dp(24))
        }, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ))
        addView(Button(context).apply {
            text = action
            setOnClickListener { onAction() }
        })
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private inner class ActivityBridgeRuntime : BridgeRuntime {
        override val runtimeVersion: String = BuildConfig.VERSION_NAME
        override val runtimeBuild: String = "android-${BuildConfig.VERSION_CODE}"
        override val nativeDeviceId: String
            get() = serviceBinder?.clientRuntime()?.deviceId
                ?: ServicePreferenceStore(this@MainActivity).nativeDeviceId

        override fun client(): NativeClientRuntime = serviceBinder?.clientRuntime()
            ?: throw IllegalStateException("Native foreground service is not bound.")

        override fun snapshot(): ClientSnapshot = client().snapshot()

        override suspend fun start(): ClientSnapshot = withContext(Dispatchers.Main.immediate) {
            if (!notificationsAvailable()) {
                pendingForegroundStart = true
                // Let the JSON-RPC failure reach the WebView before replacing
                // it with the native permission gate.
                webView?.post { showNotificationGate() }
                throw BridgeRuntimeFailure(
                    BridgeError.INVALID_STATE,
                    "A visible persistent notification must be allowed before the native host starts.",
                    userAction = "open_app",
                )
            }
            CodeverConnectionService.startFromUser(this@MainActivity)
            serviceBinder?.start()
                ?: throw IllegalStateException("Native host service is not bound.")
        }

        override suspend fun bootstrap(
            input: MatrixBootstrap,
        ): Pair<PublicMatrixSession, ClientSnapshot> = serviceBinder?.bootstrap(input)
            ?: throw IllegalStateException("Native foreground service is not bound.")

        override suspend fun completePairing(
            pairingId: String,
            deviceName: String,
        ): Pair<PublicTrustState.Trusted, ClientSnapshot> {
            val binder = serviceBinder
                ?: throw IllegalStateException("Native foreground service is not bound.")
            val preview = binder.clientRuntime().pairingPreview(pairingId)
                ?: throw IllegalStateException("The pairing preview is no longer available.")
            val confirmed = withContext(Dispatchers.Main.immediate) {
                confirmNativePairing(preview.gatewayName, preview.verificationCode)
            }
            if (!confirmed) {
                binder.clientRuntime().cancelPairing(pairingId)
                throw NativePairingRejectedException("Pairing was cancelled on the Android device.")
            }
            return binder.completePairing(pairingId, deviceName)
        }

        override suspend fun disconnect(mode: String): ClientSnapshot {
            val snapshot = serviceBinder?.disconnect(mode)
                ?: throw IllegalStateException("Native foreground service is not bound.")
            withContext(Dispatchers.Main.immediate) {
                if (serviceBound || bindingRequested) {
                    runCatching { unbindService(serviceConnection) }
                }
                serviceBinder = null
                serviceBound = false
                bindingRequested = false
                pendingForegroundStart = false
                webView?.post { showDisconnectedPage() }
            }
            return snapshot
        }
    }

    private suspend fun confirmNativePairing(
        gatewayName: String,
        verificationCode: String,
    ): Boolean = suspendCancellableCoroutine { continuation ->
        val dialog = AlertDialog.Builder(this)
            .setTitle("Pair with $gatewayName?")
            .setMessage(
                "Confirm that this code matches the Gateway:\n\n$verificationCode\n\n" +
                    "This grants the Gateway permission to exchange encrypted Codever commands with this device.",
            )
            .setPositiveButton("Pair") { _, _ ->
                if (continuation.isActive) continuation.resume(true)
            }
            .setNegativeButton("Cancel") { _, _ ->
                if (continuation.isActive) continuation.resume(false)
            }
            .setOnCancelListener {
                if (continuation.isActive) continuation.resume(false)
            }
            .create()
        continuation.invokeOnCancellation { dialog.dismiss() }
        dialog.show()
    }

    private companion object {
        const val KEY_NOTIFICATION_REQUESTED = "notification-permission-requested"
    }
}
