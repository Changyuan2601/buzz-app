use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use nostr::{
    key::{PublicKey, SecretKey},
    nips::nip44,
};
use secp256k1::{Keypair, Secp256k1};
use sha2::{Digest, Sha256};

pub(crate) fn envelope(viewer: &str, kind: u16, serial: u64) -> AgentEvent {
    let created = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    envelope_at(viewer, kind, serial, created)
}
pub(crate) fn envelope_at(viewer: &str, kind: u16, serial: u64, created: u64) -> AgentEvent {
    let secret = [2; 32];
    let pair = Keypair::from_secret_key(
        &Secp256k1::signing_only(),
        &secp256k1::SecretKey::from_byte_array(secret).unwrap(),
    );
    let agent = pair.x_only_public_key().0.to_string();
    let conversation = nip44::v2::ConversationKey::derive(
        &SecretKey::from_slice(&secret).unwrap(),
        &PublicKey::from_hex(viewer).unwrap(),
    )
    .unwrap();
    let plaintext = format!(
        r#"{{"channelId":"private-channel","kind":"turn_started","payload":"archive-secret-marker","serial":{serial}}}"#
    );
    let content = STANDARD.encode(
        nip44::v2::encrypt_to_bytes_with_nonce(&conversation, plaintext.as_bytes(), [7; 32])
            .unwrap(),
    );
    let tags = vec![
        vec!["p", viewer],
        vec!["agent", &agent],
        vec!["frame", "telemetry"],
    ];
    let hash = Sha256::digest(
        serde_json::to_vec(&json!([0, agent, created, kind, tags, content])).unwrap(),
    );
    serde_json::from_value(json!({"id":format!("{hash:x}"),"pubkey":agent,"sig":Secp256k1::signing_only().sign_schnorr_no_aux_rand(&hash,&pair).to_string(),"created_at":created,"kind":kind,"tags":tags,"content":content})).unwrap()
}
fn viewer() -> String {
    Keypair::from_secret_key(
        &Secp256k1::signing_only(),
        &secp256k1::SecretKey::from_byte_array([1; 32]).unwrap(),
    )
    .x_only_public_key()
    .0
    .to_string()
}
#[test]
fn storage_partition_dedup_policy_paging_and_shrinking() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("archive.sqlite3");
    let mut store = store::Store::open(path.clone()).unwrap();
    let viewer = viewer();
    let event = envelope(&viewer, 24200, 0);
    let now = event.created_at as i64;
    // One timestamp for every fixture. prune(now + 86401) expires only rows
    // stamped at most 1 s after `now`; wall-clock stamps from a slow run survive.
    let at = |kind, serial| envelope_at(&viewer, kind, serial, event.created_at);
    for community in ["https://a.test", "https://b.test"] {
        store.seed(&viewer, community).unwrap();
    }
    store.seed("another-viewer", "https://a.test").unwrap();
    for _ in 0..2 {
        store
            .ingest(&viewer, "https://a.test", &event, None, 0, now)
            .unwrap();
    }
    assert_eq!(
        store
            .read(&viewer, "https://a.test", 24200, None, None)
            .unwrap()
            .0
            .len(),
        1
    );
    assert!(store
        .read(&viewer, "https://b.test", 24200, None, None)
        .unwrap()
        .0
        .is_empty());
    assert!(store
        .read("another-viewer", "https://a.test", 24200, None, None)
        .unwrap()
        .0
        .is_empty());
    let metrics = at(44200, 1);
    store
        .ingest(&viewer, "https://a.test", &metrics, None, 0, now)
        .unwrap();
    for i in 1..205 {
        store
            .ingest(&viewer, "https://a.test", &at(24200, i), None, 0, now)
            .unwrap();
    }
    let page = store
        .read(&viewer, "https://a.test", 24200, None, None)
        .unwrap()
        .0;
    assert_eq!(page.len(), 100);
    let next = store
        .read(
            &viewer,
            "https://a.test",
            24200,
            None,
            Some(page.last().unwrap().0),
        )
        .unwrap()
        .0;
    assert_eq!(next.len(), 100);
    assert!(next[0].0 < page.last().unwrap().0);
    assert!(store
        .read(&viewer, "https://a.test", 24200, None, Some(0))
        .is_err());
    assert!(store
        .read(&viewer, "https://a.test", 24200, Some("bad"), None)
        .is_err());
    let settings = store
        .configure(
            &viewer,
            "https://a.test",
            store::CaptureSettings {
                observer: false,
                metrics: true,
                days: 1,
                metrics_days: 365,
                revision: 0,
            },
            now,
        )
        .unwrap();
    assert_eq!(settings["revision"], 1);
    assert!(store
        .ingest(&viewer, "https://a.test", &event, None, 0, now)
        .is_err());
    let disabled = at(24200, 999);
    store
        .ingest(&viewer, "https://a.test", &disabled, None, 1, now)
        .unwrap();
    let count = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        count
            .query_row(
                "SELECT COUNT(*) FROM archive_events WHERE kind=24200",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        205
    );
    assert_eq!(
        count
            .query_row(
                "SELECT COUNT(*) FROM archive_events WHERE id=?1",
                [&disabled.id],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    drop(count);
    assert!(store
        .configure(
            &viewer,
            "https://a.test",
            store::CaptureSettings {
                observer: true,
                metrics: true,
                days: 30,
                metrics_days: 365,
                revision: 0
            },
            now
        )
        .is_err());
    store.prune(now + 86401).unwrap();
    assert!(store
        .read(&viewer, "https://a.test", 24200, None, None)
        .unwrap()
        .0
        .is_empty());
    assert_eq!(
        store
            .read(&viewer, "https://a.test", 44200, None, None)
            .unwrap()
            .0
            .len(),
        1
    );
    store.clear(&viewer, "https://a.test", Some(24200)).unwrap();
    assert_eq!(
        store
            .read(&viewer, "https://a.test", 44200, None, None)
            .unwrap()
            .0
            .len(),
        1
    );
    drop(store);
    let reopened = store::Store::open(path.clone()).unwrap();
    assert_eq!(
        reopened.settings(&viewer, "https://a.test").unwrap()["observer"],
        false
    );
    drop(reopened);
    let connection = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        connection
            .query_row("PRAGMA auto_vacuum", [], |r| r.get::<_, u32>(0))
            .unwrap(),
        2
    );
    drop(connection);
    let bytes = std::fs::read(path).unwrap();
    assert!(!bytes
        .windows(b"archive-secret-marker".len())
        .any(|s| s == b"archive-secret-marker"));
}
#[test]
fn newer_schema_is_never_modified_and_corruption_is_not_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("newer.sqlite3");
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.execute_batch("PRAGMA user_version=4; CREATE TABLE future(data TEXT); INSERT INTO future VALUES('keep');").unwrap();
    drop(connection);
    let before = std::fs::read(&path).unwrap();
    assert!(store::Store::open(path.clone()).is_err());
    assert_eq!(before, std::fs::read(&path).unwrap());
    let corrupt = dir.path().join("corrupt.sqlite3");
    std::fs::write(&corrupt, b"not a database").unwrap();
    assert!(store::Store::open(corrupt.clone()).is_err());
    assert_eq!(std::fs::read(corrupt).unwrap(), b"not a database");
}

