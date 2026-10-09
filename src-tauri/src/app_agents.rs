//! Native custody for agents the app runs through a plugin (Agents2). The key
//! and owner attestation never enter the WebView; it asks for one bounded
//! event at a time, and native signs and posts it to the agent's community.
use crate::agents::profile_http::authorization;
use buzz_agent_controller::{
    AppAgent, AppAgents, Credentials, PlatformCredentials, Published, Secret, CREDENTIALS_BUSY,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use zeroize::Zeroizing;

const BUSY_WAITS: u32 = 50;
const BUSY_WAIT: std::time::Duration = std::time::Duration::from_millis(100);

/// The identity file (which locks its own writes across app instances) and its
/// own credential handle, so Agents2 never waits on, or fails with, the harness
/// agent controller (whose storage lock another app may hold).
#[derive(Clone)]
pub(crate) struct AppAgentHost {
    agents: Result<AppAgents, String>,
    credentials: Arc<dyn Credentials>,
    /// Each key after its first read, so only create and first use reach the
    /// credential store, whose lock refuses rather than waits. Waiting on this
    /// lock instead lets concurrent publications queue for that first read.
    keys: Arc<Mutex<HashMap<String, Arc<Secret>>>>,
    /// One profile publication per agent at a time, so each is newer than the
    /// last; Delete takes it too, so no publication outlives the key.
    profiles: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
}
impl AppAgentHost {
    pub(crate) fn new(path: Result<PathBuf, String>) -> Self {
        Self {
            agents: path.map(AppAgents::open),
            credentials: Arc::new(PlatformCredentials::default()),
            keys: Arc::default(),
            profiles: Arc::default(),
        }
    }
    fn keys(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Secret>>> {
        self.keys
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
    fn profile_turn(&self, pubkey: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.profiles
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(pubkey.into())
            .or_default()
            .clone()
    }
    /// The agent's key; read from the credential store only on first use. A
    /// busy store (a harness start or another app holding it) is waited out for
    /// a few seconds, without holding up agents whose keys are already read.
    async fn key(&self, agent: AppAgent) -> Result<(AppAgent, Arc<Secret>), String> {
        let host = self.clone();
        blocking(move || {
            let mut waits = 0;
            loop {
                let mut keys = host.keys();
                if let Some(key) = keys.get(&agent.pubkey) {
                    return Ok((agent, key.clone()));
                }
                match agent.read_key(host.credentials.as_ref()) {
                    Err(error) if error == CREDENTIALS_BUSY && waits < BUSY_WAITS => {
                        drop(keys);
                        waits += 1;
                        std::thread::sleep(BUSY_WAIT);
                    }
                    read => {
                        let key = Arc::new(read?);
                        keys.insert(agent.pubkey.clone(), key.clone());
                        return Ok((agent, key));
                    }
                }
            }
        })
        .await
    }
    /// Deletes the key once any profile publication in flight has settled, so
    /// the community's cleanup sees every profile it will ever have. The row
    /// stays, marked deleted, until the WebView has cleaned up the community and
    /// calls `app_agent_forget`.
    async fn delete(&self, pubkey: String) -> Result<(), String> {
        let turn = self.profile_turn(&pubkey);
        let _turn = turn.lock().await;
        let host = self.clone();
        blocking(move || {
            // Held across the deletion, so no publication re-reads the key meanwhile.
            let mut keys = host.keys();
            keys.remove(&pubkey);
            host.agents
                .clone()?
                .remove(&pubkey, host.credentials.as_ref())
        })
        .await
    }
    /// The agent, if it still has its key. One deleted elsewhere loses its cached key.
    async fn agent(&self, pubkey: String) -> Result<AppAgent, String> {
        let host = self.clone();
        blocking(move || {
            let agent = host.agents.clone()?.get(&pubkey);
            if agent.is_err() {
                host.keys().remove(&pubkey);
            }
            agent
        })
        .await
    }
    /// The environment a process of `plugin` runs with to act as one of its own
    /// agents: the key, community and owner attestation, named as the harness
    /// passes them to buzz-acp. Unlike `publish`, whatever holds the key can
    /// sign any event as the agent.
    pub(crate) async fn process_identity(
        &self,
        pubkey: String,
        plugin: &str,
    ) -> Result<Vec<(&'static str, Zeroizing<String>)>, String> {
        let agent = self.agent(pubkey).await?;
        if agent.agent_type.split_once('/').map(|(owner, _)| owner) != Some(plugin) {
            return Err("That agent belongs to another plugin".into());
        }
        let (agent, key) = self.key(agent).await?;
        let hex = key.hex();
        Ok(vec![
            ("BUZZ_PRIVATE_KEY", hex.clone()),
            ("NOSTR_PRIVATE_KEY", hex),
            ("BUZZ_RELAY_URL", Zeroizing::new(agent.relay.clone())),
            ("BUZZ_AUTH_TAG", Zeroizing::new(agent.auth.clone())),
        ])
    }
}

/// Runs blocking file and credential work off the async runtime.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "Native credential operation failed".to_owned())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppAgentSummary {
    pubkey: String,
    relay: String,
    owner: String,
    #[serde(rename = "type")]
    agent_type: String,
    name: String,
    deleted: bool,
}
impl From<AppAgent> for AppAgentSummary {
    fn from(agent: AppAgent) -> Self {
        Self {
            pubkey: agent.pubkey,
            relay: agent.relay,
            owner: agent.owner,
            agent_type: agent.agent_type,
            name: agent.name,
            deleted: agent.deleted,
        }
    }
}

#[tauri::command]
pub(crate) async fn app_agent_list(
    state: tauri::State<'_, AppAgentHost>,
) -> Result<Vec<AppAgentSummary>, String> {
    let agents = state.agents.clone()?;
    blocking(move || Ok(agents.list()?.into_iter().map(Into::into).collect())).await
}

/// Generates a key for `owner` in `destination`, has the signed-in owner attest
/// it, and saves both. Nothing is saved unless all three succeed.
#[tauri::command]
pub(crate) async fn app_agent_create(
    state: tauri::State<'_, AppAgentHost>,
    identity: tauri::State<'_, crate::identity::IdentityHost>,
    destination: String,
    owner: String,
    agent_type: String,
    name: String,
) -> Result<AppAgentSummary, String> {
    let agents = state.agents.clone()?;
    let prepared = AppAgents::prepare(&destination, &owner, &agent_type, &name)?;
    let auth = identity
        .inner()
        .authorize_agent(owner, prepared.pubkey().to_owned())
        .await?;
    let host = state.inner().clone();
    blocking(move || {
        // Held so no first key read meets this write in the credential store.
        let mut keys = host.keys();
        host.credentials.retry();
        let (agent, key) = agents.commit(prepared, &auth, host.credentials.as_ref())?;
        keys.insert(agent.pubkey.clone(), Arc::new(key));
        Ok(agent.into())
    })
    .await
}

#[tauri::command]
pub(crate) async fn app_agent_rename(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    name: String,
) -> Result<(), String> {
    let agents = state.agents.clone()?;
    blocking(move || agents.rename(&pubkey, &name)).await
}

#[tauri::command]
pub(crate) async fn app_agent_delete(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
) -> Result<(), String> {
    state.delete(pubkey).await
}

#[tauri::command]
pub(crate) async fn app_agent_forget(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
) -> Result<(), String> {
    let agents = state.agents.clone()?;
    blocking(move || agents.forget(&pubkey)).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AppAgentEvent {
    kind: u16,
    content: String,
    #[serde(default)]
    tags: Vec<Vec<String>>,
}

/// Signs one event as the agent and posts it to the agent's own community.
#[tauri::command]
pub(crate) async fn app_agent_publish(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    event: AppAgentEvent,
) -> Result<Value, String> {
    let (agent, key) = state.key(state.agent(pubkey).await?).await?;
    let signed = agent.sign(&key, event.kind, event.content, event.tags)?;
    post(&agent, &key, signed).await
}

/// Publishes the agent's profile if its name differs from the last one its
/// community accepted. Safe to call any time; one runs per agent at a time.
#[tauri::command]
pub(crate) async fn app_agent_publish_profile(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
) -> Result<(), String> {
    let turn = state.profile_turn(&pubkey);
    let _turn = turn.lock().await;
    let agent = state.agent(pubkey).await?;
    if agent.profile.as_ref().map(|last| &last.name) == Some(&agent.name) {
        return Ok(());
    }
    let (agent, key) = state.key(agent).await?;
    let signed = post(&agent, &key, agent.profile_event(&key)?).await?;
    let created_at = signed
        .get("created_at")
        .and_then(Value::as_u64)
        .ok_or("Invalid agent event")?;
    let agents = state.agents.clone()?;
    blocking(move || {
        agents.published(
            &agent.pubkey,
            Published {
                name: agent.name,
                created_at,
            },
        )
    })
    .await
}

async fn post(agent: &AppAgent, key: &Secret, signed: Value) -> Result<Value, String> {
    let event_id = signed
        .get("id")
        .and_then(Value::as_str)
        .ok_or("Invalid agent event")?
        .to_owned();
    let bytes = serde_json::to_vec(&signed).map_err(|_| "Could not encode agent event")?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|_| "Agent client unavailable")?;
    let response = client
        .post(agent.events_url())
        .header("Content-Type", "application/json")
        .header(
            "Authorization",
            authorization(agent.http_auth(key, &bytes)?)?,
        )
        .header("x-auth-tag", &agent.auth)
        .body(bytes)
        .send()
        .await
        .map_err(|_| "Agent event unconfirmed; it may or may not have been accepted")?;
    let status = response.status();
    let body = response.bytes().await.unwrap_or_default();
    let receipt: Value =
        serde_json::from_slice(&body[..body.len().min(16 * 1024)]).unwrap_or(Value::Null);
    if !status.is_success()
        || receipt.get("accepted").and_then(Value::as_bool) != Some(true)
        || receipt.get("event_id").and_then(Value::as_str) != Some(event_id.as_str())
    {
        let reason = receipt
            .get("message")
            .or_else(|| receipt.get("error"))
            .and_then(Value::as_str)
            .map(|text| text.chars().take(300).collect::<String>())
            .unwrap_or_else(|| format!("status {}", status.as_u16()));
        return Err(format!("The community refused the agent event: {reason}"));
    }
    Ok(signed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// One saved key, behind a store that is busy for the first few reads.
    struct Busy(String, AtomicU32);
    impl Credentials for Busy {
        fn read_legacy(
            &self,
            _: buzz_agent_controller::LegacySource,
            _: &str,
        ) -> Result<Secret, String> {
            unreachable!()
        }
        fn read(&self, _: &str, pubkey: &str) -> Result<Option<Secret>, String> {
            if self.1.load(Ordering::SeqCst) > 0 {
                self.1.fetch_sub(1, Ordering::SeqCst);
                return Err(CREDENTIALS_BUSY.into());
            }
            Secret::parse(&self.0, pubkey).map(Some)
        }
        fn add(&self, _: &str, _: &Secret) -> Result<(), String> {
            unreachable!()
        }
        fn delete(&self, _: &str, _: &str) -> Result<(), String> {
            unreachable!()
        }
    }

    #[tokio::test]
    async fn a_first_key_read_waits_out_a_busy_store() {
        let key = Secret::generate().unwrap();
        let host = AppAgentHost {
            agents: Err("unused".into()),
            credentials: Arc::new(Busy(key.hex().to_string(), AtomicU32::new(3))),
            keys: Arc::default(),
            profiles: Arc::default(),
        };
        let agent = AppAgent {
            pubkey: key.pubkey().into(),
            relay: "wss://relay.example".into(),
            owner: "a".repeat(64),
            auth: "[]".into(),
            agent_type: "p/t".into(),
            name: "Ada".into(),
            profile: None,
            deleted: false,
        };
        let (_, read) = host.key(agent).await.unwrap();
        assert_eq!(read.pubkey(), key.pubkey());
    }

    #[tokio::test]
    async fn delete_waits_for_a_profile_publication_in_flight() {
        let dir = tempfile::tempdir().unwrap();
        let host = AppAgentHost::new(Ok(dir.path().join("identities.json")));
        let pubkey = "c".repeat(64);
        let turn = host.profile_turn(&pubkey);
        let publishing = turn.lock().await;
        let mut deleting = tokio::spawn({
            let host = host.clone();
            let pubkey = pubkey.clone();
            async move { host.delete(pubkey).await }
        });
        // Unblocked, deleting an absent agent takes well under this.
        let waited = std::time::Duration::from_millis(300);
        assert!(tokio::time::timeout(waited, &mut deleting).await.is_err());
        drop(publishing);
        deleting.await.unwrap().unwrap();
    }
}
