use super::{now, template, Call, Channel, IdentityHost, Result, Update};
use crate::federated_identity::{assertion::HEADER, FederatedIdentity};
use buzz_audio_client::{
    connection::{self, AudioSocket as Socket},
    encoder::AudioEncoder,
    jitter::PeerJitterBuffer,
    wire::parse_relay_frame,
};
use futures_util::{SinkExt, StreamExt};
#[cfg(test)]
use serde_json::json;
use serde_json::Value;
use std::{collections::BTreeMap, time::Duration};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::{
    connect_async_tls_with_config,
    tungstenite::{client::IntoClientRequest, protocol::WebSocketConfig, Message},
    Connector,
};

type Peers = BTreeMap<u8, String>;

fn websocket_request(
    url: &url::Url,
    assertion: Option<&str>,
) -> Result<tokio_tungstenite::tungstenite::http::Request<()>> {
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|_| "Invalid Huddle WebSocket request")?;
    if let Some(assertion) = assertion {
        request.headers_mut().insert(
            HEADER,
            assertion
                .parse()
                .map_err(|_| "Invalid federated authorization")?,
        );
    }
    Ok(request)
}

fn tls_config() -> Result<std::sync::Arc<rustls::ClientConfig>> {
    static CONFIG: std::sync::OnceLock<Result<std::sync::Arc<rustls::ClientConfig>>> =
        std::sync::OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let mut roots = rustls::RootCertStore::empty();
            roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
            if roots.is_empty() {
                return Err("System TLS certificates unavailable".into());
            }
            // reqwest and the updater enable different providers. Choose explicitly,
            // rather than letting rustls panic when both providers are compiled in.
            let config = rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(
                rustls::crypto::aws_lc_rs::default_provider(),
            ))
            .with_safe_default_protocol_versions()
            .map_err(|_| "Huddle TLS unavailable")?
            .with_root_certificates(roots)
            .with_no_client_auth();
            Ok(std::sync::Arc::new(config))
        })
        .clone()
}

fn roster(value: &Value) -> Result<Peers> {
    Ok(connection::parse_peers(value)?
        .into_iter()
        .map(|p| (p.index, p.pubkey))
        .collect())
}
pub(super) async fn connect(
    host: &IdentityHost,
    fi: &FederatedIdentity,
    call: &Call,
    room: &str,
) -> Result<(Socket, Peers, Option<Duration>)> {
    let mut url = super::origin(&call.community)?;
    url.set_scheme("wss").map_err(|_| "Invalid Huddle relay")?;
    // Use the same origin string as the existing desktop v2 client for NIP-42.
    let relay = url.as_str().trim_end_matches('/').to_owned();
    url.set_path(&format!("/huddle/{room}/audio"));
    let authorization = fi.assertion_for_relay(host, &url).await?;
    fi.admit_authorization(host, &authorization).await?;
    let joined = tokio::time::timeout(Duration::from_secs(15), async {
        let config = WebSocketConfig::default()
            .max_message_size(Some(65_536))
            .max_frame_size(Some(65_536));
        let request = websocket_request(&url, authorization.header())?;
        let (mut socket, _) = connect_async_tls_with_config(
            request,
            Some(config),
            false,
            Some(Connector::Rustls(tls_config()?)),
        )
        .await
        .map_err(|_| "Huddle WebSocket connection failed")?;
        let challenge = tokio::time::timeout(Duration::from_secs(5), control(&mut socket))
            .await
            .map_err(|_| "Huddle challenge timed out")??;
        if challenge["type"] != "challenge" {
            return Err("Invalid Huddle handshake".into());
        }
        let challenge = challenge["challenge"]
            .as_str()
            .filter(|value| !value.is_empty() && value.len() <= 4096)
            .ok_or("Invalid Huddle challenge")?
            .to_owned();
        let event = host
            .sign(template(
                22242,
                vec![
                    vec!["relay".into(), relay],
                    vec!["challenge".into(), challenge],
                ],
                String::new(),
            ))
            .await?;
        socket
            .send(Message::Text(
                serde_json::json!({
                    "type": "auth",
                    "event": event,
                    "parent_channel_id": call.parent,
                    "protocol_version": buzz_audio_client::wire::PROTOCOL_VERSION,
                })
                .to_string()
                .into(),
            ))
            .await
            .map_err(|_| "Huddle authentication failed")?;
        let admission = tokio::time::timeout(Duration::from_secs(5), control(&mut socket))
            .await
            .map_err(|_| "Huddle admission timed out")??;
        if admission["type"] != "joined" {
            return Err("Huddle admission was not confirmed".into());
        }
        let index = admission["peer_index"]
            .as_u64()
            .and_then(|value| u8::try_from(value).ok())
            .ok_or("Invalid Huddle publisher index")?;
        let peers = connection::parse_peers(&admission)?;
        Ok::<_, String>(buzz_audio_client::connection::Joined {
            socket,
            index,
            peers,
        })
    })
    .await
    .map_err(|_| "Huddle connection timed out")??;
    if !fi.authorization_session_current(&authorization) {
        return Err("Federated authorization changed".into());
    }
    let remaining = authorization.remaining();
    Ok((
        joined.socket,
        joined
            .peers
            .into_iter()
            .map(|p| (p.index, p.pubkey))
            .collect(),
        remaining,
    ))
}

