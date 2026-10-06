use super::*;

fn options(path: &str) -> OAuthRequest {
    OAuthRequest {
        authorization_url: "https://provider.example/authorize?client_id=buzz&scope=a%20b&scope=c"
            .into(),
        callback_path: path.into(),
    }
}

#[derive(Debug, PartialEq)]
struct Started {
    id: String,
    callback_url: String,
    state: String,
}

fn start(host: &OAuthCallbackHost, request: OAuthRequest) -> Result<Started, String> {
    let mut opened = None;
    let attempt = host.begin(request, |url| {
        opened = Some(url::Url::parse(url).unwrap());
        Ok(())
    })?;
    let authorization = opened.unwrap();
    let state = authorization
        .query_pairs()
        .find(|(name, _)| name == "state")
        .unwrap()
        .1
        .into_owned();
    Ok(Started {
        id: attempt.id,
        callback_url: attempt.callback_url,
        state,
    })
}

// Transport cases use a fixed matching state to isolate request validation.
fn parse_callback(
    bytes: &[u8],
    authority: &str,
    path: &str,
) -> (u16, &'static str, Option<OAuthCallback>) {
    super::parse_callback(bytes, authority, path, "attempt+state")
}

fn response(parameters: &[(&str, &str)]) -> OAuthCallback {
    OAuthCallback {
        parameters: parameters
            .iter()
            .map(|(name, value)| ((*name).into(), (*value).into()))
            .collect(),
    }
}

#[test]
fn selected_path_must_be_a_canonical_absolute_path_without_query_or_fragment() {
    let state = OAuthCallbackHost::default();
    for path in [
        "",
        "callback",
        "//evil.example/callback",
        "/callback?x=y",
        "/callback#x",
        "/a/../callback",
        "/\\evil.example/callback",
        "/callback with spaces",
    ] {
        assert_eq!(
            start(&state, options(path)),
            Err("Invalid callback path".into())
        );
    }
    assert!(state.0.lock().unwrap().is_none());
}

fn request(authority: &str, target: &str, extra: &str) -> Vec<u8> {
    format!("GET {target} HTTP/1.1\r\nHost: {authority}\r\n{extra}\r\n").into_bytes()
}

#[test]
fn callback_requires_the_exact_loopback_host_and_selected_path() {
    let host = "127.0.0.1:4567";
    let path = "/callback/random";
    let target = "/callback/random?code=x&state=attempt%2Bstate";
    for bytes in [
        request("evil.example", target, ""),
        request(host, &format!("//evil.example{target}"), ""),
        request(host, target, "Origin: https://evil.example\r\n"),
        request(host, target, "Host: 127.0.0.1:4567\r\n"),
        request(host, &format!("{target}#fragment"), ""),
        format!("POST {target} HTTP/1.1\r\nHost: {host}\r\n\r\n").into_bytes(),
    ] {
        let (status, _, code) = parse_callback(&bytes, host, path);
        assert_eq!(status, 400);
        assert!(code.is_none());
    }
    for target in ["/callback/wrong?code=x", "/wrong/../callback/random?code=x"] {
        assert_eq!(
            parse_callback(&request(host, target, ""), host, path).0,
            404
        );
    }
}

#[test]
fn callback_rejects_missing_empty_duplicate_or_oversized_code() {
    let host = "127.0.0.1:4567";
    let path = "/callback/random";
    for query in [
        "",
        "code=",
        "code=a&code=b",
        &format!("code={}", "a".repeat(4097)),
    ] {
        let target = format!("{path}?state=attempt%2Bstate&{query}");
        let (_, _, code) = parse_callback(&request(host, &target, ""), host, path);
        assert!(code.is_none());
    }
}

async fn send(url: &url::Url, target: &str, extra: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", url.port().unwrap()))
        .await
        .unwrap();
    stream
        .write_all(&request(
            &format!("127.0.0.1:{}", url.port().unwrap()),
            target,
            extra,
        ))
        .await
        .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).await.unwrap();
    response
}

