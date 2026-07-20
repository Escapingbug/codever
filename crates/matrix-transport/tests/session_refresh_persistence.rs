use anyhow::{Result, bail};
use codever_matrix_transport::{MatrixTransport, StoredMatrixSession};
use matrix_sdk::ruma::{device_id, user_id};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use tempfile::tempdir;
use wiremock::{
    Mock, MockServer, Request, Respond, ResponseTemplate,
    matchers::{body_json, method, path},
};

#[derive(Clone)]
struct ExpiredThenHealthyDevices {
    calls: Arc<AtomicUsize>,
}

impl Respond for ExpiredThenHealthyDevices {
    fn respond(&self, _: &Request) -> ResponseTemplate {
        if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
            ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "errcode": "M_UNKNOWN_TOKEN",
                "error": "Access token expired",
                "soft_logout": false
            }))
        } else {
            ResponseTemplate::new(200).set_body_json(serde_json::json!({ "devices": [] }))
        }
    }
}

fn session(homeserver: String) -> StoredMatrixSession {
    StoredMatrixSession {
        homeserver,
        user_id: user_id!("@codever:example.test").to_owned(),
        device_id: device_id!("MOBILE").to_owned(),
        access_token: "old-access".into(),
        refresh_token: Some("old-refresh".into()),
    }
}

async fn restored_transport(server: &MockServer) -> Result<MatrixTransport> {
    Mock::given(method("GET"))
        .and(path("/_matrix/client/versions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "versions": ["v1.11"],
            "unstable_features": {}
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/_matrix/client/v3/devices"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "devices": []
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/_matrix/client/v3/user/@codever:example.test/account_data/m.secret_storage.default_key"))
        .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
            "errcode": "M_NOT_FOUND",
            "error": "No secret storage key"
        })))
        .mount(server)
        .await;
    let store = tempdir()?;
    // Keep the temporary SQLite store alive for the lifetime of this test process.
    let store_path = store.keep();
    MatrixTransport::restore(session(server.uri()), store_path, "test-passphrase").await
}

async fn mount_rotated_tokens(server: &MockServer) {
    Mock::given(method("POST"))
        .and(path("/_matrix/client/v3/refresh"))
        .and(body_json(
            serde_json::json!({ "refresh_token": "old-refresh" }),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "new-access",
            "refresh_token": "new-refresh",
            "expires_in_ms": 300_000
        })))
        .expect(1)
        .mount(server)
        .await;
}

#[tokio::test]
async fn rotated_refresh_token_is_durable_before_refresh_returns() -> Result<()> {
    let server = MockServer::start().await;
    mount_rotated_tokens(&server).await;
    let transport = restored_transport(&server).await?;
    let saved = Arc::new(Mutex::new(Vec::new()));
    transport.install_session_persistence({
        let saved = saved.clone();
        move |session| {
            saved.lock().unwrap().push(session);
            Ok(())
        }
    })?;

    transport.refresh_access_token().await?;

    let saved = saved.lock().unwrap();
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0].access_token, "new-access");
    assert_eq!(saved[0].refresh_token.as_deref(), Some("new-refresh"));
    transport.ensure_session_persisted()?;
    Ok(())
}

#[tokio::test]
async fn persistence_failure_blocks_clean_shutdown_until_checkpoint_succeeds() -> Result<()> {
    let server = MockServer::start().await;
    mount_rotated_tokens(&server).await;
    let transport = restored_transport(&server).await?;
    let attempts = Arc::new(AtomicUsize::new(0));
    transport.install_session_persistence({
        let attempts = attempts.clone();
        move |_| {
            if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                bail!("credential store temporarily unavailable");
            }
            Ok(())
        }
    })?;

    // matrix-sdk 0.18 logs callback failures instead of failing refresh. Codever must
    // retain that failure and refuse to call the lifecycle clean until it checkpoints.
    transport.refresh_access_token().await?;
    assert!(transport.ensure_session_persisted().is_err());
    transport.checkpoint_session()?;
    transport.ensure_session_persisted()?;
    assert_eq!(attempts.load(Ordering::SeqCst), 2);
    Ok(())
}

