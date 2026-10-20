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

pub(super) fn jwt(agent: &AppAgent, claims: serde_json::Value) -> String {
    let now = now().unwrap() as u64;
    let mut base = serde_json::json!({
        "iss": "https://issuer.example",
        "aud": "https://relay.example",
        "nostr_pubkey": agent.pubkey,
        "nostr_owner_pubkey": agent.owner,
        "iat": now,
        "exp": now + 300,
    });
    for (name, value) in claims.as_object().unwrap() {
        base[name] = value.clone();
    }
    format!(
        "{}.{}.sig",
        URL_SAFE_NO_PAD.encode(br#"{"typ":"nip-fi-agent+jwt","alg":"ES256"}"#),
        URL_SAFE_NO_PAD.encode(base.to_string())
    )
}
pub(super) fn issued(agent: &AppAgent, claims: serde_json::Value) -> serde_json::Value {
    let token = jwt(agent, claims);
    let exp = serde_json::from_slice::<serde_json::Value>(
        &URL_SAFE_NO_PAD
            .decode(token.split('.').nth(1).unwrap())
            .unwrap(),
    )
    .unwrap()["exp"]
        .clone();
    serde_json::json!({ "assertion": token, "nostr_pubkey": agent.pubkey, "expires_at": exp })
}

#[tokio::test]
async fn an_agent_assertion_is_minted_with_the_grant_validated_and_reused() {
    let key = Secret::generate().unwrap();
    let mut probe = fixture("http://unused".into()).agent;
    probe.pubkey = key.pubkey().into();
    let reply = issued(&probe, serde_json::json!({}));
    let (base, served) = issuer(vec![(200, enrolled(&"b".repeat(64))), (200, reply)]).await;
    let mut f = fixture(base);
    f.agent.pubkey = key.pubkey().into();
    f.key = key;

    let first = f.tokens.evidence(&f.agent, &f.key).await.unwrap().unwrap();
    assert!(first.starts_with("Bearer ") && first.contains('.'));
    let again = f.tokens.evidence(&f.agent, &f.key).await.unwrap().unwrap();
    assert_eq!(*first, *again);

    let seen = served.await.unwrap();
    assert_eq!(seen.len(), 2, "the cached assertion is reused");
    let mint = &seen[1];
    assert_eq!(
        mint.target,
        "POST /mount/v1/nip-fi/agent-assertion HTTP/1.1"
    );
    let header = |name: &str| {
        mint.headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    };
    assert_eq!(header("authorization"), Some("Bearer grant-1"));
    assert!(header("nostr-authorization").unwrap().starts_with("Nostr "));
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&mint.body).unwrap(),
        serde_json::json!({ "nostr_pubkey": f.agent.pubkey, "relay_url": "wss://relay.example" })
    );
}

#[test]
fn agent_assertions_must_name_this_agent_owner_issuer_and_community() {
    let f = fixture("http://unused".into());
    let grant = Grant::new(
        f.agent.owner.clone(),
        f.agent.pubkey.clone(),
        "a@example.com".into(),
        "https://issuer.example".into(),
        "g".into(),
    );
    let now = now().unwrap() as u64;
    let check = |claims: serde_json::Value| {
        let token = jwt(&f.agent, claims);
        validate(
            &token,
            &f.agent,
            &grant,
            "wss://relay.example",
            now + 300,
            now,
        )
    };
    assert!(check(serde_json::json!({})).is_ok());
    for wrong in [
        serde_json::json!({ "nostr_pubkey": "c".repeat(64) }),
        serde_json::json!({ "nostr_owner_pubkey": "c".repeat(64) }),
        serde_json::json!({ "iss": "https://other.example" }),
        serde_json::json!({ "aud": "https://other.example" }),
        serde_json::json!({ "exp": now + 299 }),
        serde_json::json!({ "iat": now + 60 }),
    ] {
        assert!(check(wrong).is_err());
    }
    let human = format!(
        "{}.{}.sig",
        URL_SAFE_NO_PAD.encode(br#"{"typ":"nip-fi+jwt"}"#),
        jwt(&f.agent, serde_json::json!({}))
            .split('.')
            .nth(1)
            .unwrap()
    );
    assert!(validate(
        &human,
        &f.agent,
        &grant,
        "wss://relay.example",
        now + 300,
        now
    )
    .is_err());
}

#[tokio::test]
async fn a_community_outside_the_organization_gets_no_assertion() {
    let mut f = fixture("http://unused".into());
    f.agent.relay = "wss://elsewhere.example".into();
    assert!(f.tokens.evidence(&f.agent, &f.key).await.unwrap().is_none());
}
