package id.my.anciety.codever.update

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import id.my.anciety.codever.BuildConfig
import id.my.anciety.codever.bridge.BridgeProtocol
import id.my.anciety.codever.diagnostics.NativeDiagnosticLog
import java.io.File
import java.net.URI
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject

class NativeUpdateManager private constructor(context: Context) {
    private val appContext = context.applicationContext
    private val parser = NativeClientReleaseParser(
        trustedOrigin = URI(BuildConfig.NATIVE_UPDATE_ORIGIN),
        allowLoopbackHttp = BuildConfig.ALLOW_INSECURE_E2E_LOOPBACK,
    )
    private val store = NativeUpdateStore(appContext)
    private val http = NativeUpdateHttpClient()
    private val artifactVerifier = NativeUpdateArtifactVerifier(appContext)
    private val installer = NativeUpdateInstaller(appContext)
    private val notifier = NativeUpdateNotifier(appContext)
    private val diagnostics = NativeDiagnosticLog.get(appContext)
    private val mutex = Mutex()
    @Volatile private var readyRelease: NativeClientRelease? = null
    @Volatile private var readyApk: File? = null
    @Volatile private var status = baseStatus()

    init {
        restoreReadyUpdate()
    }

    fun status(): NativeUpdateStatus = status

    /** Accepts release metadata only after the signed CVP workspace snapshot was verified. */
    suspend fun acceptPublishedRelease(value: JsonObject): NativeUpdateStatus = mutex.withLock {
        publish(baseStatus(NativeUpdatePhase.CHECKING))
        diagnostics.record("update.gateway_release_received")
        try {
            val release = parser.parse(value)
            if (release.channel != UPDATE_CHANNEL) {
                throw NativeClientReleaseException("release_channel_unsupported")
            }
            val previouslyAccepted = store.acceptedRelease?.let { encoded ->
                runCatching { parser.parse(encoded) }.getOrNull()
            }
            if (
                previouslyAccepted != null
                && comparable(previouslyAccepted) == comparable(release)
                && canReusePublishedReleaseStatus(
                    release.versionCode,
                    BuildConfig.VERSION_CODE.toLong(),
                    status,
                )
            ) {
                return@withLock status
            }
            val decision = NativeUpdatePolicy.decide(
                release = release,
                highestVersionCode = store.highestVersionCode,
                currentVersionCode = BuildConfig.VERSION_CODE.toLong(),
                currentPackageName = appContext.packageName,
                currentBridgeVersion = BridgeProtocol.VERSION,
                currentAndroidApi = Build.VERSION.SDK_INT,
                supportedAbis = Build.SUPPORTED_ABIS.toSet(),
            )
            retainPublishedRelease(release)
            if (decision == NativeUpdateDecision.Current) {
                clearReadyIfSuperseded()
                diagnostics.record("update.gateway_release_current")
                return@withLock publish(baseStatus(
                    phase = NativeUpdatePhase.CURRENT,
                    checkedAt = System.currentTimeMillis(),
                ))
            }
            if (readyRelease?.versionCode?.let { it < release.versionCode } == true) {
                store.clearReady()
                readyRelease = null
                readyApk = null
                notifier.clear()
            }
            val existingReady = readyRelease?.takeIf { it.versionCode == release.versionCode }
            val existingReadyApk = readyApk
            if (existingReady != null && existingReadyApk?.isFile == true) {
                val valid = runCatching { artifactVerifier.verify(existingReadyApk, release) }.isSuccess
                if (valid) {
                    return@withLock publish(statusFor(release, NativeUpdatePhase.READY))
                }
                store.clearReady()
                readyRelease = null
                readyApk = null
            }
            publish(statusFor(release, NativeUpdatePhase.AVAILABLE))
            val partial = store.partialFile(release.versionCode)
            publish(statusFor(
                release,
                NativeUpdatePhase.DOWNLOADING,
                downloadedBytes = partial.takeIf(File::isFile)?.length() ?: 0L,
            ))
            if (partial.length() != release.artifact.size) {
                http.download(
                    URI(release.artifact.url),
                    partial,
                    release.artifact.size,
                ) { downloaded ->
                    publish(statusFor(
                        release,
                        NativeUpdatePhase.DOWNLOADING,
                        downloadedBytes = downloaded,
                    ))
                }
            }
            try {
                artifactVerifier.verify(partial, release)
            } catch (error: Exception) {
                partial.delete()
                throw error
            }
            val ready = store.readyFile(release.versionCode)
            store.clearReady()
            if (ready.exists() && !ready.delete()) {
                throw NativeUpdateArtifactException("ready_artifact_replace_failed")
            }
            if (!partial.renameTo(ready)) {
                throw NativeUpdateArtifactException("ready_artifact_move_failed")
            }
            store.saveReady(release, ready)
            readyRelease = release
            readyApk = ready
            diagnostics.record(
                "update.ready",
                mapOf("version_code" to release.versionCode.toString()),
            )
            val result = publish(statusFor(release, NativeUpdatePhase.READY))
            if (NotificationManagerCompat.from(appContext).areNotificationsEnabled()) {
                runCatching { notifier.showReady(release.versionName) }
            }
            result
        } catch (error: Exception) {
            val detail = detailCode(error)
            diagnostics.record("update.gateway_release_failed", mapOf("reason" to detail))
            val ready = readyRelease
            val apk = readyApk
            if (ready != null && apk?.isFile == true) {
                publish(statusFor(ready, NativeUpdatePhase.READY, detailCode = detail))
            } else {
                publish(baseStatus(
                    phase = NativeUpdatePhase.FAILED,
                    detailCode = detail,
                    checkedAt = System.currentTimeMillis(),
                ))
            }
        }
    }

