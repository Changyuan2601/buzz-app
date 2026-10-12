//! NIP-FA issuance and local JWT misuse checks; the relay verifies JWT signatures.
use super::{
    config::canonical_relay,
    protocol::{self, expiry, now, Failure},
    FederatedIdentity, Status,
};
use crate::identity::{EventTemplate, IdentityHost};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use tokio::sync::Mutex;
use url::Url;
use zeroize::Zeroizing;

pub(crate) const HEADER: &str = "Nostr-Federated-Identity";
#[derive(Clone)]
pub(crate) struct Assertion {
    pub(crate) header: Zeroizing<String>,
    pub(crate) expires_at: u64,
    pub(crate) revision: String,
    pub(crate) viewer: String,
    pub(crate) relay: String,
    refresh_at: u64,
}
impl Assertion {
    pub(crate) fn remaining(&self) -> std::time::Duration {
        std::time::UNIX_EPOCH
            .checked_add(std::time::Duration::from_secs(self.expires_at))
            .and_then(|expiry| expiry.duration_since(std::time::SystemTime::now()).ok())
            .unwrap_or_default()
    }
}
#[derive(Default)]
pub(super) struct Acquisition {
    completed: AtomicU64,
    result: Mutex<Option<Result<Assertion, Failure>>>,
}
pub(super) type AssertionCache = std::collections::HashMap<String, Arc<Acquisition>>;

/// No credential goes on discovery. The exact relay supplies only the requirement,
/// never the configured adapter destination.
pub(crate) async fn discovery(relay: &str) -> Result<bool, String> {
    let relay = canonical_relay(relay)?;
    let url = format!("https://{}/info", &relay[6..]);
    let client = protocol::client().map_err(str::to_owned)?;
    let document: serde_json::Value =
        protocol::json(|| client.get(&url).header("Accept", "application/nostr+json"))
            .await
            .map_err(|_| "Federated community discovery failed".to_owned())?;
    evaluate_discovery(&document).map_err(str::to_owned)
}
fn evaluate_discovery(document: &serde_json::Value) -> Result<bool, &'static str> {
    if !document.is_object() {
        return Err("Invalid federated community discovery");
    }
    let requires = match document.get("limitation") {
        Some(value) if !value.is_object() => return Err("Invalid federated community discovery"),
        value => match value.and_then(|v| v.get("federated_identity")) {
            None | Some(serde_json::Value::Bool(false)) => false,
            Some(serde_json::Value::Bool(true)) => true,
            _ => return Err("Invalid federated community discovery"),
        },
    };
    if !requires {
        return Ok(false);
    }
    let descriptor = document
        .get("federated_identity")
        .ok_or("Incomplete federated community discovery")?;
    if descriptor.get("core").and_then(|v| v.as_str()) != Some("client-attached")
        || descriptor
            .pointer("/assertion_freshness/class")
            .and_then(|v| v.as_str())
            != Some("offline-jwt")
        || !matches!(
            descriptor.pointer("/assertion_freshness/maximum_residual_upstream_revocation_seconds"),
            None | Some(serde_json::Value::Null)
        )
    {
        return Err("Unsupported federated community discovery");
    }
    Ok(true)
}

