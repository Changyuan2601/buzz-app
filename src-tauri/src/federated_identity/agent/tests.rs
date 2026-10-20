use super::grant::tests::MemoryGrants;
use super::*;
use crate::federated_identity::tests::{at_adapter, record, Memory};

pub(super) struct Seen {
    pub(super) target: String,
    pub(super) headers: Vec<(String, String)>,
    pub(super) body: Vec<u8>,
}

/// Answers each request with the next `(status, body)`, then reports them.
pub(super) async fn issuer(
    replies: Vec<(u16, serde_json::Value)>,
) -> (String, tokio::task::JoinHandle<Vec<Seen>>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/mount", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let mut seen = Vec::new();
        for (status, reply) in replies {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            while !head.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                socket.read_exact(&mut byte).await.unwrap();
                head.push(byte[0]);
            }
            let text = String::from_utf8(head).unwrap();
            let mut lines = text.split("\r\n");
            let target = lines.next().unwrap().to_owned();
            let headers: Vec<_> = lines
                .filter_map(|line| line.split_once(':'))
                .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_owned()))
                .collect();
            let size: usize = headers
                .iter()
                .find(|(name, _)| name == "content-length")
                .map_or(0, |(_, value)| value.parse().unwrap());
            let mut body = vec![0; size];
            socket.read_exact(&mut body).await.unwrap();
            seen.push(Seen {
                target,
                headers,
                body,
            });
            let reply = reply.to_string();
            let response = format!(
                "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                reply.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        }
        seen
    });
    (base, task)
}

pub(super) struct Fixture {
    pub(super) tokens: AgentTokens,
    pub(super) grants: Arc<MemoryGrants>,
    pub(super) agent: AppAgent,
    pub(super) key: Secret,
}
/// An owner signed in as `a@example.com` at `base`, and one agent.
pub(super) fn fixture(base: String) -> Fixture {
    let identity = at_adapter(Arc::new(Memory::default()), base);
    let mut session = record();
    Arc::get_mut(&mut session).unwrap().record.email = Some("a@example.com".into());
    identity.state().session = Some(session);
    let grants = Arc::new(MemoryGrants::default());
    let key = Secret::generate().unwrap();
    let agent = AppAgent {
        pubkey: key.pubkey().into(),
        relay: "wss://relay.example".into(),
        owner: "b".repeat(64),
        auth: r#"["auth","owner","conditions","sig"]"#.into(),
        agent_type: "p/t".into(),
        name: "Ada".into(),
        picture: None,
        profile: None,
        about: None,
        deleted: false,
        deleting: false,
    };
    Fixture {
        tokens: AgentTokens::with_store(identity, grants.clone()),
        grants,
        agent,
        key,
    }
}
pub(super) fn enrolled(owner: &str) -> serde_json::Value {
    serde_json::json!({
        "access_token": "grant-1",
        "issued_token_type": GRANT_TOKEN_TYPE,
        "token_type": "N_A",
        "expires_in": 691200,
        "nostr_owner_pubkey": owner,
        "nip_fi_issuer": "https://issuer.example",
    })
}

#[tokio::test]
async fn enrollment_exchanges_the_owner_session_with_only_the_agent_proof() {
    let (base, served) = issuer(vec![(200, enrolled(&"b".repeat(64)))]).await;
    let f = fixture(base);
    let grant = f.tokens.grant(&f.agent, &f.key).await.unwrap();
    assert_eq!(
        (grant.token.as_str(), grant.account.as_str()),
        ("grant-1", "a@example.com")
    );
    // Stored, so a second use does not enroll again.
    assert!(f.tokens.grant(&f.agent, &f.key).await.is_ok());

    let seen = served.await.unwrap();
    assert_eq!(seen.len(), 1);
    let wire = &seen[0];
    assert_eq!(wire.target, "POST /mount/v1/nip-fi/agent-grant HTTP/1.1");
    let fields: Vec<(String, String)> = url::form_urlencoded::parse(&wire.body)
        .into_owned()
        .collect();
    let field = |name: &str| fields.iter().find(|(n, _)| n == name).unwrap().1.clone();
    assert_eq!(fields.len(), 7);
    assert_eq!(field("subject_token"), "fixture-session-token");
    assert_eq!(field("agent_pubkey"), f.agent.pubkey);
    assert_eq!(field("runtime"), "local");
    assert_eq!(field("owner_attestation"), f.agent.auth);
    assert_eq!(field("requested_token_type"), GRANT_TOKEN_TYPE);
    for ambient in ["authorization", "cookie", "x-bb-session"] {
        assert!(wire.headers.iter().all(|(name, _)| name != ambient));
    }
    let proof = &wire
        .headers
        .iter()
        .find(|(n, _)| n == "nostr-agent-proof")
        .unwrap()
        .1;
    let proof: serde_json::Value =
        serde_json::from_slice(&STANDARD.decode(&proof["Nostr ".len()..]).unwrap()).unwrap();
    assert_eq!(proof["pubkey"], f.agent.pubkey.as_str());
    let u = proof["tags"][0][1].as_str().unwrap();
    assert!(u.ends_with("/mount/v1/nip-fi/agent-grant"));
    use sha2::{Digest, Sha256};
    assert_eq!(
        proof["tags"][2][1],
        format!("{:x}", Sha256::digest(&wire.body)).as_str()
    );
}

#[tokio::test]
async fn enrollment_needs_a_session_and_refuses_another_owner() {
    let (base, served) = issuer(vec![(200, enrolled(&"c".repeat(64)))]).await;
    let f = fixture(base);
    assert!(f.tokens.grant(&f.agent, &f.key).await.is_err());
    assert!(f.grants.0.lock().unwrap().is_empty());
    served.await.unwrap();

    f.tokens.0.identity.state().session = None;
    assert_eq!(
        f.tokens.grant(&f.agent, &f.key).await.err().as_deref(),
        Some(SIGN_IN)
    );
}
