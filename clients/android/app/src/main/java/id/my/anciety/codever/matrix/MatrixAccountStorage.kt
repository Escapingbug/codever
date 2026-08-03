package id.my.anciety.codever.matrix

import android.content.Context
import id.my.anciety.codever.security.SecretCipher
import java.io.File

data class MatrixAccountFiles(
    val accountScope: String,
    val sessionStore: MatrixSessionStore,
    val journal: DecryptedEventJournal,
    val sdkDataPath: String,
    val sdkCachePath: String,
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
        MatrixAccountWiper.deleteSdkAccountRoot(sdkRoot, files.accountScope)
        sdkRoot.listFiles()?.takeIf { it.isEmpty() }?.let { sdkRoot.delete() }
    }

    private fun scoped(accountScope: String): MatrixAccountFiles {
        require(ACCOUNT_SCOPE.matches(accountScope)) { "Matrix account scope is invalid." }
        root.mkdirsOrThrow()
        val data = File(sdkRoot, "$accountScope/data").apply { mkdirsOrThrow() }
        val cache = File(sdkRoot, "$accountScope/cache").apply { mkdirsOrThrow() }
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
