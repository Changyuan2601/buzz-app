use super::*;
fn target() -> Target {
    Target {
        pubkey: "a".repeat(64),
        owner: "b".repeat(64),
        relay: "wss://example.test".into(),
        channel: "34aeaccc-c83b-4422-beac-a4b8661f9f59".into(),
        root: "c".repeat(64),
        repo: "block/buzz-app".into(),
        pr: 677,
    }
}
fn poll(output: &str) -> Poll {
    Poll {
        snapshot: json!({"cursor": 2}),
        output: output.into(),
        terminal: false,
    }
}
#[test]
fn restart_preserves_cursor_pending_and_ambiguous_attempt() {
    let dir = tempfile::tempdir().unwrap();
    let route = target();
    let (store, mut journal) = Store::open(dir.path(), &route).unwrap();
    journal.checkpoint(poll("new event")).unwrap();
    journal.pending[0].attempted = true;
    store.save(&journal).unwrap();
    drop(store);
    let (_, restored) = Store::open(dir.path(), &route).unwrap();
    assert_eq!(restored.snapshot, Some(json!({"cursor": 2})));
    assert_eq!(restored.pending[0].text, "new event");
    assert!(restored.pending[0].attempted);
}
#[test]
fn only_one_active_subscription_per_exact_target() {
    let dir = tempfile::tempdir().unwrap();
    let route = target();
    let (store, _) = Store::open(dir.path(), &route).unwrap();
    assert!(Store::open(dir.path(), &route).is_err());
    drop(store);
    assert!(Store::open(dir.path(), &route).is_ok());
}
#[test]
fn changing_any_route_component_changes_the_target() {
    let route = target();
    route.validate().unwrap();
    let original = route.id();
    for index in 0..7 {
        let mut other = route.clone();
        match index {
            0 => other.pubkey = "d".repeat(64),
            1 => other.owner = "e".repeat(64),
            2 => other.relay = "wss://other.test".into(),
            3 => other.root = "f".repeat(64),
            4 => other.channel = "44aeaccc-c83b-4422-beac-a4b8661f9f59".into(),
            5 => other.repo = "block/other".into(),
            _ => other.pr = 815,
        }
        assert_ne!(original, other.id());
    }
}
#[test]
fn full_backlog_never_advances_the_source_cursor() {
    let mut journal = Journal::new(target());
    journal.snapshot = Some(json!({"cursor": 1}));
    for _ in 0..MAX_PENDING {
        journal.pending.push(Pending {
            id: "pending".into(),
            text: "pending".into(),
            event: None,
            attempted: false,
        });
    }
    assert!(journal.checkpoint(poll("new event")).is_err());
    assert_eq!(journal.snapshot, Some(json!({"cursor": 1})));
}
#[tokio::test]
async fn unavailable_native_transport_does_not_read_live_credentials() {
    assert!(load_sender_key().await.is_err());
}

