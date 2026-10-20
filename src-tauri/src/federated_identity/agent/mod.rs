//! Agent token client: each local agent's NIP-FI grant and the agent assertion
//! JWTs it mints. The native app holds both; nothing crosses IPC.
// Attached to the agent requests in app_agents.rs by a later commit.
#![allow(dead_code)]

pub(crate) mod grant;

use super::{protocol, FederatedIdentity};
use base64::{engine::general_purpose::STANDARD, Engine};
use buzz_agent_controller::{AppAgent, Secret};
use grant::{Grant, GrantStore, SecureGrantStore};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as AsyncMutex;
use zeroize::Zeroizing;

const GRANT_PATH: &str = "/v1/nip-fi/agent-grant";
const GRANT_TOKEN_TYPE: &str = "urn:builderlab:params:oauth:token-type:nip-fi-agent-grant";
const SIGN_IN: &str = "Sign in to your organization to enroll this agent";
const CHANGED: &str = "Your organization sign-in changed; try again";

#[derive(Clone)]
pub(crate) struct AgentTokens(Arc<Inner>);
struct Inner {
    identity: FederatedIdentity,
    store: Arc<dyn GrantStore>,
    /// One turn per agent, so concurrent requests share one enrollment.
    slots: Mutex<HashMap<String, Arc<AsyncMutex<Slot>>>>,
}
#[derive(Default)]
struct Slot {}

impl AgentTokens {
    pub(crate) fn new(identity: FederatedIdentity) -> Self {
        Self::with_store(identity, Arc::new(SecureGrantStore))
    }
    fn with_store(identity: FederatedIdentity, store: Arc<dyn GrantStore>) -> Self {
        Self(Arc::new(Inner {
            identity,
            store,
            slots: Mutex::default(),
        }))
    }
    fn slot(&self, agent: &str) -> Arc<AsyncMutex<Slot>> {
        self.0
            .slots
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(agent.into())
            .or_default()
            .clone()
    }
    async fn storage<T: Send + 'static>(
        &self,
        run: impl FnOnce(&dyn GrantStore) -> Result<T, &'static str> + Send + 'static,
    ) -> Result<T, String> {
        let store = self.0.store.clone();
        tauri::async_runtime::spawn_blocking(move || run(store.as_ref()))
            .await
            .map_err(|_| "Secure storage is unavailable")?
            .map_err(str::to_owned)
    }
    /// The signed-in BB account, if any.
    fn account(&self) -> Option<String> {
        let state = self.0.identity.state();
        state
            .session
            .as_ref()
            .filter(|_| !state.closed)
            .and_then(|session| session.record.email.clone())
    }
    fn grant_key(&self, agent: &AppAgent) -> String {
        self.0.identity.agent_grant_key(&agent.owner, &agent.pubkey)
    }

    /// The agent's grant, enrolling it on first use: new agents and ones made
    /// before enrollment existed alike.
    async fn grant(&self, agent: &AppAgent, key: &Secret) -> Result<Grant, String> {
        let (at, account) = (self.grant_key(agent), self.account());
        if let Some(grant) = self
            .storage(move |store| grant::load(store, &at, account.as_deref()))
            .await?
        {
            return Ok(grant);
        }
        let grant = self.enroll(agent, key).await?;
        let at = self.grant_key(agent);
        self.storage(move |store| store.write(&at, &grant).map(|()| grant))
            .await
    }

    /// Exchanges the owner's BB session for a grant for this agent (RFC 8693),
    /// proven by the owner's NIP-OA tag and the agent's own signature. Only the
    /// session that started it may install the result.
    async fn enroll(&self, agent: &AppAgent, key: &Secret) -> Result<Grant, String> {
        let identity = &self.0.identity;
        let account = self.account().ok_or(SIGN_IN)?;
        let (form, revision, endpoint) = identity
            .with_session(|token, revision, config| {
                let form = url::form_urlencoded::Serializer::new(String::new())
                    .append_pair(
                        "grant_type",
                        "urn:ietf:params:oauth:grant-type:token-exchange",
                    )
                    .append_pair("subject_token", token)
                    .append_pair(
                        "subject_token_type",
                        "urn:builderlab:params:oauth:token-type:bb-session",
                    )
                    .append_pair("requested_token_type", GRANT_TOKEN_TYPE)
                    .append_pair("agent_pubkey", &agent.pubkey)
                    .append_pair("runtime", "local")
                    .append_pair("owner_attestation", &agent.auth)
                    .finish();
                (
                    Zeroizing::new(form),
                    revision.to_owned(),
                    config.endpoint(GRANT_PATH),
                )
            })
            .ok_or(SIGN_IN)?;
        if form.len() > 8192 {
            return Err("This agent's enrollment is too large".into());
        }
        let cancel = identity.cancellation_for(&revision)?;
        // Each attempt is signed anew: the issuer refuses a replayed proof.
        let proof = || nostr(agent.issuer_auth(key, endpoint.as_str(), form.as_bytes())?);
        proof()?;
        let client = protocol::client()?;
        #[derive(Deserialize)]
        struct Enrolled {
            access_token: String,
            issued_token_type: String,
            token_type: String,
            nostr_owner_pubkey: String,
            nip_fi_issuer: String,
        }
        let request = protocol::json::<Enrolled>(|| {
            let request = client
                .post(endpoint.clone())
                .header("Content-Type", "application/x-www-form-urlencoded")
                .body(form.as_bytes().to_vec());
            match proof() {
                Ok(proof) => request.header("Nostr-Agent-Proof", proof),
                Err(_) => request,
            }
        });
        let enrolled = tokio::select! {
            () = cancel.cancelled() => return Err(CHANGED.into()),
            enrolled = request => enrolled.map_err(|failure| refused(failure.code))?,
        };
        let token = Zeroizing::new(enrolled.access_token);
        if !identity.current(&revision) {
            return Err(CHANGED.into());
        }
        if enrolled.issued_token_type != GRANT_TOKEN_TYPE
            || enrolled.token_type != "N_A"
            || enrolled.nostr_owner_pubkey != agent.owner
            || enrolled.nip_fi_issuer.is_empty()
            || token.is_empty()
            || token.len() > 1024
            || token.chars().any(char::is_whitespace)
        {
            return Err("Your organization returned an invalid agent enrollment".into());
        }
        Ok(Grant::new(
            agent.owner.clone(),
            agent.pubkey.clone(),
            account,
            enrolled.nip_fi_issuer,
            token.to_string(),
        ))
    }
}

/// A NIP-98 `Nostr` header value for one signed HTTP auth event.
fn nostr(event: serde_json::Value) -> Result<String, String> {
    serde_json::to_vec(&event)
        .map(|event| format!("Nostr {}", STANDARD.encode(event)))
        .map_err(|_| "Could not authorize the agent".into())
}

/// What the agent's owner sees when the identity issuer turns it away.
fn refused(code: &'static str) -> String {
    match code {
        "network-unavailable" | "network-timeout" => {
            "Your organization's identity service is unreachable".into()
        }
        code => format!("Your organization refused this agent ({code})"),
    }
}

#[cfg(test)]
mod tests;
