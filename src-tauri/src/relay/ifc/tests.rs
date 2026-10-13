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
    fn check(&self, policy: &str, history: &str) -> Result<()> {
        evaluate(
            &self.agent,
            CommunityId::from_uuid(Uuid::from_u128(2)),
            self.relay.public_key(),
            &self.message(self.channel),
            policy,
            history,
        )
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
    let held = AUDITS.acquire_many(2).await.unwrap();
    observe(
        host.clone(),
        agents.clone(),
        url.clone(),
        Value::Null,
        "[]".into(),
        &response,
    );
    assert_eq!(response.body, "original history");
    drop(held);
    // Malformed context fails inside the same detached audit used by relay_http.
    observe(host, agents, url, Value::Null, "[]".into(), &response);
    let _finished = tokio::time::timeout(Duration::from_secs(1), AUDITS.acquire_many(2))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(response.body, "original history");
}