struct Transport {
    sent: Mutex<Vec<Value>>,
    uncertain: bool,
    wrong_receipt: bool,
    unavailable: bool,
}
impl DeliveryTransport for Transport {
    async fn read(&self, _: &AppAgent, _: &Secret, _: &[Value]) -> Result<Value, String> {
        if self.unavailable {
            return Err("Unavailable transport".into());
        }
        let mut events = self.sent.lock().unwrap().clone();
        if self.wrong_receipt {
            events[0]["tags"][0][1] = json!("wrong-channel");
        }
        Ok(json!(events))
    }
    async fn post(&self, _: &AppAgent, _: &Secret, event: Value) -> Result<(), String> {
        self.sent.lock().unwrap().push(event);
        if self.uncertain {
            Err("Lost response".into())
        } else {
            Ok(())
        }
    }
}
fn sender() -> (Secret, AppAgent, Target) {
    let key = Secret::generate().unwrap();
    let mut route = target();
    let secp = secp256k1::Secp256k1::new();
    let mut owner_secret = [0; 32];
    owner_secret[31] = 2;
    let pair = secp256k1::Keypair::from_secret_key(
        &secp,
        &secp256k1::SecretKey::from_byte_array(owner_secret).unwrap(),
    );
    route.owner = pair.x_only_public_key().0.to_string();
    let sig = secp.sign_schnorr_no_aux_rand(
        &Sha256::digest(format!("nostr:agent-auth:{}:", key.pubkey())),
        &pair,
    );
    let sender = AppAgent {
        pubkey: key.pubkey().into(),
        owner: route.owner.clone(),
        relay: route.relay.clone(),
        auth: json!(["auth", route.owner, "", sig.to_string()]).to_string(),
        agent_type: "buzz.monitor/pr".into(),
        name: "Monitor".into(),
        picture: None,
        about: None,
        profile: None,
        deleted: false,
    };
    verify_sender(&sender).unwrap();
    (key, sender, route)
}
#[tokio::test]
async fn restart_reconciles_the_exact_known_receipt_without_resending() {
    let (key, sender, route) = sender();
    let dir = tempfile::tempdir().unwrap();
    let (store, mut journal) = Store::open(dir.path(), &route).unwrap();
    journal.sender = Some(sender);
    journal.checkpoint(poll("new review")).unwrap();
    store.save(&journal).unwrap();
    let transport = Transport {
        sent: Mutex::default(),
        uncertain: true,
        wrong_receipt: false,
        unavailable: false,
    };
    assert!(deliver_with(&store, &mut journal, &key, &transport)
        .await
        .is_err());
    assert_eq!(transport.sent.lock().unwrap().len(), 1);
    assert!(journal.pending[0].attempted);
    drop(store);
    let (store, mut restored) = Store::open(dir.path(), &route).unwrap();
    deliver_with(&store, &mut restored, &key, &transport)
        .await
        .unwrap();
    restored.checkpoint(poll("new review")).unwrap();
    deliver_with(&store, &mut restored, &key, &transport)
        .await
        .unwrap();
    assert_eq!(transport.sent.lock().unwrap().len(), 1);
    assert_eq!(restored.receipts.len(), 1);
    assert!(restored.pending.is_empty());
}
#[tokio::test]
async fn unavailable_readback_preserves_ambiguous_callback_and_blocks_resend() {
    let (key, sender, route) = sender();
    let dir = tempfile::tempdir().unwrap();
    let (store, mut journal) = Store::open(dir.path(), &route).unwrap();
    journal.sender = Some(sender);
    journal.checkpoint(poll("new review")).unwrap();
    let transport = Transport {
        sent: Mutex::default(),
        uncertain: true,
        wrong_receipt: false,
        unavailable: true,
    };
    assert!(deliver_with(&store, &mut journal, &key, &transport)
        .await
        .is_err());
    let original_id = journal.pending[0].event.as_ref().unwrap()["id"].clone();
    assert!(deliver_with(&store, &mut journal, &key, &transport)
        .await
        .is_err());
    assert_eq!(
        journal.pending[0].event.as_ref().unwrap()["id"],
        original_id
    );
    assert_eq!(transport.sent.lock().unwrap().len(), 1);
}
#[tokio::test]
async fn a_receipt_from_a_different_route_cannot_acknowledge_delivery() {
    let (key, sender, route) = sender();
    let dir = tempfile::tempdir().unwrap();
    let (store, mut journal) = Store::open(dir.path(), &route).unwrap();
    journal.sender = Some(sender);
    journal.checkpoint(poll("new review")).unwrap();
    let transport = Transport {
        sent: Mutex::default(),
        uncertain: true,
        wrong_receipt: true,
        unavailable: false,
    };
    assert!(deliver_with(&store, &mut journal, &key, &transport)
        .await
        .is_err());
    assert!(deliver_with(&store, &mut journal, &key, &transport)
        .await
        .is_err());
    assert!(journal.receipts.is_empty());
    assert_eq!(journal.pending.len(), 1);
    assert_eq!(transport.sent.lock().unwrap().len(), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn the_real_source_process_and_journal_deliver_a_new_event_once_after_restart() {
    let (key, sender, route) = sender();
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("fixture.py");
    std::fs::write(&script, "import json,sys\nr=json.load(sys.stdin)\nassert r['repo']=='block/buzz-app' and r['pr']==677\nassert not any(k.startswith(('BUZZ_', 'NOSTR_')) for k in __import__('os').environ)\nprint(json.dumps({'snapshot': {'cursor': 1 if r['snapshot'] is None else 2}, 'output': '' if r['snapshot'] is None else 'new review', 'terminal':False}))\n").unwrap();
    let (store, mut journal) = Store::open(dir.path(), &route).unwrap();
    journal.sender = Some(sender);
    journal
        .checkpoint(source_poll_at(&script, &route, None).await.unwrap())
        .unwrap();
    assert!(journal.pending.is_empty());
    store.save(&journal).unwrap();
    drop(store);
    let (store, mut journal) = Store::open(dir.path(), &route).unwrap();
    let next = source_poll_at(&script, &route, journal.snapshot.as_ref())
        .await
        .unwrap();
    journal.checkpoint(next).unwrap();
    store.save(&journal).unwrap();
    let transport = Transport {
        sent: Mutex::default(),
        uncertain: false,
        wrong_receipt: false,
        unavailable: false,
    };
    deliver_with(&store, &mut journal, &key, &transport)
        .await
        .unwrap();
    let events = transport.sent.lock().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["tags"][0], json!(["h", route.channel]));
    assert_eq!(events[0]["tags"][1], json!(["e", route.root, "", "reply"]));
    assert_eq!(events[0]["tags"][2], json!(["p", route.pubkey]));
    assert!(events[0]["content"]
        .as_str()
        .unwrap()
        .contains("new review"));
    assert_eq!(journal.receipts, vec![events[0]["id"].as_str().unwrap()]);
}

#[tokio::test]
async fn an_active_registration_cannot_survive_the_loss_of_native_hosting_authority() {
    let subscriptions = Subscriptions::new(Err("unused".into()));
    let route = target();
    subscriptions.active.lock().unwrap().insert(route.id());
    let host = AppAgentHost::new(Err("unused".into()), Err("unused".into()), false);
    assert!(subscriptions.start(host, route, None).await.is_err());
}
