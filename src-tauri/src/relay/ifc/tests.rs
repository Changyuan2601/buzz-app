use super::*;
use nostr::prelude::{EventBuilder, FinalizeEvent, Keys, Kind, Tag};

struct Facts {
    owner: Keys,
    relay: Keys,
    agent: AppAgent,
    channel: Uuid,
}
impl Facts {
    fn new() -> Self {
        let owner = Keys::parse(&format!("{:064x}", 1)).unwrap();
        let relay = Keys::parse(&format!("{:064x}", 2)).unwrap();
        let key = Keys::parse(&format!("{:064x}", 3)).unwrap();
        Self {
            agent: AppAgent {
                pubkey: key.public_key().to_hex(),
                relay: "wss://relay.test".into(),
                owner: owner.public_key().to_hex(),
                auth: "[]".into(),
                agent_type: "claude-code/agent".into(),
                name: "test".into(),
                picture: None,
                profile: None,
                about: None,
                deleted: false,
            },
            owner,
            relay,
            channel: Uuid::from_u128(1),
        }
    }
    fn event(&self, kind: u16, tags: Vec<Vec<String>>, signer: &Keys) -> Event {
        EventBuilder::new(Kind::from(kind), "")
            .tags(tags.into_iter().map(|tag| Tag::parse(tag).unwrap()))
            .finalize(signer)
            .unwrap()
    }
    fn message(&self, channel: Uuid) -> Event {
        self.event(9, vec![vec!["h".into(), channel.to_string()]], &self.owner)
    }
    fn policy(&self, include_owner: bool) -> String {
        let metadata = self.event(
            39000,
            vec![
                vec!["d".into(), self.channel.to_string()],
                vec!["t".into(), "dm".into()],
                vec!["private".into()],
            ],
            &self.relay,
        );
        let mut members = vec![
            vec!["d".into(), self.channel.to_string()],
            vec!["p".into(), self.agent.pubkey.clone()],
        ];
        if include_owner {
            members.push(vec!["p".into(), self.agent.owner.clone()]);
        }
        json!([metadata, self.event(39002, members, &self.relay)]).to_string()
    }
    fn bound(&self, policy: &str, history: &str, retained: &History) -> Result<Binding> {
        evaluate(
            &self.agent,
            CommunityId::from_uuid(Uuid::from_u128(2)),
            self.relay.public_key(),
            &self.message(self.channel),
            policy,
            history,
            Some(retained),
        )
    }
    fn check(&self, policy: &str, history: &str) -> Result<()> {
        self.bound(
            policy,
            history,
            &History {
                id: "test-history".into(),
                fresh: true,
                binding: Value::Null,
            },
        )
        .map(|_| ())
    }
}

#[test]
fn history_filter_admits_the_scheduler_payload_and_rejects_other_reads() {
    // Shared with the native transport test, which produces this through the scheduler.
    let filters = include_str!("../../../../src/features/ifc/history-read-filter.json");
    let channel = Uuid::from_u128(1);
    assert!(admit_history_filter(filters, channel).is_ok());
    assert!(admit_history_filter(filters, Uuid::from_u128(2)).is_err());

    let expected: Value = serde_json::from_str(filters).unwrap();
    for (field, value) in [
        ("#h", json!([])),
        (
            "#h",
            json!([channel.to_string(), Uuid::from_u128(2).to_string()]),
        ),
        ("limit", json!(12)),
        ("kinds", json!([9])),
        ("kinds", json!([40002, 9, 1])),
        ("kinds", json!([40002, 9, 9])),
        ("search", json!("extra filter field")),
    ] {
        let mut invalid = expected.clone();
        invalid[0][field] = value;
        assert!(admit_history_filter(&invalid.to_string(), channel).is_err());
    }
    for invalid in ["{", "[]", &json!([expected[0], expected[0]]).to_string()] {
        assert!(admit_history_filter(invalid, channel).is_err());
    }
}

#[test]
fn production_check_uses_verified_members_and_message_sources() {
    let facts = Facts::new();
    let history = json!([facts.message(facts.channel)]).to_string();
    assert!(facts.check(&facts.policy(true), &history).is_ok());
    assert!(facts.check(&facts.policy(false), &history).is_err());
    let wrong_channel = json!([facts.message(Uuid::from_u128(3))]).to_string();
    assert!(facts.check(&facts.policy(true), &wrong_channel).is_err());
    let mut forged = facts.message(facts.channel);
    forged.content = "Changed after signing".into();
    assert!(facts
        .check(&facts.policy(true), &json!([forged]).to_string())
        .is_err());
    let mut policy: Vec<Event> = serde_json::from_str(&facts.policy(true)).unwrap();
    policy[0].content = "Forged metadata".into();
    assert!(facts
        .check(&serde_json::to_string(&policy).unwrap(), &history)
        .is_err());
}

