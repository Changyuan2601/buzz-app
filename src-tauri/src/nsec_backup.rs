//! Purpose-bound native backup. No key crosses IPC.
mod crypto;
mod persistence;
pub(crate) use persistence::root as storage_root;

use crate::{identity::IdentityHost, nsec_backup_config::Config};
use buzz_nsec_backup::Client;
use secp256k1::XOnlyPublicKey;
use serde::Deserialize;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::async_runtime::JoinHandle;
use zeroize::Zeroizing;

const RETRY: &str = "Could not restore your identity. Try again.";
const CANCELED: &str = "Restore was canceled. Try again.";
const UNAVAILABLE: &str = "Backup recovery is unavailable. Try again later.";
type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Source {
    Builderlab,
    Hosted,
}
impl Source {
    fn index(self) -> usize {
        match self {
            Self::Builderlab => 0,
            Self::Hosted => 1,
        }
    }
}

#[derive(Clone)]
struct Session {
    source: Source,
    credential: Zeroizing<String>,
}
#[derive(Default)]
struct State {
    closed: bool,
    epoch: u64,
    generations: [Option<u64>; 2],
    session: Option<Session>,
    worker: Option<JoinHandle<()>>,
    rerun: bool,
}
impl State {
    fn retire(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
        self.rerun = false;
        if let Some(worker) = self.worker.take() {
            worker.abort();
        }
    }
}
#[derive(Clone)]
pub(crate) struct NsecBackupHost {
    state: Arc<Mutex<State>>,
    config: Arc<Option<Config>>,
    root: Option<PathBuf>,
}
impl Default for NsecBackupHost {
    fn default() -> Self {
        let config = crate::nsec_backup_config::configured(
            option_env!("BUZZ_NSEC_BACKUP_SERVICE_URL"),
            option_env!("BUZZ_NSEC_BACKUP_NAMESPACE"),
        )
        .ok()
        .flatten();
        Self {
            state: Default::default(),
            config: Arc::new(config),
            // Default test hosts never access the OS account's backup directory.
            root: if cfg!(test) { None } else { storage_root() },
        }
    }
}
impl NsecBackupHost {
    pub(crate) fn document_load(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.retire();
        state.session = None;
        // Source counters restart with each renderer document.
        state.generations = [None, None];
    }
    pub(crate) fn close(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.closed = true;
        state.retire();
        state.session = None;
    }
    pub(crate) fn local_key_installed(&self, identity: IdentityHost) {
        if let Ok(mut state) = self.state.lock() {
            state.retire();
        }
        self.trigger(identity);
    }
    fn valid(&self, epoch: u64) -> Result<()> {
        let state = self.state.lock().map_err(|_| CANCELED)?;
        if state.closed || state.epoch != epoch {
            Err(CANCELED.into())
        } else {
            Ok(())
        }
    }
    fn source_allowed(&self, source: Source) -> bool {
        let Some(config) = self.config.as_ref() else {
            return false;
        };
        match source {
            Source::Hosted => config.service_url == "https://app.builderlab.xyz/api/goose",
            Source::Builderlab => url::Url::parse(&config.service_url)
                .ok()
                .is_some_and(|url| {
                    !buzzodz_plugins::BUILDERLAB_ORIGIN.is_empty()
                        && url.origin().ascii_serialization() == buzzodz_plugins::BUILDERLAB_ORIGIN
                }),
        }
    }
    fn session(
        &self,
        source: Source,
        generation: u64,
        credential: Option<String>,
        identity: IdentityHost,
    ) -> Result<()> {
        // Reject a foreign service before copying a caller's already-held credential.
        let credential = credential.map(Zeroizing::new);
        if !self.source_allowed(source) {
            return Ok(());
        }
        if credential.as_ref().is_some_and(|c| !valid_credential(c)) {
            return Err("Invalid backup session".into());
        }
        let mut state = self.state.lock().map_err(|_| "Backup unavailable")?;
        if state.closed {
            return Ok(());
        }
        let previous = state.generations[source.index()];
        if previous.is_some_and(|seen| generation <= seen) {
            return Ok(());
        }
        state.generations[source.index()] = Some(generation);
        if credential.is_none() && state.session.as_ref().is_some_and(|s| s.source != source) {
            return Ok(());
        }
        state.retire();
        state.session = credential.map(|credential| Session { source, credential });
        drop(state);
        self.trigger(identity);
        Ok(())
    }
    fn trigger(&self, identity: IdentityHost) {
        if self.config.is_none() || self.root.is_none() {
            return;
        }
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.closed {
            return;
        }
        if state
            .worker
            .as_ref()
            .is_some_and(|task| !task.inner().is_finished())
        {
            state.rerun = true;
            return;
        }
        let Some(session) = state.session.clone() else {
            return;
        };
        let epoch = state.epoch;
        state.rerun = false;
        let host = self.clone();
        state.worker = Some(tauri::async_runtime::spawn(async move {
            loop {
                if host.backup(&identity, &session, epoch).await.is_err() {
                    eprintln!("Automatic identity backup deferred");
                }
                let Ok(mut state) = host.state.lock() else {
                    return;
                };
                if state.closed || state.epoch != epoch {
                    return;
                }
                // Consume overlapping lifecycle events in this worker, without a timer.
                if std::mem::take(&mut state.rerun) {
                    continue;
                }
                state.worker = None;
                return;
            }
        }));
    }
    async fn backup(&self, identity: &IdentityHost, session: &Session, epoch: u64) -> Result<()> {
        let config = self.config.as_ref().as_ref().ok_or(UNAVAILABLE)?;
        let api = Api::new(&config.service_url, &session.credential)?;
        let account = api.me().await?;
        self.valid(epoch)?;
        let pubkey = identity.viewer().await?;
        let current = api.current().await?;
        if current.as_deref() != Some(&pubkey) {
            return Err("Backup identity mismatch".into());
        }
        let client = Client::new(&config.service_url, &session.credential).map_err(|_| RETRY)?;
        let enrollment = client.enroll().await.map_err(|_| RETRY)?;
        self.valid(epoch)?;
        crypto::validate_enrollment(
            &enrollment,
            &config.namespace,
            &enrollment.owner_id,
            &pubkey,
        )?;
        let locked = {
            let state = self.state.lock().map_err(|_| RETRY)?;
            if state.closed || state.epoch != epoch {
                return Err(CANCELED.into());
            }
            persistence::LockedRecord::open(
                self.root.as_ref().ok_or(RETRY)?,
                config,
                &account.subject,
                &enrollment.nostr_pubkey,
            )?
        };
        self.valid(epoch)?;
        let mut record = match locked.read()? {
            Some(record) => {
                record.matches(config, &account.subject, &enrollment)?;
                record
            }
            None => {
                let mut record = persistence::Record::new(config, &account.subject, &enrollment);
                let namespace = config.namespace.clone();
                let expected = pubkey.clone();
                let owner = enrollment.owner_id.clone();
                let bytes = identity
                    .with_key(move |secret, local| {
                        if local != expected {
                            return Err("Backup identity mismatch".into());
                        }
                        crypto::seal(&enrollment, &namespace, &owner, local, secret)
                    })
                    .await?;
                record.envelope = Some(String::from_utf8(bytes).map_err(|_| RETRY)?);
                let state = self.state.lock().map_err(|_| RETRY)?;
                if state.closed || state.epoch != epoch {
                    return Err(CANCELED.into());
                }
                locked.write(&record)?;
                drop(state);
                record
            }
        };
        let Some(envelope) = record.envelope.as_ref() else {
            return Ok(());
        };
        self.valid(epoch)?;
        let receipt = client
            .upload(envelope.as_bytes())
            .await
            .map_err(|_| RETRY)?;
        if !receipt.stored || receipt.backup_id != record.backup_id {
            return Err("Backup receipt mismatch".into());
        }
        let state = self.state.lock().map_err(|_| RETRY)?;
        if state.closed || state.epoch != epoch {
            return Err(CANCELED.into());
        }
        record.envelope = None;
        locked.write(&record)?;
        Ok(())
    }
}

