#![recursion_limit = "256"]

use anyhow::{Context, Result};
use codever_matrix_transport::{DISCOVERY_EVENT_TYPE, GATEWAY_EVENT_TYPE, MatrixTransport};
use serde_json::{Value, json};
use std::{
    env,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::time::timeout;

#[tokio::main]
async fn main() -> Result<()> {
    let homeserver = env::var("CODEVER_MATRIX_HOMESERVER")?;
    let (transport, _) = MatrixTransport::relogin_password(
        &homeserver,
        &env::var("CODEVER_MATRIX_USERNAME")?,
        &env::var("CODEVER_MATRIX_PASSWORD")?,
        "Codever discovery smoke device",
        &env::var("CODEVER_TRUSTED_DEVICE")?,
        env::var("CODEVER_TRUSTED_STORE")?,
        &env::var("CODEVER_TRUSTED_STORE_PASSPHRASE")?,
    )
    .await?;
    let room_id = env::var("CODEVER_CONTROL_ROOM")?.parse()?;
    let expected_gateway = env::var("CODEVER_EXPECTED_GATEWAY")?;
    let mut events = transport.subscribe();
    let sync_transport = transport.clone();
    let sync_task = tokio::spawn(async move { sync_transport.sync().await });
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    transport
        .send_raw(
            &room_id,
            DISCOVERY_EVENT_TYPE,
            &format!("discovery-smoke-{nonce}"),
            json!({ "version": 1, "requestId": format!("discover_{nonce}") }),
        )
        .await?;
    timeout(Duration::from_secs(10), async {
        loop {
            let event = events.recv().await.context("Matrix event stream closed")?;
            if !event.encrypted || !event.verified_device {
                continue;
            }
            let event_type = event.event.get("type").and_then(Value::as_str);
            let gateway_id = event
                .event
                .pointer("/content/gateway/id")
                .and_then(Value::as_str);
            let has_device_id = event
                .event
                .pointer("/content/gateway/capabilities/metadata/matrixDeviceId")
                .is_some();
            if event_type == Some(GATEWAY_EVENT_TYPE)
                && gateway_id == Some(&expected_gateway)
                && has_device_id
            {
                return Ok::<_, anyhow::Error>(event.event);
            }
        }
    })
    .await
    .context("Gateway discovery response timed out")??;
    transport.stop();
    let _ = timeout(Duration::from_secs(5), sync_task).await;
    println!(
        "{}",
        json!({ "discovered": expected_gateway, "encrypted": true, "verified": true })
    );
    Ok(())
}