#[tokio::test]
async fn production_observer_preserves_history_on_failure_and_capacity_exhaustion() {
    let response = RelayResponse {
        status: 200,
        headers: Default::default(),
        body: "original history".into(),
    };
    let host = IdentityHost::fixture();
    let agents = AppAgentHost::new(Err("unused".into()), Err("unused".into()), false);
    let url = Url::parse("https://relay.test/query").unwrap();
    let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
    let receipt = tauri::ipc::Channel::new(move |body| {
        sent.send(body.deserialize::<Option<Value>>().unwrap())
            .unwrap();
        Ok(())
    });
    let held = AUDITS.acquire_many(2).await.unwrap();
    observe(
        host.clone(),
        agents.clone(),
        url.clone(),
        Value::Null,
        "[]".into(),
        &response,
        Some(receipt.clone()),
    );
    assert_eq!(received.recv().await, Some(None));
    assert_eq!(response.body, "original history");
    drop(held);
    // Malformed context settles the same background receipt used by relay_http.
    observe(
        host,
        agents,
        url,
        Value::Null,
        "[]".into(),
        &response,
        Some(receipt),
    );
    assert_eq!(received.recv().await, Some(None));
    let _finished = tokio::time::timeout(Duration::from_secs(1), AUDITS.acquire_many(2))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(response.body, "original history");
}

#[test]
fn retained_history_preserves_its_original_domain_and_uses_it_for_later_reads() {
    let facts = Facts::new();
    let history = json!([facts.message(facts.channel)]).to_string();
    let fresh = History {
        id: "actual-id".into(),
        fresh: true,
        binding: Value::Null,
    };
    let original = facts.bound(&facts.policy(true), &history, &fresh).unwrap();
    // The native adapter consumes these same wire fields; no core serialization API.
    let wire: Value = serde_json::from_str(include_str!(
        "../../../../src/features/ifc/retained-history-binding.json"
    ))
    .unwrap();
    assert_eq!(json!(original), wire);
    let retained = History {
        id: fresh.id.clone(),
        fresh: false,
        binding: json!(original),
    };

    let metadata: Vec<Event> = serde_json::from_str(&facts.policy(true)).unwrap();
    let bob = Keys::parse(&format!("{:064x}", 4)).unwrap();
    let members = facts.event(
        39002,
        vec![
            vec!["d".into(), facts.channel.to_string()],
            vec!["p".into(), facts.agent.pubkey.clone()],
            vec!["p".into(), facts.agent.owner.clone()],
            vec!["p".into(), bob.public_key().to_hex()],
        ],
        &facts.relay,
    );
    let expanded = json!([metadata[0], members]).to_string();
    let reused = facts.bound(&expanded, &history, &retained).unwrap();
    assert_eq!(json!(reused), json!(original));
    let wider = facts.bound(&expanded, &history, &fresh).unwrap();
    assert_ne!(wider.domain().unwrap(), original.domain().unwrap());

    // The current narrow domain would allow this read; the pinned wider one denies it.
    let wider_history = History {
        binding: json!(wider),
        ..retained
    };
    assert!(facts
        .bound(&facts.policy(true), &history, &wider_history)
        .is_err());
}

#[test]
fn legacy_malformed_and_other_history_bindings_remain_unknown() {
    let facts = Facts::new();
    let policy = facts.policy(true);
    let history = json!([facts.message(facts.channel)]).to_string();
    let fresh = History {
        id: "actual-id".into(),
        fresh: true,
        binding: Value::Null,
    };
    let valid = facts.bound(&policy, &history, &fresh).unwrap();
    let mut other_id = json!(valid);
    other_id["sessionId"] = json!("another-id");
    let mut unsupported = json!(valid);
    unsupported["version"] = json!(2);
    for binding in [Value::Null, json!({ "version": 1 }), other_id, unsupported] {
        let retained = History {
            id: fresh.id.clone(),
            fresh: false,
            binding,
        };
        assert!(facts.bound(&policy, &history, &retained).is_err());
    }
    assert!(evaluate(
        &facts.agent,
        CommunityId::from_uuid(Uuid::from_u128(2)),
        facts.relay.public_key(),
        &facts.message(facts.channel),
        &policy,
        &history,
        None
    )
    .is_err());
}
