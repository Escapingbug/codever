package id.my.anciety.codever.update

enum class NativeUpdatePhase(val wireName: String) {
    CURRENT("current"),
    CHECKING("checking"),
    AVAILABLE("available"),
    DOWNLOADING("downloading"),
    READY("ready"),
    INSTALLING("installing"),
    PERMISSION_REQUIRED("permission_required"),
    FAILED("failed"),
}

data class NativeUpdateStatus(
    val phase: NativeUpdatePhase,
    val currentVersionCode: Long,
    val currentVersionName: String,
    val latestVersionCode: Long? = null,
    val latestVersionName: String? = null,
    val buildId: String? = null,
    val downloadedBytes: Long? = null,
    val totalBytes: Long? = null,
    val detailCode: String? = null,
    val checkedAt: Long? = null,
)
