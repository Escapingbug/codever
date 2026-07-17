use std::{env, fs, path::{Path, PathBuf}};

fn main() {
    if let Some(project) = env::var_os("TAURI_ANDROID_PROJECT_PATH") {
        configure_android_keyring(Path::new(&project));
    }
    tauri_build::build()
}

fn configure_android_keyring(project: &Path) {
    let java = project.join("app/src/main/java");
    let activity = find_file(&java, "MainActivity.kt")
        .expect("Android MainActivity.kt was not generated");
    let source = fs::read_to_string(&activity).expect("failed to read Android MainActivity");
    let source = if source.contains("Keyring.initializeNdkContext(applicationContext)") {
        source
    } else {
        source
            .replace(
                "import androidx.activity.enableEdgeToEdge",
                "import androidx.activity.enableEdgeToEdge\nimport io.crates.keyring.Keyring",
            )
            .replace(
                "  override fun onCreate(savedInstanceState: Bundle?) {",
                "  override fun onCreate(savedInstanceState: Bundle?) {\n    Keyring.initializeNdkContext(applicationContext)",
            )
    };
    fs::write(activity, source).expect("failed to configure Android MainActivity keyring context");

    let bridge = java.join("io/crates/keyring/Keyring.kt");
    fs::create_dir_all(bridge.parent().expect("keyring bridge parent"))
        .expect("failed to create Android keyring bridge directory");
    fs::write(bridge, r#"package io.crates.keyring

import android.content.Context

class Keyring {
  companion object {
    init {
      System.loadLibrary("codever_app_lib")
    }

    external fun initializeNdkContext(context: Context)
  }
}
"#).expect("failed to write Android keyring bridge");
}

fn find_file(directory: &Path, name: &str) -> Option<PathBuf> {
    for entry in fs::read_dir(directory).ok()? {
        let path = entry.ok()?.path();
        if path.is_dir() {
            if let Some(found) = find_file(&path, name) { return Some(found); }
        } else if path.file_name().is_some_and(|value| value == name) {
            return Some(path);
        }
    }
    None
}