async fn control(socket: &mut buzz_audio_client::connection::AudioSocket) -> Result<Value> {
    loop {
        match socket.next().await {
            Some(Ok(Message::Text(text))) => {
                let value: Value =
                    serde_json::from_str(&text).map_err(|_| "Invalid Huddle response")?;
                if value["type"] == "error" {
                    return Err(value["message"]
                        .as_str()
                        .unwrap_or("Huddle rejected by relay")
                        .chars()
                        .take(240)
                        .collect());
                }
                return Ok(value);
            }
            Some(Ok(Message::Ping(data))) => socket
                .send(Message::Pong(data))
                .await
                .map_err(|_| "Huddle disconnected")?,
            Some(Ok(Message::Pong(_))) => {}
            _ => return Err("Huddle disconnected during admission".into()),
        }
    }
}

struct Receiver {
    jitter: PeerJitterBuffer,
    last_packet: tokio::time::Instant,
}
struct Codec {
    encoder: AudioEncoder,
    receivers: BTreeMap<u8, Receiver>,
}
impl Codec {
    fn new() -> Result<Self> {
        Ok(Self {
            encoder: AudioEncoder::new()?,
            receivers: BTreeMap::new(),
        })
    }
    fn insert(&mut self, frame: &[u8], peers: &Peers) -> Result<()> {
        if frame.len() > 4009 {
            return Ok(());
        }
        let Some((index, header, payload)) = parse_relay_frame(frame) else {
            return Ok(());
        };
        if !peers.contains_key(&index) {
            return Ok(());
        }
        if let std::collections::btree_map::Entry::Vacant(entry) = self.receivers.entry(index) {
            entry.insert(Receiver {
                jitter: PeerJitterBuffer::new(index)
                    .map_err(|e| format!("Audio decoder unavailable: {e}"))?,
                last_packet: tokio::time::Instant::now(),
            });
        }
        if let Some(receiver) = self.receivers.get_mut(&index) {
            // Malformed or excessively late media must not end the call.
            if receiver
                .jitter
                .insert_packet(header.seq, header.ts_48k, payload)
                .is_ok()
            {
                receiver.last_packet = tokio::time::Instant::now();
            }
        }
        Ok(())
    }
    fn play(
        &mut self,
        peers: &Peers,
        mut emit: impl FnMut(String, Vec<f32>) -> Result<()>,
    ) -> Result<()> {
        for (index, receiver) in &mut self.receivers {
            if receiver.last_packet.elapsed() > Duration::from_millis(500)
                && receiver.jitter.is_empty()
            {
                continue;
            }
            if let Some(peer) = peers.get(index) {
                let (samples, _) = receiver
                    .jitter
                    .get_audio()
                    .map_err(|e| format!("Huddle playback failed: {e}"))?;
                emit(peer.clone(), samples)?;
            }
        }
        Ok(())
    }
    fn replace(&mut self, peers: &mut Peers, next: Peers) {
        self.receivers.retain(|i, _| peers.get(i) == next.get(i));
        *peers = next;
    }
    fn joined(&mut self, peers: &mut Peers, delta: Peers) {
        let mut next = peers.clone();
        next.extend(delta);
        self.replace(peers, next);
    }
}

