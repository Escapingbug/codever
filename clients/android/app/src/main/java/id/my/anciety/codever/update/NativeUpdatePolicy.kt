package id.my.anciety.codever.update

internal sealed interface NativeUpdateDecision {
    data object Current : NativeUpdateDecision
    data object Download : NativeUpdateDecision
}

internal object NativeUpdatePolicy {
    fun decide(
        release: NativeClientRelease,
        highestVersionCode: Long,
        currentVersionCode: Long,
        currentPackageName: String,
        currentBridgeVersion: Int,
        currentAndroidApi: Int,
        supportedAbis: Set<String>,
    ): NativeUpdateDecision {
        if (release.versionCode < highestVersionCode) {
            throw NativeClientReleaseException("release_version_replayed")
        }
        if (release.packageName != currentPackageName) {
            throw NativeClientReleaseException("release_package_mismatch")
        }
        if (release.minimumAndroid > currentAndroidApi) {
            throw NativeClientReleaseException("release_android_unsupported")
        }
        if (release.architecture !in supportedAbis) {
            throw NativeClientReleaseException("release_architecture_unsupported")
        }
        if (currentBridgeVersion !in release.nativeBridgeMinimum..release.nativeBridgeMaximum) {
            throw NativeClientReleaseException("release_bridge_unsupported")
        }
        return if (release.versionCode > currentVersionCode) {
            NativeUpdateDecision.Download
        } else {
            NativeUpdateDecision.Current
        }
    }
}
