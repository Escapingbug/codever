package id.my.anciety.codever.matrix

import android.content.Context
import id.my.anciety.codever.security.SecretCipher
import java.io.File

data class MatrixAccountFiles(
    val accountScope: String,
    val sessionStore: MatrixSessionStore,
    val journal: DecryptedEventJournal,
    val applicationControlCursor: MatrixSyncCursorStore,
    val sdkDataPath: String,
    val sdkCachePath: String,
    val sdkCacheMigrated: Boolean,
)

class MatrixAccountStorage(
    context: Context,
    private val cipher: SecretCipher,
) {
    private val root = File(context.noBackupFilesDir, "matrix-native-v1")
    private val sdkRoot = File(root, "sdk")

    fun findCurrent(): MatrixAccountFiles? {
        val accountScopes = root.listFiles().orEmpty().mapNotNull { file ->
            file.takeIf(File::isFile)?.let { SESSION_FILE.matchEntire(it.name)?.groupValues?.get(1) }
        }.toSet()
        check(accountScopes.size <= 1) { "Multiple native Matrix sessions require explicit recovery." }
        val accountScope = accountScopes.singleOrNull() ?: return null
        return scoped(accountScope)
    }

    fun forSession(session: StoredMatrixSession): MatrixAccountFiles = scoped(
        MatrixIdentifiers.accountStoreName(session.homeserverUrl, session.userId),
    )

    fun clear(files: MatrixAccountFiles) {
        require(ACCOUNT_SCOPE.matches(files.accountScope)) { "Matrix account scope is invalid." }
        files.sessionStore.clear()
        files.journal.clear()
        files.applicationControlCursor.clear()
        MatrixAccountWiper.deleteSdkAccountRoot(sdkRoot, files.accountScope)
        sdkRoot.listFiles()?.takeIf { it.isEmpty() }?.let { sdkRoot.delete() }
    }

    private fun scoped(accountScope: String): MatrixAccountFiles {
        require(ACCOUNT_SCOPE.matches(accountScope)) { "Matrix account scope is invalid." }
        root.mkdirsOrThrow()
        val accountRoot = File(sdkRoot, accountScope)
        val data = File(accountRoot, "data").apply { mkdirsOrThrow() }
        val cache = MatrixAccountCacheMigration.prepare(accountRoot)
        return MatrixAccountFiles(
            accountScope = accountScope,
            sessionStore = EncryptedMatrixSessionStore(
                File(root, "session-$accountScope.enc"),
                cipher,
                accountScope,
            ),
            journal = EncryptedBoundedEventJournal(
                File(root, "journal-$accountScope.enc"),
                cipher,
                accountScope,
            ),
            applicationControlCursor = EncryptedMatrixSyncCursorStore(
                File(root, "control-sync-$accountScope.enc"),
                cipher,
                accountScope,
            ),
            sdkDataPath = data.absolutePath,
            sdkCachePath = cache.directory.absolutePath,
            sdkCacheMigrated = cache.migrated,
        )
    }

    private fun File.mkdirsOrThrow() {
        check(isDirectory || mkdirs()) { "Native Matrix storage could not be created." }
    }

    private companion object {
        val ACCOUNT_SCOPE = Regex("^[0-9a-f]{64}$")
        val SESSION_FILE = Regex("^session-([0-9a-f]{64})\\.enc(?:\\.bak)?$")
    }
}

internal data class MatrixCachePreparation(
    val directory: File,
    val migrated: Boolean,
)

/**
 * Rotates only disposable SDK cache state. The data directory contains the
 * Matrix device and crypto store and must survive an APK transport upgrade.
 */
internal object MatrixAccountCacheMigration {
    fun prepare(accountRoot: File): MatrixCachePreparation {
        val canonicalAccountRoot = accountRoot.canonicalFile
        check(canonicalAccountRoot.isDirectory || canonicalAccountRoot.mkdirs()) {
            "Matrix SDK account storage could not be created."
        }
        val obsolete = OBSOLETE_CACHE_NAMES.map { name ->
            File(canonicalAccountRoot, name).canonicalFile
        }
        val current = File(canonicalAccountRoot, CURRENT_CACHE_NAME).canonicalFile
        require(
            obsolete.all { it.parentFile == canonicalAccountRoot } &&
                current.parentFile == canonicalAccountRoot
        ) {
            "Matrix SDK cache escaped its account root."
        }
        val migrated = obsolete.any(File::exists)
        obsolete.forEach { directory ->
            check(!directory.exists() || directory.deleteRecursively()) {
                "Legacy Matrix SDK cache could not be removed."
            }
        }
        check(current.isDirectory || current.mkdirs()) {
            "Matrix SDK cache could not be created."
        }
        return MatrixCachePreparation(current, migrated)
    }

    private val OBSOLETE_CACHE_NAMES = listOf("cache", "cache-v2")
    private const val CURRENT_CACHE_NAME = "cache-v3"
}

internal object MatrixAccountWiper {
    private val accountScopePattern = Regex("^[0-9a-f]{64}$")

    fun deleteSdkAccountRoot(sdkRoot: File, accountScope: String) {
        require(accountScopePattern.matches(accountScope)) { "Matrix account scope is invalid." }
        val canonicalSdkRoot = sdkRoot.canonicalFile
        val canonicalAccountRoot = File(canonicalSdkRoot, accountScope).canonicalFile
        require(canonicalAccountRoot.parentFile == canonicalSdkRoot) {
            "Matrix SDK storage escaped its account root."
        }
        check(!canonicalAccountRoot.exists() || canonicalAccountRoot.deleteRecursively()) {
            "Matrix SDK credentials could not be removed."
        }
    }
}
