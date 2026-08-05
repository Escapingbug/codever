# Matrix Rust SDK uses generated UniFFI/JNA bindings.
-keep class org.matrix.rustcomponents.** { *; }
-keep, includedescriptorclasses class org.rustls.platformverifier.** { *; }
-keep class uniffi.** { *; }
-keep class com.sun.jna.** { *; }
-dontwarn com.sun.jna.**
