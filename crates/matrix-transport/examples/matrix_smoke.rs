#![recursion_limit = "256"]

use anyhow::{Context, Result, bail};
use codever_matrix_transport::{INVENTORY_EVENT_TYPE, MatrixTransport};
use serde_json::json;
use std::{
    env, process,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::time::timeout;

#[tokio::main]
async fn main() -> Result<()> {
    let homeserver = env::var("CODEVER_MATRIX_HOMESERVER")?;
    let username = env::var("CODEVER_MATRIX_USERNAME")?;
    let password = env::var("CODEVER_MATRIX_PASSWORD")?;
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let store = env::temp_dir().join(format!("codever-matrix-smoke-{}-{nonce}", process::id()));
    let (transport, session) = MatrixTransport::login_password(
        &homeserver,
        &username,
        &password,
        "Codever transport smoke test",
        &store,
        &format!("smoke-{nonce}"),
    )
    .await?;
    let room_id = transport.ensure_control_room().await?;
    let mut events = transport.subscribe();
    let syncing = transport.clone();
    let sync_task = tokio::spawn(async move { syncing.sync().await });
    let transaction_id = format!("smoke-{nonce}");
    transport
        .send_raw(
            &room_id,
            INVENTORY_EVENT_TYPE,
            &transaction_id,
            json!({ "smoke": transaction_id }),
        )
        .await?;

    let received = timeout(Duration::from_secs(30), async {
        loop {
            let event = events.recv().await.context("Matrix event stream closed")?;
            if event.event.get("type").and_then(|value| value.as_str())
                == Some(INVENTORY_EVENT_TYPE)
                && event
                    .event
                    .get("content")
                    .and_then(|value| value.get("smoke"))
                    == Some(&json!(transaction_id))
            {
                return Ok::<_, anyhow::Error>(event);
            }
        }
    })
    .await
    .context("timed out waiting for encrypted Matrix event")??;
    if !received.encrypted || !received.verified_device {
        bail!("smoke event was not encrypted and verified");
    }
    transport.stop();
    let _ = timeout(Duration::from_secs(5), sync_task).await;
    println!(
        "{}",
        json!({
            "userId": session.user_id,
            "deviceId": session.device_id,
            "roomId": room_id,
            "encrypted": received.encrypted,
            "verifiedDevice": received.verified_device,
        })
    );
    Ok(())
}
