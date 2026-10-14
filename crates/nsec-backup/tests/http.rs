use std::{io::ErrorKind, time::Duration};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use buzz_nsec_backup::{Client, Error};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

// Encrypted envelope from block/buzz's HPKE interoperability fixture; all keys are synthetic.
const ENVELOPE: &[u8] = include_bytes!("fixtures/envelope.json");
const BACKUP_ID: &str = "018f6f4e-83d1-7a4e-8c8e-4f914f7d31a2";
const SECOND_ID: &str = "018f6f4e-83d1-7a4e-8c8e-4f914f7d31a3";
const FAILED_ID: &str = "018f6f4e-83d1-7a4e-8c8e-4f914f7d31a4";
const OTHER_FAILED_ID: &str = "018f6f4e-83d1-7a4e-8c8e-4f914f7d31a5";
const SESSION: &str = "fixture-session";
const RECIPIENT_PUBLIC_KEY: &str =
    "BMW2UZQAGGqOEKu9wF0-RQyGEuXboGknCRUnEQMkrPsDcdmNZiOV2HL66Wf-de8k2yCnwsGvGcNEItlPYpsbHa0";

struct Request {
    headers: String,
    body: Vec<u8>,
}

enum Framing {
    Close,
    ContentLength,
    Chunked,
}

struct Reply {
    status: u16,
    body: Vec<u8>,
    headers: String,
    framing: Framing,
    release: Option<oneshot::Receiver<()>>,
}

impl Reply {
    fn body(status: u16, body: Vec<u8>) -> Self {
        Self {
            status,
            body,
            headers: String::new(),
            framing: Framing::Close,
            release: None,
        }
    }

    fn json(value: Value) -> Self {
        Self::body(200, serde_json::to_vec(&value).unwrap())
    }
}

async fn server(replies: Vec<Reply>, prefix: &str) -> (Client, JoinHandle<Vec<Request>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}{prefix}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        tokio::time::timeout(Duration::from_secs(5), async move {
            let mut requests = Vec::new();
            for reply in replies {
                let (stream, _) = listener.accept().await.unwrap();
                let mut stream = BufReader::new(stream);
                let mut headers = String::new();
                loop {
                    let mut line = String::new();
                    assert!(stream.read_line(&mut line).await.unwrap() > 0);
                    headers.push_str(&line);
                    assert!(headers.len() < 8192);
                    if line == "\r\n" {
                        break;
                    }
                }
                let length = headers
                    .lines()
                    .filter_map(|line| line.split_once(':'))
                    .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                    .map(|(_, value)| value.trim().parse().unwrap())
                    .unwrap_or(0);
                assert!(length <= 4096);
                let mut body = vec![0; length];
                stream.read_exact(&mut body).await.unwrap();
                requests.push(Request { headers, body });
                let framing = match reply.framing {
                    Framing::Close => String::new(),
                    Framing::ContentLength => format!("Content-Length: {}\r\n", reply.body.len()),
                    Framing::Chunked => "Transfer-Encoding: chunked\r\n".into(),
                };
                let head = format!(
                    "HTTP/1.1 {} Test\r\n{framing}{}Connection: close\r\n\r\n",
                    reply.status, reply.headers
                );
                stream.get_mut().write_all(head.as_bytes()).await.unwrap();
                // A rejected response may close its connection before the fixture finishes writing.
                if matches!(reply.framing, Framing::Chunked) {
                    for chunk in reply.body.chunks(1024) {
                        let head = format!("{:x}\r\n", chunk.len());
                        if stream.get_mut().write_all(head.as_bytes()).await.is_err()
                            || stream.get_mut().write_all(chunk).await.is_err()
                            || stream.get_mut().write_all(b"\r\n").await.is_err()
                        {
                            break;
                        }
                    }
                } else {
                    let _ = stream.get_mut().write_all(&reply.body).await;
                }
                if let Some(release) = reply.release {
                    release.await.unwrap();
                }
                if matches!(reply.framing, Framing::Chunked) {
                    let _ = stream.get_mut().write_all(b"0\r\n\r\n").await;
                }
            }
            requests
        })
        .await
        .unwrap()
    });
    (Client::new(&url, SESSION).unwrap(), task)
}

