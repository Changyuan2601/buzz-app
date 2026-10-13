//! Native process evidence only. Intake routing is verified separately; neither
//! an app acknowledgment nor rewriting this snapshot renews turn liveness.
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

const FRAME: usize = 4 * 1024 * 1024;
const SESSIONS: usize = 512;
#[derive(Clone, Debug, Serialize)]
pub(crate) struct Route {
    pub relay: String,
    pub owner: String,
    pub agent: String,
    pub channel_id: String,
    pub root_id: String,
    pub trigger_id: String,
}
#[derive(Clone, Debug, Serialize)]
struct Session {
    #[serde(flatten)]
    route: Route,
    codex_thread_id: String,
    turn_id: String,
    trigger_ids: Vec<String>,
    state: &'static str,
    observed_at_ms: u64,
}
#[derive(Default)]
struct Stream {
    input: String,
    output: String,
    next_route: Option<Route>,
    pending: BTreeMap<String, (String, Route)>,
}
#[derive(Serialize)]
struct Registry {
    version: u8,
    producer: &'static str,
    generation: String,
    sequence: u64,
    generated_at_ms: u64,
    complete: bool,
    diagnostic: Option<&'static str>,
    #[serde(serialize_with = "session_rows")]
    sessions: BTreeMap<String, Session>,
    #[serde(skip)]
    streams: BTreeMap<u64, Stream>,
    #[serde(skip)]
    terminals: BTreeMap<String, (&'static str, u64)>,
}
impl Default for Registry {
    fn default() -> Self {
        Self {
            version: 1,
            producer: "buzz.codex/native",
            generation: uuid::Uuid::new_v4().to_string(),
            sequence: 0,
            generated_at_ms: 0,
            complete: true,
            diagnostic: None,
            sessions: BTreeMap::new(),
            streams: BTreeMap::new(),
            terminals: BTreeMap::new(),
        }
    }
}
#[derive(Clone, Default)]
pub(crate) struct PluginObserver(Arc<Mutex<Registry>>);
fn session_rows<S: serde::Serializer>(
    rows: &BTreeMap<String, Session>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    rows.values().collect::<Vec<_>>().serialize(serializer)
}
fn stamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn terminal(state: &str) -> bool {
    matches!(state, "completed" | "failed" | "interrupted")
}
impl Registry {
    fn fault(&mut self, reason: &'static str) {
        self.complete = false;
        self.diagnostic = Some(reason);
    }
    fn accept(&mut self, process: u64, thread: String, turn: String, route: Route, at: u64) {
        if thread.len() > 128 || turn.is_empty() || turn.len() > 128 {
            self.fault("invalid_session");
            return;
        }
        let key = format!(
            "{process}:{thread}:{turn}:{}:{}",
            route.channel_id, route.root_id
        );
        if !self.sessions.contains_key(&key) && self.sessions.len() >= SESSIONS {
            self.fault("truncated");
            return;
        }
        let terminal = self
            .terminals
            .get(&format!("{process}:{thread}:{turn}"))
            .copied();
        let row = self.sessions.entry(key).or_insert_with(|| Session {
            trigger_ids: vec![],
            route: route.clone(),
            codex_thread_id: thread,
            turn_id: turn,
            state: terminal.map_or("accepted", |row| row.0),
            observed_at_ms: terminal.map_or(at, |row| row.1),
        });
        if row.route.agent != route.agent
            || row.route.relay != route.relay
            || row.route.owner != route.owner
        {
            self.fault("conflicting_route");
            return;
        }
        if !row.trigger_ids.contains(&route.trigger_id) {
            if row.trigger_ids.len() >= 64 {
                self.fault("truncated");
                return;
            }
            row.trigger_ids.push(route.trigger_id);
        }
    }
    fn wire(&mut self, process: u64, incoming: bool, wire: Value, at: u64) {
        let method = wire.get("method").and_then(Value::as_str);
        let p = &wire["params"];
        let thread = p["threadId"].as_str();
        if incoming {
            let stream = self.streams.entry(process).or_default();
            let route = stream.next_route.take();
            if !matches!(method, Some("turn/start" | "turn/steer")) {
                if route.is_some() {
                    self.fault("unexpected_route");
                }
                return;
            }
            let Some(thread) = thread else {
                self.fault("missing_thread");
                return;
            };
            if stream.pending.len() >= 128 {
                self.fault("truncated");
                return;
            }
            let Some(route) = route else {
                self.fault("missing_route");
                return;
            };
            let Some(id) = wire.get("id") else {
                self.fault("missing_request");
                return;
            };
            stream
                .pending
                .insert(id.to_string(), (thread.to_owned(), route));
            return;
        }
        if method.is_none() {
            let Some(id) = wire.get("id") else {
                return;
            };
            let pending = self
                .streams
                .entry(process)
                .or_default()
                .pending
                .remove(&id.to_string());
            if let Some((thread, route)) = pending {
                if wire.get("error").is_some() {
                    return;
                }
                let turn = wire["result"]["turn"]["id"]
                    .as_str()
                    .or_else(|| wire["result"]["turnId"].as_str());
                if let Some(turn) = turn {
                    self.accept(process, thread, turn.to_owned(), route, at);
                } else {
                    self.fault("missing_acceptance");
                }
            }
            return;
        }
        let Some(thread) = thread else {
            return;
        };
        let turn = p["turn"]["id"].as_str().or_else(|| p["turnId"].as_str());
        let Some(turn) = turn else {
            return;
        };
        if method == Some("turn/started") {
            let routes: Vec<_> = self
                .streams
                .entry(process)
                .or_default()
                .pending
                .values()
                .filter(|(id, _)| id == thread)
                .cloned()
                .collect();
            for (thread, route) in routes {
                self.accept(process, thread, turn.to_owned(), route, at);
            }
        }
        let outcome = match p["turn"]["status"].as_str() {
            Some("completed") => "completed",
            Some("failed") => "failed",
            Some("interrupted") => "interrupted",
            _ => "unknown",
        };
        if method == Some("turn/completed") {
            let key = format!("{process}:{thread}:{turn}");
            if self.terminals.len() >= SESSIONS && !self.terminals.contains_key(&key) {
                self.fault("truncated");
                return;
            }
            self.terminals.insert(key, (outcome, at));
        }
        let prefix = format!("{process}:{thread}:{turn}:");
        for (key, row) in &mut self.sessions {
            if !key.starts_with(&prefix) || terminal(row.state) {
                continue;
            }
            if method == Some("turn/completed") {
                row.state = outcome;
                row.observed_at_ms = at;
            } else if method.is_some_and(|m| m.starts_with("item/") || m == "turn/started") {
                row.state = "running";
                row.observed_at_ms = at;
            }
        }
    }
}
impl PluginObserver {
    fn registry(&self) -> std::sync::MutexGuard<'_, Registry> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
    pub(crate) fn open(&self, process: u64) {
        let mut registry = self.registry();
        if registry.streams.is_empty() && !registry.complete {
            *registry = Registry::default();
        }
        registry.streams.insert(process, Stream::default());
    }
    pub(crate) fn bind(&self, process: u64, route: Route) {
        let mut registry = self.registry();
        let Some(stream) = registry.streams.get_mut(&process) else {
            return;
        };
        if !stream.input.is_empty() || stream.next_route.is_some() {
            registry.fault("overlapping_route");
            return;
        }
        stream.next_route = Some(route);
    }
    pub(crate) fn bytes(&self, process: u64, incoming: bool, data: &str) {
        let mut registry = self.registry();
        let Some(stream) = registry.streams.get_mut(&process) else {
            return;
        };
        let buffer = if incoming {
            &mut stream.input
        } else {
            &mut stream.output
        };
        buffer.push_str(data);
        let mut frames = vec![];
        while let Some(end) = buffer.find('\n') {
            if end > FRAME {
                buffer.clear();
                registry.fault("oversized_frame");
                return;
            }
            frames.push(buffer.drain(..=end).collect::<String>());
        }
        if buffer.len() > FRAME {
            buffer.clear();
            registry.fault("oversized_frame");
            return;
        }
        for line in frames {
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<Value>(&line) {
                Ok(wire) if wire.is_object() => registry.wire(process, incoming, wire, stamp()),
                Ok(_) => registry.fault("malformed_frame"),
                Err(_) => registry.fault("malformed_frame"),
            }
        }
    }
    pub(crate) fn outage(&self, process: Option<u64>) {
        let mut registry = self.registry();
        if process.is_none() {
            *registry = Registry::default();
            return;
        }
        if !registry.streams.contains_key(&process.unwrap()) {
            return;
        }
        registry.fault("process_outage");
        for (key, row) in &mut registry.sessions {
            if process.map_or(true, |id| key.starts_with(&format!("{id}:"))) && !terminal(row.state)
            {
                row.state = "unknown";
            }
        }
        if let Some(process) = process {
            registry.streams.remove(&process);
        } else {
            registry.streams.clear();
        }
    }
    #[cfg(test)]
    pub(crate) fn snapshot(&self) -> Value {
        serde_json::to_value(&*self.registry()).unwrap()
    }
    pub(crate) async fn flush(
        &self,
        path: PathBuf,
        host: &crate::app_agents::AppAgentHost,
    ) -> Result<(), String> {
        let snapshot = {
            let mut registry = self.registry();
            if registry.diagnostic == Some("export_failed") {
                registry.diagnostic = None;
            }
            registry.sequence += 1;
            registry.generated_at_ms = stamp();
            serde_json::to_value(&*registry).map_err(|_| "Observer encoding failed")?
        };
        let events = host.observer_events(snapshot).await?;
        let bytes = serde_json::to_vec(&serde_json::json!({"version":1,"events":events}))
            .map_err(|_| "Observer encoding failed")?;
        if bytes.len() > 1024 * 1024 {
            return Err("Observer export too large".into());
        }
        tokio::task::spawn_blocking(move || -> std::io::Result<()> {
            let parent = path
                .parent()
                .ok_or_else(|| std::io::Error::other("Missing observer directory"))?;
            std::fs::create_dir_all(parent)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
            }
            let mut file = tempfile::NamedTempFile::new_in(parent)?;
            file.write_all(&bytes)?;
            file.as_file().sync_all()?;
            file.persist(path).map_err(|error| error.error)?;
            Ok(())
        })
        .await
        .map_err(|_| "Observer export failed")?
        .map_err(|_| "Observer export failed".into())
    }
    /// Fixed app-data path. Publisher freshness never renews session liveness.
    pub(crate) fn export(&self, path: PathBuf, host: crate::app_agents::AppAgentHost) {
        let observer = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut timer = tokio::time::interval(std::time::Duration::from_secs(10));
            loop {
                timer.tick().await;
                if observer.flush(path.clone(), &host).await.is_err() {
                    observer
                        .registry()
                        .diagnostic
                        .get_or_insert("export_failed");
                }
            }
        });
    }
}

