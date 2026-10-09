use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use nostr_pairing::{EventBuilder, Keys, Kind};
use serde_json::{json, Value};
use sha2::Sha256;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;

struct Request {
    path: String,
    headers: String,
    body: Vec<u8>,
}
struct Reply {
    status: u16,
    body: Vec<u8>,
}
fn json_reply(value: Value) -> Reply {
    Reply {
        status: 200,
        body: serde_json::to_vec(&value).unwrap(),
    }
}
// Loopback HTTP is test-only. Production destinations are canonical WSS -> HTTPS.
fn server(
    count: usize,
    mut reply: impl FnMut(usize, Request) -> Reply + Send + 'static,
) -> (String, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let worker = std::thread::spawn(move || {
        for index in 0..count {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let header_end = loop {
                let mut chunk = [0; 4096];
                let n = stream.read(&mut chunk).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&chunk[..n]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    break end + 4;
                }
            };
            let headers = String::from_utf8(bytes[..header_end].to_vec()).unwrap();
            let length: usize = headers
                .lines()
                .find_map(|l| {
                    l.to_lowercase()
                        .strip_prefix("content-length: ")
                        .map(str::to_owned)
                })
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            while bytes.len() < header_end + length {
                let mut chunk = [0; 4096];
                let n = stream.read(&mut chunk).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&chunk[..n]);
            }
            let path = headers.split_whitespace().nth(1).unwrap().to_owned();
            let response = reply(
                index,
                Request {
                    path,
                    headers,
                    body: bytes[header_end..].to_vec(),
                },
            );
            let header = format!("HTTP/1.1 {} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", response.status, response.body.len());
            // A response-size refusal can close the client socket before all bytes arrive.
            let _ = stream
                .write_all(header.as_bytes())
                .and_then(|_| stream.write_all(&response.body));
        }
    });
    (origin, worker)
}

#[tokio::test]
async fn publication_requires_bounded_exact_receipt_and_retries_without_redirects() {
    let key = buzz_agent_controller::Secret::generate().unwrap();
    let keys = Keys::new(nostr_pairing::SecretKey::from_hex(key.hex().as_str()).unwrap());
    let event = EventBuilder::new(Kind::Custom(30174), "encrypted-fixture")
        .sign_with_keys(&keys)
        .unwrap();
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    for mode in [
        "refused",
        "redirect",
        "malformed",
        "oversized",
        "wrong-id",
        "rejected",
        "accepted",
    ] {
        let expected = event.id.to_hex();
        let pubkey = keys.public_key().to_hex();
        let (origin, worker) = server(1, move |_, request| {
            assert_eq!(request.path, "/events");
            let posted: Value = serde_json::from_slice(&request.body).unwrap();
            assert_eq!(posted["id"], expected);
            assert_eq!(posted["pubkey"], pubkey);
            let encoded = request
                .headers
                .lines()
                .find_map(|line| line.strip_prefix("authorization: Nostr "))
                .unwrap();
            let authorization: nostr_pairing::Event =
                serde_json::from_slice(&STANDARD.decode(encoded).unwrap()).unwrap();
            authorization.verify().unwrap();
            assert_eq!(authorization.pubkey.to_hex(), pubkey);
            let tags = serde_json::to_value(&authorization.tags).unwrap();
            assert!(tags
                .as_array()
                .unwrap()
                .contains(&json!(["method", "POST"])));
            assert!(tags.as_array().unwrap().contains(&json!([
                "payload",
                format!("{:x}", <Sha256 as sha2::Digest>::digest(&request.body))
            ])));
            assert!(request
                .headers
                .contains("x-auth-tag: fixture-authorization"));
            match mode {
                "refused" => Reply {
                    status: 403,
                    body: vec![],
                },
                "redirect" => Reply {
                    status: 302,
                    body: vec![],
                },
                "malformed" => Reply {
                    status: 200,
                    body: b"invalid".to_vec(),
                },
                "oversized" => Reply {
                    status: 200,
                    body: vec![b' '; 16 * 1024 + 1],
                },
                _ => json_reply(json!({"accepted":mode!="rejected",
                    "event_id":if mode=="wrong-id" { "00".repeat(32) } else { expected.clone() }})),
            }
        });
        let profile = CreationProfile {
            credential_id: "fixture".into(),
            pubkey: key.pubkey().into(),
            url: format!("{origin}/events"),
            auth: "fixture-authorization".into(),
            name: "fixture".into(),
            picture: None,
            about: None,
            revision: 1,
        };
        let outcome = profile_http::publish_memory(
            &client,
            &profile,
            &key,
            serde_json::to_value(&event).unwrap(),
        )
        .await;
        assert_eq!(outcome.is_ok(), mode == "accepted", "{mode}: {outcome:?}");
        worker.join().unwrap();
    }
}

#[test]
fn accepted_receipt_is_not_current_confirmation() {
    let current = json!({"partial":false,"entries":[{"slug":"core","eventId":"saved"}]});
    confirm_current(&current, "core", "saved").unwrap();
    for listing in [
        json!({"partial":true,"entries":[{"slug":"core","eventId":"saved"}]}),
        json!({"entries":[{"slug":"core","eventId":"saved"}]}),
        json!({"partial":false,"entries":[]}),
        json!({"partial":false,"entries":[{"slug":"core","eventId":"newer"}]}),
        json!({"partial":false,"entries":[{"slug":"mem/other","eventId":"saved"}]}),
    ] {
        assert!(confirm_current(&listing, "core", "saved").is_err());
    }
}

