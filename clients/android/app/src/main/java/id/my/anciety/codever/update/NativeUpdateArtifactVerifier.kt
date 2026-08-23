package id.my.anciety.codever.update

import android.content.Context
import android.content.pm.PackageManager
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

internal class NativeUpdateArtifactVerifier(private val context: Context) {
    @Suppress("DEPRECATION")
    fun verify(file: File, release: NativeClientRelease) {
        if (!file.isFile || file.length() != release.artifact.size) {
            throw NativeUpdateArtifactException("artifact_size_mismatch")
        }
        if (sha256(file) != release.artifact.sha256) {
            throw NativeUpdateArtifactException("artifact_hash_mismatch")
        }
        if (release.packageName != context.packageName) {
            throw NativeUpdateArtifactException("artifact_package_mismatch")
        }
        val manager = context.packageManager
        val target = manager.getPackageArchiveInfo(
            file.absolutePath,
            PackageManager.GET_SIGNING_CERTIFICATES,
        ) ?: throw NativeUpdateArtifactException("artifact_package_unreadable")
        if (target.packageName != context.packageName || target.longVersionCode != release.versionCode) {
            throw NativeUpdateArtifactException("artifact_package_mismatch")
        }
        val installed = manager.getPackageInfo(
            context.packageName,
            PackageManager.GET_SIGNING_CERTIFICATES,
        )
        val targetCertificates = signerDigests(target.signingInfo)
        val installedCertificates = signerDigests(installed.signingInfo)
        if (
            release.artifact.signingCertificateSha256 !in targetCertificates ||
            targetCertificates.intersect(installedCertificates).isEmpty()
        ) {
            throw NativeUpdateArtifactException("artifact_signer_mismatch")
        }
    }

    private fun signerDigests(signingInfo: android.content.pm.SigningInfo?): Set<String> =
        signingInfo?.apkContentsSigners.orEmpty().mapTo(linkedSetOf()) { signature ->
            MessageDigest.getInstance("SHA-256")
                .digest(signature.toByteArray())
                .joinToString("") { "%02x".format(it.toInt() and 0xff) }
        }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }
}

internal class NativeUpdateArtifactException(val detailCode: String) : Exception(detailCode)
