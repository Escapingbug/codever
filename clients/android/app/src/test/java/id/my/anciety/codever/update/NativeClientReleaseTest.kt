package id.my.anciety.codever.update

import java.net.URI
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeClientReleaseTest {
    @Test
    fun `an accepted release resumes after process death until the APK is actually ready`() {
        val interrupted = NativeUpdateStatus(
            phase = NativeUpdatePhase.CURRENT,
            currentVersionCode = 41,
            currentVersionName = "41",
        )
        assertFalse(canReusePublishedReleaseStatus(42, 41, interrupted))

        val installed = interrupted.copy(currentVersionCode = 42)
        assertTrue(canReusePublishedReleaseStatus(42, 42, installed))

        val ready = interrupted.copy(
            phase = NativeUpdatePhase.READY,
            latestVersionCode = 42,
        )
        assertTrue(canReusePublishedReleaseStatus(42, 41, ready))
        assertFalse(canReusePublishedReleaseStatus(43, 41, ready))
    }

    private val parser = NativeClientReleaseParser(URI("https://updates.example"))

    @Test
    fun `parses Gateway-published immutable Android release`() {
        val release = parser.parse(releaseJson())

        assertEquals(42L, release.versionCode)
        assertEquals("alpha", release.channel)
        assertEquals(
            "https://updates.example/native-updates/releases/android/alpha/42/codever.apk",
            release.artifact.url,
        )
    }

    @Test
    fun `rejects artifact outside the deployment origin`() {
        val external = releaseJson().replace("https://updates.example", "https://attacker.example")

        assertThrows(NativeClientReleaseException::class.java) {
            parser.parse(external)
        }
    }

    @Test
    fun `rejects artifact outside immutable release path`() {
        val unsafe = releaseJson().replace(
            "/native-updates/releases/android/alpha/42/codever.apk",
            "/native-updates/channels/alpha/codever.apk",
        )

        assertThrows(NativeClientReleaseException::class.java) {
            parser.parse(unsafe)
        }
    }

    @Test
    fun `policy rejects account-state rollback but accepts same release retry`() {
        val release = parser.parse(releaseJson())
        assertEquals(
            NativeUpdateDecision.Download,
            NativeUpdatePolicy.decide(
                release,
                highestVersionCode = release.versionCode,
                currentVersionCode = 41,
                currentPackageName = "id.my.anciety.codever",
                currentBridgeVersion = 1,
                currentAndroidApi = 36,
                supportedAbis = setOf("arm64-v8a"),
            ),
        )
        assertThrows(NativeClientReleaseException::class.java) {
            NativeUpdatePolicy.decide(
                release,
                highestVersionCode = release.versionCode + 1,
                currentVersionCode = 41,
                currentPackageName = "id.my.anciety.codever",
                currentBridgeVersion = 1,
                currentAndroidApi = 36,
                supportedAbis = setOf("arm64-v8a"),
            )
        }
    }

    private fun releaseJson() = """{
        "platform":"android",
        "channel":"alpha",
        "architecture":"arm64-v8a",
        "packageName":"id.my.anciety.codever",
        "versionCode":42,
        "versionName":"0.1.0-alpha.42",
        "buildId":"android-alpha-42",
        "publishedAt":1787400000000,
        "minimumAndroid":31,
        "nativeBridgeMinimum":1,
        "nativeBridgeMaximum":1,
        "importance":"recommended",
        "releaseNotes":[],
        "artifact":{
            "url":"https://updates.example/native-updates/releases/android/alpha/42/codever.apk",
            "size":1234,
            "sha256":"${"a".repeat(64)}",
            "signingCertificateSha256":"${"b".repeat(64)}"
        }
    }""".trimIndent()
}
