package id.my.anciety.codever.client

import android.content.Context
import id.my.anciety.codever.diagnostics.NativeDiagnosticLog
import id.my.anciety.codever.matrix.MatrixBootstrap
import id.my.anciety.codever.matrix.MatrixConnectionRuntime
import id.my.anciety.codever.matrix.MatrixDecryptedEvent
import id.my.anciety.codever.matrix.MatrixLoginTokenIssueResult
import id.my.anciety.codever.matrix.MatrixRuntimeStatus
import id.my.anciety.codever.matrix.MatrixTransportIdentity
import id.my.anciety.codever.matrix.PublicMatrixSession
import kotlinx.serialization.json.JsonObject

interface NativeMatrixObserver {
    fun onTransportReady(identity: MatrixTransportIdentity)
    fun onConvergenceRequired(reason: String)
    fun onDecryptedEvent(event: MatrixDecryptedEvent)
}

interface NativeMatrixPort {
    val status: MatrixRuntimeStatus
    fun setObserver(observer: NativeMatrixObserver?)
    fun start()
    fun publicSession(): PublicMatrixSession?
    suspend fun bootstrap(input: MatrixBootstrap): PublicMatrixSession
    suspend fun issueLoginToken(password: String?): MatrixLoginTokenIssueResult
    suspend fun sendRoomMessage(contentJson: String, rotateRoomKey: Boolean = false)
    /** Returns true only when Matrix reports that the room timeline start was reached. */
    suspend fun paginateRoomHistory(limit: Int): Boolean
    suspend fun sendApplicationControlEvent(contentJson: String, transactionId: String)
    suspend fun uploadMedia(mimeType: String, bytes: ByteArray): String
    suspend fun downloadMedia(url: String): ByteArray
    suspend fun profileProperty(userId: String, key: String): JsonObject?
    suspend fun stop(clearSession: Boolean)
    suspend fun revokeSession()
    suspend fun close()
}

class MatrixNativePort(context: Context) : NativeMatrixPort {
    @Volatile
    private var observer: NativeMatrixObserver? = null
    private val diagnostics = NativeDiagnosticLog.get(context)
    private val runtime = MatrixConnectionRuntime(
        context = context,
        diagnostics = diagnostics,
        onTransportReady = { identity -> observer?.onTransportReady(identity) },
        onConvergenceRequired = { reason -> observer?.onConvergenceRequired(reason) },
        onDecryptedEvent = { event -> observer?.onDecryptedEvent(event) },
    )

    override val status: MatrixRuntimeStatus get() = runtime.status

    override fun setObserver(observer: NativeMatrixObserver?) {
        this.observer = observer
    }

    override fun start() = runtime.start()
    override fun publicSession(): PublicMatrixSession? = runtime.publicSession()
    override suspend fun bootstrap(input: MatrixBootstrap): PublicMatrixSession = runtime.bootstrap(input)
    override suspend fun issueLoginToken(password: String?): MatrixLoginTokenIssueResult =
        runtime.issueLoginToken(password)
    override suspend fun sendRoomMessage(contentJson: String, rotateRoomKey: Boolean) =
        runtime.sendRoomMessage(contentJson, rotateRoomKey)
    override suspend fun paginateRoomHistory(limit: Int): Boolean =
        runtime.paginateRoomHistory(limit)
    override suspend fun sendApplicationControlEvent(contentJson: String, transactionId: String) =
        runtime.sendApplicationControlEvent(contentJson, transactionId)
    override suspend fun uploadMedia(mimeType: String, bytes: ByteArray): String =
        runtime.uploadMedia(mimeType, bytes)
    override suspend fun downloadMedia(url: String): ByteArray = runtime.downloadMedia(url)
    override suspend fun profileProperty(userId: String, key: String): JsonObject? =
        runtime.profileProperty(userId, key)
    override suspend fun stop(clearSession: Boolean) = runtime.stop(clearSession)
    override suspend fun revokeSession() {
        runtime.revokeSession()
    }
    override suspend fun close() = runtime.close()
}
