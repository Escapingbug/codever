pub mod execution_auth;

use anyhow::{Context, Result, bail};
use futures_util::StreamExt;
pub use matrix_sdk::SessionChange;
use matrix_sdk::{
    Client, LoopCtrl, Room, RoomState, SessionTokens,
    authentication::matrix::MatrixSession,
    config::SyncSettings,
    deserialized_responses::{EncryptionInfo, VerificationState},
    encryption::{
        LocalTrust,
        verification::{Verification, VerificationRequest, VerificationRequestState},
    },
    ruma::{
        OwnedDeviceId, OwnedMxcUri, OwnedRoomId, OwnedUserId,
        api::client::{room::create_room, uiaa},
        assign,
        events::{
            AnySyncTimelineEvent, InitialStateEvent,
            key::verification::request::ToDeviceKeyVerificationRequestEvent,
            room::{EncryptedFile, encryption::RoomEncryptionEventContent},
        },
        serde::Raw,
    },
    store::RoomLoadSettings,
};
use matrix_sdk_base::SessionMeta;
use matrix_sdk_crypto::{AttachmentDecryptor, AttachmentEncryptor, MediaEncryptionInfo};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io,
    path::{Path, PathBuf},
    sync::{
        Arc, RwLock as StdRwLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tempfile::NamedTempFile;
use tokio::io::AsyncWriteExt;
use tokio::sync::{RwLock, broadcast};
use tokio_util::io::ReaderStream;

pub const COMMAND_EVENT_TYPE: &str = "io.codever.command.v1";
pub const RESPONSE_EVENT_TYPE: &str = "io.codever.response.v1";
pub const CONVERSATION_EVENT_TYPE: &str = "io.codever.conversation.v1";
pub const INVENTORY_EVENT_TYPE: &str = "io.codever.inventory.v1";
pub const GATEWAY_EVENT_TYPE: &str = "io.codever.gateway.v1";
pub const DISCOVERY_EVENT_TYPE: &str = "io.codever.discovery.v1";
pub const AUTHORIZATION_EVENT_TYPE: &str = "io.codever.authorization.v1";

#[derive(Deserialize)]
struct MatrixMediaUploadResponse {
    content_uri: OwnedMxcUri,
}

fn encrypt_to_temporary_file(path: &Path) -> Result<(NamedTempFile, MediaEncryptionInfo)> {
    let parent = path
        .parent()
        .context("Matrix media staging path has no parent")?;
    let mut input = File::open(path).with_context(|| {
        format!(
            "failed to open Matrix media staging file {}",
            path.display()
        )
    })?;
    let mut encrypted = NamedTempFile::new_in(parent)
        .context("failed to create encrypted Matrix media staging file")?;
    let mut encryptor = AttachmentEncryptor::new(&mut input);
    io::copy(&mut encryptor, encrypted.as_file_mut()).context("failed to encrypt Matrix media")?;
    let encryption = encryptor.finish();
    encrypted
        .as_file_mut()
        .sync_all()
        .context("failed to flush encrypted Matrix media")?;
    Ok((encrypted, encryption))
}

fn decrypt_to_destination(
    encrypted: NamedTempFile,
    file: EncryptedFile,
    destination: PathBuf,
) -> Result<()> {
    let parent = destination
        .parent()
        .context("Matrix media destination has no parent")?;
    let mut encrypted_input =
        File::open(encrypted.path()).context("failed to reopen downloaded Matrix media")?;
    let mut decryptor = AttachmentDecryptor::new(&mut encrypted_input, file.into())
        .context("Matrix media encryption metadata is invalid")?;
    let mut plaintext = NamedTempFile::new_in(parent)
        .context("failed to create Matrix media plaintext staging file")?;
    io::copy(&mut decryptor, plaintext.as_file_mut())
        .context("Matrix media authentication or decryption failed")?;
    plaintext
        .as_file_mut()
        .sync_all()
        .context("failed to flush decrypted Matrix media")?;
    plaintext
        .persist(&destination)
        .with_context(|| format!("failed to store Matrix media at {}", destination.display()))?;
    Ok(())
}
pub const CONTROL_ROOM_STATE_TYPE: &str = "io.codever.control.v1";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMatrixSession {
    pub homeserver: String,
    pub user_id: OwnedUserId,
    pub device_id: OwnedDeviceId,
    pub access_token: String,
    pub refresh_token: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportEvent {
    pub room_id: OwnedRoomId,
    pub event: Value,
    pub encrypted: bool,
    pub verified_device: bool,
    pub sender_device: Option<OwnedDeviceId>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationSnapshot {
    pub flow_id: String,
    pub stage: String,
    pub we_started: bool,
    pub other_device_id: Option<String>,
    pub emojis: Option<Vec<VerificationEmoji>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancellation: Option<VerificationCancellation>,
}

#[derive(Clone, Debug, Serialize)]
pub struct VerificationEmoji {
    pub symbol: String,
    pub description: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationCancellation {
    pub code: String,
    pub reason: String,
    pub cancelled_by_us: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixDeviceSnapshot {
    pub device_id: String,
    pub display_name: Option<String>,
    pub verified: bool,
    pub current: bool,
    pub verifiable: bool,
}

#[derive(Clone)]
pub struct MatrixTransport {
    client: Client,
    events: broadcast::Sender<TransportEvent>,
    sync_activity: broadcast::Sender<()>,
    stopped: Arc<AtomicBool>,
    verifications: Arc<RwLock<HashMap<String, VerificationRequest>>>,
    verification_devices: Arc<RwLock<HashMap<String, OwnedDeviceId>>>,
    locally_verified_devices: Arc<StdRwLock<HashSet<OwnedDeviceId>>>,
}

impl MatrixTransport {
    pub async fn login_password(
        homeserver: &str,
        username: &str,
        password: &str,
        device_display_name: &str,
        store_path: impl AsRef<Path>,
        store_passphrase: &str,
    ) -> Result<(Self, StoredMatrixSession)> {
        Self::login_password_for_device(
            homeserver,
            username,
            password,
            device_display_name,
            None,
            store_path,
            store_passphrase,
        )
        .await
    }

    pub async fn relogin_password(
        homeserver: &str,
        username: &str,
        password: &str,
        device_display_name: &str,
        device_id: &str,
        store_path: impl AsRef<Path>,
        store_passphrase: &str,
    ) -> Result<(Self, StoredMatrixSession)> {
        Self::login_password_for_device(
            homeserver,
            username,
            password,
            device_display_name,
            Some(device_id),
            store_path,
            store_passphrase,
        )
        .await
    }

    async fn login_password_for_device(
        homeserver: &str,
        username: &str,
        password: &str,
        device_display_name: &str,
        device_id: Option<&str>,
        store_path: impl AsRef<Path>,
        store_passphrase: &str,
    ) -> Result<(Self, StoredMatrixSession)> {
        if username.is_empty() || password.is_empty() {
            bail!("Matrix username and password are required");
        }
        if store_passphrase.is_empty() {
            bail!("Matrix store passphrase is required");
        }
        let client = Client::builder()
            .homeserver_url(homeserver)
            .sqlite_store(store_path, Some(store_passphrase))
            .handle_refresh_tokens()
            .build()
            .await
            .context("failed to open the persistent Matrix client")?;
        let login = client.matrix_auth().login_username(username, password);
        let login = if let Some(device_id) = device_id {
            login.device_id(device_id)
        } else {
            login
        };
        login
            .initial_device_display_name(device_display_name)
            .request_refresh_token()
            .send()
            .await
            .context("Matrix password login failed")?;
        if let Err(error) = client
            .encryption()
            .bootstrap_cross_signing_if_needed(None)
            .await
        {
            let response = error
                .as_uiaa_response()
                .context("failed to bootstrap Matrix cross-signing")?;
            let mut password_auth = uiaa::Password::new(
                uiaa::UserIdentifier::Matrix(uiaa::MatrixUserIdentifier::new(username.to_owned())),
                password.to_owned(),
            );
            password_auth.session = response.session.clone();
            client
                .encryption()
                .bootstrap_cross_signing(Some(uiaa::AuthData::Password(password_auth)))
                .await
                .context("Matrix rejected cross-signing bootstrap")?;
        }
        let session = client
            .matrix_auth()
            .session()
            .context("Matrix login returned no session")?;
        let stored = StoredMatrixSession {
            homeserver: homeserver.to_owned(),
            user_id: session.meta.user_id,
            device_id: session.meta.device_id,
            access_token: session.tokens.access_token,
            refresh_token: session.tokens.refresh_token,
        };
        Ok((Self::from_client(client).await?, stored))
    }

    pub async fn restore(
        session: StoredMatrixSession,
        store_path: impl AsRef<Path>,
        store_passphrase: &str,
    ) -> Result<Self> {
        if store_passphrase.is_empty() {
            bail!("Matrix store passphrase is required");
        }
        let client = Client::builder()
            .homeserver_url(&session.homeserver)
            .sqlite_store(store_path, Some(store_passphrase))
            .handle_refresh_tokens()
            .build()
            .await
            .context("failed to open the persistent Matrix client")?;
        client
            .matrix_auth()
            .restore_session(
                MatrixSession {
                    meta: SessionMeta {
                        user_id: session.user_id,
                        device_id: session.device_id,
                    },
                    tokens: SessionTokens {
                        access_token: session.access_token,
                        refresh_token: session.refresh_token,
                    },
                },
                RoomLoadSettings::default(),
            )
            .await
            .context("failed to restore the Matrix session")?;

        Self::from_client(client).await
    }

    async fn from_client(client: Client) -> Result<Self> {
        let (events, _) = broadcast::channel(1_024);
        let (sync_activity, _) = broadcast::channel(32);
        let transport = Self {
            client,
            events,
            sync_activity,
            stopped: Arc::new(AtomicBool::new(false)),
            verifications: Arc::new(RwLock::new(HashMap::new())),
            verification_devices: Arc::new(RwLock::new(HashMap::new())),
            locally_verified_devices: Arc::new(StdRwLock::new(HashSet::new())),
        };
        transport.install_event_handler();
        transport.refresh_locally_verified_devices().await?;
        Ok(transport)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<TransportEvent> {
        self.events.subscribe()
    }

    pub fn subscribe_to_session_changes(&self) -> broadcast::Receiver<SessionChange> {
        self.client.subscribe_to_session_changes()
    }

    pub fn subscribe_to_sync_activity(&self) -> broadcast::Receiver<()> {
        self.sync_activity.subscribe()
    }

    pub fn stored_session(&self) -> Option<StoredMatrixSession> {
        let session = self.client.matrix_auth().session()?;
        Some(StoredMatrixSession {
            homeserver: self.client.homeserver().to_string(),
            user_id: session.meta.user_id,
            device_id: session.meta.device_id,
            access_token: session.tokens.access_token,
            refresh_token: session.tokens.refresh_token,
        })
    }

    pub async fn ensure_control_room(&self) -> Result<OwnedRoomId> {
        self.client
            .sync_once(SyncSettings::default())
            .await
            .context("failed to synchronize Matrix rooms")?;
        for room in self.client.joined_rooms() {
            if room
                .get_state_event(CONTROL_ROOM_STATE_TYPE.into(), "")
                .await
                .context("failed to inspect Codever room state")?
                .is_some()
            {
                return Ok(room.room_id().to_owned());
            }
        }
        let encryption = InitialStateEvent::with_empty_state_key(
            RoomEncryptionEventContent::with_recommended_defaults(),
        )
        .to_raw_any();
        let request = assign!(create_room::v3::Request::new(), {
            name: Some("Codever".to_owned()),
            preset: Some(create_room::v3::RoomPreset::PrivateChat),
            initial_state: vec![encryption],
        });
        let room = self
            .client
            .create_room(request)
            .await
            .context("failed to create Codever control room")?;
        room.send_state_event_raw(
            CONTROL_ROOM_STATE_TYPE,
            "",
            serde_json::json!({ "version": 1, "purpose": "codever-control" }),
        )
        .await
        .context("failed to mark Codever control room")?;
        Ok(room.room_id().to_owned())
    }

    pub async fn request_device_verification(
        &self,
        device_id: &str,
    ) -> Result<VerificationSnapshot> {
        if let Some(existing) = self
            .verifications
            .read()
            .await
            .values()
            .map(verification_snapshot)
            .find(|snapshot| {
                snapshot.other_device_id.as_deref() == Some(device_id)
                    && !matches!(
                        snapshot.stage.as_str(),
                        "done" | "cancelled" | "unsupported"
                    )
            })
        {
            return Ok(existing);
        }
        let user_id = self
            .client
            .user_id()
            .context("Matrix client is not logged in")?;
        self.client
            .encryption()
            .request_user_identity(user_id)
            .await
            .context("failed to refresh Matrix device keys")?;
        let device = self
            .client
            .encryption()
            .get_device(user_id, device_id.into())
            .await?
            .context("Matrix device was not found")?;
        let request = device.request_verification().await?;
        let flow_id = request.flow_id().to_owned();
        self.verifications
            .write()
            .await
            .insert(flow_id, request.clone());
        self.remember_verification_device(&request).await;
        Ok(verification_snapshot(&request))
    }

    pub async fn devices(&self) -> Result<Vec<MatrixDeviceSnapshot>> {
        let user_id = self
            .client
            .user_id()
            .context("Matrix client is not logged in")?;
        let current_device = self.client.device_id();
        self.client
            .encryption()
            .request_user_identity(user_id)
            .await
            .context("failed to refresh Matrix device keys")?;
        let response = self.client.devices().await?;
        let mut devices = Vec::with_capacity(response.devices.len());
        for item in response.devices {
            let crypto_device = self
                .client
                .encryption()
                .get_device(user_id, &item.device_id)
                .await?;
            devices.push(MatrixDeviceSnapshot {
                current: current_device == Some(item.device_id.as_ref()),
                device_id: item.device_id.to_string(),
                display_name: item.display_name,
                verified: crypto_device
                    .as_ref()
                    .is_some_and(|value| value.is_verified()),
                verifiable: crypto_device.is_some(),
            });
        }
        Ok(devices)
    }

    pub async fn trust_device(&self, device_id: &str) -> Result<()> {
        let user_id = self
            .client
            .user_id()
            .context("Matrix client is not logged in")?;
        let device_id: OwnedDeviceId = device_id.into();
        self.client
            .encryption()
            .request_user_identity(user_id)
            .await
            .context("failed to refresh Matrix device keys")?;
        self.client
            .encryption()
            .get_device(user_id, &device_id)
            .await?
            .context("Matrix device was not found")?
            .set_local_trust(LocalTrust::Verified)
            .await?;
        self.locally_verified_devices
            .write()
            .expect("local trust lock poisoned")
            .insert(device_id);
        Ok(())
    }

    async fn refresh_locally_verified_devices(&self) -> Result<()> {
        let user_id = self
            .client
            .user_id()
            .context("Matrix client is not logged in")?;
        let response = self.client.devices().await?;
        let mut verified = HashSet::new();
        for item in response.devices {
            if self
                .client
                .encryption()
                .get_device(user_id, &item.device_id)
                .await?
                .is_some_and(|device| device.is_verified())
            {
                verified.insert(item.device_id);
            }
        }
        *self
            .locally_verified_devices
            .write()
            .expect("local trust lock poisoned") = verified;
        Ok(())
    }

    pub async fn verification_requests(&self) -> Result<Vec<VerificationSnapshot>> {
        let requests: Vec<_> = self.verifications.read().await.values().cloned().collect();
        let mut snapshots = Vec::with_capacity(requests.len());
        for request in requests {
            self.remember_verification_device(&request).await;
            self.persist_completed_verification_trust(&request).await?;
            snapshots.push(verification_snapshot(&request));
        }
        Ok(snapshots)
    }

    pub async fn advance_verification(&self, flow_id: &str) -> Result<VerificationSnapshot> {
        let request = self
            .verifications
            .read()
            .await
            .get(flow_id)
            .cloned()
            .context("Matrix verification request was not found")?;
        self.remember_verification_device(&request).await;
        match request.state() {
            VerificationRequestState::Requested { .. } => request.accept().await?,
            VerificationRequestState::Ready { .. } if request.we_started() => {
                request
                    .start_sas()
                    .await?
                    .context("SAS verification could not be started")?;
            }
            VerificationRequestState::Transitioned {
                verification: Verification::SasV1(sas),
            } if !sas.we_started() && !sas.can_be_presented() => sas.accept().await?,
            _ => {}
        }
        self.persist_completed_verification_trust(&request).await?;
        Ok(verification_snapshot(&request))
    }

    pub async fn confirm_verification(
        &self,
        flow_id: &str,
        matches: bool,
    ) -> Result<VerificationSnapshot> {
        let request = self
            .verifications
            .read()
            .await
            .get(flow_id)
            .cloned()
            .context("Matrix verification request was not found")?;
        self.remember_verification_device(&request).await;
        let sas = match request.state() {
            VerificationRequestState::Transitioned {
                verification: Verification::SasV1(sas),
            } => sas,
            _ => bail!("SAS verification is not ready for confirmation"),
        };
        if sas.emoji().is_none() {
            bail!("SAS verification has no short authentication string yet");
        }
        if matches {
            sas.confirm().await?;
        } else {
            sas.mismatch().await?
        }
        self.persist_completed_verification_trust(&request).await?;
        Ok(verification_snapshot(&request))
    }

    async fn remember_verification_device(&self, request: &VerificationRequest) {
        if let Some(device_id) = verification_device_id(request) {
            self.verification_devices
                .write()
                .await
                .insert(request.flow_id().to_owned(), device_id);
        }
    }

    async fn persist_completed_verification_trust(
        &self,
        request: &VerificationRequest,
    ) -> Result<()> {
        let snapshot = verification_snapshot(request);
        if !verification_stage_allows_trust(&snapshot.stage) {
            return Ok(());
        }
        let device_id = self
            .verification_devices
            .read()
            .await
            .get(request.flow_id())
            .cloned()
            .context("Completed Matrix verification has no peer device")?;
        if self
            .locally_verified_devices
            .read()
            .expect("local trust lock poisoned")
            .contains(&device_id)
        {
            return Ok(());
        }
        // A Gateway intentionally does not hold the account's cross-signing
        // private keys. Persist SAS trust only after both devices completed it.
        let user_id = self
            .client
            .user_id()
            .context("Matrix client is not logged in")?;
        self.client
            .encryption()
            .get_device(user_id, &device_id)
            .await?
            .context("Verified Matrix device disappeared before trust was persisted")?
            .set_local_trust(LocalTrust::Verified)
            .await?;
        self.locally_verified_devices
            .write()
            .expect("local trust lock poisoned")
            .insert(device_id);
        Ok(())
    }

    pub async fn cancel_verification(&self, flow_id: &str) -> Result<()> {
        let request = self
            .verifications
            .read()
            .await
            .get(flow_id)
            .cloned()
            .context("Matrix verification request was not found")?;
        request.cancel().await?;
        Ok(())
    }

    pub async fn send_raw(
        &self,
        room_id: &OwnedRoomId,
        event_type: &str,
        transaction_id: &str,
        content: Value,
    ) -> Result<String> {
        validate_event_type(event_type)?;
        if transaction_id.is_empty() {
            bail!("Matrix transaction ID is required");
        }
        let room = self
            .client
            .get_room(room_id)
            .context("Matrix room is not known locally")?;
        if room.state() != RoomState::Joined {
            bail!("Matrix room is not joined");
        }
        let response = tokio::time::timeout(
            Duration::from_secs(20),
            room.send_raw(event_type, content)
                .with_transaction_id(transaction_id.into()),
        )
        .await
        .context("Matrix event send timed out")?
        .context("failed to send the Matrix event")?;
        Ok(response.response.event_id.to_string())
    }

    /// Encrypts a local file using the Matrix encrypted-media format and uploads
    /// only ciphertext to the homeserver. The returned key metadata must travel
    /// inside an encrypted and independently authorized Codever command.
    pub async fn upload_encrypted_file_path(
        &self,
        path: impl AsRef<Path>,
    ) -> Result<EncryptedFile> {
        let path = path.as_ref().to_owned();
        let (encrypted, encryption) =
            tokio::task::spawn_blocking(move || encrypt_to_temporary_file(&path))
                .await
                .context("Matrix media encryption worker stopped")??;
        let size = encrypted
            .as_file()
            .metadata()
            .context("failed to inspect encrypted Matrix media")?
            .len();
        let stream = ReaderStream::new(
            tokio::fs::File::open(encrypted.path())
                .await
                .context("failed to open encrypted Matrix media")?,
        );
        let access_token = self
            .client
            .access_token()
            .context("Matrix access token is unavailable")?;
        let upload_url = self
            .client
            .homeserver()
            .join("_matrix/media/v3/upload")
            .context("failed to construct the Matrix media upload URL")?;
        let response = reqwest::Client::new()
            .post(upload_url)
            .bearer_auth(access_token)
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .header(reqwest::header::CONTENT_LENGTH, size)
            .body(reqwest::Body::wrap_stream(stream))
            .send()
            .await
            .context("failed to upload encrypted Matrix media")?
            .error_for_status()
            .context("Matrix rejected the encrypted media upload")?
            .json::<MatrixMediaUploadResponse>()
            .await
            .context("Matrix returned an invalid media upload response")?;
        Ok(EncryptedFile::new(
            response.content_uri,
            encryption.encryption_info,
            encryption.hashes,
        ))
    }

    /// Downloads and authenticates standard Matrix encrypted media, then writes
    /// its plaintext to a caller-owned staging path.
    pub async fn download_encrypted_file(
        &self,
        file: EncryptedFile,
        destination: impl AsRef<Path>,
    ) -> Result<()> {
        let destination = destination.as_ref().to_owned();
        let staging_directory = destination
            .parent()
            .context("Matrix media destination has no parent")?;
        let (server_name, media_id) = file
            .url
            .parts()
            .context("Matrix encrypted media has an invalid MXC URI")?;
        let mut download_url = self.client.homeserver();
        download_url.set_query(None);
        download_url.set_fragment(None);
        download_url
            .path_segments_mut()
            .map_err(|_| anyhow::anyhow!("Matrix homeserver URL cannot contain media paths"))?
            .clear()
            .extend([
                "_matrix",
                "client",
                "v1",
                "media",
                "download",
                server_name.as_str(),
                media_id,
            ]);
        let access_token = self
            .client
            .access_token()
            .context("Matrix access token is unavailable")?;
        let response = reqwest::Client::new()
            .get(download_url)
            .bearer_auth(access_token)
            .send()
            .await
            .context("failed to download Matrix encrypted media")?
            .error_for_status()
            .context("Matrix rejected the encrypted media download")?;
        let encrypted = NamedTempFile::new_in(staging_directory)
            .context("failed to stage Matrix encrypted media")?;
        let mut encrypted_output = tokio::fs::File::create(encrypted.path())
            .await
            .context("failed to open the Matrix media download staging file")?;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            encrypted_output
                .write_all(&chunk.context("Matrix media download was interrupted")?)
                .await
                .context("failed to stage downloaded Matrix media")?;
        }
        encrypted_output
            .flush()
            .await
            .context("failed to flush downloaded Matrix media")?;
        drop(encrypted_output);

        tokio::task::spawn_blocking(move || decrypt_to_destination(encrypted, file, destination))
            .await
            .context("Matrix media decryption worker stopped")??;
        Ok(())
    }

    pub async fn sync(&self) -> Result<()> {
        let stopped = self.stopped.clone();
        let sync_activity = self.sync_activity.clone();
        self.client
            .sync_with_callback(Default::default(), move |_| {
                let stopped = stopped.clone();
                let sync_activity = sync_activity.clone();
                async move {
                    let _ = sync_activity.send(());
                    if stopped.load(Ordering::Acquire) {
                        LoopCtrl::Break
                    } else {
                        LoopCtrl::Continue
                    }
                }
            })
            .await
            .context("Matrix sync stopped")
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
    }

    pub fn client(&self) -> &Client {
        &self.client
    }

    fn install_event_handler(&self) {
        let sender = self.events.clone();
        let locally_verified_devices = self.locally_verified_devices.clone();
        self.client.add_event_handler(
            move |raw: Raw<AnySyncTimelineEvent>,
                  room: Room,
                  encryption: Option<EncryptionInfo>| {
                let sender = sender.clone();
                let locally_verified_devices = locally_verified_devices.clone();
                async move {
                    let Ok(event) = serde_json::from_str::<Value>(raw.json().get()) else {
                        return;
                    };
                    let encrypted = encryption.is_some();
                    let cross_signing_verified = encryption.as_ref().is_some_and(|value| {
                        matches!(value.verification_state, VerificationState::Verified)
                    });
                    let sender_device = encryption.and_then(|value| value.sender_device);
                    let verified_device = sender_is_verified(
                        cross_signing_verified,
                        sender_device.as_ref(),
                        &locally_verified_devices
                            .read()
                            .expect("local trust lock poisoned"),
                    );
                    let _ = sender.send(TransportEvent {
                        room_id: room.room_id().to_owned(),
                        event,
                        encrypted,
                        verified_device,
                        sender_device,
                    });
                }
            },
        );
        let client = self.client.clone();
        let verifications = self.verifications.clone();
        self.client
            .add_event_handler(move |event: ToDeviceKeyVerificationRequestEvent| {
                let client = client.clone();
                let verifications = verifications.clone();
                async move {
                    if let Some(request) = client
                        .encryption()
                        .get_verification_request(
                            &event.sender,
                            event.content.transaction_id.as_str(),
                        )
                        .await
                    {
                        verifications
                            .write()
                            .await
                            .insert(request.flow_id().to_owned(), request);
                    }
                }
            });
    }
}

fn verification_snapshot(request: &VerificationRequest) -> VerificationSnapshot {
    let mut cancellation = None;
    let (stage, other_device_id, emojis) = match request.state() {
        VerificationRequestState::Created { .. } => ("created", None, None),
        VerificationRequestState::Requested {
            other_device_data, ..
        } => (
            "requested",
            Some(other_device_data.device_id().to_string()),
            None,
        ),
        VerificationRequestState::Ready {
            other_device_data, ..
        } => (
            "ready",
            Some(other_device_data.device_id().to_string()),
            None,
        ),
        VerificationRequestState::Transitioned {
            verification: Verification::SasV1(sas),
        } => {
            let stage = if sas.is_done() {
                "done"
            } else if sas.is_cancelled() {
                "cancelled"
            } else if sas.can_be_presented() {
                "present_sas"
            } else {
                "sas"
            };
            let emojis = sas.emoji().map(|values| {
                values
                    .into_iter()
                    .map(|emoji| VerificationEmoji {
                        symbol: emoji.symbol.to_owned(),
                        description: emoji.description.to_owned(),
                    })
                    .collect()
            });
            (
                stage,
                Some(sas.other_device().device_id().to_string()),
                emojis,
            )
        }
        VerificationRequestState::Done => ("done", None, None),
        VerificationRequestState::Cancelled(info) => {
            cancellation = Some(VerificationCancellation {
                code: info.cancel_code().as_str().to_owned(),
                reason: info.reason().to_owned(),
                cancelled_by_us: info.cancelled_by_us(),
            });
            ("cancelled", None, None)
        }
        _ => ("unsupported", None, None),
    };
    VerificationSnapshot {
        flow_id: request.flow_id().to_owned(),
        stage: stage.to_owned(),
        we_started: request.we_started(),
        other_device_id,
        emojis,
        cancellation,
    }
}

fn verification_device_id(request: &VerificationRequest) -> Option<OwnedDeviceId> {
    match request.state() {
        VerificationRequestState::Requested {
            other_device_data, ..
        }
        | VerificationRequestState::Ready {
            other_device_data, ..
        } => Some(other_device_data.device_id().to_owned()),
        VerificationRequestState::Transitioned {
            verification: Verification::SasV1(sas),
        } => Some(sas.other_device().device_id().to_owned()),
        _ => None,
    }
}

fn verification_stage_allows_trust(stage: &str) -> bool {
    stage == "done"
}

pub fn validate_event_type(event_type: &str) -> Result<()> {
    if matches!(
        event_type,
        COMMAND_EVENT_TYPE
            | RESPONSE_EVENT_TYPE
            | CONVERSATION_EVENT_TYPE
            | INVENTORY_EVENT_TYPE
            | GATEWAY_EVENT_TYPE
            | DISCOVERY_EVENT_TYPE
            | AUTHORIZATION_EVENT_TYPE
    ) {
        Ok(())
    } else {
        bail!("unsupported Codever Matrix event type")
    }
}

fn sender_is_verified(
    cross_signing_verified: bool,
    sender_device: Option<&OwnedDeviceId>,
    locally_verified_devices: &HashSet<OwnedDeviceId>,
) -> bool {
    cross_signing_verified
        || sender_device.is_some_and(|device_id| locally_verified_devices.contains(device_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Seek, SeekFrom, Write};

    #[test]
    fn only_codever_event_types_cross_the_native_boundary() {
        for event_type in [
            COMMAND_EVENT_TYPE,
            RESPONSE_EVENT_TYPE,
            CONVERSATION_EVENT_TYPE,
            INVENTORY_EVENT_TYPE,
            GATEWAY_EVENT_TYPE,
            DISCOVERY_EVENT_TYPE,
            AUTHORIZATION_EVENT_TYPE,
        ] {
            validate_event_type(event_type).unwrap();
        }
        assert!(validate_event_type("m.room.message").is_err());
        assert!(validate_event_type("io.attacker.command").is_err());
    }

    #[test]
    fn persisted_local_device_trust_authorizes_events_after_transport_restart() {
        let verified: OwnedDeviceId = "PHONEDEVICE".into();
        let unknown: OwnedDeviceId = "ATTACKER".into();
        let locally_verified = HashSet::from([verified.clone()]);

        assert!(sender_is_verified(
            false,
            Some(&verified),
            &locally_verified
        ));
        assert!(sender_is_verified(true, Some(&unknown), &HashSet::new()));
        assert!(!sender_is_verified(
            false,
            Some(&unknown),
            &locally_verified
        ));
        assert!(!sender_is_verified(false, None, &locally_verified));
    }

    #[test]
    fn local_trust_requires_bilateral_verification_completion() {
        for stage in [
            "created",
            "requested",
            "ready",
            "sas",
            "present_sas",
            "cancelled",
        ] {
            assert!(
                !verification_stage_allows_trust(stage),
                "stage {stage} must not persist trust"
            );
        }
        assert!(verification_stage_allows_trust("done"));
    }

    #[test]
    fn matrix_media_streams_through_disk_and_round_trips() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.bin");
        let destination = directory.path().join("destination.bin");
        let content = vec![0x5a; 2 * 1024 * 1024 + 17];
        std::fs::write(&source, &content).unwrap();
        let (encrypted, encryption) = encrypt_to_temporary_file(&source).unwrap();
        assert_eq!(
            encrypted.as_file().metadata().unwrap().len(),
            content.len() as u64
        );
        let file = EncryptedFile::new(
            "mxc://matrix.example/media".try_into().unwrap(),
            encryption.encryption_info,
            encryption.hashes,
        );

        decrypt_to_destination(encrypted, file, destination.clone()).unwrap();

        assert_eq!(std::fs::read(destination).unwrap(), content);
    }

    #[test]
    fn matrix_media_rejects_tampered_ciphertext_without_plaintext_output() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.bin");
        let destination = directory.path().join("destination.bin");
        std::fs::write(&source, b"authenticated attachment").unwrap();
        let (mut encrypted, encryption) = encrypt_to_temporary_file(&source).unwrap();
        let mut first = [0_u8; 1];
        encrypted.as_file_mut().seek(SeekFrom::Start(0)).unwrap();
        encrypted.as_file_mut().read_exact(&mut first).unwrap();
        first[0] ^= 0xff;
        encrypted.as_file_mut().seek(SeekFrom::Start(0)).unwrap();
        encrypted.as_file_mut().write_all(&first).unwrap();
        encrypted.as_file_mut().sync_all().unwrap();
        let file = EncryptedFile::new(
            "mxc://matrix.example/tampered".try_into().unwrap(),
            encryption.encryption_info,
            encryption.hashes,
        );

        assert!(decrypt_to_destination(encrypted, file, destination.clone()).is_err());
        assert!(!destination.exists());
    }
}
