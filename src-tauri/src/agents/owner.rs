//! Agent starts use the same human signer as this host's frontend. The public
//! development pin selects a broker; it never authorizes an agent on its own.
use crate::identity::IdentityHost;
use std::time::Duration;

#[derive(Clone)]
pub(crate) enum Owner {
    Native(IdentityHost),
    Broker(Result<Broker, String>),
}

#[derive(Clone)]
pub(crate) struct Broker {
    endpoint: reqwest::Url,
    expected: String,
}

impl Owner {
    pub(crate) fn select(
        native: IdentityHost,
        development: bool,
        pin: Option<&str>,
        dev_url: Option<&reqwest::Url>,
    ) -> Self {
        let pin = pin.unwrap_or("").trim();
        if !development || pin.is_empty() {
            Self::Native(native)
        } else {
            Self::Broker(Broker::new(pin, dev_url))
        }
    }

    pub(super) async fn viewer(&self) -> Result<String, String> {
        match self {
            Self::Native(identity) => identity.viewer().await,
            Self::Broker(broker) => broker.as_ref().map_err(Clone::clone)?.viewer().await,
        }
    }
}

const UNAVAILABLE: &str =
    "Development broker identity is unavailable; check the dev server and retry Start";

impl Broker {
    fn new(pin: &str, dev_url: Option<&reqwest::Url>) -> Result<Self, String> {
        use nostr::nips::nip19::FromBech32;
        let key = if pin.starts_with("npub1") {
            nostr::key::PublicKey::from_bech32(pin)
        } else {
            nostr::key::PublicKey::from_hex(pin)
        }
        .map_err(|_| "Invalid development viewer pin; use a public hex key or npub")?;
        let url = dev_url.ok_or("Development broker needs a configured loopback dev URL")?;
        if url.scheme() != "http"
            || !matches!(url.host_str(), Some("localhost" | "127.0.0.1"))
            || url.port().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("Development broker needs a configured loopback HTTP dev URL".into());
        }
        Ok(Self {
            endpoint: url.join("/api/relay/identity").map_err(|_| UNAVAILABLE)?,
            expected: key.to_hex(),
        })
    }

    async fn viewer(&self) -> Result<String, String> {
        // The existing broker derives viewer from its loaded signing key. Local
        // processes and same-origin plugins are trusted, as in its HTTP boundary.
        // Never consult another host, a proxy, or native credentials on failure.
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| UNAVAILABLE)?;
        let mut response = client
            .get(self.endpoint.clone())
            .send()
            .await
            .map_err(|_| UNAVAILABLE)?;
        if !response.status().is_success() {
            return Err(UNAVAILABLE.into());
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| UNAVAILABLE)? {
            if body.len() + chunk.len() > 1024 {
                return Err(UNAVAILABLE.into());
            }
            body.extend_from_slice(&chunk);
        }
        #[derive(serde::Deserialize)]
        struct Identity {
            viewer: String,
        }
        let identity: Identity = serde_json::from_slice(&body).map_err(|_| UNAVAILABLE)?;
        if identity.viewer != self.expected {
            return Err("Development broker identity does not match the configured public key; restart the correct dev server".into());
        }
        Ok(identity.viewer)
    }
}

#[cfg(test)]
mod tests;
