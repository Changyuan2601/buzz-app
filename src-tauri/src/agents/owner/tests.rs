use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const OWNER: &str = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";

async fn server(status: &str, body: &str) -> (reqwest::Url, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap())
        .parse()
        .unwrap();
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        let n = stream.read(&mut request).await.unwrap();
        assert!(std::str::from_utf8(&request[..n])
            .unwrap()
            .starts_with("GET /api/relay/identity HTTP/1.1"));
        stream.write_all(response.as_bytes()).await.unwrap();
    });
    (url, task)
}

#[tokio::test]
async fn host_mode_selects_broker_not_unrelated_native_identity() {
    let native = IdentityHost::fixture();
    assert_ne!(native.viewer().await.unwrap(), OWNER);
    let (url, task) = server("200 OK", &format!(r#"{{"viewer":"{OWNER}"}}"#)).await;
    let owner = Owner::select(native.clone(), true, Some(OWNER), Some(&url));
    assert_eq!(owner.viewer().await.unwrap(), OWNER);
    task.await.unwrap();
    // Packaged builds ignore even a malformed pin/URL; empty development pins use native.
    for (development, pin) in [(false, Some("invalid")), (true, None), (true, Some("  "))] {
        let owner = Owner::select(native.clone(), development, pin, Some(&url));
        assert_eq!(
            owner.viewer().await.unwrap(),
            native.viewer().await.unwrap()
        );
    }
}

#[tokio::test]
async fn broker_failure_never_uses_matching_native_identity_or_cached_success() {
    for (status, body) in [
        ("503 Unavailable", "{}".to_owned()),
        (
            "302 Found\r\nLocation: http://127.0.0.1:1/",
            "{}".to_owned(),
        ),
        ("200 OK", "not json".to_owned()),
        ("200 OK", "{}".to_owned()),
        ("200 OK", format!(r#"{{"viewer":"{}"}}"#, "a".repeat(64))),
        ("200 OK", "x".repeat(1025)),
    ] {
        let (url, task) = server(status, &body).await;
        let owner = Owner::select(IdentityHost::fixture_owner(), true, Some(OWNER), Some(&url));
        assert!(owner.viewer().await.is_err(), "{status}");
        task.await.unwrap();
    }
    let (url, task) = server("200 OK", &format!(r#"{{"viewer":"{OWNER}"}}"#)).await;
    let owner = Owner::select(IdentityHost::fixture_owner(), true, Some(OWNER), Some(&url));
    assert_eq!(owner.viewer().await.unwrap(), OWNER);
    task.await.unwrap();
    assert!(
        owner.viewer().await.is_err(),
        "closed broker must not reuse a cached owner"
    );
}

#[test]
fn pin_and_destination_are_validated_without_credentials_or_network() {
    use nostr::nips::nip19::ToBech32;
    let url = "http://localhost:1431/".parse().unwrap();
    let npub = nostr::key::PublicKey::from_hex(OWNER)
        .unwrap()
        .to_bech32()
        .unwrap();
    for pin in [OWNER.to_owned(), OWNER.to_uppercase(), npub] {
        assert_eq!(Broker::new(&pin, Some(&url)).unwrap().expected, OWNER);
    }
    for pin in ["not a key", "nsec1never-read-a-private-key", "ab"] {
        assert!(Broker::new(pin, Some(&url)).is_err());
    }
    assert!(Broker::new(OWNER, None).is_err());
    for value in [
        "https://localhost:1431",
        "http://example.com:1431",
        "http://localhost",
        "http://user@localhost:1431",
        "http://localhost:1431/?q=x",
        "http://localhost:1431/#x",
    ] {
        assert!(
            Broker::new(OWNER, Some(&value.parse().unwrap())).is_err(),
            "{value}"
        );
    }
}
