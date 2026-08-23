package id.my.anciety.codever.update

import android.content.Context
import androidx.core.content.edit
import java.io.File

internal data class StoredNativeUpdate(
    val release: String,
    val apk: File,
)

/** Rebuildable update metadata. Device identity and Matrix state never live here. */
internal class NativeUpdateStore(private val context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    val directory = File(context.noBackupFilesDir, DIRECTORY).apply { mkdirs() }

    var highestVersionCode: Long
        get() = preferences.getLong(KEY_HIGHEST_VERSION_CODE, 0L)
        set(value) {
            preferences.edit(commit = true) { putLong(KEY_HIGHEST_VERSION_CODE, value) }
        }

    var acceptedRelease: String?
        get() = preferences.getString(KEY_ACCEPTED_RELEASE, null)
        set(value) {
            preferences.edit(commit = true) {
                if (value == null) remove(KEY_ACCEPTED_RELEASE) else putString(KEY_ACCEPTED_RELEASE, value)
            }
        }

    fun partialFile(versionCode: Long): File = File(directory, "$versionCode.apk.partial")
    fun readyFile(versionCode: Long): File = File(directory, "$versionCode.apk")

    fun saveReady(release: NativeClientRelease, apk: File) {
        require(apk.parentFile?.canonicalFile == directory.canonicalFile)
        preferences.edit(commit = true) {
            putString(KEY_READY_RELEASE, release.encoded)
            putString(KEY_READY_FILE, apk.name)
        }
    }

    fun loadReady(): StoredNativeUpdate? {
        val release = preferences.getString(KEY_READY_RELEASE, null) ?: return null
        val fileName = preferences.getString(KEY_READY_FILE, null)
            ?.takeIf { READY_FILE_PATTERN.matches(it) }
            ?: return null
        val file = File(directory, fileName)
        if (!file.isFile || file.canonicalFile.parentFile != directory.canonicalFile) return null
        return StoredNativeUpdate(release, file)
    }

    fun clearReady(deleteApk: Boolean = true) {
        val existing = loadReady()
        preferences.edit(commit = true) {
            remove(KEY_READY_RELEASE)
            remove(KEY_READY_FILE)
        }
        if (deleteApk) existing?.apk?.delete()
    }

    fun validate() {
        if (!directory.isDirectory) throw IllegalStateException("The native update directory is unavailable.")
        preferences.getString(KEY_READY_FILE, null)?.let { fileName ->
            require(READY_FILE_PATTERN.matches(fileName))
            require(File(directory, fileName).canonicalFile.parentFile == directory.canonicalFile)
        }
        require(highestVersionCode >= 0)
    }

    fun reset() {
        preferences.edit(commit = true) { clear() }
        directory.listFiles()?.forEach { file ->
            if (file.isFile && (file.name.endsWith(".apk") || file.name.endsWith(".partial"))) {
                file.delete()
            }
        }
        val legacy = File(context.noBackupFilesDir, LEGACY_DIRECTORY)
        legacy.listFiles()?.forEach { file ->
            if (file.isFile && (file.name.endsWith(".apk") || file.name.endsWith(".partial"))) {
                file.delete()
            }
        }
    }

    private companion object {
        const val PREFERENCES = "codever-native-update-v2"
        const val DIRECTORY = "native-update-v2"
        const val LEGACY_DIRECTORY = "native-update-v1"
        const val KEY_HIGHEST_VERSION_CODE = "highest-version-code"
        const val KEY_ACCEPTED_RELEASE = "accepted-release"
        const val KEY_READY_RELEASE = "ready-release"
        const val KEY_READY_FILE = "ready-file"
        val READY_FILE_PATTERN = Regex("^[1-9][0-9]{0,10}\\.apk$")
    }
}