fn valid_credential(value: &str) -> bool {
    !value.is_empty() && value.len() <= 4096 && value.bytes().all(|c| (33..=126).contains(&c))
}
fn public_key(value: &str) -> Result<String> {
    let public: XOnlyPublicKey = value.parse().map_err(|_| RETRY)?;
    if public.to_string() != value {
        return Err(RETRY.into());
    }
    Ok(value.to_owned())
}
#[derive(Deserialize)]
struct Account {
    subject: String,
    expires_at: String,
}
struct Api {
    http: reqwest::Client,
    root: String,
    credential: reqwest::header::HeaderValue,
}
impl Api {
    fn new(root: &str, credential: &str) -> Result<Self> {
        let mut header = reqwest::header::HeaderValue::from_str(credential).map_err(|_| RETRY)?;
        header.set_sensitive(true);
        Ok(Self {
            http: Self::http(root)?,
            root: root.to_owned(),
            credential: header,
        })
    }
    fn http(root: &str) -> Result<reqwest::Client> {
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .timeout(Duration::from_secs(30));
        if root.starts_with("http:") {
            builder = builder.no_proxy();
        }
        builder.build().map_err(|_| RETRY.into())
    }
    async fn request(&self, path: &str, post: bool) -> Result<Zeroizing<Vec<u8>>> {
        let url = format!("{}{path}", self.root);
        let request = if post {
            self.http
                .post(url)
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body("{}")
        } else {
            self.http.get(url)
        };
        let response = request
            .header("X-BB-Session-Credential", &self.credential)
            .send()
            .await
            .map_err(|_| RETRY)?;
        Self::body(response).await
    }
    async fn body(mut response: reqwest::Response) -> Result<Zeroizing<Vec<u8>>> {
        if !response.status().is_success()
            || response.content_length().is_some_and(|len| len > 8192)
        {
            return Err(RETRY.into());
        }
        let mut body = Zeroizing::new(Vec::with_capacity(8192));
        while let Some(chunk) = response.chunk().await.map_err(|_| RETRY)? {
            if chunk.len() > 8192 - body.len() {
                return Err(RETRY.into());
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    }
    async fn me(&self) -> Result<Account> {
        let account: Account = serde_json::from_slice(&self.request("/v1/auth/me", false).await?)
            .map_err(|_| RETRY)?;
        let expiry = chrono::DateTime::parse_from_rfc3339(&account.expires_at)
            .map_err(|_| RETRY)?
            .timestamp();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| RETRY)?
            .as_secs();
        if account.subject.is_empty()
            || account.subject.len() > 1024
            || account.subject.chars().any(char::is_control)
            || expiry <= now as i64
        {
            return Err(RETRY.into());
        }
        Ok(account)
    }
    async fn current(&self) -> Result<Option<String>> {
        let value: serde_json::Value = serde_json::from_slice(
            &self
                .request("/v1/buzz/nostr-identities/current", true)
                .await?,
        )
        .map_err(|_| RETRY)?;
        if value.get("error").is_some_and(|error| !error.is_null()) {
            return Err(RETRY.into());
        }
        let known = value
            .get("correlation_id")
            .and_then(|id| id.as_str())
            .is_some_and(|id| !id.is_empty());
        match value.get("identity") {
            Some(serde_json::Value::Null) if known => Ok(None),
            Some(identity) => public_key(
                identity
                    .get("pubkey_hex")
                    .and_then(|key| key.as_str())
                    .ok_or(RETRY)?,
            )
            .map(Some),
            None if known => Ok(None),
            _ => Err(RETRY.into()),
        }
    }
}

#[tauri::command]
pub(crate) fn nsec_backup_available(host: tauri::State<'_, NsecBackupHost>) -> bool {
    host.config.is_some()
}
#[tauri::command]
pub(crate) fn nsec_backup_session(
    host: tauri::State<'_, NsecBackupHost>,
    identity: tauri::State<'_, IdentityHost>,
    source: Source,
    generation: u64,
    credential: Option<String>,
) -> Result<()> {
    host.session(source, generation, credential, identity.inner().clone())
}
#[tauri::command]
pub(crate) fn nsec_backup_retry(
    host: tauri::State<'_, NsecBackupHost>,
    identity: tauri::State<'_, IdentityHost>,
    source: Source,
) {
    let matching = host.state.lock().ok().is_some_and(|state| {
        state
            .session
            .as_ref()
            .is_some_and(|session| session.source == source)
    });
    if matching {
        host.trigger(identity.inner().clone());
    }
}
#[cfg(test)]
#[path = "nsec_backup/tests.rs"]
mod tests;
