use super::{now, template, Call, Channel, IdentityHost, Result, Update};
use crate::federated_identity::{assertion, FederatedIdentity};
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
    tungstenite::{client::IntoClientRequest, handshake::client::Request, Message},
    Connector,
};
use url::Url;

type Peers = BTreeMap<u8, String>;

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
) -> Result<(Socket, Peers)> {
    let community = super::origin(&call.community)?;
    // Issued for the community's HTTPS origin and the signing identity, like
    // every other relay route; without a NIP-FI session it carries nothing.
    let authorization = super::super::evidence(host, Some(fi), &community)
        .await?
        .ok_or("Huddle authorization unavailable")?;
    let request = audio_request(&community, room, authorization.header())?;
    fi.during_authorization(host, &authorization, open(host, call, request))
        .await?
}

/// The audio upgrade request: `Authorization` stays NIP-98 territory, so the
/// NIP-FI assertion travels in its own header, as on the main socket.
fn audio_request(community: &Url, room: &str, assertion: Option<&str>) -> Result<Request> {
    let mut url = community.clone();
    url.set_scheme("wss").map_err(|_| "Invalid Huddle relay")?;
    url.set_path(&format!("/huddle/{room}/audio"));
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|_| "Invalid Huddle relay")?;
    if let Some(assertion) = assertion {
        request.headers_mut().insert(
            assertion::HEADER,
            assertion
                .parse()
                .map_err(|_| "Invalid federated authorization")?,
        );
    }
    Ok(request)
}

async fn open(host: &IdentityHost, call: &Call, request: Request) -> Result<(Socket, Peers)> {
    // Use the same origin string as the existing desktop v2 client for NIP-42.
    let relay = super::origin(&call.community)?
        .as_str()
        .trim_end_matches('/')
        .replacen("https://", "wss://", 1);
    let joined = connection::connect(
        request,
        Some(&call.parent),
        Some(Connector::Rustls(tls_config()?)),
        |challenge| async move {
            host.sign(template(
                22242,
                vec![
                    vec!["relay".into(), relay],
                    vec!["challenge".into(), challenge],
                ],
                String::new(),
            ))
            .await
        },
    )
    .await?;
    Ok((
        joined.socket,
        joined
            .peers
            .into_iter()
            .map(|p| (p.index, p.pubkey))
            .collect(),
    ))
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
    loop {
        if *stop.borrow() {
            break;
        }
        tokio::select! {
            biased;
            _ = stop.changed() => break,
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
    fn the_audio_upgrade_carries_the_assertion_only_in_its_own_header() {
        let community = Url::parse("https://relay.example/").unwrap();
        let request = audio_request(&community, "room", Some("Bearer jwt")).unwrap();
        assert_eq!(request.uri(), "wss://relay.example/huddle/room/audio");
        assert_eq!(request.headers()[assertion::HEADER], "Bearer jwt");
        assert!(request.headers().get("authorization").is_none());

        // Without a NIP-FI session the upgrade is exactly the old bare URL.
        let bare = audio_request(&community, "room", None).unwrap();
        assert!(bare.headers().get(assertion::HEADER).is_none());
        assert!(bare.headers().get("authorization").is_none());
    }
    #[test]
    fn tls_uses_an_explicit_provider_with_system_trust() {
        assert!(tls_config().is_ok());
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
