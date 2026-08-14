package id.my.anciety.codever.web

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ClipData
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
import android.view.ViewGroup
import android.view.WindowManager
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
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import id.my.anciety.codever.BuildConfig
import id.my.anciety.codever.R
import id.my.anciety.codever.bridge.BridgeRuntime
import id.my.anciety.codever.bridge.BridgeError
import id.my.anciety.codever.bridge.BridgeRuntimeFailure
import id.my.anciety.codever.bridge.NativeWebBridge
import id.my.anciety.codever.bridge.TrustedWebOrigin
import id.my.anciety.codever.client.NativeClientRuntime
import id.my.anciety.codever.client.NativePairingRejectedException
import id.my.anciety.codever.client.events.ClientSnapshot
import id.my.anciety.codever.client.events.PublicTrustState
import id.my.anciety.codever.diagnostics.NativeDiagnosticLog
import id.my.anciety.codever.service.CodeverConnectionService
import id.my.anciety.codever.service.ActivityLaunchDecision
import id.my.anciety.codever.service.ServicePreferenceStore
import id.my.anciety.codever.service.ServiceStartPolicy
import id.my.anciety.codever.matrix.MatrixBootstrap
import id.my.anciety.codever.matrix.PublicMatrixSession
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlin.coroutines.resume

class MainActivity : ComponentActivity() {
    private var serviceBinder: CodeverConnectionService.LocalBinder? = null
    private var serviceBound = false
    private var bindingRequested = false
    private var serviceConnectionInterrupted = false
    private var serviceBinderReady = CompletableDeferred<CodeverConnectionService.LocalBinder>()
    private lateinit var contentHost: FrameLayout
    private var webView: WebView? = null
    private var nativeBridge: NativeWebBridge? = null
    private var foreground = false
    private var pendingForegroundStart = false
    private var pendingSessionId: String? = null
    private var nativeBackDispatchPending = false
    private var nativeBackDispatchGeneration = 0L
    private val diagnostics by lazy { NativeDiagnosticLog.get(this) }

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
            if (!serviceBinderReady.isCompleted) serviceBinderReady.complete(serviceBinder!!)
            serviceBinder?.setUiForeground(foreground)
            val reloadWebHost = serviceConnectionInterrupted || pendingForegroundStart
            serviceConnectionInterrupted = false
            diagnostics.record(
                "activity.service_connected",
                mapOf(
                    "stage" to when {
                        webView == null -> "create"
                        reloadWebHost -> "reload"
                        else -> "keep"
                    },
                ),
            )
            if (pendingForegroundStart && notificationsAvailable()) {
                serviceBinder?.startInBackground()
                pendingForegroundStart = false
            }
            showWebHost(reloadExisting = reloadWebHost)
        }

        override fun onServiceDisconnected(name: ComponentName) {
            serviceBinder = null
            serviceBound = false
            bindingRequested = false
            serviceConnectionInterrupted = true
            serviceBinderReady = CompletableDeferred()
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
        configureEdgeToEdgeContent()
        diagnostics.record("activity.created")
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                dispatchNativeBack()
            }
        })
        handleIntent(intent)
        showWebHost()
        ensureHostBound()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        foreground = true
        serviceBinder?.setUiForeground(true)
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
        serviceBinder?.setUiForeground(false)
        super.onStop()
    }

    override fun onDestroy() {
        diagnostics.record("activity.destroyed")
        if (serviceBound || bindingRequested) {
            runCatching { unbindService(serviceConnection) }
            serviceBound = false
            bindingRequested = false
            serviceBinder = null
        }
        if (!serviceBinderReady.isCompleted) serviceBinderReady.cancel()
        nativeBackDispatchGeneration += 1
        nativeBackDispatchPending = false
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

    private fun dispatchNativeBack() {
        val current = webView
        if (current == null) {
            performNativeBackFallback(null)
            return
        }
        if (nativeBackDispatchPending) return

        nativeBackDispatchPending = true
        val generation = ++nativeBackDispatchGeneration
        current.postDelayed({
            if (!nativeBackDispatchPending || nativeBackDispatchGeneration != generation) return@postDelayed
            nativeBackDispatchPending = false
            if (current !== webView || isFinishing || isDestroyed) return@postDelayed
            performNativeBackFallback(current)
        }, NATIVE_BACK_RESPONSE_TIMEOUT_MS)

        runCatching {
            current.evaluateJavascript(NATIVE_BACK_DISPATCH_SCRIPT) { result ->
                if (!nativeBackDispatchPending || nativeBackDispatchGeneration != generation) {
                    return@evaluateJavascript
                }
                nativeBackDispatchPending = false
                if (current !== webView || isFinishing || isDestroyed) return@evaluateJavascript
                if (!nativeBackWasHandled(result)) performNativeBackFallback(current)
            }
        }.onFailure {
            if (nativeBackDispatchGeneration == generation) {
                nativeBackDispatchPending = false
                if (current === webView && !isFinishing && !isDestroyed) {
                    performNativeBackFallback(current)
                }
            }
        }
    }

    private fun performNativeBackFallback(current: WebView?) {
        when (nativeBackFallbackAction(current?.canGoBack() == true)) {
            NativeBackFallbackAction.WEB_HISTORY -> current?.goBack()
            NativeBackFallbackAction.BACKGROUND_TASK -> {
                if (!moveTaskToBack(true)) finish()
            }
        }
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
        diagnostics.record(
            "activity.service_binding_requested",
            mapOf("available" to bindingRequested.toString()),
        )
        if (!bindingRequested) {
            if (!serviceBinderReady.isCompleted) {
                serviceBinderReady.completeExceptionally(
                    IllegalStateException("The native host service could not be bound."),
                )
            }
            showRecoveryPage("The native host service could not be bound.")
        }
    }

    private fun startForegroundAndBind() {
        pendingForegroundStart = true
        if (!notificationsAvailable()) {
            showNotificationGate()
            return
        }
        CodeverConnectionService.startFromUser(this)
        serviceBinder?.let {
            it.startInBackground()
            pendingForegroundStart = false
            showWebHost(reloadExisting = true)
            return
        }
        bindHostOnly()
    }

    private fun showNotificationGate() {
        val requested = preferences.getBoolean(KEY_NOTIFICATION_REQUESTED, false)
        val canRequest = Build.VERSION.SDK_INT >= 33 &&
            (!requested || shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS))
        showContent(messageView(
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

    private fun showWebHost(reloadExisting: Boolean = false) {
        val existing = webView
        when (webHostActionAfterServiceConnected(existing != null, reloadExisting)) {
            WebHostBindingAction.KEEP -> {
                checkNotNull(existing)
                showContent(existing)
                diagnostics.record("activity.web_host_kept_during_bind")
                return
            }
            WebHostBindingAction.RELOAD -> {
                checkNotNull(existing)
                showContent(existing)
                diagnostics.record("activity.web_host_reloading_after_bind")
                val target = pendingWebAppUrl()
                if (target == TrustedWebOrigin.APP_URL) existing.reload() else existing.loadUrl(target)
                return
            }
            WebHostBindingAction.CREATE -> Unit
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
        showContent(created)
        diagnostics.record("activity.web_host_created")
        created.loadUrl(pendingWebAppUrl())
    }

    private fun configureEdgeToEdgeContent() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        // Insets below are the single source of truth for keyboard avoidance.
        // Prevent the platform from also panning or resizing the same content.
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING)

        contentHost = FrameLayout(this).apply {
            setBackgroundColor(0xFFF4F6FA.toInt())
        }
        ViewCompat.setOnApplyWindowInsetsListener(contentHost) { host, windowInsets ->
            val resolved = resolveNativeWebInsets(
                systemBars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars()).toEdges(),
                displayCutout = windowInsets.getInsets(WindowInsetsCompat.Type.displayCutout()).toEdges(),
                mandatoryGestures = windowInsets
                    .getInsets(WindowInsetsCompat.Type.mandatorySystemGestures())
                    .toEdges(),
                ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime()).toEdges(),
                imeVisible = windowInsets.isVisible(WindowInsetsCompat.Type.ime()),
            )
            if (
                host.paddingLeft != resolved.left ||
                host.paddingTop != resolved.top ||
                host.paddingRight != resolved.right ||
                host.paddingBottom != resolved.bottom
            ) {
                host.setPadding(resolved.left, resolved.top, resolved.right, resolved.bottom)
            }

            // The WebView is already laid out inside the native safe region.
            // Consuming here prevents a WebView implementation from applying
            // the same values again through CSS safe-area environment values.
            WindowInsetsCompat.CONSUMED
        }
        setContentView(contentHost)
        ViewCompat.requestApplyInsets(contentHost)
    }

    private fun Insets.toEdges(): InsetEdges = InsetEdges(left, top, right, bottom)

    private fun showContent(content: View) {
        if (content.parent !== contentHost) {
            (content.parent as? ViewGroup)?.removeView(content)
            contentHost.removeAllViews()
            contentHost.addView(
                content,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT,
                ),
            )
        }
        ViewCompat.requestApplyInsets(contentHost)
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
            override fun onPageCommitVisible(view: WebView, url: String) {
                diagnostics.record("activity.web_page_visible")
            }

            override fun onPageFinished(view: WebView, url: String) {
                diagnostics.record("activity.web_page_finished")
            }

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

    private fun handleIntent(intent: Intent?) {
        when (intent?.action) {
            ACTION_EXPORT_DIAGNOSTICS -> exportDiagnostics(intent)
            ACTION_OPEN_SESSION -> openSessionFromNotification(intent)
        }
    }

    private fun openSessionFromNotification(intent: Intent) {
        intent.action = null
        val sessionId = intent.getStringExtra(EXTRA_SESSION_ID)
            ?.takeIf { it.isNotBlank() && it.length <= 512 && !it.any(Char::isISOControl) }
            ?: return
        intent.removeExtra(EXTRA_SESSION_ID)
        pendingSessionId = sessionId
        diagnostics.record(
            "notification.task_opened",
            mapOf("stage" to if (serviceBound) "bound" else "deferred"),
        )
        // If Android recreated this Activity or disconnected the service while
        // it was backgrounded, retain the target until onServiceConnected
        // reloads the Web host; navigating now would be overwritten by that
        // reload.
        if (serviceBound) webView?.loadUrl(pendingWebAppUrl())
    }

    private fun pendingWebAppUrl(): String {
        val sessionId = pendingSessionId ?: return TrustedWebOrigin.APP_URL
        pendingSessionId = null
        return "${TrustedWebOrigin.APP_URL}#session=${Uri.encode(sessionId)}"
    }

    private fun exportDiagnostics(intent: Intent) {
        intent.action = null
        diagnostics.record("diagnostics.export_requested")
        runCatching {
            val report = diagnostics.export()
            val uri = FileProvider.getUriForFile(
                this,
                "$packageName.fileprovider",
                report,
            )
            val share = Intent(Intent.ACTION_SEND)
                .setType("text/plain")
                .putExtra(Intent.EXTRA_STREAM, uri)
                .putExtra(Intent.EXTRA_SUBJECT, "Codever native diagnostics ${BuildConfig.VERSION_NAME}")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            share.clipData = ClipData.newRawUri("Codever diagnostics", uri)
            startActivity(Intent.createChooser(share, getString(R.string.diagnostics_share_title)))
            diagnostics.record("diagnostics.export_shared")
        }.onFailure { error ->
            diagnostics.record(
                "diagnostics.export_failure",
                mapOf(
                    "error" to error.javaClass.simpleName
                        .replace(Regex("[^A-Za-z0-9._:+/-]"), "_")
                        .take(160),
                ),
            )
            showRecoveryPage("The native diagnostic report could not be exported.")
        }
    }

    private fun showRecoveryPage(detail: String) {
        showContent(messageView(
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
        showContent(messageView(
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

    private suspend fun awaitServiceBinder(): CodeverConnectionService.LocalBinder =
        serviceBinder ?: withTimeout(SERVICE_BIND_TIMEOUT_MS) { serviceBinderReady.await() }

    private inner class ActivityBridgeRuntime : BridgeRuntime {
        override val runtimeVersion: String = BuildConfig.VERSION_NAME
        override val runtimeBuild: String = BuildConfig.NATIVE_BUILD_ID
        override val nativeDeviceId: String
            get() = serviceBinder?.readyClientRuntime()?.deviceId
                ?: ServicePreferenceStore(this@MainActivity).nativeDeviceId

        override suspend fun client(): NativeClientRuntime =
            awaitServiceBinder().clientRuntime()

        override suspend fun snapshot(): ClientSnapshot = client().snapshot()

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
            awaitServiceBinder().start()
        }

        override suspend fun bootstrap(
            input: MatrixBootstrap,
        ): Pair<PublicMatrixSession, ClientSnapshot> = awaitServiceBinder().bootstrap(input)

        override suspend fun completePairing(
            pairingId: String,
            deviceName: String,
        ): Pair<PublicTrustState.Trusted, ClientSnapshot> {
            diagnostics.record("activity.pairing_completion.entered")
            val binder = awaitServiceBinder()
            val (preview, alreadyConfirmed) = binder.clientRuntime().pairingConfirmation(pairingId)
                ?: throw IllegalStateException("The pairing preview is no longer available.")
            if (!alreadyConfirmed) {
                val confirmed = withContext(Dispatchers.Main.immediate) {
                    confirmNativePairing(preview.gatewayName, preview.verificationCode)
                }
                if (!confirmed) {
                    binder.clientRuntime().cancelPairing(pairingId)
                    throw NativePairingRejectedException(
                        "Pairing was cancelled on the Android device.",
                        retryable = false,
                    )
                }
            }
            diagnostics.record("activity.pairing_completion.confirmed")
            return binder.completePairing(pairingId, deviceName)
        }

        override suspend fun disconnect(mode: String): ClientSnapshot {
            val snapshot = awaitServiceBinder().disconnect(mode)
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
                diagnostics.record("activity.pairing_confirmation.accepted")
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

    companion object {
        private const val KEY_NOTIFICATION_REQUESTED = "notification-permission-requested"
        private const val SERVICE_BIND_TIMEOUT_MS = 10_000L
        const val ACTION_EXPORT_DIAGNOSTICS =
            "id.my.anciety.codever.action.EXPORT_DIAGNOSTICS"
        const val ACTION_OPEN_SESSION =
            "id.my.anciety.codever.action.OPEN_SESSION"
        const val EXTRA_SESSION_ID =
            "id.my.anciety.codever.extra.SESSION_ID"
    }
}
