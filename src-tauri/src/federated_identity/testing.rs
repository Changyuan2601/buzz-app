//! Crate-visible fixtures for owners outside this module that must prove they
//! carry NIP-FI evidence, without reaching into session internals.
use super::{tests, FederatedIdentity, Status};
use std::sync::Arc;

/// A signed-in session whose assertions come from `adapter_base` (a plain
/// loopback fixture) and whose community at `relay` requires NIP-FI.
pub(crate) fn signed_in(adapter_base: String, relay: &str, required: bool) -> FederatedIdentity {
    let mut owner = tests::at_adapter(Arc::new(tests::Memory::default()), adapter_base);
    let authority = &relay["wss://".len()..];
    Arc::get_mut(&mut owner.0)
        .unwrap()
        .config
        .as_mut()
        .unwrap()
        .community_hosts = vec![authority.into()];
    owner.discovered(relay, required);
    owner.install(tests::record());
    owner
}

impl FederatedIdentity {
    fn install(&self, session: Arc<super::Session>) {
        let mut state = self.state();
        state.session = Some(session);
        state.snapshot.status = Status::SignedIn;
        state.restored = true;
    }
    pub(crate) fn sign_out_for_test(&self) {
        self.retire(Status::SignedOut, None);
    }
    /// Retires the current account and installs another in its place.
    pub(crate) fn switch_account_for_test(&self) {
        self.retire(Status::SignedOut, None);
        self.install(tests::record());
    }
}

/// An issuer that mints one assertion for `viewer` at `relay`: its base, the
/// assertion, and a handle yielding the request bodies it received.
pub(crate) async fn issuer(
    viewer: &str,
    relay: &str,
) -> (String, String, tokio::task::JoinHandle<Vec<String>>) {
    let minted = super::protocol::now().unwrap() as u64;
    let expires = minted + 60;
    let assertion = jwt(viewer, relay, minted, expires);
    let (base, server) = tests::adapter(vec![serde_json::json!({
        "assertion": assertion,
        "nostr_pubkey": viewer,
        "expires_at": expires,
    })])
    .await;
    let bodies = tokio::spawn(async move {
        server
            .await
            .unwrap()
            .into_iter()
            .map(|wire| String::from_utf8(wire.body).unwrap())
            .collect()
    });
    (base, assertion, bodies)
}

/// An unsigned NIP-FI JWT the client-side validator accepts for `relay`.
fn jwt(viewer: &str, relay: &str, minted: u64, expires: u64) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let claims = serde_json::json!({"nostr_pubkey":viewer,"aud":format!("https://{}",&relay[6..]),"iat":minted,"exp":expires});
    format!(
        "{}.{}.eA",
        URL_SAFE_NO_PAD.encode(br#"{"typ":"nip-fi+jwt","alg":"ES256"}"#),
        URL_SAFE_NO_PAD.encode(claims.to_string())
    )
}
