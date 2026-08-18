package id.my.anciety.codever.client

import android.content.Context
import id.my.anciety.codever.diagnostics.NativeDiagnosticLog
import id.my.anciety.codever.matrix.MatrixBootstrap
import id.my.anciety.codever.matrix.MatrixConnectionRuntime
import id.my.anciety.codever.matrix.MatrixDecryptedEvent
import id.my.anciety.codever.matrix.MatrixLoginTokenIssueResult
import id.my.anciety.codever.matrix.MatrixSessionDirectoryLocator
import id.my.anciety.codever.matrix.MatrixThreadHistoryBatch
import id.my.anciety.codever.matrix.MatrixRuntimeStatus
import id.my.anciety.codever.matrix.MatrixTransportIdentity
import id.my.anciety.codever.matrix.PublicMatrixSession
import kotlinx.serialization.json.JsonObject

interface NativeMatrixObserver {
    /** Megolm and the bound Matrix identity are ready for the pairing channel. */
    fun onPairingTransportReady(identity: MatrixTransportIdentity)

    /** The independent application-control receiver is ready for trusted commands. */
    fun onTransportReady(identity: MatrixTransportIdentity)
    fun onConvergenceRequired(reason: String)
    suspend fun onDecryptedEvent(event: MatrixDecryptedEvent)
    suspend fun onAuthoritativeGatewayState(
        event: MatrixDecryptedEvent,
    ): MatrixSessionDirectoryLocator {
        throw UnsupportedOperationException("Matrix session-directory decoding is unavailable.")
    }
    suspend fun onAuthoritativeRoomState(events: List<MatrixDecryptedEvent>) {
        for (event in events) onDecryptedEvent(event)
    }
}

interface NativeMatrixPort {
    val status: MatrixRuntimeStatus
    val commandTransportReady: Boolean
    fun setObserver(observer: NativeMatrixObserver?)
    fun start()
    fun publicSession(): PublicMatrixSession?
    suspend fun bootstrap(input: MatrixBootstrap): PublicMatrixSession
    suspend fun issueLoginToken(password: String?): MatrixLoginTokenIssueResult
    suspend fun sendPairingMessage(contentJson: String)
    suspend fun closePairingChannel()
    suspend fun loadThreadHistory(
        threadRootEventId: String,
        from: String?,
        limit: Int,
    ): MatrixThreadHistoryBatch
    suspend fun sendApplicationControlEvent(contentJson: String, transactionId: String)
    suspend fun refreshApplicationRoomState()
    suspend fun uploadMedia(mimeType: String, bytes: ByteArray): String
    suspend fun downloadMedia(url: String): ByteArray
    suspend fun profileProperty(userId: String, key: String): JsonObject?
    suspend fun stop(clearSession: Boolean)
    suspend fun revokeSession()
    suspend fun close()

    fun injectNetworkAvailabilityForE2e(available: Boolean) {
        throw UnsupportedOperationException("Synthetic Matrix networking is unavailable.")
    }
}

class MatrixNativePort(context: Context) : NativeMatrixPort {
    @Volatile
    private var observer: NativeMatrixObserver? = null
    private val diagnostics = NativeDiagnosticLog.get(context)
    private val runtime = MatrixConnectionRuntime(
        context = context,
        diagnostics = diagnostics,
        onPairingTransportReady = { identity -> observer?.onPairingTransportReady(identity) },
        onTransportReady = { identity -> observer?.onTransportReady(identity) },
        onConvergenceRequired = { reason -> observer?.onConvergenceRequired(reason) },
        onDecryptedEvent = { event -> observer?.onDecryptedEvent(event) },
        onAuthoritativeGatewayState = { event ->
            observer?.onAuthoritativeGatewayState(event)
                ?: throw IllegalStateException("The native Matrix observer is unavailable.")
        },
        onAuthoritativeRoomState = { events -> observer?.onAuthoritativeRoomState(events) },
    )

    override val status: MatrixRuntimeStatus get() = runtime.status
    override val commandTransportReady: Boolean get() = runtime.commandTransportReady

    override fun setObserver(observer: NativeMatrixObserver?) {
        this.observer = observer
    }

    override fun start() = runtime.start()
    override fun publicSession(): PublicMatrixSession? = runtime.publicSession()
    override suspend fun bootstrap(input: MatrixBootstrap): PublicMatrixSession = runtime.bootstrap(input)
    override suspend fun issueLoginToken(password: String?): MatrixLoginTokenIssueResult =
        runtime.issueLoginToken(password)
    override suspend fun sendPairingMessage(contentJson: String) =
        runtime.sendPairingMessage(contentJson)
    override suspend fun closePairingChannel() = runtime.closePairingChannel()
    override suspend fun loadThreadHistory(
        threadRootEventId: String,
        from: String?,
        limit: Int,
    ): MatrixThreadHistoryBatch = runtime.loadThreadHistory(threadRootEventId, from, limit)
    override suspend fun sendApplicationControlEvent(contentJson: String, transactionId: String) =
        runtime.sendApplicationControlEvent(contentJson, transactionId)
    override suspend fun refreshApplicationRoomState() = runtime.refreshApplicationRoomState()
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
    override fun injectNetworkAvailabilityForE2e(available: Boolean) =
        runtime.injectNetworkAvailabilityForE2e(available)
}
