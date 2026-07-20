#![recursion_limit = "256"]

use anyhow::{Context, Result, bail};
use codever_matrix_transport::{MatrixTransport, VerificationSnapshot};
use serde_json::Value;
use std::{env, fs, time::Duration};
use tokio::time::{sleep, timeout};

#[tokio::main]
async fn main() -> Result<()> {
    let homeserver = env::var("CODEVER_MATRIX_HOMESERVER")?;
    let username = env::var("CODEVER_MATRIX_USERNAME")?;
    let password = env::var("CODEVER_MATRIX_PASSWORD")?;
    let trusted_store = env::var("CODEVER_TRUSTED_STORE")?;
    let trusted_passphrase = env::var("CODEVER_TRUSTED_STORE_PASSPHRASE")?;
    let trusted_device = env::var("CODEVER_TRUSTED_DEVICE")?;
    let config: Value =
        serde_json::from_str(&fs::read_to_string(env::var("CODEVER_GATEWAY_CONFIG")?)?)?;
    let credential_path = config
        .pointer("/matrix/credentialPath")
        .and_then(Value::as_str)
        .context("credentialPath")?;
    let credential: Value = serde_json::from_str(&fs::read_to_string(credential_path)?)?;
    let gateway_device = config
        .pointer("/matrix/deviceId")
        .and_then(Value::as_str)
        .context("deviceId")?;
    let gateway_store = config
        .pointer("/matrix/storePath")
        .and_then(Value::as_str)
        .context("storePath")?;
    let gateway_store_passphrase = credential
        .get("storePassphrase")
        .and_then(Value::as_str)
        .context("storePassphrase")?;
    let (gateway, gateway_session) = MatrixTransport::relogin_password(
        &homeserver,
        &username,
        &password,
        "Codever Gateway SAS recovery",
        gateway_device,
        gateway_store,
        gateway_store_passphrase,
    )
    .await?;
    fs::write(
        credential_path,
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 1,
            "accessToken": gateway_session.access_token,
            "refreshToken": gateway_session.refresh_token,
            "storePassphrase": gateway_store_passphrase,
        }))?,
    )?;
    let (trusted, _) = MatrixTransport::relogin_password(
        &homeserver,
        &username,
        &password,
        "Codever trusted bootstrap device",
        &trusted_device,
        trusted_store,
        &trusted_passphrase,
    )
    .await?;

    let trusted_sync = trusted.clone();
    let gateway_sync = gateway.clone();
    let trusted_task = tokio::spawn(async move { trusted_sync.sync().await });
    let gateway_task = tokio::spawn(async move { gateway_sync.sync().await });
    sleep(Duration::from_secs(2)).await;
    eprintln!("sas: both sync loops started");
    let request = trusted.request_device_verification(gateway_device).await?;
    let flow_id = request.flow_id.clone();
    eprintln!(
        "sas: request {} created at stage {}",
        flow_id, request.stage
    );
    let mut matched = false;
    let mut previous = String::new();
    for attempt in 0..60 {
        let left = trusted.advance_verification(&flow_id).await?;
        let gateway_requests = gateway.verification_requests().await?;
        let right = if gateway_requests
            .iter()
            .any(|value| value.flow_id == flow_id)
        {
            Some(gateway.advance_verification(&flow_id).await?)
        } else {
            None
        };
        let stage = format!(
            "left={}, right={}, gateway_requests={}",
            left.stage,
            right
                .as_ref()
                .map(|value| value.stage.as_str())
                .unwrap_or("missing"),
            gateway_requests.len(),
        );
        if stage != previous {
            eprintln!("sas: attempt {attempt}: {stage}");
            if let Some(cancellation) = left.cancellation.as_ref() {
                eprintln!("sas: left cancellation: {cancellation:?}");
            }
            if let Some(cancellation) = right.as_ref().and_then(|value| value.cancellation.as_ref())
            {
                eprintln!("sas: right cancellation: {cancellation:?}");
            }
            previous = stage;
        }
        if let Some(right) = right
            && left.stage == "present_sas"
            && right.stage == "present_sas"
        {
            if emoji_symbols(&left) != emoji_symbols(&right) {
                bail!("Matrix SAS emoji mismatch")
            }
            trusted.confirm_verification(&flow_id, true).await?;
            gateway.confirm_verification(&flow_id, true).await?;
            matched = true;
        }
        if matched {
            let left = trusted.advance_verification(&flow_id).await?;
            let right = gateway.advance_verification(&flow_id).await?;
            if left.stage == "done" && right.stage == "done" {
                println!(
                    "{}",
                    serde_json::json!({
                        "trustedDevice": trusted_device,
                        "gatewayDevice": gateway_device,
                        "flowId": flow_id,
                        "verified": true,
                    })
                );
                trusted.stop();
                gateway.stop();
                let _ = timeout(Duration::from_secs(5), trusted_task).await;
                let _ = timeout(Duration::from_secs(5), gateway_task).await;
                return Ok(());
            }
        }
        sleep(Duration::from_millis(500)).await;
    }
    bail!("Matrix SAS verification did not complete")
}

fn emoji_symbols(snapshot: &VerificationSnapshot) -> Vec<&str> {
    snapshot
        .emojis
        .as_ref()
        .map(|values| values.iter().map(|value| value.symbol.as_str()).collect())
        .unwrap_or_default()
}
