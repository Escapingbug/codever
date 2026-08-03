plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

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
        versionCode = 1
        versionName = "0.1.0"

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

    testImplementation("junit:junit:4.13.2")
}