fn backup(id: &str, secret: Value) -> Value {
    json!({"backup_id": id, "nostr_pubkey": "24".repeat(32), "secret_key": secret})
}

fn recovery(backups: Vec<Value>, failed_ids: Vec<&str>) -> Value {
    json!({"backups": backups, "failed_backup_ids": failed_ids})
}

fn assert_redacted(error: &Error, sensitive: &str) {
    for diagnostic in [format!("{error}"), format!("{error:?}")] {
        assert!(!diagnostic.contains(sensitive));
        assert!(!diagnostic.contains(SESSION));
    }
}

#[tokio::test]
async fn enrollment_upload_retry_and_list_recovery_use_the_native_session_and_api_prefix() {
    let mut enrollment: Value = serde_json::from_slice(ENVELOPE).unwrap();
    let fields = enrollment.as_object_mut().unwrap();
    fields.remove("enc");
    fields.remove("ciphertext");
    fields.insert("recipient_public_key".into(), json!(RECIPIENT_PUBLIC_KEY));
    let mut enrolled_reply = Reply::json(enrollment);
    enrolled_reply.headers = "Set-Cookie: browser-session=fixture-cookie\r\n".into();
    let receipt = json!({"backup_id": BACKUP_ID, "stored": true});
    let (client, requests) = server(
        vec![
            enrolled_reply,
            Reply::body(503, b"transient fixture failure".to_vec()),
            Reply::json(receipt),
            Reply::json(recovery(
                vec![
                    backup(BACKUP_ID, json!(URL_SAFE_NO_PAD.encode([0x42; 32]))),
                    backup(SECOND_ID, json!(URL_SAFE_NO_PAD.encode([0xa5; 32]))),
                ],
                vec![FAILED_ID, OTHER_FAILED_ID],
            )),
        ],
        "/api",
    )
    .await;

    let enrolled = client.enroll().await.unwrap();
    assert_eq!(enrolled.version, 1);
    assert_eq!(enrolled.suite.kem_id, 16);
    assert_eq!(enrolled.suite.kdf_id, 1);
    assert_eq!(enrolled.suite.aead_id, 2);
    assert_eq!(enrolled.recipient_key_id, "backup-key-2026-09");
    assert_eq!(enrolled.service_namespace, "backup/staging");
    assert_eq!(enrolled.owner_id, "subject:01J8A4M7Q1G4X8S8M51FS7K2HX");
    assert_eq!(enrolled.backup_id, BACKUP_ID);
    assert_eq!(
        enrolled.nostr_pubkey,
        "24653eac434488002cc06bbfb7f10fe18991e35f9fe4302dbea6d2353dc0ab1c"
    );
    assert_eq!(enrolled.recipient_public_key, RECIPIENT_PUBLIC_KEY);
    assert!(matches!(
        client.upload(ENVELOPE).await,
        Err(Error::HttpStatus(503))
    ));
    let uploaded = client.upload(ENVELOPE).await.unwrap();
    assert_eq!(uploaded.backup_id, BACKUP_ID);
    assert!(uploaded.stored);
    let recovered = client.recover().await.unwrap();
    assert_eq!(recovered.backups.len(), 2);
    assert_eq!(recovered.backups[0].backup_id, BACKUP_ID);
    assert_eq!(recovered.backups[1].backup_id, SECOND_ID);
    assert_eq!(recovered.backups[0].nostr_pubkey, "24".repeat(32));
    assert_eq!(recovered.backups[0].secret_key(), &[0x42; 32]);
    assert_eq!(recovered.backups[1].secret_key(), &[0xa5; 32]);
    assert_eq!(recovered.failed_backup_ids, [FAILED_ID, OTHER_FAILED_ID]);
    for diagnostic in [format!("{client:?}"), format!("{recovered:?}")] {
        assert!(!diagnostic.contains(SESSION));
        assert!(!diagnostic.contains(&URL_SAFE_NO_PAD.encode([0x42; 32])));
        assert!(!diagnostic.contains("66, 66"));
        assert!(!diagnostic.contains("165, 165"));
    }

    let requests = requests.await.unwrap();
    assert_eq!(requests.len(), 4);
    for (request, suffix) in requests.iter().zip(["/enrollment", "", "", "/recovery"]) {
        assert!(request.headers.starts_with(&format!(
            "POST /api/v1/buzz/nsec-backups{suffix} HTTP/1.1\r\n"
        )));
        let headers = request.headers.to_ascii_lowercase();
        assert!(headers.contains("\r\nx-bb-session-credential: fixture-session\r\n"));
        assert!(headers.contains("\r\ncontent-type: application/json\r\n"));
        assert!(!headers.contains("\r\ncookie:"));
        assert!(!headers.contains("\r\nauthorization:"));
    }
    assert!(requests[0].body.is_empty());
    assert_eq!(requests[1].body, ENVELOPE);
    assert_eq!(requests[2].body, ENVELOPE);
    assert!(requests[3].body.is_empty());
}

