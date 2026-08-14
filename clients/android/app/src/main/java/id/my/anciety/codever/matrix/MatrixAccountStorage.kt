package id.my.anciety.codever.matrix

import android.content.Context
import id.my.anciety.codever.security.SecretCipher
import java.io.File

data class MatrixAccountFiles(
    val accountScope: String,
    val sessionStore: MatrixSessionStore,
    val applicationControlCursor: MatrixSyncCursorStore,
    val sdkDataPath: String,
    val sdkCachePath: String,
)

class MatrixAccountStorage(
    context: Context,
    private val cipher: SecretCipher,
) {
    private val root = File(context.noBackupFilesDir, "matrix-native-v2")
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
        files.applicationControlCursor.clear()
        MatrixAccountWiper.deleteSdkAccountRoot(sdkRoot, files.accountScope)
        sdkRoot.listFiles()?.takeIf { it.isEmpty() }?.let { sdkRoot.delete() }
    }

    private fun scoped(accountScope: String): MatrixAccountFiles {
        require(ACCOUNT_SCOPE.matches(accountScope)) { "Matrix account scope is invalid." }
        root.mkdirsOrThrow()
        val accountRoot = File(sdkRoot, accountScope)
        val data = File(accountRoot, "data").apply { mkdirsOrThrow() }
        val cache = MatrixAccountCache.prepare(accountRoot)
        return MatrixAccountFiles(
            accountScope = accountScope,
            sessionStore = EncryptedMatrixSessionStore(
                File(root, "session-$accountScope.enc"),
                cipher,
                accountScope,
            ),
            applicationControlCursor = EncryptedMatrixSyncCursorStore(
                File(root, "control-sync-$accountScope.enc"),
                cipher,
                accountScope,
            ),
            sdkDataPath = data.absolutePath,
            sdkCachePath = cache.absolutePath,
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

internal object MatrixAccountCache {
    fun prepare(accountRoot: File): File {
        val canonicalAccountRoot = accountRoot.canonicalFile
        check(canonicalAccountRoot.isDirectory || canonicalAccountRoot.mkdirs()) {
            "Matrix SDK account storage could not be created."
        }
        val current = File(canonicalAccountRoot, CACHE_NAME).canonicalFile
        require(current.parentFile == canonicalAccountRoot) {
            "Matrix SDK cache escaped its account root."
        }
        check(current.isDirectory || current.mkdirs()) {
            "Matrix SDK cache could not be created."
        }
        return current
    }

    private const val CACHE_NAME = "cache"
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
