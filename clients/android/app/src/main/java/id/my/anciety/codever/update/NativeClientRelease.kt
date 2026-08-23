package id.my.anciety.codever.update

import java.net.URI
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

enum class NativeUpdateImportance(val wireName: String) {
    RECOMMENDED("recommended"),
    REQUIRED("required");

    companion object {
        fun fromWire(value: String): NativeUpdateImportance = entries.firstOrNull {
            it.wireName == value
        } ?: throw NativeClientReleaseException("release_importance_unsupported")
    }
}

data class NativeUpdateArtifact(
    val url: String,
    val size: Long,
    val sha256: String,
    val signingCertificateSha256: String,
)

data class NativeClientRelease(
    val channel: String,
    val publishedAt: Long,
    val architecture: String,
    val packageName: String,
    val versionCode: Long,
    val versionName: String,
    val buildId: String,
    val minimumAndroid: Int,
    val nativeBridgeMinimum: Int,
    val nativeBridgeMaximum: Int,
    val importance: NativeUpdateImportance,
    val releaseNotes: List<String>,
    val artifact: NativeUpdateArtifact,
    val encoded: String,
)

class NativeClientReleaseException(val detailCode: String) : IllegalArgumentException(detailCode)

/** Parses the latest release already authenticated by the CVP Gateway snapshot. */
class NativeClientReleaseParser(
    private val trustedOrigin: URI,
    private val allowLoopbackHttp: Boolean = false,
) {
    private val json = Json { isLenient = false; explicitNulls = false }

    fun parse(text: String): NativeClientRelease = parse(parseObject(text))

    fun parse(value: JsonObject): NativeClientRelease {
        requireExactKeys(
            value,
            setOf(
                "platform",
                "channel",
                "architecture",
                "packageName",
                "versionCode",
                "versionName",
                "buildId",
                "publishedAt",
                "minimumAndroid",
                "nativeBridgeMinimum",
                "nativeBridgeMaximum",
                "importance",
                "releaseNotes",
                "artifact",
            ),
            "release_shape_invalid",
        )
        if (requireString(value, "platform", 32) != "android") {
            throw NativeClientReleaseException("release_platform_unsupported")
        }
        val channel = requireString(value, "channel", 32)
        if (!CHANNEL_PATTERN.matches(channel)) {
            throw NativeClientReleaseException("release_channel_invalid")
        }
        val versionCode = requireLong(value, "versionCode", 1, 2_100_000_000)
        val bridgeMinimum = requireInteger(value, "nativeBridgeMinimum", 1, 1_000)
        val bridgeMaximum = requireInteger(value, "nativeBridgeMaximum", 1, 1_000)
        if (bridgeMinimum > bridgeMaximum) {
            throw NativeClientReleaseException("release_bridge_range_invalid")
        }
        val architecture = requireString(value, "architecture", 32)
        if (architecture != "arm64-v8a") {
            throw NativeClientReleaseException("release_architecture_unsupported")
        }
        val notes = requireArray(value, "releaseNotes", MAX_RELEASE_NOTES).mapIndexed { index, item ->
            val primitive = item as? JsonPrimitive
                ?: throw NativeClientReleaseException("release_note_${index}_invalid")
            primitive.takeIf { it.isString }?.contentOrNull
                ?.takeIf { it.isNotBlank() && it.length <= MAX_RELEASE_NOTE_LENGTH }
                ?: throw NativeClientReleaseException("release_note_${index}_invalid")
        }
        val artifactValue = value["artifact"]?.let { runCatching { it.jsonObject }.getOrNull() }
            ?: throw NativeClientReleaseException("release_artifact_missing")
        requireExactKeys(
            artifactValue,
            setOf("url", "size", "sha256", "signingCertificateSha256"),
            "release_artifact_shape_invalid",
        )
        val artifactUri = runCatching { URI(requireString(artifactValue, "url", 2_048)) }
            .getOrElse { throw NativeClientReleaseException("release_artifact_url_invalid") }
        validateArtifactUri(artifactUri, channel, versionCode)
        val sha256 = requireString(artifactValue, "sha256", 64).lowercase()
        val certificate = requireString(
            artifactValue,
            "signingCertificateSha256",
            64,
        ).lowercase()
        if (!SHA256_PATTERN.matches(sha256) || !SHA256_PATTERN.matches(certificate)) {
            throw NativeClientReleaseException("release_artifact_digest_invalid")
        }
        return NativeClientRelease(
            channel = channel,
            publishedAt = requireLong(value, "publishedAt", 1, Long.MAX_VALUE),
            architecture = architecture,
            packageName = requireString(value, "packageName", 256),
            versionCode = versionCode,
            versionName = requireString(value, "versionName", 256),
            buildId = requireString(value, "buildId", 256),
            minimumAndroid = requireInteger(value, "minimumAndroid", 21, 10_000),
            nativeBridgeMinimum = bridgeMinimum,
            nativeBridgeMaximum = bridgeMaximum,
            importance = NativeUpdateImportance.fromWire(requireString(value, "importance", 32)),
            releaseNotes = notes,
            artifact = NativeUpdateArtifact(
                url = artifactUri.toASCIIString(),
                size = requireLong(artifactValue, "size", 1, MAX_APK_BYTES),
                sha256 = sha256,
                signingCertificateSha256 = certificate,
            ),
            encoded = value.toString(),
        )
    }

    private fun validateArtifactUri(uri: URI, channel: String, versionCode: Long) {
        if (uri.userInfo != null || uri.query != null || uri.fragment != null) {
            throw NativeClientReleaseException("release_artifact_url_components_invalid")
        }
        val loopback = allowLoopbackHttp &&
            uri.scheme == "http" && uri.host == "127.0.0.1" && uri.port in 1..65_535
        val trusted = uri.scheme == "https" &&
            uri.host == trustedOrigin.host && normalizedPort(uri) == normalizedPort(trustedOrigin)
        if (!loopback && !trusted) {
            throw NativeClientReleaseException("release_artifact_origin_untrusted")
        }
        val expectedPrefix = "/native-updates/releases/android/$channel/$versionCode/"
        if (!uri.path.startsWith(expectedPrefix) || uri.path.substringAfterLast('/').isBlank()) {
            throw NativeClientReleaseException("release_artifact_path_invalid")
        }
    }

    private fun parseObject(text: String): JsonObject = runCatching {
        json.parseToJsonElement(text).jsonObject
    }.getOrElse { throw NativeClientReleaseException("release_json_invalid") }

    private fun requireExactKeys(value: JsonObject, keys: Set<String>, detail: String) {
        if (value.keys != keys) throw NativeClientReleaseException(detail)
    }

    private fun requireString(value: JsonObject, name: String, maxLength: Int): String =
        value[name]?.let { runCatching { it.jsonPrimitive }.getOrNull() }
            ?.takeIf { it.isString }?.contentOrNull
            ?.takeIf { it.isNotBlank() && it.length <= maxLength }
            ?: throw NativeClientReleaseException("release_${name}_invalid")

    private fun requireInteger(
        value: JsonObject,
        name: String,
        minimum: Int,
        maximum: Int,
    ): Int = value[name]?.let { runCatching { it.jsonPrimitive.intOrNull }.getOrNull() }
        ?.takeIf { it in minimum..maximum }
        ?: throw NativeClientReleaseException("release_${name}_invalid")

    private fun requireLong(value: JsonObject, name: String, minimum: Long, maximum: Long): Long =
        value[name]?.let { runCatching { it.jsonPrimitive.longOrNull }.getOrNull() }
            ?.takeIf { it in minimum..maximum }
            ?: throw NativeClientReleaseException("release_${name}_invalid")

    private fun requireArray(value: JsonObject, name: String, maximum: Int): JsonArray =
        value[name]?.let { runCatching { it.jsonArray }.getOrNull() }
            ?.takeIf { it.size <= maximum }
            ?: throw NativeClientReleaseException("release_${name}_invalid")

    private fun normalizedPort(uri: URI): Int = when {
        uri.port >= 0 -> uri.port
        uri.scheme == "https" -> 443
        uri.scheme == "http" -> 80
        else -> -1
    }

    companion object {
        const val MAX_APK_BYTES = 100L * 1024 * 1024
        private const val MAX_RELEASE_NOTES = 20
        private const val MAX_RELEASE_NOTE_LENGTH = 500
        private val CHANNEL_PATTERN = Regex("^[a-z][a-z0-9-]{0,31}$")
        private val SHA256_PATTERN = Regex("^[0-9a-f]{64}$")
    }
}
