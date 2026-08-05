plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "org.rustls.platformverifier"
    compileSdk = 36

    defaultConfig {
        minSdk = 31

        // The vendored production component never enables its FFI-only mock
        // trust store. This matches the release AAR published with crate 0.1.1.
        buildConfigField("boolean", "TEST", "false")
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
}