#[test]
fn snapshot_memory_limits_and_duplicate_slugs_are_checked_before_custody() {
    let entry = || SnapshotMemoryEntry {
        slug: "core".into(),
        body: "fixture".into(),
    };
    validate(&[entry()]).unwrap();
    for slug in ["../secret", "core\nunsafe", "mem/", "mem/UPPER", "mem/a//b"] {
        assert!(validate(&[SnapshotMemoryEntry {
            slug: slug.into(),
            body: String::new(),
        }])
        .is_err());
    }

    assert!(validate(&[entry(), entry()]).is_err());
    assert!(validate(
        &(0..129)
            .map(|i| SnapshotMemoryEntry {
                slug: format!("mem/entry-{i}"),
                body: String::new(),
            })
            .collect::<Vec<_>>()
    )
    .is_err());
    assert!(validate(&[SnapshotMemoryEntry {
        slug: "core".into(),
        body: "x".repeat(64 * 1024 + 1),
    }])
    .is_err());
    assert!(validate(
        &(0..17)
            .map(|i| SnapshotMemoryEntry {
                slug: format!("mem/entry-{i}"),
                body: "x".repeat(64 * 1024),
            })
            .collect::<Vec<_>>()
    )
    .is_err());
    assert!(require_complete(&json!({"partial":false})).is_err());
}

#[tokio::test]
async fn restore_target_rejects_foreign_owner_legacy_identity_revision_and_shutdown() {
    use tauri::Manager;
    let (directory, owner, app, _view) = crate::agents::tests::fixture();
    let id = crate::agents::tests::seed(directory.path());
    let identity = app.state::<crate::identity::IdentityHost>();
    let viewer = identity.viewer().await.unwrap();
    let path = directory.path().join("store/agents.json");
    let mut stored: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let auth = identity
        .authorize_agent(viewer.clone(), "ab".repeat(32))
        .await
        .unwrap();
    stored["agents"][0]["authTag"] = json!(serde_json::to_string(&auth).unwrap());
    std::fs::write(&path, serde_json::to_vec(&stored).unwrap()).unwrap();
    // Signed attestation alone must not admit old/imported identities.
    assert_eq!(
        target(owner.clone(), id.clone(), viewer.clone())
            .await
            .err()
            .unwrap(),
        "Snapshot memory requires a native-created agent"
    );
    stored["agents"][0]["nativeCreated"] = json!(true);
    std::fs::write(&path, serde_json::to_vec(&stored).unwrap()).unwrap();
    let profile = target(owner.clone(), id.clone(), viewer.clone())
        .await
        .unwrap();
    assert_eq!(
        target(owner.clone(), id.clone(), "cd".repeat(32))
            .await
            .err()
            .unwrap(),
        "Snapshot memory belongs to another owner"
    );
    current_target(owner.clone(), identity.inner(), &id, &viewer, &profile)
        .await
        .unwrap();
    assert_eq!(
        current_target(
            owner.clone(),
            identity.inner(),
            &id,
            &"cd".repeat(32),
            &profile
        )
        .await
        .err()
        .unwrap(),
        "Identity changed during memory restore"
    );
    stored["agents"][0]["revision"] = json!(2);
    std::fs::write(&path, serde_json::to_vec(&stored).unwrap()).unwrap();
    assert_eq!(
        current_target(owner.clone(), identity.inner(), &id, &viewer, &profile)
            .await
            .err()
            .unwrap(),
        "Agent changed during memory restore"
    );
    owner.1.store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(
        current_target(owner, identity.inner(), &id, &viewer, &profile)
            .await
            .is_err()
    );
}

#[test]
fn rejects_escaped_memory_event_before_native_write() {
    let entries = vec![SnapshotMemoryEntry {
        slug: "core".into(),
        body: "\\".repeat(40_000),
    }];
    assert!(validate(&entries).is_err());
    assert!(validate(&[SnapshotMemoryEntry {
        slug: "core".into(),
        body: "x".repeat(30_000),
    }])
    .is_ok());
}

#[test]
fn rejects_reader_dto_aggregate_before_memory_publication() {
    let entries: Vec<_> = (0..40)
        .map(|i| SnapshotMemoryEntry {
            slug: format!("mem/{i}"),
            body: "x".repeat(30_000),
        })
        .collect();
    assert!(validate(&entries).is_err());
    assert!(validate(&entries[..30]).is_ok());
}

#[test]
fn per_event_envelope_boundary_matches_native_reader() {
    let (mut low, mut high) = (0usize, 65_535usize);
    while low < high {
        let middle = (low + high).div_ceil(2);
        if buzz_agent_controller::validate_snapshot_memory_envelope("mem/a", &"x".repeat(middle))
            .is_ok()
        {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    let valid = low;
    assert!(validate(&[SnapshotMemoryEntry {
        slug: "mem/a".into(),
        body: "x".repeat(valid)
    }])
    .is_ok());
    assert!(validate(&[SnapshotMemoryEntry {
        slug: "mem/a".into(),
        body: "x".repeat(valid + 1)
    }])
    .is_err());
}

#[test]
fn restore_validation_rejects_hidden_context_and_accepts_word_final_joiners() {
    let entry = |body: &str| SnapshotMemoryEntry {
        slug: "core".into(),
        body: body.into(),
    };
    for body in ["before\u{202e}after", "before\u{200b}after"] {
        assert!(validate(&[entry(body)]).is_err());
    }
    assert!(validate(&[entry("അവന്‍ വന്നു\r\nفارسی‌زبان")]).is_ok());
}
