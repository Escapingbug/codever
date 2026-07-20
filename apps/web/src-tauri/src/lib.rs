#![recursion_limit = "256"]

use base64ct::{Base64, Base64UrlUnpadded, Encoding};
use codever_matrix_transport::{
    execution_auth::{
        generate_execution_identity, sign_execution_token, ExecutionJwk, SignExecutionInput,
    },
    MatrixTransport, SessionChange, StoredMatrixSession,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs::OpenOptions,
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
    time::{Duration, SystemTime},
};
use tauri::{Emitter, Manager};
use tokio::sync::RwLock;

const KEYRING_SERVICE: &str = "id.my.anciety.codever";
const MATRIX_EVENT_NAME: &str = "codever://matrix-event";

#[derive(Default)]
struct MatrixState(RwLock<Option<MatrixRuntime>>);

struct MatrixRuntime {
    transport: MatrixTransport,
    tasks: Vec<tauri::async_runtime::JoinHandle<()>>,
}

#[derive(Default)]
struct MediaUploadState(RwLock<HashMap<String, StagedMediaUpload>>);

struct StagedMediaUpload {
    path: PathBuf,
    size_bytes: u64,
    received_bytes: u64,
}

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
    connection_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MatrixReauthenticateInput {
    session: MatrixPublicSession,
    password: String,
    device_display_name: String,
    secret_account: String,
    connection_id: String,
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

fn persist_matrix_session(
    secret_account: &str,
    store_passphrase: &str,
    session: StoredMatrixSession,
) -> Result<(), String> {
    let encoded = serde_json::to_string(&MatrixSecret {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        store_passphrase: store_passphrase.to_owned(),
    })
    .map_err(|error| error.to_string())?;
    keyring_entry(secret_account)?
        .set_password(&encoded)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn matrix_initialize(
    app: tauri::AppHandle,
    state: tauri::State<'_, MatrixState>,
    session: MatrixPublicSession,
    secret_account: String,
    connection_id: String,
) -> Result<(), String> {
    validate_connection_id(&connection_id)?;
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
    let persistence_account = secret_account.clone();
    let persistence_passphrase = secret.store_passphrase.clone();
    let transport = MatrixTransport::restore_with_session_persistence(
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
        move |session| {
            persist_matrix_session(&persistence_account, &persistence_passphrase, session)
                .map_err(|error| std::io::Error::other(error).into())
        },
    )
    .await
    .map_err(|error| error.to_string())?;
    let tasks = start_matrix_sync(app, &transport, connection_id);
    *state.0.write().await = Some(MatrixRuntime { transport, tasks });
    Ok(())
}

fn start_matrix_sync(
    app: tauri::AppHandle,
    transport: &MatrixTransport,
    connection_id: String,
) -> Vec<tauri::async_runtime::JoinHandle<()>> {
    let mut tasks = Vec::with_capacity(4);
    let mut session_changes = transport.subscribe_to_session_changes();
    let session_transport = transport.clone();
    let session_app = app.clone();
    let session_connection_id = connection_id.clone();
    tasks.push(tauri::async_runtime::spawn(async move {
        loop {
            match session_changes.recv().await {
                Ok(SessionChange::TokensRefreshed) => {
                    if let Err(error) = session_transport.ensure_session_persisted() {
                        emit_matrix_payload(
                            &session_app,
                            &session_connection_id,
                            serde_json::json!({
                                "kind": "session_error",
                                "message": format!("Unable to persist refreshed Matrix credentials: {error:#}"),
                            }),
                        );
                    }
                }
                Ok(SessionChange::UnknownToken(error)) => {
                    emit_matrix_payload(
                        &session_app,
                        &session_connection_id,
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
    }));
    let mut events = transport.subscribe();
    let event_app = app.clone();
    let event_connection_id = connection_id.clone();
    tasks.push(tauri::async_runtime::spawn(async move {
        while let Ok(event) = events.recv().await {
            emit_matrix_payload(&event_app, &event_connection_id, event);
        }
    }));
    let mut sync_activity = transport.subscribe_to_sync_activity();
    let sync_app = app.clone();
    let sync_connection_id = connection_id.clone();
    tasks.push(tauri::async_runtime::spawn(async move {
        loop {
            match sync_activity.recv().await {
                Ok(()) => {
                    emit_matrix_payload(&sync_app, &sync_connection_id,
                        serde_json::json!({ "kind": "sync_healthy", "message": "Matrix sync is active" }));
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    }));
    let sync_transport = transport.clone();
    tasks.push(tauri::async_runtime::spawn(async move {
        if let Err(error) = sync_transport.sync().await {
            emit_matrix_payload(
                &app,
                &connection_id,
                serde_json::json!({
                    "kind": "sync_error",
                    "message": error.to_string(),
                }),
            );
        }
    }));
    tasks
}

fn validate_connection_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err("invalid Matrix connection ID".into());
    }
    Ok(())
}

fn emit_matrix_payload(app: &tauri::AppHandle, connection_id: &str, payload: impl Serialize) {
    let Ok(mut value) = serde_json::to_value(payload) else {
        return;
    };
    let Some(object) = value.as_object_mut() else {
        return;
    };
    object.insert(
        "connectionId".into(),
        Value::String(connection_id.to_owned()),
    );
    let _ = app.emit(MATRIX_EVENT_NAME, value);
}

#[tauri::command]
async fn matrix_login(
    app: tauri::AppHandle,
    state: tauri::State<'_, MatrixState>,
    input: MatrixLoginInput,
) -> Result<MatrixPublicSession, String> {
    validate_connection_id(&input.connection_id)?;
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
    let persistence_account = input.secret_account.clone();
    let persistence_passphrase = store_passphrase.clone();
    let (transport, session) = MatrixTransport::login_password_with_session_persistence(
        &input.homeserver,
        &input.username,
        &input.password,
        &input.device_display_name,
        store_path,
        &store_passphrase,
        move |session| {
            persist_matrix_session(&persistence_account, &persistence_passphrase, session)
                .map_err(|error| std::io::Error::other(error).into())
        },
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
    let tasks = start_matrix_sync(app, &transport, input.connection_id);
    *state.0.write().await = Some(MatrixRuntime { transport, tasks });
    Ok(public)
}

#[tauri::command]
async fn matrix_reauthenticate(
    app: tauri::AppHandle,
    state: tauri::State<'_, MatrixState>,
    input: MatrixReauthenticateInput,
) -> Result<MatrixPublicSession, String> {
    validate_connection_id(&input.connection_id)?;
    if state.0.read().await.is_some() {
        return Err("Matrix transport is already initialized".into());
    }
    if input.password.is_empty() {
        return Err("Matrix password is required".into());
    }
    let encoded = keyring_entry(&input.secret_account)?
        .get_password()
        .map_err(|error| error.to_string())?;
    let previous: MatrixSecret = serde_json::from_str(&encoded)
        .map_err(|_| "invalid Matrix secret in platform credential store".to_owned())?;
    if previous.store_passphrase.is_empty() {
        return Err("Matrix secret is incomplete".into());
    }
    let store_path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("matrix-store");
    let persistence_account = input.secret_account.clone();
    let persistence_passphrase = previous.store_passphrase.clone();
    let (transport, session) = MatrixTransport::relogin_password_with_session_persistence(
        &input.session.homeserver,
        &input.session.user_id,
        &input.password,
        &input.device_display_name,
        &input.session.device_id,
        store_path,
        &previous.store_passphrase,
        move |session| {
            persist_matrix_session(&persistence_account, &persistence_passphrase, session)
                .map_err(|error| std::io::Error::other(error).into())
        },
    )
    .await
    .map_err(|error| error.to_string())?;
    if session.device_id.as_str() != input.session.device_id.as_str() {
        return Err("Matrix reauthentication returned a different device ID".into());
    }
    keyring_entry(&input.secret_account)?
        .set_password(
            &serde_json::to_string(&MatrixSecret {
                access_token: session.access_token.clone(),
                refresh_token: session.refresh_token.clone(),
                store_passphrase: previous.store_passphrase.clone(),
            })
            .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
    let public = MatrixPublicSession {
        homeserver: session.homeserver,
        user_id: session.user_id.to_string(),
        device_id: session.device_id.to_string(),
    };
    let tasks = start_matrix_sync(app, &transport, input.connection_id);
    *state.0.write().await = Some(MatrixRuntime { transport, tasks });
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
    let transport = matrix_transport(&state).await?;
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
    let transport = matrix_transport(&state).await?;
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
    transport
        .verification_requests()
        .await
        .and_then(|value| serde_json::to_value(value).map_err(Into::into))
        .map_err(|error| error.to_string())
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaUploadSnapshot {
    upload_id: String,
    size_bytes: u64,
    received_bytes: u64,
}

#[tauri::command]
async fn matrix_media_upload_begin(
    app: tauri::AppHandle,
    uploads: tauri::State<'_, MediaUploadState>,
    size_bytes: u64,
) -> Result<MediaUploadSnapshot, String> {
    let mut random = [0_u8; 18];
    getrandom::fill(&mut random).map_err(|error| error.to_string())?;
    let upload_id = format!("media_{}", Base64UrlUnpadded::encode_string(&random));
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("matrix-media-staging");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let active_paths = uploads
        .0
        .read()
        .await
        .values()
        .map(|upload| upload.path.clone())
        .collect();
    remove_stale_media_staging(&directory, &active_paths);
    let path = directory.join(&upload_id);
    OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    uploads.0.write().await.insert(
        upload_id.clone(),
        StagedMediaUpload {
            path,
            size_bytes,
            received_bytes: 0,
        },
    );
    Ok(MediaUploadSnapshot {
        upload_id,
        size_bytes,
        received_bytes: 0,
    })
}

fn remove_stale_media_staging(directory: &PathBuf, active_paths: &HashSet<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if active_paths.contains(&path)
            || !entry.file_name().to_string_lossy().starts_with("media_")
        {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .and_then(|modified| {
                SystemTime::now()
                    .duration_since(modified)
                    .map_err(std::io::Error::other)
            })
            .is_ok_and(|age| age > Duration::from_secs(24 * 60 * 60));
        if stale {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[tauri::command]
async fn matrix_media_upload_chunk(
    uploads: tauri::State<'_, MediaUploadState>,
    upload_id: String,
    offset: u64,
    data: String,
) -> Result<MediaUploadSnapshot, String> {
    let bytes = Base64::decode_vec(&data).map_err(|_| "invalid Matrix media chunk encoding")?;
    if bytes.is_empty() || bytes.len() > 512 * 1024 {
        return Err("Matrix media chunk must be between 1 and 524288 bytes".into());
    }
    let mut records = uploads.0.write().await;
    let upload = records
        .get_mut(&upload_id)
        .ok_or("unknown Matrix media upload")?;
    let end = offset
        .checked_add(bytes.len() as u64)
        .ok_or("Matrix media chunk offset overflow")?;
    if offset > upload.received_bytes || end > upload.size_bytes {
        return Err("Matrix media chunk offset or size is invalid".into());
    }
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&upload.path)
        .map_err(|error| error.to_string())?;
    if offset < upload.received_bytes {
        if end > upload.received_bytes {
            return Err("Matrix media retry overlaps the received boundary".into());
        }
        file.seek(SeekFrom::Start(offset))
            .map_err(|error| error.to_string())?;
        let mut existing = vec![0_u8; bytes.len()];
        file.read_exact(&mut existing)
            .map_err(|error| error.to_string())?;
        if existing != bytes {
            return Err("Matrix media chunk retry does not match staged bytes".into());
        }
    } else {
        file.seek(SeekFrom::Start(offset))
            .map_err(|error| error.to_string())?;
        file.write_all(&bytes).map_err(|error| error.to_string())?;
        upload.received_bytes += bytes.len() as u64;
    }
    Ok(MediaUploadSnapshot {
        upload_id,
        size_bytes: upload.size_bytes,
        received_bytes: upload.received_bytes,
    })
}

#[tauri::command]
async fn matrix_media_upload_complete(
    matrix: tauri::State<'_, MatrixState>,
    uploads: tauri::State<'_, MediaUploadState>,
    upload_id: String,
) -> Result<Value, String> {
    let upload = uploads
        .0
        .write()
        .await
        .remove(&upload_id)
        .ok_or("unknown Matrix media upload")?;
    if upload.received_bytes != upload.size_bytes {
        uploads.0.write().await.insert(upload_id, upload);
        return Err("Matrix media upload is incomplete".into());
    }
    let result = matrix_transport(&matrix)
        .await?
        .upload_encrypted_file_path(&upload.path)
        .await
        .and_then(|value| serde_json::to_value(value).map_err(Into::into))
        .map_err(|error| error.to_string());
    let _ = std::fs::remove_file(upload.path);
    result
}

#[tauri::command]
async fn matrix_media_upload_cancel(
    uploads: tauri::State<'_, MediaUploadState>,
    upload_id: String,
) -> Result<(), String> {
    if let Some(upload) = uploads.0.write().await.remove(&upload_id) {
        std::fs::remove_file(upload.path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

async fn matrix_transport(
    state: &tauri::State<'_, MatrixState>,
) -> Result<MatrixTransport, String> {
    state
        .0
        .read()
        .await
        .as_ref()
        .map(|runtime| runtime.transport.clone())
        .ok_or_else(|| "Matrix transport is not initialized".to_owned())
}

#[tauri::command]
async fn matrix_close(state: tauri::State<'_, MatrixState>) -> Result<(), String> {
    let mut state = state.0.write().await;
    if let Some(runtime) = state.as_ref() {
        runtime
            .transport
            .checkpoint_session()
            .map_err(|error| format!("could not safely close Matrix session: {error:#}"))?;
        runtime
            .transport
            .ensure_session_persisted()
            .map_err(|error| format!("could not safely close Matrix session: {error:#}"))?;
    }
    if let Some(runtime) = state.take() {
        runtime.transport.stop();
        abort_and_join(runtime.tasks).await;
    }
    Ok(())
}

async fn abort_and_join(tasks: Vec<tauri::async_runtime::JoinHandle<()>>) {
    for task in &tasks {
        task.abort();
    }
    for task in tasks {
        let _ = task.await;
    }
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

    let builder = tauri::Builder::default()
        .manage(MatrixState::default())
        .manage(MediaUploadState::default());
    #[cfg(feature = "desktop-e2e")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .invoke_handler(tauri::generate_handler![
            secure_secret_get,
            secure_secret_set,
            secure_secret_delete,
            matrix_initialize,
            matrix_login,
            matrix_reauthenticate,
            matrix_send,
            matrix_ensure_control_room,
            matrix_devices,
            matrix_verification_request,
            matrix_verification_list,
            matrix_verification_advance,
            matrix_verification_confirm,
            matrix_verification_cancel,
            matrix_media_upload_begin,
            matrix_media_upload_chunk,
            matrix_media_upload_complete,
            matrix_media_upload_cancel,
            matrix_close,
            execution_identity_create,
            execution_sign,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Codever");
}

#[cfg(test)]
mod tests {
    use super::abort_and_join;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };

    struct Dropped(Arc<AtomicBool>);
    impl Drop for Dropped {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }

    #[tokio::test]
    async fn reconnect_waits_until_retired_matrix_tasks_release_their_resources() {
        let dropped = Arc::new(AtomicBool::new(false));
        let guard = Dropped(dropped.clone());
        let task = tauri::async_runtime::spawn(async move {
            let _guard = guard;
            std::future::pending::<()>().await;
        });

        abort_and_join(vec![task]).await;

        assert!(dropped.load(Ordering::Acquire));
    }
}