#[tokio::test]
async fn real_listener_preserves_ipc_contracts_and_closes_after_completion() {
    let state = OAuthCallbackHost::default();
    let mut authorization = None;
    let attempt = state
        .begin(options("/oauth2redirect/provider"), |url| {
            authorization = Some(url::Url::parse(url).unwrap());
            Ok(())
        })
        .unwrap();
    assert_eq!(
        serde_json::to_value(&attempt).unwrap(),
        serde_json::json!({"id": attempt.id, "callbackUrl": attempt.callback_url})
    );
    let authorization = authorization.unwrap();
    let expected_state = authorization
        .query_pairs()
        .find(|(name, _)| name == "state")
        .unwrap()
        .1
        .into_owned();
    assert_eq!(
        authorization.query_pairs().into_owned().collect::<Vec<_>>(),
        [
            ("client_id", "buzz"),
            ("scope", "a b"),
            ("scope", "c"),
            ("redirect_uri", attempt.callback_url.as_str()),
            ("state", expected_state.as_str()),
        ]
        .map(|(name, value)| (name.to_owned(), value.to_owned()))
    );
    let id = attempt.id.as_str();
    let url = url::Url::parse(&attempt.callback_url).unwrap();
    assert_eq!(url.host_str(), Some("127.0.0.1"));
    assert!(uuid::Uuid::parse_str(id).is_ok());
    assert!(!url.as_str().contains(id));
    let wait = state.wait(id);
    let browser = async {
        assert!(send(&url, "/callback/wrong?code=x", "")
            .await
            .starts_with("HTTP/1.1 404"));
        // Keep a second connection queued behind the callback. Its identity stays
        // tied to this listener even if another test later reuses the port.
        let address = ("127.0.0.1", url.port().unwrap());
        let mut callback = TcpStream::connect(address).await.unwrap();
        let queued = TcpStream::connect(address).await.unwrap();
        callback
            .write_all(&request(
                &format!("127.0.0.1:{}", url.port().unwrap()),
                &format!(
                    "{}?code=one%2Btime&state={expected_state}&extra=a&extra=b",
                    url.path()
                ),
                "",
            ))
            .await
            .unwrap();
        let mut response = String::new();
        callback.read_to_string(&mut response).await.unwrap();
        assert!(response.starts_with("HTTP/1.1 200"));
        assert!(response.contains("Cache-Control: no-store"));
        assert!(response.contains("Referrer-Policy: no-referrer"));
        assert!(response.contains("Return to the app"));
        assert!(!response.contains("one+time"));
        assert!(!response.contains("one%2Btime"));
        assert!(!response.contains(&expected_state));
        queued
    };
    let (result, mut queued) = tokio::join!(wait, browser);
    assert_eq!(
        serde_json::to_value(result.unwrap()).unwrap(),
        serde_json::json!({"parameters": [["code", "one+time"], ["state", expected_state], ["extra", "a"], ["extra", "b"]]})
    );
    assert!(state.0.lock().unwrap().is_none());
    let mut byte = [0];
    let closed = tokio::time::timeout(Duration::from_secs(5), queued.read(&mut byte))
        .await
        .expect("completed callback must close queued connections");
    match closed {
        Ok(0) => (),
        Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => (),
        other => panic!("expected queued connection to close, got {other:?}"),
    }
    assert!(state.wait(id).await.is_err());
}

#[tokio::test]
async fn cancellation_unblocks_wait_and_stale_cancel_does_not_end_a_new_attempt() {
    let state = OAuthCallbackHost::default();
    let first = start(&state, options("/callback/legacy-nonce")).unwrap().id;
    assert!(start(&state, options("/callback/other")).is_err());
    let wait = state.wait(&first);
    let cancel = async {
        state.cancel(&first).unwrap();
    };
    let (result, ()) = tokio::join!(wait, cancel);
    assert_eq!(result, Err("Sign-in canceled.".into()));
    let attempt = start(&state, options("/callback/new-nonce")).unwrap();
    let second = attempt.id;
    assert_ne!(first, second);
    let url = url::Url::parse(&attempt.callback_url).unwrap();
    state.cancel(&first).unwrap();
    let target = format!("{}?code=next&state={}", url.path(), attempt.state);
    let (result, _) = tokio::join!(state.wait(&second), send(&url, &target, ""));
    assert_eq!(
        result,
        Ok(response(&[("code", "next"), ("state", &attempt.state)]))
    );
}

#[tokio::test(start_paused = true)]
async fn abandoned_listener_expires_and_can_be_replaced() {
    let state = OAuthCallbackHost::default();
    let id = start(&state, options("/oauth2redirect/provider"))
        .unwrap()
        .id;
    assert_eq!(
        state.wait(&id).await,
        Err("Sign-in timed out. Try again.".into())
    );
    let next = start(&state, options("/oauth2redirect/provider"))
        .unwrap()
        .id;
    state.cancel(&next).unwrap();
}

#[tokio::test]
async fn main_document_reload_cancels_wait_and_allows_new_sign_in() {
    use tauri::webview::PageLoadEvent::{Finished, Started};

    // Async Tauri commands queue startup, allowing reload cleanup to overtake it.
    let _: fn(_, _, _, _) -> Result<OAuthAttempt, String> =
        oauth_callback_begin::<tauri::test::MockRuntime>;
    let state = OAuthCallbackHost::default();
    let first = start(&state, options("/callback/old")).unwrap().id;
    for (label, event) in [("browser-content", Started), ("main", Finished)] {
        state.document_load(label, event).unwrap();
        assert_eq!(state.0.lock().unwrap().as_ref().unwrap().id, first);
    }
    let reload = async {
        state.document_load("main", Started).unwrap();
        let attempt = start(&state, options("/callback/new")).unwrap();
        let next = attempt.id;
        let url = url::Url::parse(&attempt.callback_url).unwrap();
        let target = format!("{}?code=new-login&state={}", url.path(), attempt.state);
        let (result, _) = tokio::join!(state.wait(&next), send(&url, &target, ""));
        assert_eq!(
            result,
            Ok(response(&[
                ("code", "new-login"),
                ("state", &attempt.state)
            ]))
        );
    };
    let (result, ()) = tokio::join!(biased; state.wait(&first), reload);
    assert_eq!(result, Err("Sign-in canceled.".into()));
}

