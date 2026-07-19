#![recursion_limit = "256"]

use base64ct::{Base64UrlUnpadded, Encoding};
use codever_matrix_transport::{
    execution_auth::{
        generate_execution_identity, sign_execution_token, ExecutionJwk, SignExecutionInput,
    },
    MatrixTransport, SessionChange, StoredMatrixSession,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Emitter, Manager};
use tokio::sync::RwLock;

const KEYRING_SERVICE: &str = "id.my.anciety.codever";
const MATRIX_EVENT_NAME: &str = "codever://matrix-event";

#[derive(Default)]
struct MatrixState(RwLock<Option<MatrixTransport>>);

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MatrixSecret {
    access_token: String,
    refresh_token: Option<String>,
    store_passphrase: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MatrixPublicSession {
    homeserver: String,
    user_id: String,
    device_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MatrixLoginInput {
    homeserver: String,
    username: String,
    password: String,
    device_display_name: String,
    secret_account: String,
}

fn keyring_entry(account: &str) -> Result<keyring_core::Entry, String> {
    if account.is_empty()
        || account.len() > 240
        || !account
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_' | ':' | '.'))
    {
        return Err("invalid secret account".into());
    }
    ensure_platform_keyring()?;
    keyring_core::Entry::new(KEYRING_SERVICE, account).map_err(|error| error.to_string())
}

#[cfg(target_os = "android")]
fn ensure_platform_keyring() -> Result<(), String> {
    use std::sync::OnceLock;

    static INITIALIZED: OnceLock<Result<(), String>> = OnceLock::new();
    INITIALIZED
        .get_or_init(|| {
            let store =
                android_native_keyring_store::Store::new().map_err(|error| error.to_string())?;
            keyring_core::set_default_store(store);
            Ok(())
        })
        .clone()
}

#[cfg(not(target_os = "android"))]
fn ensure_platform_keyring() -> Result<(), String> {
    Ok(())
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
    keyring_entry(&account)?
        .set_password(&value)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn secure_secret_delete(account: String) -> Result<(), String> {
    match keyring_entry(&account)?.delete_credential() {
        Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
async fn matrix_initialize(
    app: tauri::AppHandle,
    state: tauri::State<'_, MatrixState>,
    session: MatrixPublicSession,
    secret_account: String,
) -> Result<(), String> {
    if state.0.read().await.is_some() {
        return Ok(());
    }
    let encoded = keyring_entry(&secret_account)?
        .get_password()
        .map_err(|error| error.to_string())?;
    let secret: MatrixSecret = serde_json::from_str(&encoded)
        .map_err(|_| "invalid Matrix secret in platform credential store".to_owned())?;
    if secret.access_token.is_empty() || secret.store_passphrase.is_empty() {
        return Err("Matrix secret is incomplete".into());
    }
    let store_path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("matrix-store");
    let transport = MatrixTransport::restore(
        StoredMatrixSession {
            homeserver: session.homeserver,
            user_id: session
                .user_id
                .parse()
                .map_err(|_| "invalid Matrix user ID")?,
            device_id: session.device_id.into(),
            access_token: secret.access_token,
            refresh_token: secret.refresh_token,
        },
        store_path,
        &secret.store_passphrase,
    )
    .await
    .map_err(|error| error.to_string())?;
    start_matrix_sync(
        app,
        &transport,
        secret_account,
        secret.store_passphrase.clone(),
    );
    *state.0.write().await = Some(transport);
    Ok(())
}

fn start_matrix_sync(
    app: tauri::AppHandle,
    transport: &MatrixTransport,
    secret_account: String,
    store_passphrase: String,
) {
    let mut session_changes = transport.subscribe_to_session_changes();
    let session_transport = transport.clone();
    let session_app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            match session_changes.recv().await {
                Ok(SessionChange::TokensRefreshed) => {
                    let result = session_transport
                        .stored_session()
                        .ok_or_else(|| "Matrix refreshed tokens but returned no session".to_owned())
                        .and_then(|session| {
                            let encoded = serde_json::to_string(&MatrixSecret {
                                access_token: session.access_token,
                                refresh_token: session.refresh_token,
                                store_passphrase: store_passphrase.clone(),
                            })
                            .map_err(|error| error.to_string())?;
                            keyring_entry(&secret_account)?
                                .set_password(&encoded)
                                .map_err(|error| error.to_string())
                        });
                    if let Err(message) = result {
                        let _ = session_app.emit(
                            MATRIX_EVENT_NAME,
                            serde_json::json!({ "kind": "session_error", "message": message }),
                        );
                    }
                }
                Ok(SessionChange::UnknownToken(error)) => {
                    let _ = session_app.emit(
                        MATRIX_EVENT_NAME,
                        serde_json::json!({
                            "kind": "session_error",
                            "message": format!("Matrix session is no longer valid: {error:?}"),
                        }),
                    );
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
    let mut events = transport.subscribe();
    let event_app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Ok(event) = events.recv().await {
            let _ = event_app.emit(MATRIX_EVENT_NAME, event);
        }
    });
    let sync_transport = transport.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = sync_transport.sync().await {
            let _ = app.emit(
                MATRIX_EVENT_NAME,
                serde_json::json!({
                    "kind": "sync_error",
                    "message": error.to_string(),
                }),
            );
        }
    });
}

#[tauri::command]
async fn matrix_login(
    app: tauri::AppHandle,
    state: tauri::State<'_, MatrixState>,
    input: MatrixLoginInput,
) -> Result<MatrixPublicSession, String> {
    if state.0.read().await.is_some() {
        return Err("Matrix transport is already initialized".into());
    }
    let mut random = [0_u8; 32];
    getrandom::fill(&mut random).map_err(|error| error.to_string())?;
    let store_passphrase = Base64UrlUnpadded::encode_string(&random);
    let store_path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("matrix-store");
    let (transport, session) = MatrixTransport::login_password(
        &input.homeserver,
        &input.username,
        &input.password,
        &input.device_display_name,
        store_path,
        &store_passphrase,
    )
    .await
    .map_err(|error| error.to_string())?;
    keyring_entry(&input.secret_account)?
        .set_password(
            &serde_json::to_string(&MatrixSecret {
                access_token: session.access_token.clone(),
                refresh_token: session.refresh_token.clone(),
                store_passphrase: store_passphrase.clone(),
            })
            .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
    let public = MatrixPublicSession {
        homeserver: session.homeserver,
        user_id: session.user_id.to_string(),
        device_id: session.device_id.to_string(),
    };
    start_matrix_sync(app, &transport, input.secret_account, store_passphrase);
    *state.0.write().await = Some(transport);
    Ok(public)
}

#[tauri::command]
async fn matrix_send(
    state: tauri::State<'_, MatrixState>,
    room_id: String,
    event_type: String,
    transaction_id: String,
    content: Value,
) -> Result<String, String> {
    let transport = state
        .0
        .read()
        .await
        .clone()
        .ok_or("Matrix transport is not initialized")?;
    transport
        .send_raw(
            &room_id.parse().map_err(|_| "invalid Matrix room ID")?,
            &event_type,
            &transaction_id,
            content,
        )
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn matrix_ensure_control_room(
    state: tauri::State<'_, MatrixState>,
) -> Result<String, String> {
    let transport = state
        .0
        .read()
        .await
        .clone()
        .ok_or("Matrix transport is not initialized")?;
    transport
        .ensure_control_room()
        .await
        .map(|room_id| room_id.to_string())
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn matrix_verification_request(
    state: tauri::State<'_, MatrixState>,
    device_id: String,
) -> Result<Value, String> {
    let transport = matrix_transport(&state).await?;
    transport
        .request_device_verification(&device_id)
        .await
        .and_then(|value| serde_json::to_value(value).map_err(Into::into))
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn matrix_devices(state: tauri::State<'_, MatrixState>) -> Result<Value, String> {
    let transport = matrix_transport(&state).await?;
    transport
        .devices()
        .await
        .and_then(|value| serde_json::to_value(value).map_err(Into::into))
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn matrix_verification_list(state: tauri::State<'_, MatrixState>) -> Result<Value, String> {
    let transport = matrix_transport(&state).await?;
    serde_json::to_value(transport.verification_requests().await).map_err(|error| error.to_string())
}

#[tauri::command]
async fn matrix_verification_advance(
    state: tauri::State<'_, MatrixState>,
    flow_id: String,
) -> Result<Value, String> {
    let transport = matrix_transport(&state).await?;
    transport
        .advance_verification(&flow_id)
        .await
        .and_then(|value| serde_json::to_value(value).map_err(Into::into))
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn matrix_verification_confirm(
    state: tauri::State<'_, MatrixState>,
    flow_id: String,
    matches: bool,
) -> Result<Value, String> {
    let transport = matrix_transport(&state).await?;
    transport
        .confirm_verification(&flow_id, matches)
        .await
        .and_then(|value| serde_json::to_value(value).map_err(Into::into))
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn matrix_verification_cancel(
    state: tauri::State<'_, MatrixState>,
    flow_id: String,
) -> Result<(), String> {
    matrix_transport(&state)
        .await?
        .cancel_verification(&flow_id)
        .await
        .map_err(|error| error.to_string())
}

async fn matrix_transport(
    state: &tauri::State<'_, MatrixState>,
) -> Result<MatrixTransport, String> {
    state
        .0
        .read()
        .await
        .clone()
        .ok_or_else(|| "Matrix transport is not initialized".to_owned())
}

#[tauri::command]
async fn matrix_close(state: tauri::State<'_, MatrixState>) -> Result<(), String> {
    if let Some(transport) = state.0.write().await.take() {
        transport.stop();
    }
    Ok(())
}

#[tauri::command]
fn execution_identity_create(account: String) -> Result<Value, String> {
    let entry = keyring_entry(&account)?;
    match entry.get_password() {
        Ok(encoded) => {
            let mut key: ExecutionJwk = serde_json::from_str(&encoded).map_err(|_| {
                "invalid execution identity in platform credential store".to_owned()
            })?;
            key.d = None;
            return Ok(serde_json::json!({ "keyId": key.kid, "publicKey": key }));
        }
        Err(keyring_core::Error::NoEntry) => {}
        Err(error) => return Err(error.to_string()),
    }
    let identity = generate_execution_identity();
    entry
        .set_password(
            &serde_json::to_string(&identity.private_key).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
    Ok(serde_json::json!({
        "keyId": identity.key_id,
        "publicKey": identity.public_key,
    }))
}

#[tauri::command]
fn execution_sign(account: String, input: SignExecutionInput) -> Result<String, String> {
    let encoded = keyring_entry(&account)?
        .get_password()
        .map_err(|error| error.to_string())?;
    let key: ExecutionJwk = serde_json::from_str(&encoded)
        .map_err(|_| "invalid execution identity in platform credential store".to_owned())?;
    sign_execution_token(&key, input).map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "windows")]
    keyring_core::set_default_store(
        windows_native_keyring_store::Store::new()
            .expect("failed to initialize Windows Credential Manager"),
    );
    #[cfg(target_os = "macos")]
    keyring_core::set_default_store(
        apple_native_keyring_store::keychain::Store::new()
            .expect("failed to initialize macOS Keychain"),
    );
    #[cfg(target_os = "ios")]
    keyring_core::set_default_store(
        apple_native_keyring_store::protected::Store::new()
            .expect("failed to initialize iOS protected storage"),
    );
    #[cfg(target_os = "linux")]
    keyring_core::set_default_store(
        zbus_secret_service_keyring_store::Store::new()
            .expect("failed to initialize Secret Service"),
    );

    let builder = tauri::Builder::default().manage(MatrixState::default());
    #[cfg(feature = "desktop-e2e")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .invoke_handler(tauri::generate_handler![
            secure_secret_get,
            secure_secret_set,
            secure_secret_delete,
            matrix_initialize,
            matrix_login,
            matrix_send,
            matrix_ensure_control_room,
            matrix_devices,
            matrix_verification_request,
            matrix_verification_list,
            matrix_verification_advance,
            matrix_verification_confirm,
            matrix_verification_cancel,
            matrix_close,
            execution_identity_create,
            execution_sign,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Codever");
}