pub(super) async fn run(
    mut socket: Socket,
    mut peers: Peers,
    assertion_remaining: Option<Duration>,
    mut pcm: mpsc::Receiver<Vec<f32>>,
    mut stop: watch::Receiver<bool>,
    updates: &Channel<Update>,
    touched: &std::sync::atomic::AtomicU64,
) -> Result<()> {
    let mut codec = Codec::new()?;
    let mut heartbeat = tokio::time::interval(Duration::from_secs(10));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut playout = tokio::time::interval(Duration::from_millis(10));
    playout.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_received = tokio::time::Instant::now();
    let expires = async {
        match assertion_remaining {
            Some(remaining) => tokio::time::sleep(remaining).await,
            None => std::future::pending().await,
        }
    };
    tokio::pin!(expires);
    loop {
        if *stop.borrow() {
            break;
        }
        tokio::select! {
            biased;
            _ = stop.changed() => break,
            _ = &mut expires => {
                return Err("Huddle authorization expired. Join again to reconnect.".into());
            }
            // Cleanup must not be starved by a continuously ready audio stream.
            _ = heartbeat.tick() => {
                super::check_cancelled(&stop, touched)?;
                if last_received.elapsed() > Duration::from_secs(30) { return Err("Huddle connection timed out. You can join again.".into()); }
                tokio::time::timeout(Duration::from_secs(2), socket.send(Message::Ping(now().to_be_bytes().to_vec().into()))).await.map_err(|_| "Huddle connection stalled")?.map_err(|_| "Huddle disconnected")?;
            }
            _ = playout.tick() => {
                codec.play(&peers, |peer, samples| updates.send(Update::Audio { peer, samples }).map_err(|_| "Huddle view closed".into()))?;
            }
            packet = socket.next() => {
                last_received = tokio::time::Instant::now();
                match packet {
                    Some(Ok(Message::Binary(frame))) => {
                        codec.insert(&frame, &peers)?;
                    }
                    Some(Ok(Message::Text(text))) => {
                        let value: Value = serde_json::from_str(&text).map_err(|_| "Invalid Huddle update")?;
                        match value["type"].as_str() {
                            Some("joined") => {
                                // Mesh joins are deltas. Preserve already connected peers.
                                codec.joined(&mut peers, roster(&value)?);
                            }
                            Some("roster") => {
                                let next = roster(&value)?;
                                codec.replace(&mut peers, next);
                            }
                            Some("left") => {
                                if let Some(i) = value["peer_index"].as_u64().filter(|i| *i <= 255) {
                                    peers.remove(&(i as u8));
                                    codec.receivers.remove(&(i as u8));
                                }
                            }
                            Some("error") => return Err("The relay ended this Huddle connection".into()),
                            _ => continue,
                        }
                        updates.send(Update::Participants {participants:peers.values().cloned().collect()}).map_err(|_| "Huddle view closed")?;
                    }
                    Some(Ok(Message::Ping(bytes))) => {
                        tokio::time::timeout(Duration::from_secs(2), socket.send(Message::Pong(bytes))).await.map_err(|_| "Huddle connection stalled")?.map_err(|_| "Huddle disconnected")?;
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return Err("Huddle disconnected. You can join again.".into()),
                    _ => {},
                }
            }
            samples = pcm.recv() => {
                let Some(samples) = samples else { break; };
                let frame = codec.encoder.encode(&samples)?;
                tokio::time::timeout(Duration::from_secs(2), socket.send(Message::Binary(frame.into()))).await.map_err(|_| "Huddle connection stalled")?.map_err(|_| "Huddle disconnected")?;
            }
        }
    }
    let _ = tokio::time::timeout(Duration::from_secs(2), socket.close(None)).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_audio_client::encoder::FRAME_SAMPLES;

    #[test]
    fn tls_uses_an_explicit_provider_with_system_trust() {
        assert!(tls_config().is_ok());
    }

    #[test]
    fn websocket_upgrade_attaches_only_the_scoped_assertion() {
        let url = url::Url::parse("wss://community.example/huddle/room/audio").unwrap();
        let protected = websocket_request(&url, Some("Bearer scoped-assertion")).unwrap();
        assert_eq!(
            protected.headers().get(HEADER).unwrap(),
            "Bearer scoped-assertion"
        );
        assert_eq!(protected.headers().get_all(HEADER).iter().count(), 1);
        assert!(protected.headers().get("Authorization").is_none());

        let public = websocket_request(&url, None).unwrap();
        assert!(public.headers().get(HEADER).is_none());
    }

    #[test]
    fn mesh_join_delta_keeps_existing_speakers_and_reuse_clears_playout() {
        let mut codec = Codec::new().unwrap();
        let mut peers = BTreeMap::from([(1, "a".repeat(64)), (2, "b".repeat(64))]);
        let frame = [
            vec![1],
            codec.encoder.encode(&vec![0.1; FRAME_SAMPLES]).unwrap(),
        ]
        .concat();
        codec.insert(&frame, &peers).unwrap();
        codec.joined(
            &mut peers,
            roster(&json!({"peers":[{"peer_index":3,"pubkey":"c".repeat(64)}]})).unwrap(),
        );
        assert_eq!(peers.len(), 3);
        assert!(codec.receivers.contains_key(&1));
        let mut heard = Vec::new();
        codec
            .play(&peers, |peer, samples| {
                assert_eq!(samples.len(), 480);
                assert!(samples.iter().all(|s| s.is_finite()));
                heard.push(peer);
                Ok(())
            })
            .unwrap();
        assert_eq!(heard, vec!["a".repeat(64)]);
        codec.joined(&mut peers, BTreeMap::from([(1, "d".repeat(64))]));
        assert!(!codec.receivers.contains_key(&1));
        assert_eq!(peers.len(), 3);
        codec.insert(&frame, &peers).unwrap();
        codec.replace(&mut peers, BTreeMap::new());
        assert!(codec.receivers.is_empty());
    }

    #[test]
    fn malformed_frames_and_rosters_are_bounded() {
        assert!(roster(&json!({"peers":[{"peer_index":256,"pubkey":"a".repeat(64)}]})).is_err());
        assert!(roster(&json!({"peers":[{"peer_index":0,"pubkey":"bad"}]})).is_err());
        let mut codec = Codec::new().unwrap();
        for frame in [vec![0; 8], vec![0; 40010], vec![0; 50]] {
            codec.insert(&frame, &Peers::new()).unwrap();
        }
        assert!(codec.receivers.is_empty());
    }
}
