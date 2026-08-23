package id.my.anciety.codever.update

import java.io.File
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URI

internal class NativeUpdateHttpClient(
    private val connectTimeoutMs: Int = 15_000,
    private val readTimeoutMs: Int = 30_000,
) {
    fun download(
        uri: URI,
        target: File,
        expectedBytes: Long,
        onProgress: (downloaded: Long) -> Unit,
    ) {
        require(expectedBytes in 1..NativeClientReleaseParser.MAX_APK_BYTES)
        target.parentFile?.mkdirs()
        var offset = target.takeIf(File::isFile)?.length() ?: 0L
        if (offset < 0 || offset > expectedBytes) {
            target.delete()
            offset = 0
        }
        val connection = open(uri)
        try {
            if (offset > 0) connection.setRequestProperty("Range", "bytes=$offset-")
            val response = connection.responseCode
            val append = offset > 0 && response == HttpURLConnection.HTTP_PARTIAL
            if (response != HttpURLConnection.HTTP_OK && !append) {
                throw NativeUpdateDownloadException("artifact_http_$response")
            }
            if (!append) offset = 0
            val advertised = connection.contentLengthLong
            if (advertised > expectedBytes || (advertised >= 0 && offset + advertised > expectedBytes)) {
                throw NativeUpdateDownloadException("artifact_size_exceeded")
            }
            RandomAccessFile(target, "rw").use { output ->
                if (append) output.seek(offset) else output.setLength(0)
                connection.inputStream.use { input ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    var total = offset
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        total += count
                        if (total > expectedBytes) throw NativeUpdateDownloadException("artifact_size_exceeded")
                        output.write(buffer, 0, count)
                        onProgress(total)
                    }
                    output.fd.sync()
                }
            }
            if (target.length() != expectedBytes) {
                throw NativeUpdateDownloadException("artifact_size_mismatch")
            }
        } finally {
            connection.disconnect()
        }
    }

    private fun open(uri: URI): HttpURLConnection = (uri.toURL().openConnection() as HttpURLConnection).apply {
        instanceFollowRedirects = false
        useCaches = false
        connectTimeout = connectTimeoutMs
        readTimeout = readTimeoutMs
        setRequestProperty("User-Agent", "CodeverNativeUpdater/1")
    }
}

internal class NativeUpdateDownloadException(val detailCode: String) : Exception(detailCode)
