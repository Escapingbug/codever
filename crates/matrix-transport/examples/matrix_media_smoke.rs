#![recursion_limit = "256"]

use anyhow::{Context, Result, ensure};
use codever_matrix_transport::MatrixTransport;
use serde_json::json;
use std::{
    env,
    time::{SystemTime, UNIX_EPOCH},
};

#[tokio::main]
async fn main() -> Result<()> {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let temporary = tempfile::Builder::new()
        .prefix("codever-matrix-media-smoke-")
        .tempdir()?;
    let directory = temporary.path();
    let source = directory.join("source.bin");
    let destination = directory.join("destination.bin");
    let content = (0..3 * 1024 * 1024 + 17)
        .map(|index| (index % 251) as u8)
        .collect::<Vec<_>>();
    std::fs::write(&source, &content)?;
    let (transport, session) = MatrixTransport::login_password(
        &env::var("CODEVER_MATRIX_HOMESERVER")?,
        &env::var("CODEVER_MATRIX_USERNAME")?,
        &env::var("CODEVER_MATRIX_PASSWORD")?,
        "Codever encrypted media smoke test",
        directory.join("matrix-store"),
        &format!("media-smoke-{nonce}"),
    )
    .await?;

    let encrypted = transport.upload_encrypted_file_path(&source).await?;
    let content_uri = encrypted.url.to_string();
    transport
        .download_encrypted_file(encrypted, &destination)
        .await?;
    let restored = std::fs::read(&destination).context("failed to read restored media")?;
    ensure!(
        restored == content,
        "Matrix encrypted media did not round-trip"
    );
    transport.stop();
    drop(transport);

    println!(
        "{}",
        json!({
            "deviceId": session.device_id,
            "contentUri": content_uri,
            "sizeBytes": content.len(),
            "verified": true,
        })
    );
    Ok(())
}
