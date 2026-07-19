pub mod execution_auth;

use anyhow::{Context, Result, bail};
pub use matrix_sdk::SessionChange;
use matrix_sdk::{
    Client, LoopCtrl, Room, RoomState, SessionTokens,
    authentication::matrix::MatrixSession,
    config::SyncSettings,
    deserialized_responses::{EncryptionInfo, VerificationState},
    encryption::verification::{Verification, VerificationRequest, VerificationRequestState},
    ruma::{
        OwnedDeviceId, OwnedRoomId, OwnedUserId,
        api::client::{room::create_room, uiaa},
        assign,
        events::{
            AnySyncTimelineEvent, InitialStateEvent,
            key::verification::request::ToDeviceKeyVerificationRequestEvent,
            room::encryption::RoomEncryptionEventContent,
        },
        serde::Raw,
    },
    store::RoomLoadSettings,
};
use matrix_sdk_base::SessionMeta;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::{RwLock, broadcast};

pub const COMMAND_EVENT_TYPE: &str = "io.codever.command.v1";
pub const RESPONSE_EVENT_TYPE: &str = "io.codever.response.v1";
pub const CONVERSATION_EVENT_TYPE: &str = "io.codever.conversation.v1";
pub const INVENTORY_EVENT_TYPE: &str = "io.codever.inventory.v1";
pub const SESSION_EVENT_TYPE: &str = "io.codever.session.v1";
pub const GATEWAY_EVENT_TYPE: &str = "io.codever.gateway.v1";
pub const DISCOVERY_EVENT_TYPE: &str = "io.codever.discovery.v1";
pub const AUTHORIZATION_EVENT_TYPE: &str = "io.codever.authorization.v1";
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
}

#[derive(Clone)]
pub struct MatrixTransport {
    client: Client,
    events: broadcast::Sender<TransportEvent>,
    stopped: Arc<AtomicBool>,
    verifications: Arc<RwLock<HashMap<String, VerificationRequest>>>,
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
        Ok((Self::from_client(client), stored))
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

        Ok(Self::from_client(client))
    }

    fn from_client(client: Client) -> Self {
        let (events, _) = broadcast::channel(1_024);
        let transport = Self {
            client,
            events,
            stopped: Arc::new(AtomicBool::new(false)),
            verifications: Arc::new(RwLock::new(HashMap::new())),
        };
        transport.install_event_handler();
        transport
    }

    pub fn subscribe(&self) -> broadcast::Receiver<TransportEvent> {
        self.events.subscribe()
    }

    pub fn subscribe_to_session_changes(&self) -> broadcast::Receiver<SessionChange> {
        self.client.subscribe_to_session_changes()
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
        let user_id = self
            .client
            .user_id()
            .context("Matrix client is not logged in")?;
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
        Ok(verification_snapshot(&request))
    }

    pub async fn devices(&self) -> Result<Vec<MatrixDeviceSnapshot>> {
        let user_id = self
            .client
            .user_id()
            .context("Matrix client is not logged in")?;
        let current_device = self.client.device_id();
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
                verified: crypto_device.is_some_and(|value| value.is_verified()),
            });
        }
        Ok(devices)
    }

    pub async fn verification_requests(&self) -> Vec<VerificationSnapshot> {
        self.verifications
            .read()
            .await
            .values()
            .map(verification_snapshot)
            .collect()
    }

    pub async fn advance_verification(&self, flow_id: &str) -> Result<VerificationSnapshot> {
        let request = self
            .verifications
            .read()
            .await
            .get(flow_id)
            .cloned()
            .context("Matrix verification request was not found")?;
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
            sas.confirm().await?
        } else {
            sas.mismatch().await?
        }
        Ok(verification_snapshot(&request))
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
        let response = room
            .send_raw(event_type, content)
            .with_transaction_id(transaction_id.into())
            .await
            .context("failed to send the Matrix event")?;
        Ok(response.response.event_id.to_string())
    }

    pub async fn sync(&self) -> Result<()> {
        let stopped = self.stopped.clone();
        self.client
            .sync_with_callback(Default::default(), move |_| {
                let stopped = stopped.clone();
                async move {
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
        self.client.add_event_handler(
            move |raw: Raw<AnySyncTimelineEvent>,
                  room: Room,
                  encryption: Option<EncryptionInfo>| {
                let sender = sender.clone();
                async move {
                    let Ok(event) = serde_json::from_str(raw.json().get()) else {
                        return;
                    };
                    let encrypted = encryption.is_some();
                    let verified_device = encryption.as_ref().is_some_and(|value| {
                        matches!(value.verification_state, VerificationState::Verified)
                    });
                    let sender_device = encryption.and_then(|value| value.sender_device);
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
        other_device_id,
        emojis,
        cancellation,
    }
}

pub fn validate_event_type(event_type: &str) -> Result<()> {
    if matches!(
        event_type,
        COMMAND_EVENT_TYPE
            | RESPONSE_EVENT_TYPE
            | CONVERSATION_EVENT_TYPE
            | INVENTORY_EVENT_TYPE
            | SESSION_EVENT_TYPE
            | GATEWAY_EVENT_TYPE
            | DISCOVERY_EVENT_TYPE
            | AUTHORIZATION_EVENT_TYPE
    ) {
        Ok(())
    } else {
        bail!("unsupported Codever Matrix event type")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_codever_event_types_cross_the_native_boundary() {
        for event_type in [
            COMMAND_EVENT_TYPE,
            RESPONSE_EVENT_TYPE,
            CONVERSATION_EVENT_TYPE,
            INVENTORY_EVENT_TYPE,
            SESSION_EVENT_TYPE,
            GATEWAY_EVENT_TYPE,
            DISCOVERY_EVENT_TYPE,
            AUTHORIZATION_EVENT_TYPE,
        ] {
            validate_event_type(event_type).unwrap();
        }
        assert!(validate_event_type("m.room.message").is_err());
        assert!(validate_event_type("io.attacker.command").is_err());
    }
}
