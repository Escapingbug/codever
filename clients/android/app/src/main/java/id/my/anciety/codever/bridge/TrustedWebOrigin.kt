package id.my.anciety.codever.bridge

import id.my.anciety.codever.BuildConfig
import java.net.URI

object TrustedWebOrigin {
    val APP_ORIGIN: String = BuildConfig.APP_ORIGIN
    val APP_URL: String = "$APP_ORIGIN/"
    private val trustedUri = requireNotNull(parse(APP_ORIGIN)) {
        "The configured Codever Web origin is invalid."
    }

    fun isTrustedOrigin(candidate: String?): Boolean {
        val uri = parse(candidate) ?: return false
        val path = uri.rawPath
        return isTrustedUri(uri) &&
            (path.isNullOrEmpty() || path == "/") &&
            uri.rawQuery == null &&
            uri.rawFragment == null
    }

    fun isTrustedUrl(candidate: String?): Boolean {
        val uri = parse(candidate) ?: return false
        return isTrustedUri(uri)
    }

    private fun isTrustedUri(uri: URI): Boolean =
        uri.scheme.equals(trustedUri.scheme, ignoreCase = true) &&
            uri.host.equals(trustedUri.host, ignoreCase = true) &&
            effectivePort(uri) == effectivePort(trustedUri) &&
            uri.rawUserInfo == null

    private fun effectivePort(uri: URI): Int = when {
        uri.port != -1 -> uri.port
        uri.scheme.equals("https", ignoreCase = true) -> 443
        uri.scheme.equals("http", ignoreCase = true) -> 80
        else -> -1
    }

    private fun parse(candidate: String?): URI? {
        if (candidate.isNullOrBlank()) return null
        return runCatching { URI(candidate) }.getOrNull()
    }
}
