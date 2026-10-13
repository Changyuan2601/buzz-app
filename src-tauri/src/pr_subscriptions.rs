//! PR source checkpoints and delivery. Agents owns conversation continuation.
use crate::app_agents::{post, read, AppAgentHost};
use crate::identity::{EventTemplate, IdentityHost};
use buzz_agent_controller::{AppAgent, Secret};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const LIMIT: usize = 8 * 1024 * 1024;
const MAX_PENDING: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Target {
    pubkey: String,
    owner: String,
    relay: String,
    channel: String,
    root: String,
    repo: String,
    pr: u32,
}
impl Target {
    fn validate(&self) -> Result<(), String> {
        let hex = |s: &str| {
            s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        };
        if !hex(&self.pubkey)
            || !hex(&self.owner)
            || !hex(&self.root)
            || self.pubkey == self.owner
            || uuid::Uuid::parse_str(&self.channel)
                .map(|v| v.to_string() != self.channel)
                .unwrap_or(true)
            || self.pr == 0
            || self.pr >= 1 << 31
            || self.repo.split('/').count() != 2
            || self.repo.split('/').any(|p| {
                p.is_empty()
                    || !p.bytes().all(|b| {
                        b.is_ascii_lowercase() || b.is_ascii_digit() || b"_.-".contains(&b)
                    })
            })
            || !self.relay.starts_with("wss://")
            || crate::relay::origin(&self.relay.replacen("wss://", "https://", 1)).is_err()
        {
            return Err("Invalid PR subscription target".into());
        }
        Ok(())
    }
    fn id(&self) -> String {
        format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(self).expect("Target serializes"))
        )
    }
    fn tags(&self) -> Vec<Vec<String>> {
        vec![
            vec!["h".into(), self.channel.clone()],
            vec!["e".into(), self.root.clone(), "".into(), "reply".into()],
            vec!["p".into(), self.pubkey.clone()],
            vec!["audience".into(), "agents".into()],
        ]
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Pending {
    id: String,
    text: String,
    event: Option<Value>,
    attempted: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    version: u8,
    target: Target,
    sender: Option<AppAgent>,
    invitation: Option<Value>,
    invitation_attempted: bool,
    snapshot: Option<Value>,
    pending: Vec<Pending>,
    receipts: Vec<String>,
    terminal: bool,
    error: Option<String>,
}
impl Journal {
    fn new(target: Target) -> Self {
        Self {
            version: 1,
            target,
            sender: None,
            invitation: None,
            invitation_attempted: false,
            snapshot: None,
            pending: vec![],
            receipts: vec![],
            terminal: false,
            error: None,
        }
    }
    fn checkpoint(&mut self, poll: Poll) -> Result<(), String> {
        if self.snapshot.as_ref() == Some(&poll.snapshot) {
            return Ok(());
        }
        let mut output = poll.output.as_str();
        let mut pending = vec![];
        while !output.is_empty() {
            let mut end = output.len().min(24 * 1024);
            while !output.is_char_boundary(end) {
                end -= 1;
            }
            pending.push(Pending {
                id: format!(
                    "{:x}",
                    Sha256::digest(format!("{}:{}", poll.snapshot, pending.len()))
                ),
                text: output[..end].to_owned(),
                event: None,
                attempted: false,
            });
            output = &output[end..];
        }
        if self.pending.len() + pending.len() > MAX_PENDING {
            return Err("PR delivery backlog is full; source checkpoint retained".into());
        }
        self.pending.extend(pending);
        self.snapshot = Some(poll.snapshot);
        self.terminal = poll.terminal;
        self.error = None;
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Poll {
    snapshot: Value,
    output: String,
    terminal: bool,
}
struct Store {
    path: PathBuf,
    _lock: File,
}
impl Store {
    #[allow(clippy::incompatible_msrv)] // Same file-lock primitive as native agent hosting.
    fn open(dir: &Path, target: &Target) -> Result<(Self, Journal), String> {
        std::fs::create_dir_all(dir).map_err(|_| "Cannot open PR subscription storage")?;
        let id = target.id();
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(dir.join(format!("{id}.lock")))
            .map_err(|_| "Cannot lock PR subscription")?;
        lock.try_lock()
            .map_err(|_| "PR subscription is already active")?;
        let store = Self {
            path: dir.join(format!("{id}.json")),
            _lock: lock,
        };
        let journal = match std::fs::read(&store.path) {
            Ok(bytes) if bytes.len() <= LIMIT => serde_json::from_slice::<Journal>(&bytes)
                .map_err(|_| "Invalid retained PR subscription")?,
            Ok(_) => return Err("Retained PR subscription exceeds limit".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Journal::new(target.clone()),
            Err(_) => return Err("Cannot read retained PR subscription".into()),
        };
        if journal.version != 1 || &journal.target != target {
            return Err("Retained PR subscription has a different route".into());
        }
        Ok((store, journal))
    }
    fn save(&self, journal: &Journal) -> Result<(), String> {
        let bytes = serde_json::to_vec(journal).map_err(|_| "Cannot encode PR checkpoint")?;
        if bytes.len() > LIMIT {
            return Err("PR checkpoint exceeds limit".into());
        }
        let dir = self.path.parent().ok_or("Invalid PR checkpoint path")?;
        let mut next =
            tempfile::NamedTempFile::new_in(dir).map_err(|_| "Cannot create PR checkpoint")?;
        next.write_all(&bytes)
            .and_then(|_| next.as_file().sync_all())
            .map_err(|_| "Cannot save PR checkpoint")?;
        next.persist(&self.path)
            .map_err(|_| "Cannot commit PR checkpoint")?;
        #[cfg(unix)]
        File::open(dir)
            .and_then(|f| f.sync_all())
            .map_err(|_| "Cannot sync PR checkpoint")?;
        Ok(())
    }
}
#[derive(Clone)]
pub(crate) struct Subscriptions {
    dir: Result<PathBuf, String>,
    active: Arc<Mutex<HashSet<String>>>,
}
impl Subscriptions {
    pub(crate) fn new(dir: Result<PathBuf, String>) -> Self {
        Self {
            dir,
            active: Arc::default(),
        }
    }
    pub(crate) fn resume(&self, host: AppAgentHost, pubkey: String) {
        let Ok(dir) = &self.dir else {
            return;
        };
        let Ok(files) = std::fs::read_dir(dir) else {
            return;
        };
        for file in files.flatten().take(100) {
            if file.path().extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let Ok(bytes) = std::fs::read(file.path()) else {
                continue;
            };
            if bytes.len() > LIMIT {
                continue;
            }
            let Ok(journal) = serde_json::from_slice::<Journal>(&bytes) else {
                continue;
            };
            if journal.target.pubkey != pubkey
                || journal.sender.is_none()
                || journal.snapshot.is_none()
                || (journal.terminal && journal.pending.is_empty())
            {
                continue;
            }
            let owner = self.clone();
            let host = host.clone();
            tauri::async_runtime::spawn(async move {
                let _ = owner.start(host, journal.target, None).await;
            });
        }
    }
    async fn start(
        &self,
        host: AppAgentHost,
        target: Target,
        identity: Option<IdentityHost>,
    ) -> Result<Value, String> {
        target.validate()?;
        if !host.claimed(&target.pubkey) {
            return Err("This host does not own the agent".into());
        }
        let current = host.agent(target.pubkey.clone()).await?;
        if current.owner != target.owner || current.relay != target.relay {
            return Err("Agent ownership changed".into());
        }
        let id = target.id();
        {
            let mut active = self
                .active
                .lock()
                .map_err(|_| "PR subscription lock unavailable")?;
            if active.contains(&id) {
                return Ok(json!({"id": id, "status": "active"}));
            }
            if active.len() >= 100 {
                return Err("PR subscription limit reached".into());
            }
            active.insert(id.clone());
        }
        let result = self.prepare(host.clone(), target, identity).await;
        match result {
            Ok((store, mut journal, sender_key)) => {
                let status = if journal.terminal && journal.pending.is_empty() {
                    "terminal"
                } else {
                    "running"
                };
                let reply = json!({"id": id, "status": status, "baseline": journal.snapshot.as_ref().map(|s| format!("{:x}", Sha256::digest(s.to_string().as_bytes()))), "sender": journal.sender.as_ref().map(|s| &s.pubkey)});
                let subscriptions = self.clone();
                let task_id = id.clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(Duration::from_secs(60)).await;
                        if !host.claimed(&journal.target.pubkey)
                            || (journal.terminal && journal.pending.is_empty())
                        {
                            break;
                        }
                        if let Err(error) = tick(&host, &store, &mut journal, &sender_key).await {
                            journal.error = Some(error);
                            if store.save(&journal).is_err() {
                                break;
                            }
                        }
                    }
                    if let Ok(mut active) = subscriptions.active.lock() {
                        active.remove(&task_id);
                    }
                });
                Ok(reply)
            }
            Err(error) => {
                self.active
                    .lock()
                    .map_err(|_| "PR subscription lock unavailable")?
                    .remove(&id);
                Err(error)
            }
        }
    }
    async fn prepare(
        &self,
        host: AppAgentHost,
        target: Target,
        identity: Option<IdentityHost>,
    ) -> Result<(Store, Journal, Arc<Secret>), String> {
        if !host.claimed(&target.pubkey) {
            return Err("This host does not own the agent".into());
        }
        let (agent, key) = host.key(host.agent(target.pubkey.clone()).await?).await?;
        if agent.owner != target.owner || agent.relay != target.relay {
            return Err("Agent ownership changed".into());
        }
        let (store, mut journal) = Store::open(self.dir.as_ref().map_err(Clone::clone)?, &target)?;
        validate_route(&agent, &key, &target).await?;
        let sender_key = Arc::new(load_sender_key().await?);
        if journal.sender.is_none() {
            let identity = identity
                .as_ref()
                .ok_or("Native monitor setup is not complete")?;
            let auth = identity
                .authorize_agent(target.owner.clone(), sender_key.pubkey().into())
                .await?;
            journal.sender = Some(AppAgent {
                pubkey: sender_key.pubkey().into(),
                relay: target.relay.clone(),
                owner: target.owner.clone(),
                auth: serde_json::to_string(&auth).map_err(|_| "Invalid monitor authorization")?,
                agent_type: "buzz.monitor/pr".into(),
                name: "Monitor".into(),
                picture: None,
                about: None,
                profile: None,
                deleted: false,
            });
            store.save(&journal)?;
        }
        let sender = journal
            .sender
            .as_ref()
            .ok_or("Monitor identity unavailable")?;
        if sender.pubkey != sender_key.pubkey()
            || sender.owner != target.owner
            || sender.relay != target.relay
            || sender.pubkey == target.pubkey
        {
            return Err("Native monitor identity changed".into());
        }
        verify_sender(sender)?;
        if !member(&agent, &key, &target.channel, &sender.pubkey).await? {
            let identity = identity
                .as_ref()
                .ok_or("Monitor channel membership unavailable")?;
            if journal.invitation.is_none() {
                let now = now()?;
                journal.invitation = Some(
                    identity
                        .sign(EventTemplate {
                            created_at: now,
                            kind: 9000,
                            content: String::new(),
                            tags: vec![
                                vec!["h".into(), target.channel.clone()],
                                vec!["p".into(), sender.pubkey.clone()],
                                vec!["role".into(), "bot".into()],
                            ],
                        })
                        .await?,
                );
                store.save(&journal)?;
            }
            if journal.invitation_attempted {
                return Err(
                    "Monitor invitation is unconfirmed; retained for membership reconciliation"
                        .into(),
                );
            }
            journal.invitation_attempted = true;
            store.save(&journal)?;
            crate::relay::publish_owned_event(
                identity,
                &target.relay,
                journal
                    .invitation
                    .as_ref()
                    .ok_or("Missing monitor invitation")?,
            )
            .await?;
            if !member(&agent, &key, &target.channel, sender_key.pubkey()).await? {
                return Err("Monitor membership not yet confirmed; source not started".into());
            }
        }
        // A profile is not parsed through the CLI. The owner attestation is native-verified.
        if journal.snapshot.is_none() {
            journal.checkpoint(source_poll(&target, None).await?)?;
            store.save(&journal)?;
        }
        deliver(&store, &mut journal, &sender_key).await?;
        Ok((store, journal, sender_key))
    }
}
fn now() -> Result<u64, String> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|_| "System clock unavailable".into())
}
fn verify_sender(sender: &AppAgent) -> Result<(), String> {
    let tag: Vec<String> =
        serde_json::from_str(&sender.auth).map_err(|_| "Invalid monitor ownership")?;
    if tag.len() != 4
        || tag[0] != "auth"
        || tag[1] != sender.owner
        || !tag[2].is_empty()
        || sender.owner == sender.pubkey
    {
        return Err("Monitor ownership mismatch".into());
    }
    let owner: secp256k1::XOnlyPublicKey =
        sender.owner.parse().map_err(|_| "Invalid monitor owner")?;
    let signature: secp256k1::schnorr::Signature =
        tag[3].parse().map_err(|_| "Invalid monitor attestation")?;
    secp256k1::Secp256k1::verification_only()
        .verify_schnorr(
            &signature,
            &Sha256::digest(format!("nostr:agent-auth:{}:", sender.pubkey)),
            &owner,
        )
        .map_err(|_| "Monitor attestation does not match owner".into())
}
fn verified(value: &Value) -> Result<(), String> {
    let event: nostr::event::Event =
        serde_json::from_value(value.clone()).map_err(|_| "Malformed relay event")?;
    event
        .verify()
        .map_err(|_| "Relay event signature mismatch".into())
}
async fn member(
    agent: &AppAgent,
    key: &Secret,
    channel: &str,
    pubkey: &str,
) -> Result<bool, String> {
    let value = read(
        agent,
        key,
        &[json!({"kinds": [39002], "#d": [channel], "limit": 1})],
    )
    .await?;
    let rows = value.as_array().ok_or("Malformed channel membership")?;
    let Some(row) = rows.first() else {
        return Ok(false);
    };
    verified(row)?;
    let tags = row["tags"]
        .as_array()
        .ok_or("Malformed channel membership")?;
    Ok(tags.iter().any(|t| t[0] == "p" && t[1] == pubkey))
}
async fn validate_route(agent: &AppAgent, key: &Secret, target: &Target) -> Result<(), String> {
    let roots = read(
        agent,
        key,
        &[json!({"ids": [target.root], "kinds": [9, 45001], "limit": 1})],
    )
    .await?;
    let root = roots
        .as_array()
        .and_then(|r| r.first())
        .ok_or("Owning thread is unavailable")?;
    verified(root)?;
    if root["id"] != target.root
        || !root["tags"]
            .as_array()
            .is_some_and(|ts| ts.iter().any(|t| t[0] == "h" && t[1] == target.channel))
        || root["tags"].as_array().is_some_and(|ts| {
            ts.iter()
                .any(|t| t[0] == "e" && (t[3] == "reply" || t[3] == "root"))
        })
        || !member(agent, key, &target.channel, &target.pubkey).await?
    {
        return Err("Subscription route does not match owning thread".into());
    }
    Ok(())
}
async fn tick(
    host: &AppAgentHost,
    store: &Store,
    journal: &mut Journal,
    key: &Secret,
) -> Result<(), String> {
    let (agent, target_key) = host
        .key(host.agent(journal.target.pubkey.clone()).await?)
        .await?;
    if agent.owner != journal.target.owner || agent.relay != journal.target.relay {
        return Err("Subscription agent ownership changed".into());
    }
    validate_route(&agent, &target_key, &journal.target).await?;
    deliver(store, journal, key).await?;
    if journal.terminal {
        return Ok(());
    }
    let poll = source_poll(&journal.target, journal.snapshot.as_ref()).await?;
    journal.checkpoint(poll)?;
    store.save(journal)?;
    deliver(store, journal, key).await
}
fn matches_callback(
    event: &Value,
    sender: &AppAgent,
    target: &Target,
    text: &str,
    source_id: &str,
) -> Result<(), String> {
    verified(event)?;
    if sender.owner != target.owner || sender.relay != target.relay {
        return Err("Callback ownership mismatch".into());
    }
    if event["pubkey"] != sender.pubkey || event["kind"] != 9 || event["content"] != text {
        return Err("Callback identity or content mismatch".into());
    }
    let mut expected = target.tags();
    expected.push(vec!["monitor".into(), target.id(), source_id.into()]);
    expected.push(serde_json::from_str(&sender.auth).map_err(|_| "Invalid callback attestation")?);
    let mut actual: Vec<Vec<String>> =
        serde_json::from_value(event["tags"].clone()).map_err(|_| "Invalid callback route")?;
    let millis = actual.pop().ok_or("Missing callback timestamp")?;
    if millis.len() != 2
        || millis[0] != "ms"
        || millis[1].parse::<u32>().map(|v| v > 999).unwrap_or(true)
        || actual != expected
    {
        return Err("Callback route mismatch".into());
    }
    Ok(())
}
trait DeliveryTransport {
    fn read(
        &self,
        sender: &AppAgent,
        key: &Secret,
        filters: &[Value],
    ) -> impl std::future::Future<Output = Result<Value, String>> + Send;
    fn post(
        &self,
        sender: &AppAgent,
        key: &Secret,
        event: Value,
    ) -> impl std::future::Future<Output = Result<(), String>> + Send;
}
struct NativeDelivery;
impl DeliveryTransport for NativeDelivery {
    async fn read(
        &self,
        sender: &AppAgent,
        key: &Secret,
        filters: &[Value],
    ) -> Result<Value, String> {
        read(sender, key, filters).await
    }
    async fn post(&self, sender: &AppAgent, key: &Secret, event: Value) -> Result<(), String> {
        post(sender, key, event).await.map(|_| ())
    }
}
async fn deliver(store: &Store, journal: &mut Journal, key: &Secret) -> Result<(), String> {
    deliver_with(store, journal, key, &NativeDelivery).await
}
async fn deliver_with(
    store: &Store,
    journal: &mut Journal,
    key: &Secret,
    transport: &impl DeliveryTransport,
) -> Result<(), String> {
    while let Some(pending) = journal.pending.first() {
        let sender = journal
            .sender
            .as_ref()
            .ok_or("Native monitor sender unavailable")?;
        let content = format!(
            "[monitor: https://github.com/{}/pull/{}]\n{}",
            journal.target.repo, journal.target.pr, pending.text
        );
        if pending.event.is_none() {
            let mut tags = journal.target.tags();
            tags.push(vec![
                "monitor".into(),
                journal.target.id(),
                pending.id.clone(),
            ]);
            let event = sender.sign(key, 9, content, tags)?;
            journal.pending[0].event = Some(event);
            store.save(journal)?;
            continue;
        }
        let event = pending.event.clone().ok_or("Missing signed callback")?;
        matches_callback(&event, sender, &journal.target, &content, &pending.id)?;
        if pending.attempted {
            let receipt = transport.read(sender, key, &[json!({"ids": [event["id"]], "kinds": [9], "#h": [journal.target.channel], "limit": 1})]).await?;
            let found = receipt
                .as_array()
                .and_then(|r| r.first())
                .ok_or("Callback delivery unconfirmed; retained without resend")?;
            if found != &event {
                return Err("Callback receipt does not match signed delivery".into());
            }
            matches_callback(found, sender, &journal.target, &content, &pending.id)?;
        } else {
            journal.pending[0].attempted = true;
            store.save(journal)?;
            transport.post(sender, key, event.clone()).await?;
        }
        journal.receipts.push(
            event["id"]
                .as_str()
                .ok_or("Missing callback receipt ID")?
                .into(),
        );
        if journal.receipts.len() > 256 {
            journal.receipts.remove(0);
        }
        journal.pending.remove(0);
        store.save(journal)?;
    }
    Ok(())
}
async fn source_poll(target: &Target, snapshot: Option<&Value>) -> Result<Poll, String> {
    let source = dirs::home_dir()
        .ok_or("No native home directory")?
        .join(".agents/skills/monitor-pr/scripts/pr-monitor-poll.py");
    source_poll_at(&source, target, snapshot).await
}
async fn source_poll_at(
    source: &Path,
    target: &Target,
    snapshot: Option<&Value>,
) -> Result<Poll, String> {
    if !source.is_file() {
        return Err("Checkpointed monitor-pr producer is not installed".into());
    }
    let path = crate::host_command::effective_path();
    let mut command =
        tokio::process::Command::new(crate::host_command::resolve_program("python3", &path));
    command
        .arg(source)
        .env("PATH", path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    for (name, _) in std::env::vars_os() {
        let name_text = name.to_string_lossy();
        if name_text.starts_with("BUZZ_") || name_text.starts_with("NOSTR_") {
            command.env_remove(name);
        }
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Cannot start PR checkpoint producer")?;
    let mut stdin = child.stdin.take().ok_or("Producer input unavailable")?;
    let mut stdout = child.stdout.take().ok_or("Producer output unavailable")?;
    let request = json!({"repo": target.repo, "pr": target.pr, "snapshot": snapshot});
    let operation = async {
        stdin
            .write_all(request.to_string().as_bytes())
            .await
            .map_err(|_| "Cannot send PR checkpoint")?;
        drop(stdin);
        let mut output = vec![];
        (&mut stdout)
            .take((LIMIT + 1) as u64)
            .read_to_end(&mut output)
            .await
            .map_err(|_| "Cannot read PR checkpoint")?;
        if output.len() > LIMIT {
            return Err("Producer checkpoint exceeds limit".into());
        }
        if !child
            .wait()
            .await
            .map_err(|_| "Cannot wait for PR producer")?
            .success()
        {
            return Err("PR checkpoint poll failed; cursor retained".into());
        }
        serde_json::from_slice::<Poll>(&output)
            .map_err(|_| "Malformed PR producer checkpoint".into())
    };
    tokio::time::timeout(Duration::from_secs(130), operation)
        .await
        .map_err(|_| "PR checkpoint poll timed out")?
}
async fn load_sender_key() -> Result<Secret, String> {
    tokio::task::spawn_blocking(|| {
        let bytes = monitor_credential()?;
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| "Native monitor credential malformed")?
            .trim();
        let secret = nostr::key::SecretKey::parse(text)
            .map_err(|_| "Native monitor credential malformed")?;
        let pubkey = nostr::key::Keys::new(secret).public_key().to_hex();
        Secret::parse(text, &pubkey)
    })
    .await
    .map_err(|_| "Native monitor custody unavailable")?
}
#[cfg(all(not(test), target_os = "macos"))]
fn monitor_credential() -> Result<zeroize::Zeroizing<Vec<u8>>, String> {
    use security_framework::os::macos::keychain::SecKeychain;
    let keychain = SecKeychain::default().map_err(|_| "Native monitor custody unavailable")?;
    keychain
        .find_generic_password("buzz-persistent-monitor", "poster")
        .map(|(p, _)| zeroize::Zeroizing::new(p.to_vec()))
        .map_err(|_| "Native monitor credential unavailable".into())
}
#[cfg(all(not(test), any(target_os = "linux", target_os = "windows")))]
fn monitor_credential() -> Result<zeroize::Zeroizing<Vec<u8>>, String> {
    buzz_credential_store::read("buzz-persistent-monitor", "poster")
        .map_err(|_| "Native monitor credential unavailable".into())
}
#[cfg(any(
    test,
    not(any(target_os = "macos", target_os = "linux", target_os = "windows"))
))]
fn monitor_credential() -> Result<zeroize::Zeroizing<Vec<u8>>, String> {
    Err("Native monitor custody unavailable".into())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn app_agent_subscribe_pr(
    state: tauri::State<'_, AppAgentHost>,
    identity: tauri::State<'_, IdentityHost>,
    pubkey: String,
    owner: String,
    channel: String,
    root: String,
    repo: String,
    pr: u32,
) -> Result<Value, String> {
    let host = state.inner().clone();
    let agent = host.agent(pubkey.clone()).await?;
    let target = Target {
        pubkey,
        owner,
        relay: agent.relay,
        channel,
        root,
        repo,
        pr,
    };
    host.subscriptions
        .start(host.clone(), target, Some(identity.inner().clone()))
        .await
}

#[cfg(test)]
mod tests;
