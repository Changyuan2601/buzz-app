//! Only upgrade/frame transport. The renderer retains subscriptions and reconnects.
use super::{config::canonical_relay, FederatedIdentity};
use crate::identity::IdentityHost;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::ipc::Channel;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest, protocol::WebSocketConfig, Message,
};
use tokio_util::sync::CancellationToken;

struct Connection {
    stop: CancellationToken,
    sender: mpsc::Sender<String>,
    start: Option<oneshot::Sender<()>>,
}
#[derive(Default)]
pub(crate) struct Sockets(Arc<Mutex<HashMap<String, Connection>>>);
impl Sockets {
    pub(crate) fn clear(&self) {
        for (_, connection) in self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .drain()
        {
            connection.stop.cancel();
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub(crate) enum SocketEvent {
    Text {
        data: String,
    },
    /// The relay's close code and reason, when it sent a close frame.
    Closed {
        code: Option<u16>,
        reason: Option<String>,
    },
}
#[derive(Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SocketMode {
    Public,
    Native,
}

#[tauri::command]
pub(crate) async fn relay_socket_connect(
    sockets: tauri::State<'_, Sockets>,
    fi: tauri::State<'_, FederatedIdentity>,
    identity: tauri::State<'_, IdentityHost>,
    id: String,
    relay: String,
    on_event: Channel<SocketEvent>,
) -> Result<SocketMode, String> {
    uuid::Uuid::parse_str(&id).map_err(|_| "Invalid socket connection")?;
    let relay = canonical_relay(&relay)?;
    let stop = CancellationToken::new();
    let (sender, mut outgoing) = mpsc::channel(16);
    let (start, started) = oneshot::channel();
    {
        let mut live = sockets
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if live.len() >= 16 || live.contains_key(&id) {
            return Err("Native sockets are busy".into());
        }
        live.insert(
            id.clone(),
            Connection {
                stop: stop.clone(),
                sender,
                start: Some(start),
            },
        );
    }
    let connect = async {
        let url = url::Url::parse(&relay).map_err(|_| "Invalid relay")?;
        let assertion = fi
            .assertion_for_socket(identity.inner(), &url, id.clone(), stop.clone())
            .await?;
        let Some(assertion) = assertion else {
            return Ok(None);
        };
        let cancel = fi.cancellation_for(&assertion.revision)?;
        fi.admit_assertion(identity.inner(), &assertion).await?;
        let mut request = relay
            .as_str()
            .into_client_request()
            .map_err(|_| "Invalid native socket request")?;
        request.headers_mut().insert(
            super::assertion::HEADER,
            assertion
                .header
                .as_str()
                .parse()
                .map_err(|_| "Invalid federated authorization")?,
        );
        let config = WebSocketConfig::default()
            .max_message_size(Some(1024 * 1024))
            .max_frame_size(Some(1024 * 1024));
        let _ = rustls::crypto::ring::default_provider().install_default();
        let (socket, _) = tokio::select! {
            _ = cancel.cancelled() => return Err("Federated session changed".into()),
            result = tokio::time::timeout(Duration::from_secs(30), tokio_tungstenite::connect_async_with_config(request, Some(config), false)) => match result.map_err(|_| "Native socket timed out")? {
                Ok(connection) => connection,
                Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
                    // NIP-FI's fixed refusal classes: 401 wants fresh evidence,
                    // 403 is a decision to stop, 503 is a temporary outage.
                    return Err(match response.status().as_u16() {
                        401 => {
                            fi.reject_assertion(&assertion).await;
                            "relay-unauthorized"
                        }
                        403 => "relay-forbidden",
                        503 => "relay-unavailable",
                        _ => "Native socket upgrade refused",
                    }
                    .into());
                }
                Err(_) => return Err("Native socket upgrade refused".into()),
            },
        };
        fi.admit_assertion(identity.inner(), &assertion).await?;
        Ok::<_, String>(Some((socket, assertion, cancel)))
    };
    let result = tokio::select! { _ = stop.cancelled() => Err("Native socket canceled".into()), result = connect => result };
    let (mut socket, assertion, cancel) = match result {
        Ok(Some(connection)) => connection,
        result => {
            sockets
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&id);
            return result.map(|_| SocketMode::Public);
        }
    };
    let host = fi.inner().clone();
    let identity = identity.inner().clone();
    let registry = sockets.0.clone();
    tauri::async_runtime::spawn(async move {
        let expires = assertion.remaining();
        let expiry = tokio::time::sleep(expires);
        tokio::pin!(expiry);
        let mut closing: Option<(u16, String)> = None;
        let ready = tokio::select! {
            result = tokio::time::timeout(Duration::from_secs(10), started) => result.is_ok_and(|value| value.is_ok()),
            _ = cancel.cancelled() => false,
            _ = stop.cancelled() => false,
            _ = &mut expiry => false,
        };
        if ready {
            let pump = async {
                loop {
                    tokio::select! {
                        data = outgoing.recv() => {
                            let Some(data) = data else { break; };
                            if host.admit_assertion(&identity, &assertion).await.is_err() { break; }
                            // FI and NIP-42 must bind the same native key.
                            if let Ok(serde_json::Value::Array(frame)) = serde_json::from_str::<serde_json::Value>(&data) {
                                if frame.first().and_then(|v| v.as_str()) == Some("AUTH") && frame.get(1).and_then(|v| v.get("pubkey")).and_then(|v| v.as_str()) != Some(assertion.viewer.as_str()) { break; }
                            }
                            if socket.send(Message::Text(data.into())).await.is_err() { break; }
                        }
                        frame = socket.next() => {
                            if host.admit_assertion(&identity, &assertion).await.is_err() { break; }
                            match frame {
                                Some(Ok(Message::Text(data))) if on_event.send(SocketEvent::Text {data:data.to_string()}).is_ok() => {},
                                Some(Ok(Message::Ping(data))) => { if socket.send(Message::Pong(data)).await.is_err() { break; } },
                                Some(Ok(Message::Pong(_))) => {},
                                Some(Ok(Message::Close(frame))) => {
                                    closing = frame.map(|frame| (u16::from(frame.code), frame.reason.to_string()));
                                    break;
                                }
                                _ => break,
                            }
                        }
                    }
                }
            };
            tokio::select! {
                _ = cancel.cancelled() => {},
                _ = stop.cancelled() => {},
                _ = &mut expiry => {},
                _ = pump => {},
            }
        }
        // Do not flush queued protected frames after expiry or retirement.
        drop(socket);
        registry
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&id);
        let (code, reason) = match closing {
            Some((code, reason)) => (Some(code), Some(reason)),
            None => (None, None),
        };
        let _ = on_event.send(SocketEvent::Closed { code, reason });
    });
    Ok(SocketMode::Native)
}
#[tauri::command]
pub(crate) fn relay_socket_start(
    sockets: tauri::State<'_, Sockets>,
    id: String,
) -> Result<(), String> {
    sockets
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get_mut(&id)
        .and_then(|entry| entry.start.take())
        .ok_or("Native socket retired")?
        .send(())
        .map_err(|_| "Native socket retired".into())
}
#[tauri::command]
pub(crate) fn relay_socket_send(
    sockets: tauri::State<'_, Sockets>,
    id: String,
    data: String,
) -> Result<(), String> {
    if data.len() > 1024 * 1024 {
        return Err("Socket frame too large".into());
    }
    sockets
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&id)
        .ok_or("Native socket retired")?
        .sender
        .try_send(data)
        .map_err(|_| "Socket send queue is full".into())
}
#[tauri::command]
pub(crate) fn relay_socket_close(
    sockets: tauri::State<'_, Sockets>,
    fi: tauri::State<'_, FederatedIdentity>,
    id: String,
) {
    fi.close_discovery(&id);
    if let Some(entry) = sockets
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&id)
    {
        entry.stop.cancel();
    }
}
