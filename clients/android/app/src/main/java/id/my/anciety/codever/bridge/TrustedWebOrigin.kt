package id.my.anciety.codever.bridge

import java.net.URI

object TrustedWebOrigin {
    const val APP_ORIGIN = "https://rd.anciety.my.id"
    const val APP_URL = "$APP_ORIGIN/"

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
        uri.scheme.equals("https", ignoreCase = true) &&
            uri.host.equals("rd.anciety.my.id", ignoreCase = true) &&
            (uri.port == -1 || uri.port == 443) &&
            uri.rawUserInfo == null

    private fun parse(candidate: String?): URI? {
        if (candidate.isNullOrBlank()) return null
        return runCatching { URI(candidate) }.getOrNull()
    }
}
