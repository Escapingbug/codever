import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val codeverAndroidRoot = rootProject.projectDir

fun gitOutput(vararg arguments: String): String? = runCatching {
    val process = ProcessBuilder("git", *arguments)
        .directory(codeverAndroidRoot)
        .redirectErrorStream(true)
        .start()
    val output = process.inputStream.bufferedReader().use { it.readText() }.trim()
    if (process.waitFor() == 0) output else null
}.getOrNull()

val androidBaseVersion = "0.1.0"
val androidVersionCodeEpochMillis = 1_577_836_800_000L // 2020-01-01T00:00:00Z
val configuredBuildEpochMillis =
    providers.environmentVariable("CODEVER_ANDROID_BUILD_EPOCH_MS").orNull
val buildEpochMillis = configuredBuildEpochMillis?.toLongOrNull()
    ?: System.currentTimeMillis()
require(configuredBuildEpochMillis == null || configuredBuildEpochMillis.toLongOrNull() != null) {
    "CODEVER_ANDROID_BUILD_EPOCH_MS must be an integer Unix timestamp in milliseconds."
}
val androidVersionCode = ((buildEpochMillis - androidVersionCodeEpochMillis) / 1_000L) + 1L
require(androidVersionCode in 1L..2_100_000_000L) {
    "Android versionCode must be between 1 and 2100000000; build timestamp was $buildEpochMillis."
}
val sourceRevision = gitOutput("rev-parse", "--short=8", "HEAD")
    ?.takeIf { it.matches(Regex("[0-9a-fA-F]{8}")) }
    ?.lowercase()
    ?: "unknown"
val sourceDirty = gitOutput("status", "--short", "--untracked-files=no")
    ?.isNotBlank()
    ?: true
val sourceLabel = "$sourceRevision${if (sourceDirty) ".dirty" else ""}"
val buildTimestamp = DateTimeFormatter
    .ofPattern("yyyyMMdd'T'HHmmssSSS'Z'")
    .withZone(ZoneOffset.UTC)
    .format(Instant.ofEpochMilli(buildEpochMillis))
val androidVersionName = "$androidBaseVersion-dev.$buildTimestamp+$sourceLabel"
val androidNativeBuildId = "android-$buildTimestamp-$sourceLabel"
val productionWebOrigin = "https://rd.anciety.my.id"
val e2eWebOrigin = providers.environmentVariable("CODEVER_ANDROID_E2E_WEB_ORIGIN")
    .orNull
    ?.also { configured ->
        require(configured.matches(Regex("http://127\\.0\\.0\\.1:[1-9][0-9]{0,4}"))) {
            "CODEVER_ANDROID_E2E_WEB_ORIGIN must be an explicit loopback HTTP origin with a port."
        }
        val port = configured.substringAfterLast(':').toInt()
        require(port in 1..65535) {
            "CODEVER_ANDROID_E2E_WEB_ORIGIN contains an invalid port."
        }
    }
    ?: "http://127.0.0.1:4173"

android {
    namespace = "id.my.anciety.codever"
    compileSdk = 36

    defaultConfig {
        applicationId = "id.my.anciety.codever"
        // The Codever application identity is one non-exportable P-256
        // Android Keystore key used for both ES256 signing and ECDH. Android
        // exposes PURPOSE_AGREE_KEY only from API 31; older devices must not
        // fall back to an exportable software private key.
        minSdk = 31
        targetSdk = 36
        // Every produced APK carries a visible, monotonic install version and
        // an exact build identity. CODEVER_ANDROID_BUILD_EPOCH_MS can pin both
        // values for a reproducible CI/release build.
        versionCode = androidVersionCode.toInt()
        versionName = androidVersionName
        buildConfigField("String", "NATIVE_BUILD_ID", "\"$androidNativeBuildId\"")
        buildConfigField("String", "APP_ORIGIN", "\"$productionWebOrigin\"")
        buildConfigField("boolean", "ALLOW_INSECURE_E2E_LOOPBACK", "false")

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        ndk {
            // The first distributed APK targets modern Android hardware. Keep
            // x86/x86_64 out of release artifacts because the Matrix SDK AAR is
            // otherwise very large. The installed local emulator is arm64.
            abiFilters += "arm64-v8a"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
        create("e2e") {
            initWith(getByName("debug"))
            applicationIdSuffix = ".e2e"
            versionNameSuffix = "-e2e"
            buildConfigField("String", "APP_ORIGIN", "\"$e2eWebOrigin\"")
            buildConfigField("boolean", "ALLOW_INSECURE_E2E_LOOPBACK", "true")
            matchingFallbacks += listOf("debug")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    lint {
        // The first APK is intentionally arm64-only; the Matrix FFI binary is
        // large and this is not a ChromeOS distribution artifact.
        disable += "ChromeOsAbiSupport"
    }

    packaging {
        jniLibs {
            // Telegram delivery is capped at 50 MiB. Compress the Matrix FFI
            // library in the APK and let Android extract it during install.
            useLegacyPackaging = true
        }
        resources.excludes += setOf(
            "META-INF/AL2.0",
            "META-INF/LGPL2.1",
        )
    }
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.webkit:webkit:1.16.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")

    // Fixed so native login/session restore, E2EE storage, timeline decryption,
    // ABI, and packaging compatibility are continuously exercised together.
    implementation("org.matrix.rustcomponents:sdk-android:26.07.28")

    // sdk-android 26.07.28 links rustls-platform-verifier 0.6.2 but its AAR
    // does not publish the companion Android verifier as a transitive
    // dependency. Without this JVM component every native TLS request fails
    // before reaching the server.
    implementation(project(":rustls-platform-verifier"))

    testImplementation("junit:junit:4.13.2")
}
