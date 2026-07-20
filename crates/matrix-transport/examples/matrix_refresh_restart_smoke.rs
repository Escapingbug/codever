#![recursion_limit = "256"]

use anyhow::{Context, Result};
use codever_matrix_transport::{MatrixTransport, StoredMatrixSession};
use serde_json::json;
use std::{
    env,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

#[tokio::main]
async fn main() -> Result<()> {
    let homeserver = env::var("CODEVER_MATRIX_HOMESERVER")?;
    let username = env::var("CODEVER_MATRIX_USERNAME")?;
    let password = env::var("CODEVER_MATRIX_PASSWORD")?;
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let store = env::temp_dir().join(format!("codever-matrix-refresh-smoke-{nonce}"));
    let passphrase = format!("refresh-smoke-{nonce}");
    let (transport, initial) = MatrixTransport::login_password(
        &homeserver,
        &username,
        &password,
        "Codever refresh restart smoke",
        &store,
        &passphrase,
    )
    .await?;
    let persisted = Arc::new(Mutex::new(None::<StoredMatrixSession>));
    transport.install_session_persistence({
        let persisted = persisted.clone();
        move |session| {
            *persisted.lock().unwrap() = Some(session);
            Ok(())
        }
    })?;
    transport.refresh_access_token().await?;
    transport.ensure_session_persisted()?;
    let rotated = persisted
        .lock()
        .unwrap()
        .clone()
        .context("first refresh was not persisted")?;
    anyhow::ensure!(
        rotated.refresh_token != initial.refresh_token,
        "refresh token did not rotate"
    );
    drop(transport);

    let restored = MatrixTransport::restore(rotated.clone(), &store, &passphrase).await?;
    let persisted_again = Arc::new(Mutex::new(None::<StoredMatrixSession>));
    restored.install_session_persistence({
        let persisted_again = persisted_again.clone();
        move |session| {
            *persisted_again.lock().unwrap() = Some(session);
            Ok(())
        }
    })?;
    restored.refresh_access_token().await?;
    restored.ensure_session_persisted()?;
    let rotated_again = persisted_again
        .lock()
        .unwrap()
        .clone()
        .context("second refresh was not persisted")?;
    anyhow::ensure!(
        rotated_again.refresh_token != rotated.refresh_token,
        "restored refresh token did not rotate again"
    );
    drop(restored);
    let _ = std::fs::remove_dir_all(&store);

    println!(
        "{}",
        json!({
            "deviceId": initial.device_id,
            "firstRotationPersisted": true,
            "restartUsedRotatedToken": true,
            "secondRotationPersisted": true
        })
    );
    Ok(())
}
