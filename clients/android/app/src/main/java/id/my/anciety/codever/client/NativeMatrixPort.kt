package id.my.anciety.codever.client

import android.content.Context
import id.my.anciety.codever.matrix.MatrixBootstrap
import id.my.anciety.codever.matrix.MatrixConnectionRuntime
import id.my.anciety.codever.matrix.MatrixDecryptedEvent
import id.my.anciety.codever.matrix.MatrixRuntimeStatus
import id.my.anciety.codever.matrix.MatrixTransportIdentity
import id.my.anciety.codever.matrix.PublicMatrixSession
import kotlinx.serialization.json.JsonObject

interface NativeMatrixObserver {
    fun onTransportReady(identity: MatrixTransportIdentity)
    fun onDecryptedEvent(event: MatrixDecryptedEvent)
}

interface NativeMatrixPort {
    val status: MatrixRuntimeStatus
    fun setObserver(observer: NativeMatrixObserver?)
    fun start()
    fun publicSession(): PublicMatrixSession?
    suspend fun bootstrap(input: MatrixBootstrap): PublicMatrixSession
    suspend fun sendRoomMessage(contentJson: String)
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
    private val runtime = MatrixConnectionRuntime(
        context = context,
        onTransportReady = { identity -> observer?.onTransportReady(identity) },
        onDecryptedEvent = { event -> observer?.onDecryptedEvent(event) },
    )

    override val status: MatrixRuntimeStatus get() = runtime.status

    override fun setObserver(observer: NativeMatrixObserver?) {
        this.observer = observer
    }

    override fun start() = runtime.start()
    override fun publicSession(): PublicMatrixSession? = runtime.publicSession()
    override suspend fun bootstrap(input: MatrixBootstrap): PublicMatrixSession = runtime.bootstrap(input)
    override suspend fun sendRoomMessage(contentJson: String) = runtime.sendRoomMessage(contentJson)
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