#[test]
fn startup_rejects_unsafe_urls_and_conflicting_owned_parameters_before_launch() {
    let host = OAuthCallbackHost::default();
    let invalid = [
        OAuthRequest {
            authorization_url: "http://provider.example/authorize".into(),
            ..options("/callback")
        },
        OAuthRequest {
            authorization_url: "https://user:secret@provider.example/authorize".into(),
            ..options("/callback")
        },
        OAuthRequest {
            authorization_url: "https://provider.example/authorize#fragment".into(),
            ..options("/callback")
        },
        OAuthRequest {
            authorization_url: "not a URL".into(),
            ..options("/callback")
        },
        OAuthRequest {
            authorization_url: "https://provider.example/authorize?st%61te=caller".into(),
            ..options("/callback")
        },
        OAuthRequest {
            authorization_url: "https://provider.example/authorize?state=caller".into(),
            ..options("/callback")
        },
        OAuthRequest {
            authorization_url: "https://provider.example/authorize?redirect_uri=caller".into(),
            ..options("/callback")
        },
        OAuthRequest {
            authorization_url: "https://provider.example/authorize?redirect%5Furi=caller".into(),
            ..options("/callback")
        },
    ];
    for request in invalid {
        assert!(host
            .begin(request, |_| panic!("Invalid startup must not launch"))
            .is_err());
        assert!(host.0.lock().unwrap().is_none());
    }
}

#[tokio::test]
async fn native_state_validates_success_and_error_callbacks_and_prevents_replay() {
    let host = OAuthCallbackHost::default();
    let attempt = start(&host, options("/oauth2redirect/provider")).unwrap();
    let state = &attempt.state;
    assert_eq!(URL_SAFE_NO_PAD.decode(state).unwrap().len(), 32);
    assert_ne!(state, &attempt.id);
    let url = url::Url::parse(&attempt.callback_url).unwrap();
    assert!(!url.as_str().contains(state));
    for response in ["code=one", "error=access_denied"] {
        for suffix in [
            String::new(),
            "&state=wrong".into(),
            format!("&state={state}&state={state}"),
        ] {
            let html = send(&url, &format!("{}?{response}{suffix}", url.path()), "").await;
            assert!(html.starts_with("HTTP/1.1 400"));
            assert!(html.contains("Invalid callback"));
            assert!(!html.contains(state));
            assert!(!html.contains("access_denied"));
        }
    }
    let target = format!("{}?code=one&state={state}", url.path());
    let (result, html) = tokio::join!(host.wait(&attempt.id), send(&url, &target, ""));
    assert_eq!(result, Ok(response(&[("code", "one"), ("state", state)])));
    assert!(html.starts_with("HTTP/1.1 200"));
    let next = start(&host, options("/oauth2redirect/provider")).unwrap();
    let next_state = &next.state;
    assert_ne!(state, next_state);
    let next_url = url::Url::parse(&next.callback_url).unwrap();
    assert!(send(&next_url, &target, "")
        .await
        .starts_with("HTTP/1.1 400"));
    let next_target = format!(
        "{}?error=access_denied&state={next_state}&error_description=private+detail&error_uri=https%3A%2F%2Fprovider.example%2Fhelp",
        next_url.path()
    );
    let (result, html) = tokio::join!(host.wait(&next.id), send(&next_url, &next_target, ""));
    assert_eq!(
        result,
        Ok(response(&[
            ("error", "access_denied"),
            ("state", next_state),
            ("error_description", "private detail"),
            ("error_uri", "https://provider.example/help")
        ]))
    );
    assert!(html.starts_with("HTTP/1.1 400"));
    assert!(!html.contains("access_denied"));
    assert!(!html.contains(next_state));
    assert!(!html.contains("private detail"));
    assert!(!html.contains("provider.example/help"));
    assert!(host.0.lock().unwrap().is_none());
}

#[tokio::test]
async fn launch_failure_cleans_up_but_cannot_cancel_a_replacement_after_reload() {
    let host = OAuthCallbackHost::default();
    assert_eq!(
        host.begin(options("/callback"), |_| Err("private-launch-error".into())),
        Err("Could not open the sign-in browser".into())
    );
    assert!(host.0.lock().unwrap().is_none());
    let mut next = None;
    assert_eq!(
        host.begin(options("/callback"), |_| {
            host.document_load("main", tauri::webview::PageLoadEvent::Started)?;
            next = Some(start(&host, options("/callback"))?);
            Err("private-launch-error".into())
        }),
        Err("Could not open the sign-in browser".into())
    );
    let next = next.unwrap();
    assert_eq!(host.0.lock().unwrap().as_ref().unwrap().id, next.id);
    host.cancel(&next.id).unwrap();
}