#[tokio::test]
async fn all_failed_and_empty_lists_are_successful_recoveries() {
    let (client, requests) = server(
        vec![
            Reply::json(recovery(vec![], vec![SECOND_ID, FAILED_ID])),
            Reply::json(recovery(vec![], vec![])),
        ],
        "",
    )
    .await;
    let recovered = client.recover().await.unwrap();
    assert!(recovered.backups.is_empty());
    assert_eq!(recovered.failed_backup_ids, [SECOND_ID, FAILED_ID]);
    let recovered = client.recover().await.unwrap();
    assert!(recovered.backups.is_empty());
    assert!(recovered.failed_backup_ids.is_empty());
    assert_eq!(requests.await.unwrap().len(), 2);
}

#[tokio::test]
async fn http_errors_preserve_status_including_no_backups_and_hide_response_bodies() {
    for status in [401, 403, 404, 409, 429, 500, 503] {
        let (client, requests) = server(
            vec![Reply::body(
                status,
                b"secret-containing-error-body".to_vec(),
            )],
            "/api/",
        )
        .await;
        let error = client.recover().await.unwrap_err();
        assert!(matches!(error, Error::HttpStatus(code) if code == status));
        assert_redacted(&error, "secret-containing-error-body");
        let requests = requests.await.unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0]
            .headers
            .starts_with("POST /api/v1/buzz/nsec-backups/recovery "));
    }
}

#[tokio::test]
async fn redirects_are_rejected_without_connecting_to_the_destination() {
    for status in [301, 302, 303, 307, 308] {
        let destination = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        destination.set_nonblocking(true).unwrap();
        let mut reply = Reply::body(status, vec![]);
        reply.headers = format!(
            "Location: http://{}/capture\r\n",
            destination.local_addr().unwrap()
        );
        let (client, requests) = server(vec![reply], "").await;
        assert!(matches!(client.recover().await, Err(Error::HttpStatus(code)) if code == status));
        assert_eq!(requests.await.unwrap().len(), 1);
        // The completed client call is the barrier for any redirect connection.
        assert_eq!(
            destination.accept().unwrap_err().kind(),
            ErrorKind::WouldBlock
        );
    }
}

#[tokio::test]
async fn malformed_responses_are_redacted_for_each_endpoint() {
    let sensitive = URL_SAFE_NO_PAD.encode([0x42; 32]);
    let malformed = json!({"version": sensitive, "stored": sensitive, "backups": sensitive});
    let (client, requests) = server(
        vec![
            Reply::json(malformed.clone()),
            Reply::json(malformed.clone()),
            Reply::json(malformed),
        ],
        "",
    )
    .await;
    for error in [
        client.enroll().await.unwrap_err(),
        client.upload(ENVELOPE).await.unwrap_err(),
        client.recover().await.unwrap_err(),
    ] {
        assert!(matches!(error, Error::InvalidResponse));
        assert_redacted(&error, &sensitive);
    }
    assert_eq!(requests.await.unwrap().len(), 3);
}