impl FederatedIdentity {
    pub(crate) async fn assertion_for_relay(
        &self,
        identity: &IdentityHost,
        url: &Url,
    ) -> Result<Option<Assertion>, String> {
        let relay = canonical_relay(&url.origin().ascii_serialization())?;
        if !discovery(&relay).await? {
            return Ok(None);
        }
        let config = self
            .0
            .config
            .as_ref()
            .ok_or("Federated identity is not configured for this community")?;
        if !config.matches_relay(&relay)? {
            return Err("Federated identity is not configured for this community".into());
        }
        self.restore().await;
        let viewer = identity.viewer().await?;
        let (revision, session, cancel) = {
            let state = self.state();
            if state.closed || state.snapshot.status != Status::SignedIn {
                return Err("Federated sign-in is required".into());
            }
            (
                state.snapshot.revision.clone(),
                state
                    .session
                    .clone()
                    .ok_or("Federated sign-in is required")?,
                state.cancellation.clone(),
            )
        };
        let key = format!("{revision}:{viewer}:{relay}");
        let entry = {
            let mut cache = self
                .0
                .assertions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if !cache.contains_key(&key) && cache.len() >= 128 {
                return Err("Too many protected communities".into());
            }
            cache.entry(key).or_default().clone()
        };
        let observed = entry.completed.load(Ordering::Acquire);
        let mut cached = entry.result.lock().await;
        if !self.current(&revision) {
            return Err("Federated session changed".into());
        }
        if entry.completed.load(Ordering::Acquire) != observed {
            let result = cached.as_ref().ok_or("Federated acquisition unavailable")?;
            let assertion = result.as_ref().map_err(|failure| failure.code.to_owned())?;
            self.admit_assertion(identity, assertion).await?;
            return Ok(Some(assertion.clone()));
        }
        let now = now().map_err(str::to_owned)? as u64;
        if let Some(assertion) = cached
            .as_ref()
            .and_then(|result| result.as_ref().ok())
            .filter(|assertion| now < assertion.refresh_at)
        {
            self.admit_assertion(identity, assertion).await?;
            return Ok(Some(assertion.clone()));
        }
        let result = tokio::select! {
            _ = cancel.cancelled() => return Err("Federated session changed".into()),
            result = self.issue(identity, &relay, &viewer, &revision, &session.record.session_token, expiry(&session.record.expires_at).map_err(str::to_owned)? as u64) => result,
        };
        *cached = Some(result.clone());
        entry.completed.fetch_add(1, Ordering::Release);
        match result {
            Ok(assertion) => {
                self.admit_assertion(identity, &assertion).await?;
                Ok(Some(assertion))
            }
            Err(failure) => {
                let retired = {
                    let mut state = self.state();
                    if !state.closed && state.snapshot.revision == revision {
                        if failure.session_denied {
                            self.retire_state(
                                &mut state,
                                Status::ReauthenticationRequired,
                                Some(failure.code),
                            )
                            .map(|session| (session, state.snapshot.revision.clone()))
                        } else {
                            state.snapshot.failure = Some(failure.code);
                            self.publish(&state);
                            None
                        }
                    } else {
                        None
                    }
                };
                if let Some((session, revision)) = retired {
                    if let Err(error) = self.remove(session).await {
                        self.change_current(&revision, Status::Unavailable, Some(error.code));
                    }
                }
                Err(failure.code.into())
            }
        }
    }
    pub(crate) async fn admit_assertion(
        &self,
        identity: &IdentityHost,
        assertion: &Assertion,
    ) -> Result<(), String> {
        let viewer = identity.viewer().await?;
        if !self.current(&assertion.revision)
            || now().map_err(str::to_owned)? as u64 >= assertion.expires_at
            || viewer != assertion.viewer
        {
            return Err("Federated authorization changed".into());
        }
        Ok(())
    }
    pub(crate) async fn admit_response(
        &self,
        identity: &IdentityHost,
        assertion: &Assertion,
        mutation: bool,
    ) -> Result<(), String> {
        self.admit_assertion(identity, assertion).await.map_err(|error| {
            if mutation {
                "Write result could not be confirmed; it may have completed. Inspect the existing operation before retrying.".into()
            } else {
                error
            }
        })
    }
    pub(crate) async fn reject_assertion(&self, assertion: &Assertion) {
        let key = format!(
            "{}:{}:{}",
            assertion.revision, assertion.viewer, assertion.relay
        );
        let entry = self
            .0
            .assertions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&key)
            .cloned();
        if let Some(entry) = entry {
            let mut cached = entry.result.lock().await;
            if cached
                .as_ref()
                .and_then(|result| result.as_ref().ok())
                .is_some_and(|current| current.header == assertion.header)
            {
                *cached = None;
            }
        }
    }
    pub(crate) async fn during<T>(
        &self,
        identity: &IdentityHost,
        assertion: &Assertion,
        operation: impl std::future::Future<Output = T>,
    ) -> Result<T, String> {
        self.admit_assertion(identity, assertion).await?;
        let cancel = self.cancellation_for(&assertion.revision)?;
        let remaining = assertion.remaining();
        let result = tokio::select! {
            _ = cancel.cancelled() => return Err("Federated authorization changed".into()),
            _ = tokio::time::sleep(remaining) => return Err("Federated authorization expired".into()),
            result = operation => result,
        };
        self.admit_assertion(identity, assertion).await?;
        Ok(result)
    }
    async fn issue(
        &self,
        identity: &IdentityHost,
        relay: &str,
        viewer: &str,
        revision: &str,
        token: &str,
        session_expiry: u64,
    ) -> Result<Assertion, Failure> {
        if viewer.len() != 64
            || !viewer
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("invalid-viewer".into());
        }
        // Field order and exact bytes are the NIP-FA assertion request contract.
        #[derive(serde::Serialize)]
        struct Body<'a> {
            nostr_pubkey: &'a str,
            relay_url: &'a str,
        }
        let body = serde_json::to_string(&Body {
            nostr_pubkey: viewer,
            relay_url: relay,
        })
        .map_err(|_| "invalid-request")?;
        if body.len() > 4096 {
            return Err("invalid-request".into());
        }
        let endpoint = self
            .0
            .config
            .as_ref()
            .ok_or("unconfigured")?
            .endpoint("/v1/identity/assertions");
        let client = protocol::client()?;
        let timestamp = now()? as u64;
        let proof = identity
            .sign(EventTemplate {
                kind: 27235,
                created_at: timestamp,
                content: String::new(),
                tags: vec![
                    vec!["u".into(), endpoint.to_string()],
                    vec!["method".into(), "POST".into()],
                    vec![
                        "payload".into(),
                        format!("{:x}", Sha256::digest(body.as_bytes())),
                    ],
                ],
            })
            .await
            .map_err(|_| "identity-unavailable")?;
        if proof.get("pubkey").and_then(|v| v.as_str()) != Some(viewer) {
            return Err("invalid-viewer".into());
        }
        let proof = format!(
            "Nostr {}",
            STANDARD.encode(serde_json::to_vec(&proof).map_err(|_| "invalid-proof")?)
        );
        #[derive(Deserialize)]
        struct Issued {
            assertion: String,
            nostr_pubkey: String,
            expires_at: u64,
        }
        let issued: Issued = protocol::json(|| {
            client
                .post(endpoint.clone())
                .bearer_auth(token)
                .header("Nostr-Authorization", &proof)
                .header("Content-Type", "application/json")
                .body(body.clone())
        })
        .await?;
        let assertion = Zeroizing::new(issued.assertion);
        let now = now()? as u64;
        validate_jwt(
            &assertion,
            &issued.nostr_pubkey,
            issued.expires_at,
            viewer,
            relay,
            session_expiry,
            now,
        )?;
        Ok(Assertion {
            header: Zeroizing::new(format!("Bearer {}", assertion.as_str())),
            expires_at: issued.expires_at,
            revision: revision.into(),
            viewer: viewer.into(),
            relay: relay.into(),
            refresh_at: if issued.expires_at - now > 15 {
                issued.expires_at.saturating_sub(15)
            } else {
                issued.expires_at
            },
        })
    }
}

