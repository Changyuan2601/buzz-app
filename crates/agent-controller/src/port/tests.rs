use super::*;
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::Mutex;

/// Saved keys by credential ID, and old Buzz's by source and pubkey.
#[derive(Default)]
struct Memory(Mutex<BTreeMap<String, String>>);
impl Credentials for Memory {
    fn read_legacy(&self, source: LegacySource, pubkey: &str) -> Result<Secret> {
        let saved = self.0.lock().unwrap();
        let hex = saved
            .get(&format!("{}:{pubkey}", source.keyring_service()))
            .ok_or("Absent")?;
        Secret::parse(hex, pubkey)
    }
    fn read(&self, id: &str, pubkey: &str) -> Result<Option<Secret>> {
        let saved = self.0.lock().unwrap();
        saved
            .get(id)
            .map(|hex| Secret::parse(hex, pubkey))
            .transpose()
    }
    fn add(&self, id: &str, key: &Secret) -> Result<()> {
        let mut saved = self.0.lock().unwrap();
        saved.insert(id.into(), key.hex().to_string());
        Ok(())
    }
    fn delete(&self, id: &str, _: &str) -> Result<()> {
        self.0.lock().unwrap().remove(id);
        Ok(())
    }
}

fn stores(dir: &std::path::Path) -> OldStores {
    OldStores {
        harness: dir.join("app/agent-controller/agents.json"),
        data_dir: dir.join("data"),
    }
}
fn write(path: std::path::PathBuf, value: Value) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, value.to_string()).unwrap();
}
fn legacy(dir: &std::path::Path, source: LegacySource, value: Value) {
    let path = dir
        .join("data")
        .join(source.app_directory())
        .join("agents/managed-agents.json");
    write(path, value);
}
fn key() -> Secret {
    Secret::generate().unwrap()
}

#[test]
fn lists_each_identity_once_preferring_the_harness_copy() {
    let dir = tempfile::tempdir().unwrap();
    let (shared, old, dev) = (key(), key(), key());
    write(
        stores(dir.path()).harness,
        json!({"version": 1, "agents": [{
            "pubkey": shared.pubkey(), "relayUrl": "wss://relay.example",
            "name": "Ada", "picture": "data:image/png;base64,AA",
            "credentialId": "ignored-by-list",
        }]}),
    );
    legacy(
        dir.path(),
        LegacySource::Installed,
        json!([
            {"pubkey": shared.pubkey(), "name": "Ada (old)", "relay_url": "wss://old.example"},
            {"pubkey": old.pubkey(), "name": " Bea ", "relay_url": "wss://old.example/",
             "avatar_url": "https://old.example/media/b.png"},
            // A persona with no identity, and an unnamed identity.
            {"pubkey": "", "name": "Persona"},
            {"pubkey": key().pubkey(), "name": ""},
        ]),
    );
    legacy(
        dir.path(),
        LegacySource::Development,
        json!([{"pubkey": dev.pubkey(), "name": "Cy", "relay_url": "not a relay"}]),
    );
    let found = stores(dir.path()).list();
    assert!(found.warnings.is_empty());
    assert_eq!(
        found.agents,
        [
            Portable {
                source: PortSource::Harness,
                pubkey: shared.pubkey().into(),
                name: "Ada".into(),
                picture: None,
                relay: "wss://relay.example".into(),
            },
            Portable {
                source: PortSource::Installed,
                pubkey: old.pubkey().into(),
                name: "Bea".into(),
                picture: Some("https://old.example/media/b.png".into()),
                relay: "wss://old.example".into(),
            },
            Portable {
                source: PortSource::Development,
                pubkey: dev.pubkey().into(),
                name: "Cy".into(),
                picture: None,
                relay: String::new(),
            },
        ]
    );
}

#[test]
fn missing_stores_list_nothing_and_a_broken_one_hides_only_itself() {
    let dir = tempfile::tempdir().unwrap();
    assert!(stores(dir.path()).list().agents.is_empty());
    assert!(stores(dir.path()).list().warnings.is_empty());
    let old = key();
    write(stores(dir.path()).harness, json!({"agents": "nope"}));
    legacy(
        dir.path(),
        LegacySource::Installed,
        json!([{"pubkey": old.pubkey(), "name": "Bea"}]),
    );
    let found = stores(dir.path()).list();
    assert_eq!(found.warnings.len(), 1);
    assert_eq!(found.agents.len(), 1);
    assert_eq!(found.agents[0].pubkey, old.pubkey());
}

#[test]
fn takes_the_key_from_the_store_it_was_listed_in() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (harness, old) = (key(), key());
    let id = agent_id(harness.pubkey(), "wss://relay.example");
    credentials.add(&id, &harness).unwrap();
    credentials.0.lock().unwrap().insert(
        format!("buzz-desktop:{}", old.pubkey()),
        old.hex().to_string(),
    );
    write(
        stores(dir.path()).harness,
        json!({"agents": [{
            "pubkey": harness.pubkey(), "relayUrl": "wss://relay.example",
            "name": "Ada", "credentialId": id,
        }]}),
    );
    legacy(
        dir.path(),
        LegacySource::Installed,
        json!([{"pubkey": old.pubkey(), "name": "Bea"}]),
    );
    let stores = stores(dir.path());
    let (agent, key) = stores
        .take(PortSource::Harness, harness.pubkey(), &credentials)
        .unwrap();
    assert_eq!(
        (agent.name.as_str(), key.pubkey()),
        ("Ada", harness.pubkey())
    );
    let (agent, key) = stores
        .take(PortSource::Installed, old.pubkey(), &credentials)
        .unwrap();
    assert_eq!((agent.name.as_str(), key.pubkey()), ("Bea", old.pubkey()));
    // Each source reads only its own store.
    assert!(stores
        .take(PortSource::Development, old.pubkey(), &credentials)
        .is_err());
    assert!(stores
        .take(PortSource::Harness, old.pubkey(), &credentials)
        .is_err());
}
