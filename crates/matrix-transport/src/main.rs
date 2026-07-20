#![recursion_limit = "256"]

use anyhow::{Context, Result, bail};
use codever_matrix_transport::{MatrixTransport, StoredMatrixSession};
use matrix_sdk::{
    SessionChange,
    ruma::{OwnedRoomId, events::room::EncryptedFile},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{Mutex, RwLock, mpsc},
};

#[derive(Debug, Deserialize)]
struct RpcRequest {
    id: String,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitializeParams {
    session: StoredMatrixSession,
    store_path: PathBuf,
    store_passphrase: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginParams {
    homeserver: String,
    username: String,
    password: String,
    device_display_name: String,
    store_path: PathBuf,
    store_passphrase: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendParams {
    room_id: OwnedRoomId,
    event_type: String,
    transaction_id: String,
    content: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceVerificationParams {
    device_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerificationFlowParams {
    flow_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfirmVerificationParams {
    flow_id: String,
    matches: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadMediaParams {
    encrypted_file: EncryptedFile,
    destination_path: PathBuf,
}

#[derive(Debug, Serialize)]
struct RpcOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<RpcError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    method: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<Value>,
}

#[derive(Debug, Serialize)]
struct RpcError {
    code: &'static str,
    message: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    let (output_tx, mut output_rx) = mpsc::channel::<RpcOutput>(1_024);
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(output) = output_rx.recv().await {
            let mut line = serde_json::to_vec(&output).context("failed to encode IPC output")?;
            line.push(b'\n');
            stdout
                .write_all(&line)
                .await
                .context("failed to write IPC output")?;
            stdout.flush().await.context("failed to flush IPC output")?;
        }
        Ok::<(), anyhow::Error>(())
    });

    let transport = Arc::new(RwLock::new(None::<MatrixTransport>));
    // Matrix SDK retries server 429 responses internally. Serialize sends so
    // concurrent RPC callers cannot multiply those retries into a storm.
    let send_gate = Arc::new(Mutex::new(()));
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines
        .next_line()
        .await
        .context("failed to read IPC input")?
    {
        if line.trim().is_empty() {
            continue;
        }
        let request = match serde_json::from_str::<RpcRequest>(&line) {
            Ok(value) => value,
            Err(error) => {
                output_tx
                    .send(failure(None, "invalid_request", error))
                    .await
                    .ok();
                continue;
            }
        };
        let id = request.id.clone();
        let request_transport = transport.clone();
        let request_send_gate = send_gate.clone();
        let request_output = output_tx.clone();
        tokio::spawn(async move {
            let result = handle(
                request,
                &request_transport,
                &request_output,
                &request_send_gate,
            )
            .await;
            let output = match result {
                Ok(value) => success(id, value),
                Err(error) => failure(Some(id), "matrix_transport_error", format!("{error:#}")),
            };
            let _ = request_output.send(output).await;
        });
    }
    drop(output_tx);
    writer.await.context("IPC writer task failed")??;
    Ok(())
}

async fn handle(
    request: RpcRequest,
    state: &Arc<RwLock<Option<MatrixTransport>>>,
    output: &mpsc::Sender<RpcOutput>,
    send_gate: &Arc<Mutex<()>>,
) -> Result<Value> {
    match request.method.as_str() {
        "login" => {
            let params: LoginParams =
                serde_json::from_value(request.params).context("invalid login parameters")?;
            let (created, session) = MatrixTransport::login_password(
                &params.homeserver,
                &params.username,
                &params.password,
                &params.device_display_name,
                params.store_path,
                &params.store_passphrase,
            )
            .await?;
            let control_room_id = created.ensure_control_room().await?;
            activate(created, state, output).await;
            Ok(json!({ "session": session, "controlRoomId": control_room_id }))
        }
        "initialize" => {
            let params: InitializeParams =
                serde_json::from_value(request.params).context("invalid initialize parameters")?;
            let created = MatrixTransport::restore(
                params.session,
                params.store_path,
                &params.store_passphrase,
            )
            .await?;
            activate(created, state, output).await;
            Ok(json!({ "initialized": true }))
        }
        "send" => {
            let params: SendParams =
                serde_json::from_value(request.params).context("invalid send parameters")?;
            let _send_guard = send_gate.lock().await;
            let transport = state
                .read()
                .await
                .clone()
                .context("Matrix transport is not initialized")?;
            let event_id = transport
                .send_raw(
                    &params.room_id,
                    &params.event_type,
                    &params.transaction_id,
                    params.content,
                )
                .await?;
            Ok(json!({ "eventId": event_id }))
        }
        "media.download" => {
            let params: DownloadMediaParams = serde_json::from_value(request.params)
                .context("invalid encrypted media download parameters")?;
            let transport = require_transport(state).await?;
            transport
                .download_encrypted_file(params.encrypted_file, params.destination_path)
                .await?;
            Ok(json!({ "downloaded": true }))
        }
        "verification.request" => {
            let params: DeviceVerificationParams = serde_json::from_value(request.params)
                .context("invalid verification request parameters")?;
            let transport = require_transport(state).await?;
            Ok(serde_json::to_value(
                transport
                    .request_device_verification(&params.device_id)
                    .await?,
            )?)
        }
        "devices.list" => {
            let transport = require_transport(state).await?;
            Ok(serde_json::to_value(transport.devices().await?)?)
        }
        "device.trust" => {
            let params: DeviceVerificationParams = serde_json::from_value(request.params)
                .context("invalid Matrix device trust parameters")?;
            let transport = require_transport(state).await?;
            transport.trust_device(&params.device_id).await?;
            Ok(json!({ "trusted": true }))
        }
        "verification.list" => {
            let transport = require_transport(state).await?;
            Ok(serde_json::to_value(
                transport.verification_requests().await?,
            )?)
        }
        "verification.advance" => {
            let params: VerificationFlowParams = serde_json::from_value(request.params)
                .context("invalid verification flow parameters")?;
            let transport = require_transport(state).await?;
            Ok(serde_json::to_value(
                transport.advance_verification(&params.flow_id).await?,
            )?)
        }
        "verification.confirm" => {
            let params: ConfirmVerificationParams = serde_json::from_value(request.params)
                .context("invalid verification confirmation parameters")?;
            let transport = require_transport(state).await?;
            Ok(serde_json::to_value(
                transport
                    .confirm_verification(&params.flow_id, params.matches)
                    .await?,
            )?)
        }
        "verification.cancel" => {
            let params: VerificationFlowParams = serde_json::from_value(request.params)
                .context("invalid verification flow parameters")?;
            let transport = require_transport(state).await?;
            transport.cancel_verification(&params.flow_id).await?;
            Ok(json!({ "cancelled": true }))
        }
        "status" => Ok(json!({ "initialized": state.read().await.is_some() })),
        "session.checkpoint" => {
            let transport = require_transport(state).await?;
            Ok(serde_json::to_value(transport.stored_session().context(
                "Matrix session is unavailable during checkpoint",
            )?)?)
        }
        _ => bail!("unknown Matrix transport method"),
    }
}

async fn require_transport(
    state: &Arc<RwLock<Option<MatrixTransport>>>,
) -> Result<MatrixTransport> {
    state
        .read()
        .await
        .clone()
        .context("Matrix transport is not initialized")
}

async fn activate(
    created: MatrixTransport,
    state: &Arc<RwLock<Option<MatrixTransport>>>,
    output: &mpsc::Sender<RpcOutput>,
) {
    let mut session_changes = created.subscribe_to_session_changes();
    let session_transport = created.clone();
    let session_output = output.clone();
    tokio::spawn(async move {
        loop {
            match session_changes.recv().await {
                Ok(SessionChange::TokensRefreshed) => {
                    let Some(session) = session_transport.stored_session() else {
                        let _ = session_output
                            .send(notification(
                                "session_error",
                                json!({ "message": "Matrix refreshed tokens but returned no session" }),
                            ))
                            .await;
                        continue;
                    };
                    if session_output
                        .send(notification(
                            "session_tokens",
                            serde_json::to_value(session).unwrap_or(Value::Null),
                        ))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(SessionChange::UnknownToken(error)) => {
                    let _ = session_output
                        .send(notification(
                            "session_error",
                            json!({ "message": format!("Matrix session is no longer valid: {error:?}") }),
                        ))
                        .await;
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    if let Some(session) = session_transport.stored_session() {
                        let _ = session_output
                            .send(notification(
                                "session_tokens",
                                serde_json::to_value(session).unwrap_or(Value::Null),
                            ))
                            .await;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
    let mut events = created.subscribe();
    let event_output = output.clone();
    tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(event) => {
                    if event_output
                        .send(notification(
                            "event",
                            serde_json::to_value(event).unwrap_or(Value::Null),
                        ))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    let _ = event_output
                        .send(notification("lagged", json!({ "skipped": skipped })))
                        .await;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
    let sync_client = created.clone();
    let sync_output = output.clone();
    tokio::spawn(async move {
        if let Err(error) = sync_client.sync().await {
            let _ = sync_output
                .send(notification(
                    "sync_error",
                    json!({ "message": error.to_string() }),
                ))
                .await;
        }
    });
    *state.write().await = Some(created);
}

fn success(id: String, result: Value) -> RpcOutput {
    RpcOutput {
        id: Some(id),
        result: Some(result),
        error: None,
        method: None,
        params: None,
    }
}

fn failure(id: Option<String>, code: &'static str, error: impl std::fmt::Display) -> RpcOutput {
    RpcOutput {
        id,
        result: None,
        error: Some(RpcError {
            code,
            message: error.to_string(),
        }),
        method: None,
        params: None,
    }
}

fn notification(method: &'static str, params: Value) -> RpcOutput {
    RpcOutput {
        id: None,
        result: None,
        error: None,
        method: Some(method),
        params: Some(params),
    }
}