fn validate_jwt(
    token: &str,
    returned_key: &str,
    returned_expiry: u64,
    viewer: &str,
    relay: &str,
    session_expiry: u64,
    now: u64,
) -> Result<u64, Failure> {
    if token.len() > 8192 || token.chars().any(char::is_whitespace) || returned_key != viewer {
        return Err("invalid-assertion".into());
    }
    let parts: Vec<_> = token.split('.').collect();
    if parts.len() != 3 || parts.iter().any(|part| part.is_empty()) {
        return Err("invalid-assertion".into());
    }
    let decode = |part: &str| -> Result<serde_json::Value, Failure> {
        let bytes = Zeroizing::new(
            URL_SAFE_NO_PAD
                .decode(part)
                .map_err(|_| "invalid-assertion")?,
        );
        serde_json::from_slice(&bytes).map_err(|_| "invalid-assertion".into())
    };
    let header = decode(parts[0])?;
    let claims = decode(parts[1])?;
    let minted = claims
        .get("iat")
        .and_then(|v| v.as_u64())
        .ok_or("invalid-assertion")?;
    let expiry = claims
        .get("exp")
        .and_then(|v| v.as_u64())
        .ok_or("invalid-assertion")?;
    if header.get("typ").and_then(|v| v.as_str()) != Some("nip-fi+jwt")
        || claims.get("aud").and_then(|v| v.as_str())
            != Some(format!("https://{}", &relay[6..]).as_str())
        || claims.get("nostr_pubkey").and_then(|v| v.as_str()) != Some(viewer)
        || expiry != returned_expiry
        || expiry <= now
        || expiry > session_expiry
        || minted > now.saturating_add(5)
        || minted > expiry
        || expiry - minted > 300
    {
        return Err("invalid-assertion".into());
    }
    Ok(minted)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn valid_absent_or_false_flags_do_not_require_credentials() {
        for doc in [
            serde_json::json!({}),
            serde_json::json!({"limitation":{"federated_identity":false},"federated_identity":{}}),
        ] {
            assert!(!evaluate_discovery(&doc).unwrap());
        }
        let supported = serde_json::json!({"limitation":{"federated_identity":true},"federated_identity":{"core":"client-attached","assertion_freshness":{"class":"offline-jwt"}}});
        assert!(evaluate_discovery(&supported).unwrap());
        for (pointer, value) in [
            (
                "/federated_identity/core",
                serde_json::json!("server-fetched"),
            ),
            (
                "/federated_identity/assertion_freshness/class",
                serde_json::json!("online"),
            ),
        ] {
            let mut unsupported = supported.clone();
            *unsupported.pointer_mut(pointer).unwrap() = value;
            assert!(evaluate_discovery(&unsupported).is_err());
        }
        let mut bounded = supported.clone();
        bounded["federated_identity"]["assertion_freshness"]
            ["maximum_residual_upstream_revocation_seconds"] = serde_json::json!(60);
        assert!(evaluate_discovery(&bounded).is_err());
        for doc in [
            serde_json::json!(null),
            serde_json::json!({"limitation":{"federated_identity":"true"}}),
            serde_json::json!({"limitation":{"federated_identity":true}}),
        ] {
            assert!(evaluate_discovery(&doc).is_err());
        }
    }
    fn jwt(viewer: &str, relay: &str, minted: u64, expires: u64) -> String {
        format!("{}.{}.eA", URL_SAFE_NO_PAD.encode(br#"{"typ":"nip-fi+jwt","alg":"ES256"}"#), URL_SAFE_NO_PAD.encode(serde_json::json!({"nostr_pubkey":viewer,"aud":format!("https://{}",&relay[6..]),"iat":minted,"exp":expires}).to_string()))
    }
    #[test]
    fn assertion_misuse_checks_require_key_exact_audience_and_bounded_session_lifetime() {
        let viewer = "ab".repeat(32);
        let relay = "wss://relay.example:8443";
        let valid = jwt(&viewer, relay, 100, 200);
        assert_eq!(
            validate_jwt(&valid, &viewer, 200, &viewer, relay, 250, 101).unwrap(),
            100
        );
        for (token, returned, expires, requested, community, session, time) in [
            (
                valid.clone(),
                "cd".repeat(32),
                200,
                viewer.clone(),
                relay,
                250,
                101,
            ),
            (
                valid.clone(),
                viewer.clone(),
                201,
                viewer.clone(),
                relay,
                250,
                101,
            ),
            (
                valid.clone(),
                viewer.clone(),
                200,
                viewer.clone(),
                "wss://other.example",
                250,
                101,
            ),
            (
                valid.clone(),
                viewer.clone(),
                200,
                viewer.clone(),
                relay,
                199,
                101,
            ),
            (
                valid.clone(),
                viewer.clone(),
                200,
                viewer.clone(),
                relay,
                250,
                200,
            ),
            (
                jwt(&viewer, relay, 100, 401),
                viewer.clone(),
                401,
                viewer.clone(),
                relay,
                500,
                101,
            ),
            (
                jwt(&viewer, relay, 107, 200),
                viewer.clone(),
                200,
                viewer.clone(),
                relay,
                250,
                101,
            ),
            (
                "bad.jwt".into(),
                viewer.clone(),
                200,
                viewer.clone(),
                relay,
                250,
                101,
            ),
        ] {
            assert!(
                validate_jwt(&token, &returned, expires, &requested, community, session, time)
                    .is_err()
            );
        }
        let sub = format!("{}.{}.eA", URL_SAFE_NO_PAD.encode(br#"{"typ":"nip-fi+jwt"}"#),URL_SAFE_NO_PAD.encode(serde_json::json!({"sub":viewer,"aud":"https://relay.example:8443","iat":100,"exp":200}).to_string()));
        assert!(validate_jwt(&sub, &viewer, 200, &viewer, relay, 250, 101).is_err());
    }
    #[tokio::test]
    async fn issuance_wire_has_separate_session_and_body_bound_same_key_nostr_proof() {
        use super::super::tests::{adapter, at_adapter, Memory};
        let identity = IdentityHost::fixture();
        let viewer = identity.viewer().await.unwrap();
        let relay = "wss://relay.example:8443";
        let minted = now().unwrap() as u64;
        let expires = minted + 60;
        let (base,server)=adapter(vec![serde_json::json!({"assertion":jwt(&viewer,relay,minted,expires),"nostr_pubkey":viewer,"expires_at":expires})]).await;
        let endpoint = format!("{base}/v1/identity/assertions");
        let host = at_adapter(Arc::new(Memory::default()), base);
        let assertion = host
            .issue(
                &identity,
                relay,
                &viewer,
                &host.snapshot().revision,
                "fixture-session-token",
                expires + 100,
            )
            .await
            .unwrap();
        assert!(assertion.header.starts_with("Bearer "));
        let seen = server.await.unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(
            seen[0].target,
            "POST /mount/v1/identity/assertions HTTP/1.1"
        );
        let expected = format!(r#"{{"nostr_pubkey":"{viewer}","relay_url":"{relay}"}}"#);
        assert_eq!(seen[0].body, expected.as_bytes());
        let headers = &seen[0].headers;
        assert_eq!(
            headers
                .iter()
                .filter(|(name, _)| name == "authorization")
                .map(|(_, value)| value.as_str())
                .collect::<Vec<_>>(),
            vec!["Bearer fixture-session-token"]
        );
        assert!(!headers.iter().any(
            |(name, _)| name == "nostr-federated-identity" || name == "x-bb-session-credential"
        ));
        let proof = headers
            .iter()
            .find(|(name, _)| name == "nostr-authorization")
            .unwrap()
            .1
            .strip_prefix("Nostr ")
            .unwrap();
        let proof: nostr::event::Event =
            serde_json::from_slice(&STANDARD.decode(proof).unwrap()).unwrap();
        proof.verify().unwrap();
        let proof = serde_json::to_value(proof).unwrap();
        assert_eq!(proof["pubkey"], viewer);
        assert_eq!(proof["kind"], 27235);
        assert_eq!(
            proof["tags"],
            serde_json::json!([
                ["u", endpoint],
                ["method", "POST"],
                [
                    "payload",
                    format!("{:x}", Sha256::digest(expected.as_bytes()))
                ]
            ])
        );
        assert!(
            assertion.remaining()
                <= std::time::UNIX_EPOCH
                    .checked_add(std::time::Duration::from_secs(expires))
                    .unwrap()
                    .duration_since(std::time::SystemTime::now())
                    .unwrap()
                    + std::time::Duration::from_millis(1)
        );
    }
    #[tokio::test(start_paused = true)]
    async fn retired_write_results_are_uncertain_and_do_not_offer_sign_in_retry() {
        use super::super::tests::{host, record, Memory};
        let host = host(Arc::new(Memory::default()));
        let identity = IdentityHost::fixture();
        let assertion = Assertion {
            header: Zeroizing::new("Bearer fixture".into()),
            expires_at: now().unwrap() as u64 + 60,
            revision: host.snapshot().revision,
            viewer: identity.viewer().await.unwrap(),
            relay: "wss://relay.example".into(),
            refresh_at: 0,
        };
        {
            let mut state = host.state();
            state.session = Some(record());
            state.snapshot.status = Status::SignedIn;
            state.restored = true;
        }
        host.admit_assertion(&identity, &assertion).await.unwrap();
        host.retire(Status::SignedOut, None);
        assert_eq!(host.admit_response(&identity, &assertion, true).await.unwrap_err(),
            "Write result could not be confirmed; it may have completed. Inspect the existing operation before retrying.");
        assert_eq!(
            host.admit_response(&identity, &assertion, false)
                .await
                .unwrap_err(),
            "Federated authorization changed"
        );
    }
    #[tokio::test(start_paused = true)]
    async fn retirement_interrupts_a_pending_protected_operation_before_its_late_result() {
        use super::super::tests::{host, record, Memory};
        let host = host(Arc::new(Memory::default()));
        let identity = IdentityHost::fixture();
        let viewer = identity.viewer().await.unwrap();
        {
            let mut state = host.state();
            state.session = Some(record());
            state.snapshot.status = Status::SignedIn;
            state.restored = true;
        }
        let assertion = Assertion {
            header: Zeroizing::new("Bearer fixture".into()),
            expires_at: now().unwrap() as u64 + 60,
            revision: host.snapshot().revision,
            viewer,
            relay: "wss://relay.example".into(),
            refresh_at: 0,
        };
        let (started, observed) = tokio::sync::oneshot::channel();
        let (late, held) = tokio::sync::oneshot::channel::<()>();
        let worker = host.clone();
        let task = tokio::spawn(async move {
            worker
                .during(&identity, &assertion, async {
                    let _ = started.send(());
                    let _ = held.await;
                    42
                })
                .await
        });
        observed.await.unwrap();
        host.retire(Status::SignedOut, None);
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), task)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        assert!(
            late.send(()).is_err(),
            "the retired operation must be dropped"
        );
    }
}
