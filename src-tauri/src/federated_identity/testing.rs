//! Crate-visible fixtures for owners outside this module that must prove they
//! carry NIP-FI evidence, without reaching into session internals.
use super::{tests, FederatedIdentity, Status};
use std::sync::Arc;

/// A signed-in session whose assertions come from `adapter_base` (a plain
/// loopback fixture) and whose community at `relay` requires NIP-FI.
pub(crate) fn signed_in(adapter_base: String, relay: &str, required: bool) -> FederatedIdentity {
    let owner = undiscovered(adapter_base, relay);
    owner.discovered(relay, required);
    owner
}
/// A signed-in session for an organization community at `relay` that has
/// not been discovered yet.
fn undiscovered(adapter_base: String, relay: &str) -> FederatedIdentity {
    let mut owner = tests::at_adapter(Arc::new(tests::Memory::default()), adapter_base);
    let authority = &relay["wss://".len()..];
    Arc::get_mut(&mut owner.0)
        .unwrap()
        .config
        .as_mut()
        .unwrap()
        .community_hosts = vec![authority.into()];
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

/// The loopback certificate every native transport trusts in tests, and only
/// in tests: `127.0.0.1`, self-signed, generated once per test process.
fn certificate() -> &'static rcgen::CertifiedKey<rcgen::KeyPair> {
    static CERTIFICATE: std::sync::OnceLock<rcgen::CertifiedKey<rcgen::KeyPair>> =
        std::sync::OnceLock::new();
    CERTIFICATE
        .get_or_init(|| rcgen::generate_simple_self_signed(vec!["127.0.0.1".into()]).unwrap())
}
pub(crate) fn trusted_root() -> reqwest::Certificate {
    reqwest::Certificate::from_der(certificate().cert.der()).unwrap()
}
/// The same root as a PEM file, for Git's `http.sslCAInfo`.
pub(crate) fn trusted_root_file() -> &'static std::path::Path {
    static FILE: std::sync::OnceLock<tempfile::TempPath> = std::sync::OnceLock::new();
    FILE.get_or_init(|| {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        std::io::Write::write_all(&mut file, certificate().cert.pem().as_bytes()).unwrap();
        file.into_temp_path()
    })
}
pub(crate) fn trusted_connector() -> tokio_tungstenite::Connector {
    let mut roots = rustls::RootCertStore::empty();
    roots.add(certificate().cert.der().clone()).unwrap();
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    tokio_tungstenite::Connector::Rustls(Arc::new(
        rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth(),
    ))
}

/// A signed-in viewer and an organization community on loopback TLS. Its
/// `/info` discovery document requires NIP-FI or not; `token` is the one
/// assertion its issuer mints.
pub(crate) struct Community {
    pub(crate) fi: FederatedIdentity,
    pub(crate) host: crate::identity::IdentityHost,
    /// `https://127.0.0.1:<port>/`.
    pub(crate) origin: url::Url,
    required: bool,
    token: String,
    listener: Arc<tokio::net::TcpListener>,
    acceptor: tokio_rustls::TlsAcceptor,
}
pub(crate) async fn community(required: bool) -> Community {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let authority = listener.local_addr().unwrap().to_string();
    let host = crate::identity::IdentityHost::fixture();
    let viewer = host.viewer().await.unwrap();
    let relay = format!("wss://{authority}");
    let (adapter, token, _) = issuer(&viewer, &relay).await;
    let key =
        rustls::pki_types::PrivateKeyDer::Pkcs8(certificate().signing_key.serialize_der().into());
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let server = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![certificate().cert.der().clone()], key)
        .unwrap();
    Community {
        fi: undiscovered(adapter, &relay),
        host,
        origin: url::Url::parse(&format!("https://{authority}/")).unwrap(),
        required,
        token,
        listener: Arc::new(listener),
        acceptor: tokio_rustls::TlsAcceptor::from(Arc::new(server)),
    }
}
impl Community {
    /// Answers discovery at `/info` whenever asked, and every other request
    /// with the next of `replies`, one connection each. Yields those other
    /// requests' heads in order.
    pub(crate) fn serve(&self, replies: Vec<String>) -> tokio::task::JoinHandle<Vec<String>> {
        let (listener, acceptor) = (self.listener.clone(), self.acceptor.clone());
        let discovery = if self.required {
            reply(
                "200 OK",
                r#"{"limitation":{"federated_identity":true},"federated_identity":{"core":"client-attached","assertion_freshness":{"class":"offline-jwt"}}}"#,
            )
        } else {
            reply("200 OK", "{}")
        };
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut replies = replies.into_iter();
            let mut heads = Vec::new();
            while replies.len() > 0 {
                let (tcp, _) = listener.accept().await.unwrap();
                let mut stream = acceptor.accept(tcp).await.unwrap();
                let mut head = Vec::new();
                while !head.ends_with(b"\r\n\r\n") {
                    head.push(stream.read_u8().await.unwrap());
                }
                let head = String::from_utf8(head).unwrap();
                let answer = if head.starts_with("GET /info ") {
                    discovery.clone()
                } else {
                    heads.push(head);
                    replies.next().unwrap()
                };
                stream.write_all(answer.as_bytes()).await.unwrap();
                let _ = stream.shutdown().await;
            }
            heads
        })
    }
    /// Asserts `head` carries exactly the issued assertion if the community
    /// requires NIP-FI, and none otherwise; never as `Authorization`.
    pub(crate) fn assert_carried(&self, head: &str) {
        let carried: Vec<_> = head
            .lines()
            .filter_map(|line| line.split_once(':'))
            .filter(|(name, _)| name.eq_ignore_ascii_case(super::assertion::HEADER))
            .map(|(_, value)| value.trim().to_owned())
            .collect();
        let expected = if self.required {
            vec![format!("Bearer {}", self.token)]
        } else {
            vec![]
        };
        assert_eq!(carried, expected, "{head}");
        assert!(!head.contains(&self.token) || self.required, "{head}");
        assert!(
            !head.to_ascii_lowercase().contains("authorization: bearer"),
            "{head}"
        );
    }
}
/// A complete response with a JSON body that closes its connection.
pub(crate) fn reply(status: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}
