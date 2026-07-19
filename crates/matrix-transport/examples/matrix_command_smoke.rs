#![recursion_limit = "256"]

use anyhow::{Context, Result, bail};
use codever_matrix_transport::{
    COMMAND_EVENT_TYPE, MatrixTransport, RESPONSE_EVENT_TYPE,
    execution_auth::{
        ExecutionJwk, SignExecutionInput, generate_execution_identity, sign_execution_token,
    },
};
use serde_json::{Value, json};
use std::{env, fs, path::Path, time::Duration};
use tokio::time::{sleep, timeout};

#[tokio::main]
async fn main() -> Result<()> {
    let private_path = env::var("CODEVER_EXECUTION_PRIVATE_KEY")?;
    let public_path = env::var("CODEVER_EXECUTION_PUBLIC_KEY")?;
    if env::var("CODEVER_PREPARE_IDENTITY").as_deref() == Ok("1") {
        prepare_identity(&private_path, &public_path)?;
        println!(
            "{}",
            json!({ "privateKeyPath": private_path, "publicKeyPath": public_path })
        );
        return Ok(());
    }

    let homeserver = env::var("CODEVER_MATRIX_HOMESERVER")?;
    let trusted_device = env::var("CODEVER_TRUSTED_DEVICE")?;
    let (transport, _) = MatrixTransport::relogin_password(
        &homeserver,
        &env::var("CODEVER_MATRIX_USERNAME")?,
        &env::var("CODEVER_MATRIX_PASSWORD")?,
        "Codever command smoke device",
        &trusted_device,
        env::var("CODEVER_TRUSTED_STORE")?,
        &env::var("CODEVER_TRUSTED_STORE_PASSPHRASE")?,
    )
    .await?;
    let room_id = env::var("CODEVER_CONTROL_ROOM")?.parse()?;
    let gateway_id = env::var("CODEVER_EXPECTED_GATEWAY")?;
    let private_key: ExecutionJwk = serde_json::from_slice(&fs::read(private_path)?)?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos();
    let request_id = format!("request_{nonce}");
    let idempotency_key = format!("inventory_{nonce}");
    let request = json!({
        "version": 1,
        "type": "client.gateway.request",
        "requestId": request_id,
        "idempotencyKey": idempotency_key,
        "payload": { "kind": "inventory.get" },
    });
    let token = sign_execution_token(
        &private_key,
        SignExecutionInput {
            request: request.clone(),
            gateway_id: gateway_id.clone(),
            issuer: format!("codever-control:{}", private_key.kid),
            subject: trusted_device,
            operation: "inventory.get".into(),
            ttl_seconds: Some(90),
        },
    )?;
    let mut events = transport.subscribe();
    let sync_transport = transport.clone();
    let sync_task = tokio::spawn(async move { sync_transport.sync().await });
    sleep(Duration::from_millis(500)).await;
    transport
        .send_raw(
            &room_id,
            COMMAND_EVENT_TYPE,
            &idempotency_key,
            json!({
                "version": 1,
                "type": "client.gateway.authorized-request",
                "request": request,
                "authorization": { "format": "cose-sign1-cwt", "token": token },
            }),
        )
        .await?;
    let response = timeout(Duration::from_secs(15), async {
        loop {
            let event = events.recv().await.context("Matrix event stream closed")?;
            if !event.encrypted || !event.verified_device {
                continue;
            }
            if event.event.get("type").and_then(Value::as_str) != Some(RESPONSE_EVENT_TYPE) {
                continue;
            }
            if event
                .event
                .pointer("/content/response/requestId")
                .and_then(Value::as_str)
                == Some(&request_id)
            {
                return Ok::<_, anyhow::Error>(event.event);
            }
        }
    })
    .await
    .context("Gateway command response timed out")??;
    transport.stop();
    let _ = timeout(Duration::from_secs(5), sync_task).await;
    let status = response
        .pointer("/content/response/status")
        .and_then(Value::as_str)
        .context("response status")?;
    if status != "completed" {
        bail!("Gateway rejected command: {response}")
    }
    println!(
        "{}",
        json!({ "gatewayId": gateway_id, "requestId": request_id, "status": status })
    );
    Ok(())
}

fn prepare_identity(private_path: &str, public_path: &str) -> Result<()> {
    let identity = generate_execution_identity();
    for path in [private_path, public_path] {
        if let Some(parent) = Path::new(path).parent() {
            fs::create_dir_all(parent)?;
        }
    }
    fs::write(
        private_path,
        serde_json::to_vec_pretty(&identity.private_key)?,
    )?;
    fs::write(
        public_path,
        serde_json::to_vec_pretty(&identity.public_key)?,
    )?;
    Ok(())
}