#[tokio::test]
async fn host_rejects_invalid_ingest_isolates_bad_rows_and_preserves_live_decode_on_disk_failure() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("archive.sqlite3");
    let identity = IdentityHost::fixture();
    let host = ArchiveHost::default();
    let viewer = viewer();
    let request = |input| {
        execute(
            &identity,
            host.clone(),
            path.clone(),
            "https://a.test".into(),
            viewer.clone(),
            input,
        )
    };
    request(Request::Settings).await.unwrap();
    let event = envelope(&viewer, 24200, 0);
    request(Request::Ingest {
        event: event.clone(),
        revision: 0,
    })
    .await
    .unwrap();
    for kind in [24200, 44200] {
        let stale = envelope_at(&viewer, kind, 8, event.created_at - 301);
        let wrong_viewer = envelope(&event.pubkey, kind, 9);
        for invalid in [stale, wrong_viewer] {
            assert!(request(Request::Ingest {
                event: invalid,
                revision: 0
            })
            .await
            .is_err());
        }
    }
    assert_eq!(
        rusqlite::Connection::open(&path)
            .unwrap()
            .query_row("SELECT COUNT(*) FROM archive_events", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    let other = envelope(&viewer, 24200, 1);
    request(Request::Ingest {
        event: other.clone(),
        revision: 0,
    })
    .await
    .unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute(
            "UPDATE archive_events SET envelope='broken' WHERE id=?1",
            [other.id],
        )
        .unwrap();
    let page = request(Request::Read {
        kind: 24200,
        agent: None,
        before: None,
    })
    .await
    .unwrap();
    assert_eq!(page["records"].as_array().unwrap().len(), 1);
    assert_eq!(page["skipped"], 1);
    assert!(execute(
        &identity,
        host.clone(),
        path.clone(),
        "https://a.test".into(),
        "f".repeat(64),
        Request::Settings
    )
    .await
    .is_err());
    connection.execute_batch("CREATE TRIGGER refuse_clear BEFORE DELETE ON archive_events BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
    assert!(request(Request::Clear { kind: Some(24200) }).await.is_err());
    assert_eq!(
        request(Request::Read {
            kind: 24200,
            agent: None,
            before: None
        })
        .await
        .unwrap()["records"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let corrupt = directory.path().join("broken.sqlite3");
    std::fs::write(&corrupt, b"not a database").unwrap();
    assert!(execute(
        &identity,
        ArchiveHost::default(),
        corrupt,
        "https://a.test".into(),
        viewer.clone(),
        Request::Settings
    )
    .await
    .is_err());
    assert!(crate::relay::agent::decode_archive(&[1; 32], &viewer, &event, false).is_ok());
}

#[test]
fn quota_evicts_oldest_of_noisy_agent_before_other_agents_and_clear_reclaims_disk() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("quota.sqlite3");
    let mut store = store::Store::open(path.clone()).unwrap();
    let viewer = viewer();
    let community = "https://a.test";
    store.seed(&viewer, community).unwrap();
    let event = envelope(&viewer, 24200, 0);
    let now = event.created_at as i64;
    let raw_size = serde_json::to_string(&event).unwrap().len() as i64;
    let db = rusqlite::Connection::open(&path).unwrap();
    // Small test budget exercises the production quota algorithm, not 512 MiB of fixtures.
    db.execute(
        "UPDATE archive_subscriptions SET budget=?1 WHERE name='observer'",
        [raw_size * 8],
    )
    .unwrap();
    let mut quiet = event.clone();
    quiet.pubkey = "b".repeat(64);
    quiet.id = "b".repeat(64);
    store
        .ingest(&viewer, community, &quiet, None, 0, now)
        .unwrap();
    store
        .ingest(&viewer, community, &event, None, 0, now)
        .unwrap();
    for i in 1..5 {
        store
            .ingest(
                &viewer,
                community,
                &envelope(&viewer, 24200, i),
                None,
                0,
                now,
            )
            .unwrap();
    }
    let rows = store.read(&viewer, community, 24200, None, None).unwrap().0;
    assert_eq!(rows.len(), 3);
    assert!(rows.iter().any(|row| row.2.contains(&quiet.id)));
    assert!(!rows.iter().any(|row| row.2.contains(&event.id)));
    assert!(
        store.settings(&viewer, community).unwrap()["bytes"]
            .as_i64()
            .unwrap()
            <= raw_size * 8
    );
    db.execute(
        "UPDATE archive_subscriptions SET budget=536870912 WHERE name='observer'",
        [],
    )
    .unwrap();
    // Store-only fixtures intentionally bypass signature admission, proven in host/IPC tests.
    for i in 10..410 {
        let mut large = envelope(&viewer, 24200, i);
        large.content = "x".repeat(8000);
        store
            .ingest(&viewer, community, &large, None, 0, now)
            .unwrap();
    }
    db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
    let before = std::fs::metadata(&path).unwrap().len();
    store.clear(&viewer, community, Some(24200)).unwrap();
    assert!(std::fs::metadata(&path).unwrap().len() < before);
    assert_eq!(
        std::fs::metadata(path.with_extension("sqlite3-wal"))
            .unwrap()
            .len(),
        0
    );
    assert_eq!(store.settings(&viewer, community).unwrap()["bytes"], 0);
    let free: i64 = db
        .query_row("PRAGMA freelist_count", [], |r| r.get(0))
        .unwrap();
    assert_eq!(free, 0);
}

#[test]
fn community_quota_evicts_oldest_across_agents_with_individual_usage_below_cap() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pool.sqlite3");
    let mut store = store::Store::open(path.clone()).unwrap();
    let viewer = viewer();
    let community = "https://a.test";
    store.seed(&viewer, community).unwrap();
    let first = envelope(&viewer, 24200, 0);
    let now = first.created_at as i64;
    let size = serde_json::to_string(&first).unwrap().len() as i64;
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute(
        "UPDATE archive_subscriptions SET budget=?1 WHERE name='observer'",
        [size * 4],
    )
    .unwrap();
    // Store-only fixtures: host/IPC tests separately prove signature admission.
    for index in 0..5 {
        let mut row = first.clone();
        row.pubkey = format!("{index:064x}");
        row.id = row.pubkey.clone();
        store
            .ingest(&viewer, community, &row, None, 0, now)
            .unwrap();
    }
    let rows = store.read(&viewer, community, 24200, None, None).unwrap().0;
    assert_eq!(rows.len(), 4);
    let ids: Vec<String> = rows
        .iter()
        .map(|r| serde_json::from_str::<AgentEvent>(&r.2).unwrap().id)
        .collect();
    assert_eq!(
        ids,
        (1..5)
            .rev()
            .map(|i| format!("{i:064x}"))
            .collect::<Vec<_>>()
    );
    assert_eq!(
        store.settings(&viewer, community).unwrap()["bytes"],
        size * 4
    );
}

#[test]
fn v1_migration_preserves_ciphertext_settings_and_revisions() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("v1.sqlite3");
    let db = rusqlite::Connection::open(&path).unwrap();
    let schema = include_str!("../../../src/features/archive/schema.sql")
        .replace("  enabled INTEGER", "  scope TEXT NOT NULL CHECK(scope IN ('h','p','e')), value TEXT NOT NULL, kinds TEXT NOT NULL, enabled INTEGER");
    db.execute_batch(&schema).unwrap();
    db.execute_batch("PRAGMA user_version=1").unwrap();
    let viewer = viewer();
    let event = envelope(&viewer, 24200, 42);
    let raw = serde_json::to_string(&event).unwrap();
    db.execute(
        "INSERT INTO archive_partitions VALUES (?1,'https://a.test',7)",
        [&viewer],
    )
    .unwrap();
    for (name, kind) in [("observer", 24200), ("metrics", 44200)] {
        db.execute(
            "INSERT INTO archive_subscriptions VALUES (?1,'https://a.test',?2,'p',?1,?3,0,7,99999)",
            rusqlite::params![viewer, name, format!("[{kind}]")],
        )
        .unwrap();
    }
    db.execute("INSERT INTO archive_events(viewer,community,subscription,id,agent,kind,created,received,bytes,envelope) VALUES (?1,'https://a.test','observer',?2,?3,24200,?4,?4,?5,?6)",rusqlite::params![viewer,event.id,event.pubkey,event.created_at as i64,raw.len() as i64,raw]).unwrap();
    let store = store::Store::open(path).unwrap();
    let settings = store.settings(&viewer, "https://a.test").unwrap();
    assert_eq!(settings["observer"], false);
    assert_eq!(settings["metrics"], false);
    assert_eq!(settings["observerDays"], 7);
    assert_eq!(settings["revision"], 7);
    assert_eq!(settings["bytes"], raw.len());
    assert_eq!(
        store
            .read(&viewer, "https://a.test", 24200, None, None)
            .unwrap()
            .0[0]
            .2,
        raw
    );
    assert_eq!(
        db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        3
    );
    assert_eq!(
        db.prepare("PRAGMA table_info(archive_subscriptions)")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap(),
        vec!["viewer", "community", "name", "enabled", "days", "budget"]
    );
}

fn content_of(path: &std::path::Path, id: &str) -> (Option<String>, i64) {
    rusqlite::Connection::open(path)
        .unwrap()
        .query_row(
            "SELECT content,undecryptable FROM archive_events WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
}

#[tokio::test]
async fn host_ingest_keeps_plaintext_only_for_metrics() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("archive.sqlite3");
    let identity = IdentityHost::fixture();
    let host = ArchiveHost::default();
    let viewer = viewer();
    for (kind, serial) in [(24200, 1), (44200, 2)] {
        let event = envelope(&viewer, kind, serial);
        execute(
            &identity,
            host.clone(),
            path.clone(),
            "https://a.test".into(),
            viewer.clone(),
            Request::Ingest {
                event: event.clone(),
                revision: 0,
            },
        )
        .await
        .unwrap();
        let (content, _) = content_of(&path, &event.id);
        let plaintext = crate::relay::agent::decode_archive(&[1; 32], &viewer, &event, false)
            .unwrap()["plaintext"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(content, (kind == 44200).then_some(plaintext));
    }
    let bytes: i64 = rusqlite::Connection::open(&path)
        .unwrap()
        .query_row(
            "SELECT bytes-length(envelope)-length(CAST(content AS BLOB)) FROM archive_events WHERE kind=44200",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(bytes, 0, "plaintext counts against the metrics byte cap");
}

#[tokio::test]
async fn v2_archive_migrates_and_backfills_only_the_unlocked_account() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("v2.sqlite3");
    let viewer = viewer();
    let other = "c".repeat(64);
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(include_str!("../../../src/features/archive/schema.sql"))
        .unwrap();
    db.execute_batch("PRAGMA user_version=2").unwrap();
    let mine: Vec<AgentEvent> = (0..70).map(|i| envelope(&viewer, 44200, i)).collect();
    let broken = envelope(&viewer, 44200, 99);
    let foreign = envelope(&viewer, 44200, 100);
    let insert = |owner: &str, event: &AgentEvent, raw: String| {
        db.execute("INSERT INTO archive_events(viewer,community,subscription,id,agent,kind,created,received,bytes,envelope) VALUES (?1,'https://a.test','metrics',?2,?3,44200,?4,?4,?5,?6)",rusqlite::params![owner,event.id,event.pubkey,event.created_at as i64,raw.len() as i64,raw]).unwrap();
    };
    for owner in [viewer.as_str(), other.as_str()] {
        db.execute(
            "INSERT INTO archive_partitions VALUES (?1,'https://a.test',0)",
            [owner],
        )
        .unwrap();
        db.execute("INSERT INTO archive_subscriptions VALUES (?1,'https://a.test','metrics',1,90,67108864)", [owner]).unwrap();
        db.execute("INSERT INTO archive_subscriptions VALUES (?1,'https://a.test','observer',1,30,536870912)", [owner]).unwrap();
    }
    for event in &mine {
        insert(&viewer, event, serde_json::to_string(event).unwrap());
    }
    insert(&viewer, &broken, "broken".into());
    insert(&other, &foreign, serde_json::to_string(&foreign).unwrap());
    let before: i64 = db
        .query_row(
            "SELECT bytes FROM archive_usage WHERE viewer=?1 AND agent=''",
            [&viewer],
            |r| r.get(0),
        )
        .unwrap();
    let identity = IdentityHost::fixture();
    let host = ArchiveHost::default();
    let settings = || {
        execute(
            &identity,
            host.clone(),
            path.clone(),
            "https://a.test".into(),
            viewer.clone(),
            Request::Settings,
        )
    };
    let first = settings().await.unwrap();
    assert_eq!(first["metricsDays"], 365);
    assert_eq!(
        db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        3
    );
    // One bounded batch per host call; the second call resumes where it stopped.
    let pending = |db: &rusqlite::Connection| -> i64 {
        db.query_row(
            "SELECT COUNT(*) FROM archive_events WHERE content IS NULL AND undecryptable=0",
            [],
            |r| r.get(0),
        )
        .unwrap()
    };
    assert_eq!(pending(&db), 71 - 64 + 1);
    settings().await.unwrap();
    settings().await.unwrap();
    assert_eq!(pending(&db), 1, "the other account's row waits for its key");
    assert_eq!(content_of(&path, &foreign.id).0, None);
    assert_eq!(content_of(&path, &broken.id), (None, 1));
    for event in &mine {
        assert!(content_of(&path, &event.id)
            .0
            .unwrap()
            .contains("archive-secret-marker"));
    }
    let after: i64 = db
        .query_row(
            "SELECT bytes FROM archive_usage WHERE viewer=?1 AND agent=''",
            [&viewer],
            |r| r.get(0),
        )
        .unwrap();
    let added: i64 = db
        .query_row(
            "SELECT SUM(length(CAST(content AS BLOB))) FROM archive_events WHERE viewer=?1",
            [&viewer],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(after, before + added);
    assert_eq!(
        db.query_row(
            "SELECT budget FROM archive_subscriptions WHERE viewer=?1 AND name='metrics'",
            [&viewer],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1 << 30
    );
    // Backfilled rows still read through the ciphertext path.
    let page = execute(
        &identity,
        host.clone(),
        path.clone(),
        "https://a.test".into(),
        viewer.clone(),
        Request::Read {
            kind: 44200,
            agent: None,
            before: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(page["records"].as_array().unwrap().len(), 70);
    assert_eq!(page["skipped"], 1);
}

#[tokio::test]
async fn metrics_retention_is_configurable_and_forever_keeps_old_rows_readable() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("retention.sqlite3");
    let identity = IdentityHost::fixture();
    let host = ArchiveHost::default();
    let viewer = viewer();
    let request = |input| {
        execute(
            &identity,
            host.clone(),
            path.clone(),
            "https://a.test".into(),
            viewer.clone(),
            input,
        )
    };
    let configure = |metrics_days, revision| Request::Configure {
        observer: true,
        metrics: true,
        observer_days: 30,
        metrics_days,
        revision,
    };
    assert_eq!(
        request(Request::Settings).await.unwrap()["metricsDays"],
        365
    );
    assert!(request(configure(30, 0)).await.is_err());
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let old = envelope_at(&viewer, 44200, 1, now - 200 * 86400);
    let raw = serde_json::to_string(&old).unwrap();
    rusqlite::Connection::open(&path).unwrap().execute("INSERT INTO archive_events(viewer,community,subscription,id,agent,kind,created,received,bytes,envelope) VALUES (?1,'https://a.test','metrics',?2,?3,44200,?4,?4,?5,?6)",rusqlite::params![viewer,old.id,old.pubkey,old.created_at as i64,raw.len() as i64,raw]).unwrap();
    assert_eq!(request(configure(0, 0)).await.unwrap()["metricsDays"], 0);
    let read = || {
        request(Request::Read {
            kind: 44200,
            agent: None,
            before: None,
        })
    };
    assert_eq!(
        read().await.unwrap()["records"].as_array().unwrap().len(),
        1
    );
    assert!(
        content_of(&path, &old.id).0.is_some(),
        "rows past 90 days still backfill"
    );
    request(configure(90, 1)).await.unwrap();
    assert!(read().await.unwrap()["records"]
        .as_array()
        .unwrap()
        .is_empty());
    let count: i64 = rusqlite::Connection::open(&path)
        .unwrap()
        .query_row("SELECT COUNT(*) FROM archive_events", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0, "shortened retention prunes expired metrics");
}

#[test]
fn metrics_cap_counts_plaintext_and_evicts_oldest() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("metrics-cap.sqlite3");
    let mut store = store::Store::open(path.clone()).unwrap();
    let viewer = viewer();
    let community = "https://a.test";
    store.seed(&viewer, community).unwrap();
    let first = envelope(&viewer, 44200, 0);
    let now = first.created_at as i64;
    let content = "{\"turn\":{\"inputTokens\":1}}";
    let size = (serde_json::to_string(&first).unwrap().len() + content.len()) as i64;
    let db = rusqlite::Connection::open(&path).unwrap();
    // The envelope alone fits five rows; with plaintext only four fit.
    db.execute(
        "UPDATE archive_subscriptions SET budget=?1 WHERE name='metrics'",
        [size * 4 + content.len() as i64],
    )
    .unwrap();
    for index in 0..5 {
        let mut row = first.clone();
        row.pubkey = format!("{index:064x}");
        row.id = row.pubkey.clone();
        store
            .ingest(&viewer, community, &row, Some(content), 0, now)
            .unwrap();
    }
    let rows = store.read(&viewer, community, 44200, None, None).unwrap().0;
    assert_eq!(rows.len(), 4);
    assert!(!rows
        .iter()
        .any(|row| row.2.contains(&format!("{:064x}", 0))));
}