#[tokio::test]
async fn invalid_secret_encodings_lengths_and_incomplete_lists_are_rejected() {
    let encoded = URL_SAFE_NO_PAD.encode([0x42; 32]);
    let invalid_secrets = vec![
        json!(""),
        json!(URL_SAFE_NO_PAD.encode([0x42; 31])),
        json!(URL_SAFE_NO_PAD.encode([0x42; 33])),
        json!(format!("{encoded}=")),
        json!("+".repeat(43)),
        json!("/".repeat(43)),
        json!("!".repeat(43)),
        json!(format!("{}J", &encoded[..42])),
        json!(42),
        json!(null),
    ];
    let mut replies: Vec<_> = invalid_secrets
        .iter()
        .map(|secret| {
            Reply::json(recovery(
                vec![
                    backup(BACKUP_ID, json!(encoded)),
                    backup(SECOND_ID, secret.clone()),
                ],
                vec![],
            ))
        })
        .collect();
    replies.extend([
        Reply::json(json!({"backups": []})),
        Reply::json(json!({"failed_backup_ids": []})),
        Reply::json(recovery(
            vec![json!({"backup_id": BACKUP_ID, "nostr_pubkey": "24".repeat(32)})],
            vec![],
        )),
        Reply::body(200, b"not JSON".to_vec()),
        Reply::body(
            200,
            b"{\"backups\":[],\"failed_backup_ids\":[]} trailing".to_vec(),
        ),
    ]);
    let count = replies.len();
    let (client, requests) = server(replies, "").await;
    for _ in 0..count {
        let error = client.recover().await.unwrap_err();
        assert!(matches!(error, Error::InvalidResponse));
        assert_redacted(&error, &encoded);
    }
    assert_eq!(requests.await.unwrap().len(), count);
}

#[tokio::test]
async fn response_limits_apply_before_eof_with_and_without_chunked_framing() {
    for framing in [Framing::Close, Framing::Chunked, Framing::ContentLength] {
        let (release, gate) = oneshot::channel();
        let mut reply = Reply::body(200, vec![b' '; 64 * 1024 + 1]);
        reply.framing = framing;
        reply.release = Some(gate);
        let (client, requests) = server(vec![reply], "").await;
        let result = client.recover().await;
        let _ = release.send(());
        assert!(matches!(result, Err(Error::BodyTooLarge(65536))));
        assert_eq!(requests.await.unwrap().len(), 1);
    }
    let (client, requests) = server(
        vec![
            Reply::body(200, vec![b' '; 4097]),
            Reply::body(200, vec![b' '; 4097]),
        ],
        "",
    )
    .await;
    assert!(matches!(
        client.enroll().await,
        Err(Error::BodyTooLarge(4096))
    ));
    assert!(matches!(
        client.upload(ENVELOPE).await,
        Err(Error::BodyTooLarge(4096))
    ));
    assert_eq!(requests.await.unwrap().len(), 2);
}

#[tokio::test]
async fn recovery_bound_accepts_all_one_hundred_backups_in_order() {
    let ids: Vec<_> = (0..100)
        .map(|i| format!("018f6f4e-83d1-7a4e-8c8e-{i:012x}"))
        .collect();
    let backups = ids
        .iter()
        .enumerate()
        .map(|(i, id)| backup(id, json!(URL_SAFE_NO_PAD.encode([i as u8; 32]))))
        .collect();
    let mut reply = Reply::json(recovery(backups, vec![]));
    assert!(reply.body.len() > 4096);
    reply.framing = Framing::Chunked;
    let (client, requests) = server(vec![reply], "").await;
    let recovered = client.recover().await.unwrap();
    assert_eq!(recovered.backups.len(), 100);
    for (i, (backup, id)) in recovered.backups.iter().zip(ids).enumerate() {
        assert_eq!(backup.backup_id, id);
        assert_eq!(backup.secret_key(), &[i as u8; 32]);
    }
    assert!(recovered.failed_backup_ids.is_empty());
    assert_eq!(requests.await.unwrap().len(), 1);
}