/// No signing key is used here. Verify the original owner/owner-attested trigger
/// and the managed agent's type before admitting a native process correlation.
pub(crate) fn verified_route(
    agent: &buzz_agent_controller::AppAgent,
    plugin: &str,
    event: Value,
) -> Result<Route, String> {
    use secp256k1::{schnorr::Signature, Secp256k1, XOnlyPublicKey};
    use sha2::{Digest, Sha256};
    let invalid = || "Invalid observer trigger or agent binding".to_owned();
    if plugin != "buzz.codex"
        || agent.deleted
        || !agent.agent_type.starts_with("buzz.codex/")
        || serde_json::to_vec(&event).map_err(|_| invalid())?.len() > 128 * 1024
    {
        return Err(invalid());
    }
    let raw: nostr::event::Event = serde_json::from_value(event.clone()).map_err(|_| invalid())?;
    raw.verify().map_err(|_| invalid())?;
    if event["kind"] != 9 {
        return Err(invalid());
    }
    let author = event["pubkey"].as_str().ok_or_else(invalid)?;
    let tags: Vec<Vec<String>> =
        serde_json::from_value(event["tags"].clone()).map_err(|_| invalid())?;
    if author != agent.owner {
        let auth: Vec<_> = tags
            .iter()
            .filter(|t| t.first().is_some_and(|s| s == "auth"))
            .collect();
        let tag = auth.first().ok_or_else(invalid)?;
        // Conditional attestations remain unavailable until an event-aware
        // native admission contract supports them. Never weaken a condition.
        if auth.len() != 1 || tag.len() != 4 || tag[1] != agent.owner || !tag[2].is_empty() {
            return Err(invalid());
        }
        let key: XOnlyPublicKey = agent.owner.parse().map_err(|_| invalid())?;
        let sig: Signature = tag[3].parse().map_err(|_| invalid())?;
        Secp256k1::verification_only()
            .verify_schnorr(
                &sig,
                &Sha256::digest(format!("nostr:agent-auth:{author}:")),
                &key,
            )
            .map_err(|_| invalid())?;
    }
    let channels: Vec<_> = tags
        .iter()
        .filter(|t| t.first().is_some_and(|s| s == "h"))
        .collect();
    if channels.len() != 1 || channels[0].len() != 2 || channels[0][1].len() > 128 {
        return Err(invalid());
    }
    let references: Vec<_> = tags
        .iter()
        .filter(|t| t.first().is_some_and(|s| s == "e"))
        .collect();
    let root = references
        .iter()
        .find(|t| t.get(3).is_some_and(|s| s == "root"))
        .or_else(|| {
            references
                .iter()
                .find(|t| t.get(3).is_some_and(|s| s == "reply"))
        })
        .and_then(|t| t.get(1))
        .cloned()
        .unwrap_or_else(|| raw.id.to_hex());
    if root.len() != 64
        || !root
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(invalid());
    }
    Ok(Route {
        relay: agent.relay.clone(),
        owner: agent.owner.clone(),
        agent: agent.pubkey.clone(),
        channel_id: channels[0][1].clone(),
        root_id: root,
        trigger_id: raw.id.to_hex(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn route(trigger: &str, root: &str) -> Route {
        Route {
            relay: "wss://example.test".into(),
            owner: "a".repeat(64),
            agent: "b".repeat(64),
            channel_id: "channel".into(),
            root_id: root.into(),
            trigger_id: trigger.into(),
        }
    }
    fn accepted(registry: &mut Registry, id: u64, thread: &str, turn: &str, route: Route) {
        registry.streams.entry(1).or_default().next_route = Some(route);
        registry.wire(
            1,
            true,
            json!({"id":id,"method":"turn/start","params":{"threadId":thread}}),
            10,
        );
        assert!(
            registry.sessions.is_empty()
                || registry
                    .sessions
                    .values()
                    .all(|s| s.codex_thread_id != thread)
        );
        registry.wire(1, false, json!({"id":id,"result":{"turn":{"id":turn}}}), 20);
        assert_eq!(
            registry
                .sessions
                .values()
                .find(|row| row.codex_thread_id == thread)
                .unwrap()
                .state,
            "accepted"
        );
        registry.wire(
            1,
            false,
            json!({"method":"turn/started","params":{"threadId":thread,"turn":{"id":turn}}}),
            21,
        );
    }
    #[test]
    fn acceptance_is_not_intake_and_concurrent_terminal_is_not_agent_idle() {
        let mut registry = Registry::default();
        accepted(
            &mut registry,
            1,
            "thread-a",
            "turn-a",
            route("first", "root-a"),
        );
        accepted(
            &mut registry,
            2,
            "thread-b",
            "turn-b",
            route("second", "root-b"),
        );
        registry.wire(1, false, json!({"method":"turn/completed","params":{"threadId":"thread-a","turn":{"id":"turn-a","status":"completed"}}}), 30);
        let rows: Vec<_> = registry.sessions.values().collect();
        assert_eq!(rows[0].state, "completed");
        assert_eq!(rows[1].state, "running");
        assert_eq!(rows[1].observed_at_ms, 21);
    }
    #[test]
    fn exporter_heartbeat_does_not_renew_execution_and_outage_is_unknown() {
        let mut registry = Registry::default();
        accepted(&mut registry, 1, "thread", "turn", route("trigger", "root"));
        registry.generated_at_ms = 1_000;
        assert_eq!(
            registry.sessions.values().next().unwrap().observed_at_ms,
            21
        );
        let observer = PluginObserver(Arc::new(Mutex::new(registry)));
        observer.outage(Some(1));
        assert_eq!(
            observer.registry().sessions.values().next().unwrap().state,
            "unknown"
        );
        assert!(!observer.registry().complete);
    }
    #[test]
    fn separate_roots_in_one_native_turn_retain_both_correlations() {
        let mut registry = Registry::default();
        accepted(
            &mut registry,
            1,
            "community",
            "turn",
            route("first", "root-a"),
        );
        registry.accept(
            1,
            "community".into(),
            "turn".into(),
            route("second", "root-b"),
            25,
        );
        assert!(registry.complete);
        assert_eq!(registry.sessions.len(), 2);
        registry.wire(1, false, json!({"method":"turn/completed","params":{"threadId":"community","turn":{"id":"turn","status":"completed"}}}), 30);
        assert!(registry.sessions.values().all(|r| r.state == "completed"));
    }
    #[test]
    fn malformed_and_oversized_streams_fail_closed() {
        let observer = PluginObserver::default();
        observer.open(1);
        observer.bytes(1, false, "not-json\n");
        assert!(!observer.registry().complete);
        let observer = PluginObserver::default();
        observer.open(1);
        observer.bytes(1, false, &"x".repeat(FRAME + 1));
        assert_eq!(observer.registry().diagnostic, Some("oversized_frame"));
    }
    #[test]
    fn completion_before_acceptance_and_reload_do_not_revive_old_turns() {
        let mut registry = Registry::default();
        registry.streams.entry(1).or_default().next_route = Some(route("trigger", "root"));
        registry.wire(
            1,
            true,
            json!({"id":1,"method":"turn/start","params":{"threadId":"thread"}}),
            10,
        );
        registry.wire(1, false, json!({"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"turn","status":"completed"}}}), 20);
        registry.wire(
            1,
            false,
            json!({"id":1,"result":{"turn":{"id":"turn"}}}),
            30,
        );
        assert_eq!(
            registry.sessions.values().next().unwrap().state,
            "completed"
        );
        let observer = PluginObserver(Arc::new(Mutex::new(registry)));
        let previous = observer.registry().generation.clone();
        observer.outage(None);
        observer.bytes(1, false, "malformed old output\n");
        let current = observer.registry();
        assert_ne!(current.generation, previous);
        assert!(current.complete);
        assert!(current.sessions.is_empty());
    }
    #[test]
    fn verified_intake_rejects_forgery_and_wrong_plugin() {
        use nostr::{
            event::{EventBuilder, FinalizeEvent, Kind, Tag},
            key::Keys,
        };
        let owner = Keys::generate();
        let agent = buzz_agent_controller::AppAgent {
            pubkey: "b".repeat(64),
            relay: "wss://example.test".into(),
            owner: owner.public_key().to_hex(),
            auth: "[]".into(),
            agent_type: "buzz.codex/codex".into(),
            name: "Fixture".into(),
            picture: None,
            profile: None,
            about: None,
            deleted: false,
        };
        let signed = EventBuilder::new(Kind::Custom(9), "fixture trigger")
            .tags([Tag::parse(["h", "channel"]).unwrap()])
            .finalize(&owner)
            .unwrap();
        let original = serde_json::to_value(signed).unwrap();
        let bound = verified_route(&agent, "buzz.codex", original.clone()).unwrap();
        assert_eq!(bound.agent, agent.pubkey);
        assert_eq!(bound.root_id, original["id"]);
        assert!(verified_route(&agent, "foreign.plugin", original.clone()).is_err());
        let mut changed = original;
        changed["content"] = json!("forged");
        assert!(verified_route(&agent, "buzz.codex", changed).is_err());
    }
    #[test]
    fn truncation_never_evicts_active_evidence_or_claims_complete() {
        let mut registry = Registry::default();
        for id in 0..SESSIONS {
            registry.accept(
                1,
                id.to_string(),
                "turn".into(),
                route("trigger", "root"),
                20,
            );
        }
        registry.accept(
            1,
            "overflow".into(),
            "turn".into(),
            route("extra", "root"),
            30,
        );
        assert_eq!(registry.sessions.len(), SESSIONS);
        assert_eq!(registry.diagnostic, Some("truncated"));
        assert!(!registry.complete);
    }
}
