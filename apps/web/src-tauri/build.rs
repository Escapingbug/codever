use std::{
    env, fs,
    path::{Path, PathBuf},
};

fn main() {
    if let Some(project) = env::var_os("TAURI_ANDROID_PROJECT_PATH") {
        configure_android_activity(Path::new(&project));
    }
    tauri_build::build()
}

fn configure_android_activity(project: &Path) {
    let java = project.join("app/src/main/java");
    let activity =
        find_file(&java, "MainActivity.kt").expect("Android MainActivity.kt was not generated");
    println!("cargo:rerun-if-changed={}", activity.display());
    let mut source = fs::read_to_string(&activity).expect("failed to read Android MainActivity");
    source = source
        .replace("import androidx.activity.enableEdgeToEdge", "")
        .replace("    enableEdgeToEdge()", "");
    if !source.contains("import io.crates.keyring.Keyring") {
        source = source.replace(
            "import android.os.Bundle",
            "import android.os.Bundle\nimport io.crates.keyring.Keyring",
        );
    }
    if !source.contains("import androidx.core.view.WindowCompat") {
        source = source.replace(
            "import android.os.Bundle",
            "import android.os.Bundle\nimport androidx.core.view.WindowCompat",
        );
    }
    if !source.contains("import android.view.View") {
        source = source.replace(
            "import android.os.Bundle",
            "import android.os.Bundle\nimport android.view.View\nimport androidx.core.view.ViewCompat\nimport androidx.core.view.WindowInsetsCompat",
        );
    }
    if !source.contains("Keyring.initializeNdkContext(applicationContext)") {
        source = source.replace(
            "  override fun onCreate(savedInstanceState: Bundle?) {",
            "  override fun onCreate(savedInstanceState: Bundle?) {\n    Keyring.initializeNdkContext(applicationContext)",
        );
    }
    if !source.contains("WindowCompat.setDecorFitsSystemWindows") {
        source = source.replace(
            "    super.onCreate(savedInstanceState)",
            "    super.onCreate(savedInstanceState)\n    WindowCompat.setDecorFitsSystemWindows(window, true)\n    WindowCompat.getInsetsController(window, window.decorView).apply {\n      isAppearanceLightStatusBars = false\n      isAppearanceLightNavigationBars = false\n    }",
        );
    }
    if !source.contains("WindowInsetsCompat.Type.systemBars()") {
        source = source.replace(
            "    WindowCompat.setDecorFitsSystemWindows(window, true)",
            "    WindowCompat.setDecorFitsSystemWindows(window, true)\n    val contentView = findViewById<View>(android.R.id.content)\n    ViewCompat.setOnApplyWindowInsetsListener(contentView) { view, insets ->\n      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())\n      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)\n      insets\n    }\n    ViewCompat.requestApplyInsets(contentView)",
        );
    }
    assert!(
        !source.contains("enableEdgeToEdge()"),
        "Android edge-to-edge must remain disabled"
    );
    assert!(
        source.contains("WindowCompat.setDecorFitsSystemWindows(window, true)"),
        "Android fitted system bars were not configured"
    );
    assert!(
        source.contains("WindowInsetsCompat.Type.systemBars()"),
        "Android system bar insets were not applied"
    );
    fs::write(activity, source).expect("failed to configure Android MainActivity keyring context");

    let bridge = java.join("io/crates/keyring/Keyring.kt");
    fs::create_dir_all(bridge.parent().expect("keyring bridge parent"))
        .expect("failed to create Android keyring bridge directory");
    fs::write(
        bridge,
        r#"package io.crates.keyring

import android.content.Context

class Keyring {
  companion object {
    init {
      System.loadLibrary("codever_app_lib")
    }

    external fun initializeNdkContext(context: Context)
  }
}
"#,
    )
    .expect("failed to write Android keyring bridge");
}

fn find_file(directory: &Path, name: &str) -> Option<PathBuf> {
    for entry in fs::read_dir(directory).ok()? {
        let path = entry.ok()?.path();
        if path.is_dir() {
            if let Some(found) = find_file(&path, name) {
                return Some(found);
            }
        } else if path.file_name().is_some_and(|value| value == name) {
            return Some(path);
        }
    }
    None
}