#[test]
fn destinations_require_https_or_loopback_and_credentials_cannot_inject_headers() {
    for url in [
        "not a URL",
        "http://example.com",
        "file:///tmp/backup",
        "https://user:password@example.com",
        "https://example.com?query=value",
        "https://example.com#fragment",
    ] {
        assert!(matches!(
            Client::new(url, SESSION),
            Err(Error::InvalidServiceUrl)
        ));
    }
    for url in [
        "https://example.com/api",
        "http://localhost",
        "http://[::1]",
    ] {
        assert!(Client::new(url, SESSION).is_ok());
    }
    for credential in ["", "session\r\nCookie: injected"] {
        assert!(matches!(
            Client::new("https://example.com", credential),
            Err(Error::InvalidCredential)
        ));
    }
}

#[tokio::test]
async fn oversized_uploads_fail_before_io_and_transport_failures_are_distinct() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let client = Client::new(&url, SESSION).unwrap();
    assert!(matches!(
        client.upload(&[0; 4097]).await,
        Err(Error::BodyTooLarge(4096))
    ));
    assert_eq!(listener.accept().unwrap_err().kind(), ErrorKind::WouldBlock);
    drop(listener);
    let error = client.upload(&[0; 4096]).await.unwrap_err();
    assert!(matches!(error, Error::Transport));
    assert_redacted(&error, SESSION);

    let mut truncated = Reply::body(200, b"{\"secret_key\":\"fixture-secret".to_vec());
    truncated.headers = "Content-Length: 512\r\n".into();
    let (client, requests) = server(
        vec![
            Reply::json(json!({"backup_id": BACKUP_ID, "stored": true})),
            truncated,
        ],
        "",
    )
    .await;
    let mut envelope = ENVELOPE.to_vec();
    envelope.resize(4096, b' ');
    assert!(client.upload(&envelope).await.unwrap().stored);
    let error = client.recover().await.unwrap_err();
    assert!(matches!(error, Error::Transport));
    assert_redacted(&error, "fixture-secret");
    assert_eq!(requests.await.unwrap()[0].body, envelope);
}

#[test]
fn loopback_http_bypasses_environment_proxies() {
    const CHILD: &str = "BUZZ_NSEC_BACKUP_PROXY_TEST_CHILD";
    if std::env::var_os(CHILD).is_some() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let (client, requests) = server(vec![Reply::json(recovery(vec![], vec![]))], "").await;
            let result = tokio::time::timeout(Duration::from_secs(5), client.recover())
                .await
                .unwrap()
                .unwrap();
            assert!(result.backups.is_empty());
            let requests = requests.await.unwrap();
            assert_eq!(requests.len(), 1);
            assert!(requests[0]
                .headers
                .to_ascii_lowercase()
                .contains("\r\nx-bb-session-credential: fixture-session\r\n"));
        });
        return;
    }

    let proxy = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    proxy.set_nonblocking(true).unwrap();
    let proxy_url = format!("http://{}", proxy.local_addr().unwrap());
    // A child process isolates proxy variables from tests running concurrently.
    let mut child = std::process::Command::new(std::env::current_exe().unwrap());
    child.args(["--exact", "loopback_http_bypasses_environment_proxies"]);
    for name in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"] {
        child.env_remove(name).env_remove(name.to_ascii_lowercase());
    }
    let output = child
        .env(CHILD, "1")
        .env("HTTP_PROXY", &proxy_url)
        .env("ALL_PROXY", &proxy_url)
        .output()
        .unwrap();
    // Child completion is the barrier for any proxy connection.
    assert_eq!(proxy.accept().unwrap_err().kind(), ErrorKind::WouldBlock);
    assert!(
        output.status.success(),
        "child failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