    suspend fun installReady(): NativeUpdateStatus = mutex.withLock {
        val release = readyRelease
        val apk = readyApk
        if (release == null || apk == null || !apk.isFile) {
            return@withLock publish(baseStatus(
                phase = NativeUpdatePhase.FAILED,
                detailCode = "update_not_ready",
            ))
        }
        if (!appContext.packageManager.canRequestPackageInstalls()) {
            return@withLock publish(statusFor(
                release,
                NativeUpdatePhase.PERMISSION_REQUIRED,
                detailCode = "install_permission_required",
            ))
        }
        try {
            artifactVerifier.verify(apk, release)
            installer.install(apk, release)
            diagnostics.record("update.install_submitted")
            publish(statusFor(release, NativeUpdatePhase.INSTALLING))
        } catch (error: Exception) {
            val detail = detailCode(error)
            diagnostics.record("update.install_failed", mapOf("reason" to detail))
            publish(statusFor(release, NativeUpdatePhase.FAILED, detailCode = detail))
        }
    }

    suspend fun onInstallResult(status: Int, confirmation: Intent?, detailCode: String?) = mutex.withLock {
        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                diagnostics.record("update.install_confirmation_required")
                if (confirmation == null) {
                    publishReadyFailure("install_confirmation_missing")
                } else {
                    val launched = runCatching {
                        appContext.startActivity(confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    }.isSuccess
                    if (!launched) {
                        val notified = NotificationManagerCompat.from(appContext).areNotificationsEnabled() &&
                            runCatching { notifier.showConfirmation(confirmation) }.isSuccess
                        if (!notified) publishReadyFailure("install_confirmation_unavailable")
                    }
                }
            }
            PackageInstaller.STATUS_SUCCESS -> {
                diagnostics.record("update.install_succeeded")
                store.clearReady()
                readyRelease = null
                readyApk = null
                notifier.clear()
            }
            else -> {
                diagnostics.record(
                    "update.install_result_failed",
                    mapOf(
                        "status" to status.toString(),
                        "reason" to detailCode.orEmpty().take(160),
                    ),
                )
                publishReadyFailure("install_status_$status")
                if (NotificationManagerCompat.from(appContext).areNotificationsEnabled()) {
                    runCatching { notifier.showFailed() }
                }
            }
        }
    }

    private fun retainPublishedRelease(release: NativeClientRelease) {
        val accepted = store.acceptedRelease?.let { encoded ->
            runCatching { parser.parse(encoded) }.getOrNull()
        }
        if (
            release.versionCode == store.highestVersionCode
            && accepted != null
            && comparable(accepted) != comparable(release)
        ) {
            throw NativeClientReleaseException("release_version_immutable")
        }
        if (release.versionCode >= store.highestVersionCode) {
            store.highestVersionCode = release.versionCode
            store.acceptedRelease = release.encoded
        }
    }

    private fun restoreReadyUpdate() {
        val stored = store.loadReady() ?: return
        runCatching {
            val release = parser.parse(stored.release)
            val decision = NativeUpdatePolicy.decide(
                release = release,
                highestVersionCode = store.highestVersionCode,
                currentVersionCode = BuildConfig.VERSION_CODE.toLong(),
                currentPackageName = appContext.packageName,
                currentBridgeVersion = BridgeProtocol.VERSION,
                currentAndroidApi = Build.VERSION.SDK_INT,
                supportedAbis = Build.SUPPORTED_ABIS.toSet(),
            )
            if (decision == NativeUpdateDecision.Current) {
                store.clearReady()
                return
            }
            artifactVerifier.verify(stored.apk, release)
            readyRelease = release
            readyApk = stored.apk
            status = statusFor(release, NativeUpdatePhase.READY)
        }.onFailure { error ->
            diagnostics.record(
                "update.ready_restore_failed",
                mapOf("reason" to detailCode(error)),
            )
            store.clearReady()
        }
    }

    private fun clearReadyIfSuperseded() {
        if (readyRelease != null || store.loadReady() != null) store.clearReady()
        readyRelease = null
        readyApk = null
        notifier.clear()
    }

    private fun publishReadyFailure(detail: String) {
        val release = readyRelease
        publish(if (release == null) {
            baseStatus(NativeUpdatePhase.FAILED, detailCode = detail)
        } else {
            statusFor(release, NativeUpdatePhase.FAILED, detailCode = detail)
        })
    }

    private fun publish(value: NativeUpdateStatus): NativeUpdateStatus {
        status = value
        return value
    }

    private fun statusFor(
        release: NativeClientRelease,
        phase: NativeUpdatePhase,
        downloadedBytes: Long? = null,
        detailCode: String? = null,
    ): NativeUpdateStatus = baseStatus(
        phase = phase,
        latestVersionCode = release.versionCode,
        latestVersionName = release.versionName,
        buildId = release.buildId,
        downloadedBytes = downloadedBytes,
        totalBytes = release.artifact.size,
        detailCode = detailCode,
        checkedAt = System.currentTimeMillis(),
    )

    private fun baseStatus(
        phase: NativeUpdatePhase = NativeUpdatePhase.CURRENT,
        latestVersionCode: Long? = null,
        latestVersionName: String? = null,
        buildId: String? = null,
        downloadedBytes: Long? = null,
        totalBytes: Long? = null,
        detailCode: String? = null,
        checkedAt: Long? = null,
    ) = NativeUpdateStatus(
        phase = phase,
        currentVersionCode = BuildConfig.VERSION_CODE.toLong(),
        currentVersionName = BuildConfig.VERSION_NAME,
        latestVersionCode = latestVersionCode,
        latestVersionName = latestVersionName,
        buildId = buildId,
        downloadedBytes = downloadedBytes,
        totalBytes = totalBytes,
        detailCode = detailCode,
        checkedAt = checkedAt,
    )

    private fun detailCode(error: Throwable): String = when (error) {
        is NativeUpdateDownloadException -> error.detailCode
        is NativeUpdateArtifactException -> error.detailCode
        is NativeClientReleaseException -> error.detailCode
        else -> error.javaClass.simpleName.lowercase().take(80)
    }

    private fun comparable(release: NativeClientRelease): NativeClientRelease =
        release.copy(encoded = "")

    companion object {
        private const val UPDATE_CHANNEL = "alpha"
        @Volatile private var instance: NativeUpdateManager? = null

        fun get(context: Context): NativeUpdateManager = instance ?: synchronized(this) {
            instance ?: NativeUpdateManager(context).also { instance = it }
        }
    }
}

internal fun canReusePublishedReleaseStatus(
    releaseVersionCode: Long,
    currentVersionCode: Long,
    status: NativeUpdateStatus,
): Boolean = when (status.phase) {
    NativeUpdatePhase.CURRENT -> releaseVersionCode <= currentVersionCode
    NativeUpdatePhase.READY,
    NativeUpdatePhase.INSTALLING,
    NativeUpdatePhase.PERMISSION_REQUIRED,
    -> status.latestVersionCode == releaseVersionCode
    else -> false
}
