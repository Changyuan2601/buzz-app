//! Native-only key creation. Retrying a prepared identity never generates a second key.
use crate::config::{agent_id, canonical_key, canonical_relay, Agent, HarnessEdit};
use crate::{AgentEdit, Controller, Credentials, Result, Secret};
use serde_json::Value;
use std::collections::BTreeMap;

pub struct NewAgent {
    pub id: String,
    pub key: Secret,
    relay: String,
    owner: String,
}
impl NewAgent {
    pub fn prepare(destination: &str, owner: &str) -> Result<Self> {
        if !canonical_key(owner) {
            return Err("Choose a signed-in owner".into());
        }
        let relay = canonical_relay(destination)?;
        let key = Secret::generate()?;
        Ok(Self {
            id: agent_id(key.pubkey(), &relay),
            key,
            relay,
            owner: owner.into(),
        })
    }
    pub fn matches(&self, destination: &str, owner: &str) -> Result<bool> {
        Ok(self.relay == canonical_relay(destination)? && self.owner == owner)
    }
    pub(crate) fn agent(&self, edit: AgentEdit, auth: &str) -> Result<Agent> {
        crate::secret::validate_attestation(auth, self.key.pubkey())?;
        let tag: Vec<String> =
            serde_json::from_str(auth).map_err(|_| "Invalid owner authorization")?;
        if tag[1] != self.owner {
            return Err("Agent authorization belongs to another owner".into());
        }
        let mut agent = Agent {
            picture: None,
            id: self.id.clone(),
            pubkey: self.key.pubkey().into(),
            relay_url: self.relay.clone(),
            name: String::new(),
            system_prompt: String::new(),
            session_policy: None,
            session_policy_inherit: false,
            workspace: String::new(),
            harness: HarnessEdit {
                command: String::new(),
                args: vec![],
                model: String::new(),
                provider: String::new(),
                databricks: None,
            },
            environment: BTreeMap::new(),
            revision: 0,
            enabled: false,
            start_on_app_launch: Some(false),
            credential_id: self.id.clone(),
            auth_tag: Some(auth.into()),
            imported: Value::Null,
            extra: BTreeMap::from([("nativeCreated".into(), Value::Bool(true))]),
        };
        agent.apply(edit)?;
        Ok(agent)
    }
    pub fn validate(&self, edit: AgentEdit, auth: &str) -> Result<()> {
        self.agent(edit, auth).map(|_| ())
    }
    pub fn save_key(&self, credentials: &dyn Credentials) -> Result<()> {
        if credentials.read(&self.id, self.key.pubkey())?.is_none() {
            credentials.add(&self.id, &self.key)?;
        }
        credentials
            .read(&self.id, self.key.pubkey())?
            .ok_or("New agent key could not be verified")?;
        Ok(())
    }
}
impl Controller {
    pub fn create(&mut self, prepared: &NewAgent, edit: AgentEdit, auth: &str) -> Result<()> {
        let mut agent = prepared.agent(edit, auth)?;
        if self.store.agents()?.iter().any(|a| a.id == agent.id) {
            return Ok(());
        }
        // Kind-0 is a replaceable profile, not an append-only command. Retry with
        // this saved key and a fresh timestamp so delayed retries remain admissible.
        agent
            .extra
            .insert("profilePending".into(), Value::Bool(true));
        self.store.insert(vec![agent])
    }
    /// Scope memory writes to a saved native-created identity and its owner attestation.
    pub fn memory_target(&self, id: &str) -> Result<CreationProfile> {
        let target = self.profile_target(id, false)?;
        let native = self
            .store
            .agents()?
            .into_iter()
            .find(|agent| agent.id == id)
            .is_some_and(|agent| agent.extra.get("nativeCreated") == Some(&Value::Bool(true)));
        if !native {
            return Err("Snapshot memory requires a native-created agent".into());
        }
        Ok(target)
    }
    /// Persist the request receipt with the identity; retries survive renderer and host reloads.
    pub fn created_request(
        &self,
        request: &str,
        destination: &str,
        owner: &str,
    ) -> Result<Option<crate::AgentView>> {
        let relay = canonical_relay(destination)?;
        let defaults = self.store.defaults()?;
        let agent = self
            .store
            .agents()?
            .into_iter()
            .find(|a| a.extra.get("bundleRequest").and_then(Value::as_str) == Some(request));
        if let Some(agent) = &agent {
            let tag: Vec<String> = serde_json::from_str(
                agent
                    .auth_tag
                    .as_deref()
                    .ok_or("Missing owner authorization")?,
            )
            .map_err(|_| "Invalid owner authorization")?;
            if agent.relay_url != relay || tag.get(1).map(String::as_str) != Some(owner) {
                return Err("Create destination or owner changed".into());
            }
        }
        Ok(agent.map(|a| a.view(&defaults)))
    }
    pub fn create_bundle_member(
        &mut self,
        prepared: &NewAgent,
        edit: AgentEdit,
        auth: &str,
        request: &str,
        bundle: &crate::teams::BundleMember,
    ) -> Result<()> {
        bundle.validate()?;
        if self
            .created_request(request, &prepared.relay, &prepared.owner)?
            .is_some()
        {
            return Ok(());
        }
        let mut agent = prepared.agent(edit, auth)?;
        let instructions =
            crate::import::team_text(&serde_json::json!(bundle.instructions))?.to_owned();
        let keep_allowlist = bundle.keep_allowlist;
        let d = &bundle.member.definition;
        let policy = if d.respond_to.as_deref() == Some("allowlist") && !keep_allowlist {
            "owner-only"
        } else {
            d.respond_to.as_deref().unwrap_or("owner-only")
        };
        agent.imported = serde_json::json!({"teamInstructions": instructions, "teamBindings": [bundle.team], "record": {
            "respond_to": policy, "respond_to_allowlist": if keep_allowlist { d.respond_to_allowlist.clone() } else { vec![] },
            "parallelism": d.parallelism, "name_pool": d.name_pool, "idle_timeout_seconds": d.idle_timeout_seconds,
            "source_is_builtin": d.source_is_builtin, "profile": bundle.member.profile,
            "max_turn_duration_seconds": d.max_turn_duration_seconds,
        }});
        agent
            .extra
            .insert("bundleRequest".into(), Value::String(request.into()));
        agent
            .extra
            .insert("profilePending".into(), Value::Bool(true));
        agent
            .extra
            .insert("importAboutPending".into(), Value::Bool(true));
        self.store.insert(vec![agent])
    }
    pub fn creation_profile(&self, id: &str) -> Result<CreationProfile> {
        self.profile_target(id, true)
    }
    fn profile_target(&self, id: &str, pending: bool) -> Result<CreationProfile> {
        let agent = self
            .store
            .agents()?
            .into_iter()
            .find(|a| a.id == id)
            .ok_or("Agent no longer exists")?;
        if pending && agent.extra.get("profilePending") != Some(&Value::Bool(true)) {
            return Err("No pending profile update".into());
        }
        let auth = agent.auth_tag.ok_or("Missing owner authorization")?;
        crate::secret::validate_attestation(&auth, &agent.pubkey)?;
        Ok(CreationProfile {
            credential_id: agent.credential_id,
            pubkey: agent.pubkey,
            url: format!(
                "{}/events",
                agent.relay_url.replacen("wss://", "https://", 1)
            ),
            auth,
            name: agent.name,
            picture: agent.picture,
            about: if agent.extra.get("importAboutPending") == Some(&Value::Bool(true)) {
                agent.imported["record"]["profile"]["about"]
                    .as_str()
                    .map(str::to_owned)
            } else {
                None
            },
            revision: agent.revision,
        })
    }
    pub fn profile_published(&mut self, id: &str, revision: u64) -> Result<()> {
        self.store.profile_published(id, revision)
    }
}
/// Native-only publication input, never serialized across IPC.
pub struct CreationProfile {
    pub credential_id: String,
    pub pubkey: String,
    pub url: String,
    pub auth: String,
    pub name: String,
    pub picture: Option<String>,
    pub about: Option<String>,
    pub revision: u64,
}
impl CreationProfile {
    pub fn event(&self, key: &Secret, existing: &[Value]) -> Result<Value> {
        if key.pubkey() != self.pubkey {
            return Err("Profile identity changed".into());
        }
        key.profile(
            &self.name,
            self.picture.as_deref(),
            self.about.as_deref(),
            &self.auth,
            existing,
        )
    }
    pub fn confirm(&self, existing: &[Value], event_id: &str) -> Result<()> {
        let current = crate::profile::current(existing, &self.pubkey)?;
        if current.as_ref().map(|profile| profile.id.as_str()) != Some(event_id) {
            return Err("A different profile is current; saved avatar remains pending. Refresh and retry publication.".into());
        }
        Ok(())
    }
    pub fn query_url(&self) -> String {
        self.url.trim_end_matches("/events").to_owned() + "/query"
    }
    pub fn authenticate_query(&self, key: &Secret, body: &[u8]) -> Result<Value> {
        if key.pubkey() != self.pubkey {
            return Err("Profile identity changed".into());
        }
        key.profile_auth(&self.query_url(), body)
    }
    pub fn authenticate(&self, key: &Secret, body: &[u8]) -> Result<Value> {
        if key.pubkey() != self.pubkey {
            return Err("Profile identity changed".into());
        }
        key.profile_auth(&self.url, body)
    }
}