#[tokio::test]
async fn concurrent_refreshes_publish_only_the_latest_durable_generation() -> Result<()> {
    let server = MockServer::start().await;
    mount_rotated_tokens(&server).await;
    let transport = restored_transport(&server).await?;
    let saved = Arc::new(Mutex::new(Vec::new()));
    transport.install_session_persistence({
        let saved = saved.clone();
        move |session| {
            saved
                .lock()
                .unwrap()
                .push((session.access_token, session.refresh_token));
            Ok(())
        }
    })?;

    let (left, right) = tokio::join!(
        transport.refresh_access_token(),
        transport.refresh_access_token()
    );
    left?;
    right?;
    transport.ensure_session_persisted()?;

    let saved = saved.lock().unwrap();
    assert_eq!(
        saved.as_slice(),
        &[("new-access".into(), Some("new-refresh".into()))]
    );
    Ok(())
}

#[tokio::test]
async fn process_restart_restores_the_rotated_refresh_token_not_the_install_token() -> Result<()> {
    let server = MockServer::start().await;
    mount_rotated_tokens(&server).await;
    let transport = restored_transport(&server).await?;
    let saved = Arc::new(Mutex::new(None));
    transport.install_session_persistence({
        let saved = saved.clone();
        move |session| {
            *saved.lock().unwrap() = Some(session);
            Ok(())
        }
    })?;
    transport.refresh_access_token().await?;
    let restarted_session = saved
        .lock()
        .unwrap()
        .clone()
        .expect("rotated session persisted");
    drop(transport);

    Mock::given(method("POST"))
        .and(path("/_matrix/client/v3/refresh"))
        .and(body_json(
            serde_json::json!({ "refresh_token": "new-refresh" }),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "newer-access",
            "refresh_token": "newer-refresh",
            "expires_in_ms": 300_000
        })))
        .expect(1)
        .mount(&server)
        .await;
    let store = tempdir()?;
    let restarted =
        MatrixTransport::restore(restarted_session, store.keep(), "restart-passphrase").await?;
    restarted.install_session_persistence(|_| Ok(()))?;
    restarted.refresh_access_token().await?;
    assert_eq!(
        restarted.stored_session().unwrap().refresh_token.as_deref(),
        Some("newer-refresh")
    );
    Ok(())
}

#[tokio::test]
async fn automatic_refresh_during_restore_is_durable_before_an_abrupt_process_exit() -> Result<()> {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/_matrix/client/versions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "versions": ["v1.11"],
            "unstable_features": {}
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/_matrix/client/v3/devices"))
        .respond_with(ExpiredThenHealthyDevices {
            calls: Arc::new(AtomicUsize::new(0)),
        })
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/_matrix/client/v3/user/@codever:example.test/account_data/m.secret_storage.default_key"))
        .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
            "errcode": "M_NOT_FOUND",
            "error": "No secret storage key"
        })))
        .mount(&server)
        .await;
    mount_rotated_tokens(&server).await;

    let persisted = Arc::new(Mutex::new(None));
    let persistence_attempts = Arc::new(AtomicUsize::new(0));
    let store = tempdir()?;
    let transport = MatrixTransport::restore_with_session_persistence(
        session(server.uri()),
        store.keep(),
        "restore-refresh-passphrase",
        {
            let persisted = persisted.clone();
            let persistence_attempts = persistence_attempts.clone();
            move |session| {
                if persistence_attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                    bail!("simulated KeyStore interruption during automatic refresh");
                }
                *persisted.lock().unwrap() = Some(session);
                Ok(())
            }
        },
    )
    .await?;
    assert_eq!(persistence_attempts.load(Ordering::SeqCst), 2);
    let restarted_session = persisted
        .lock()
        .unwrap()
        .clone()
        .expect("automatic refresh during restore was persisted");
    assert_eq!(restarted_session.access_token, "new-access");
    assert_eq!(
        restarted_session.refresh_token.as_deref(),
        Some("new-refresh")
    );

    // Simulate Android killing the process without invoking matrix_close.
    drop(transport);

    Mock::given(method("POST"))
        .and(path("/_matrix/client/v3/refresh"))
        .and(body_json(
            serde_json::json!({ "refresh_token": "new-refresh" }),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "newer-access",
            "refresh_token": "newer-refresh",
            "expires_in_ms": 300_000
        })))
        .expect(1)
        .mount(&server)
        .await;
    let restarted_store = tempdir()?;
    let restarted = MatrixTransport::restore(
        restarted_session,
        restarted_store.keep(),
        "restart-after-kill-passphrase",
    )
    .await?;
    restarted.install_session_persistence(|_| Ok(()))?;
    restarted.refresh_access_token().await?;
    assert_eq!(
        restarted.stored_session().unwrap().refresh_token.as_deref(),
        Some("newer-refresh")
    );
    Ok(())
}
