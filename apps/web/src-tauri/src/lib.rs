const KEYRING_SERVICE: &str = "id.my.anciety.codever";

fn keyring_entry(account: &str) -> Result<keyring_core::Entry, String> {
    if account.is_empty() || account.len() > 240 || !account.chars().all(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_' | ':' | '.')) {
        return Err("invalid secret account".into());
    }
    keyring_core::Entry::new(KEYRING_SERVICE, account).map_err(|error| error.to_string())
}

#[tauri::command]
fn secure_secret_get(account: String) -> Result<Option<String>, String> {
    match keyring_entry(&account)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring_core::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn secure_secret_set(account: String, value: String) -> Result<(), String> {
    if value.is_empty() || value.len() > 65_536 {
        return Err("invalid secret value".into());
    }
    keyring_entry(&account)?.set_password(&value).map_err(|error| error.to_string())
}

#[tauri::command]
fn secure_secret_delete(account: String) -> Result<(), String> {
    match keyring_entry(&account)?.delete_credential() {
        Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "android")]
    keyring_core::set_default_store(android_native_keyring_store::Store::new().expect("failed to initialize Android Keystore"));
    #[cfg(target_os = "windows")]
    keyring_core::set_default_store(windows_native_keyring_store::Store::new().expect("failed to initialize Windows Credential Manager"));
    #[cfg(target_os = "macos")]
    keyring_core::set_default_store(apple_native_keyring_store::keychain::Store::new().expect("failed to initialize macOS Keychain"));
    #[cfg(target_os = "ios")]
    keyring_core::set_default_store(apple_native_keyring_store::protected::Store::new().expect("failed to initialize iOS protected storage"));
    #[cfg(target_os = "linux")]
    keyring_core::set_default_store(zbus_secret_service_keyring_store::Store::new().expect("failed to initialize Secret Service"));

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![secure_secret_get, secure_secret_set, secure_secret_delete])
        .run(tauri::generate_context!())
        .expect("failed to run Codever");
}
