use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use buzzodz_plugins::HostGrants;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};

use crate::{with_manager, PluginManager};

const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_HEADER_BYTES: usize = 8192;
const MAX_RESPONSE_HEADER_BYTES: usize = 16 * 1024;
const DEADLINE: Duration = Duration::from_secs(30);
/// A streamed body may pause this long between chunks, and run this long in total.
const STREAM_IDLE: Duration = Duration::from_secs(60);
const STREAM_DEADLINE: Duration = Duration::from_secs(600);
const MAX_STREAMS: usize = 16;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostRequest {
    url: String,
    #[serde(default = "default_method")]
    method: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    body: Option<String>,
}

fn default_method() -> String {
    "GET".into()
}

#[derive(Serialize)]
pub(crate) struct HostResponse {
    status: u16,
    headers: BTreeMap<String, String>,
    body: String,
}

#[tauri::command]
pub(crate) async fn plugin_host_request(
    manager: tauri::State<'_, PluginManager>,
    id: String,
    revision: String,
    request: HostRequest,
) -> Result<HostResponse, String> {
    let (url, method, headers) = validate_request(&request)?;
    let operation = async {
        let grants = with_manager(manager, move |manager| manager.host_grants(&id, &revision))
            .await
            .map_err(|_| "Host request is unavailable")?;
        if !allows_origin(&grants, &url) {
            return Err("Host request origin is not declared".into());
        }
        send_request(url, method, headers, request.body).await
    };
    tokio::time::timeout(DEADLINE, operation)
        .await
        .map_err(|_| "Host request timed out")?
}

/// Status and headers of a streamed response. The body follows as `FetchEvent`s.
#[derive(Debug, Serialize)]
pub(crate) struct FetchHead {
    status: u16,
    headers: BTreeMap<String, String>,
}
/// Decoded UTF-8 body text in arrival order, then exactly one `End` or `Error`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub(crate) enum FetchEvent {
    Chunk { text: String },
    End,
    Error { message: String },
}
/// Streams a plugin may still cancel, keyed by the caller's stream id.
#[derive(Clone, Default)]
pub(crate) struct HostStreams(Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>>);
impl HostStreams {
    fn open(&self, id: &str) -> Result<tokio::sync::oneshot::Receiver<()>, String> {
        let mut streams = self.0.lock().map_err(|_| "Host request is unavailable")?;
        if id.is_empty() || id.len() > 64 || streams.contains_key(id) {
            return Err("Invalid host stream".into());
        }
        if streams.len() >= MAX_STREAMS {
            return Err("Too many open host streams".into());
        }
        let (cancel, cancelled) = tokio::sync::oneshot::channel();
        streams.insert(id.into(), cancel);
        Ok(cancelled)
    }
    fn close(&self, id: &str) -> Option<tokio::sync::oneshot::Sender<()>> {
        self.0.lock().ok()?.remove(id)
    }
}

/// `plugin_host_request` with a streamed body: resolves once the response headers
/// arrive, then delivers the body over `on_event` until it ends, fails, exceeds the
/// same size bound, or the plugin cancels `stream_id`.
#[tauri::command]
pub(crate) async fn plugin_host_fetch(
    manager: tauri::State<'_, PluginManager>,
    streams: tauri::State<'_, HostStreams>,
    id: String,
    revision: String,
    stream_id: String,
    request: HostRequest,
    on_event: tauri::ipc::Channel<FetchEvent>,
) -> Result<FetchHead, String> {
    let (url, method, headers) = validate_request(&request)?;
    let streams = streams.inner().clone();
    let mut cancelled = streams.open(&stream_id)?;
    let operation = async {
        let grants = with_manager(manager, move |manager| manager.host_grants(&id, &revision))
            .await
            .map_err(|_| "Host request is unavailable")?;
        if !allows_origin(&grants, &url) {
            return Err("Host request origin is not declared".into());
        }
        let mut outgoing = client(None)?.request(method, url).headers(headers);
        if let Some(body) = request.body {
            outgoing = outgoing.body(body);
        }
        let response = outgoing.send().await.map_err(|_| "Host request failed")?;
        let head = FetchHead {
            status: response.status().as_u16(),
            headers: response_headers(&response)?,
        };
        Ok::<_, String>((head, response))
    };
    let opened = tokio::select! {
        opened = tokio::time::timeout(DEADLINE, operation) => {
            opened.unwrap_or_else(|_| Err("Host request timed out".into()))
        }
        _ = &mut cancelled => Err("Host request was cancelled".into()),
    };
    let (head, response) = match opened {
        Ok(opened) => opened,
        Err(error) => {
            streams.close(&stream_id);
            return Err(error);
        }
    };
    tauri::async_runtime::spawn(async move {
        pump(response, cancelled, |event| on_event.send(event).is_ok()).await;
        streams.close(&stream_id);
    });
    Ok(head)
}

/// Stops a stream opened by `plugin_host_fetch`. Unknown and finished ids are ignored.
#[tauri::command]
pub(crate) fn plugin_host_fetch_cancel(streams: tauri::State<'_, HostStreams>, stream_id: String) {
    if let Some(cancel) = streams.close(&stream_id) {
        let _ = cancel.send(());
    }
}

/// Forwards the body as text. Stops silently on cancel or when nothing is listening.
async fn pump(
    mut response: reqwest::Response,
    mut cancelled: tokio::sync::oneshot::Receiver<()>,
    emit: impl Fn(FetchEvent) -> bool,
) {
    let body = async {
        let mut pending = Vec::new();
        let mut total = 0;
        loop {
            let chunk = tokio::time::timeout(STREAM_IDLE, response.chunk())
                .await
                .map_err(|_| "Host response stalled")?
                .map_err(|_| "Host response failed")?;
            let Some(chunk) = chunk else {
                return if pending.is_empty() {
                    Ok(true)
                } else {
                    Err("Host response is not UTF-8")
                };
            };
            total += chunk.len();
            if total > MAX_RESPONSE_BYTES {
                return Err("Host response is too large");
            }
            let text = decode(&mut pending, &chunk)?;
            if !text.is_empty() && !emit(FetchEvent::Chunk { text }) {
                return Ok(false);
            }
        }
    };
    let finished = tokio::select! {
        finished = tokio::time::timeout(STREAM_DEADLINE, body) => {
            finished.unwrap_or(Err("Host response timed out"))
        }
        _ = &mut cancelled => return,
    };
    match finished {
        Ok(true) => emit(FetchEvent::End),
        Ok(false) => false,
        Err(message) => emit(FetchEvent::Error {
            message: message.into(),
        }),
    };
}

/// Appends `chunk` and takes the longest valid UTF-8 prefix, keeping a character
/// split across chunks for the next call.
fn decode(pending: &mut Vec<u8>, chunk: &[u8]) -> Result<String, &'static str> {
    pending.extend_from_slice(chunk);
    let valid = match std::str::from_utf8(pending) {
        Ok(_) => pending.len(),
        Err(error) if error.error_len().is_none() => error.valid_up_to(),
        Err(_) => return Err("Host response is not UTF-8"),
    };
    let rest = pending.split_off(valid);
    Ok(String::from_utf8(std::mem::replace(pending, rest)).unwrap_or_default())
}

fn allows_origin(grants: &HostGrants, url: &reqwest::Url) -> bool {
    grants
        .network_origins
        .contains(&url.origin().ascii_serialization())
}

fn validate_request(
    request: &HostRequest,
) -> Result<(reqwest::Url, reqwest::Method, HeaderMap), String> {
    if request.url.len() > 2048 {
        return Err("Invalid host request URL".into());
    }
    let url = reqwest::Url::parse(&request.url).map_err(|_| "Invalid host request URL")?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err("Host requests require HTTPS without URL credentials".into());
    }
    let method = match request.method.as_str() {
        "GET" => reqwest::Method::GET,
        "HEAD" => reqwest::Method::HEAD,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        _ => return Err("Invalid host request method".into()),
    };
    if request
        .body
        .as_ref()
        .is_some_and(|body| body.len() > MAX_REQUEST_BYTES)
    {
        return Err("Host request body is too large".into());
    }
    if request.headers.len() > 32
        || request
            .headers
            .iter()
            .map(|(name, value)| name.len() + value.len())
            .sum::<usize>()
            > MAX_HEADER_BYTES
    {
        return Err("Host request headers are too large".into());
    }
    let mut headers = HeaderMap::new();
    for (name, value) in &request.headers {
        let name =
            HeaderName::from_bytes(name.as_bytes()).map_err(|_| "Invalid host request header")?;
        if matches!(
            name.as_str(),
            "host"
                | "cookie"
                | "proxy-authorization"
                | "proxy-authenticate"
                | "proxy-connection"
                | "connection"
                | "keep-alive"
                | "te"
                | "trailer"
                | "transfer-encoding"
                | "upgrade"
                | "content-length"
        ) {
            return Err("Host request header is not allowed".into());
        }
        let value = HeaderValue::from_str(value).map_err(|_| "Invalid host request header")?;
        headers.insert(name, value);
    }
    Ok((url, method, headers))
}

/// No redirects. A buffered request bounds the whole exchange; a stream bounds its
/// own phases instead.
fn client(deadline: Option<Duration>) -> Result<reqwest::Client, String> {
    let builder = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none());
    match deadline {
        Some(deadline) => builder.timeout(deadline),
        None => builder.connect_timeout(DEADLINE),
    }
    .build()
    .map_err(|_| "Host request client is unavailable".into())
}

fn response_headers(response: &reqwest::Response) -> Result<BTreeMap<String, String>, String> {
    let mut headers = BTreeMap::new();
    let mut header_bytes = 0;
    let mut header_count = 0;
    for (name, value) in response.headers() {
        if name.as_str() == "set-cookie" {
            continue;
        }
        let Ok(value) = value.to_str() else {
            continue;
        };
        header_count += 1;
        header_bytes += name.as_str().len() + value.len();
        if header_count > 64 || header_bytes > MAX_RESPONSE_HEADER_BYTES {
            return Err("Host response headers are too large".into());
        }
        headers.insert(name.to_string(), value.to_owned());
    }
    Ok(headers)
}

async fn send_request(
    url: reqwest::Url,
    method: reqwest::Method,
    headers: HeaderMap,
    body: Option<String>,
) -> Result<HostResponse, String> {
    let mut request = client(Some(DEADLINE))?
        .request(method, url)
        .headers(headers);
    if let Some(body) = body {
        request = request.body(body);
    }
    let mut response = request.send().await.map_err(|_| "Host request failed")?;
    let status = response.status().as_u16();
    let headers = response_headers(&response)?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Host response failed")? {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err("Host response is too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = String::from_utf8(bytes).map_err(|_| "Host response is not UTF-8")?;
    Ok(HostResponse {
        status,
        headers,
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn local_response(response: Vec<u8>) -> (reqwest::Url, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = [0u8; 1024];
            let count = socket.read(&mut request).unwrap();
            assert!(request[..count].starts_with(b"POST /graphql HTTP/1.1"));
            let _ = socket.write_all(&response);
        });
        (
            reqwest::Url::parse(&format!("http://{address}/graphql")).unwrap(),
            server,
        )
    }

    fn request(url: &str) -> HostRequest {
        HostRequest {
            url: url.into(),
            method: "POST".into(),
            headers: BTreeMap::new(),
            body: Some("{}".into()),
        }
    }

    #[test]
    fn validates_https_url_and_bounds() {
        assert!(validate_request(&request("https://api.example.test/graphql")).is_ok());
        assert!(validate_request(&request("http://api.example.test/graphql")).is_err());
        assert!(validate_request(&request("https://user:pass@api.example.test/")).is_err());
        let mut large = request("https://api.example.test/");
        large.body = Some("x".repeat(MAX_REQUEST_BYTES + 1));
        assert!(validate_request(&large).is_err());
    }

    #[test]
    fn rejects_cookie_and_routing_headers() {
        for name in [
            "Host",
            "Cookie",
            "Proxy-Authorization",
            "Proxy-Connection",
            "Connection",
            "Transfer-Encoding",
        ] {
            let mut input = request("https://api.example.test/");
            input.headers.insert(name.into(), "private".into());
            assert!(validate_request(&input).is_err(), "{name}");
        }
    }

    #[test]
    fn matches_only_the_declared_origin() {
        let grants = HostGrants {
            commands: vec![],
            network_origins: vec!["https://api.example.test".into()],
            ..HostGrants::default()
        };
        for url in [
            "https://api.example.test/",
            "https://api.example.test/graphql",
        ] {
            assert!(allows_origin(&grants, &reqwest::Url::parse(url).unwrap()));
        }
        for url in [
            "https://sub.api.example.test/",
            "https://api.example.test:8443/",
        ] {
            assert!(!allows_origin(&grants, &reqwest::Url::parse(url).unwrap()));
        }
    }

    #[test]
    fn bundled_builderlab_uses_native_grants_for_exact_request_origins() {
        let temp = tempfile::tempdir().unwrap();
        let manager =
            buzzodz_plugins::Manager::open(Some(temp.path().into()), "test", false).unwrap();
        let grants = manager.host_grants("block.builderlab", "bundled").unwrap();
        let origin = grants
            .network_origins
            .first()
            .map(String::as_str)
            .unwrap_or("https://app.builderlab.xyz");
        let (url, _, _) = validate_request(&request(&format!(
            "{origin}/api/goose/v1/auth/login/exchange"
        )))
        .unwrap();
        assert_eq!(
            allows_origin(&grants, &url),
            !grants.network_origins.is_empty()
        );
        let mut other = url;
        other
            .set_port(Some(if other.port() == Some(8443) {
                9443
            } else {
                8443
            }))
            .unwrap();
        let (url, _, _) = validate_request(&request(other.as_str())).unwrap();
        assert!(!allows_origin(&grants, &url));
    }

    #[test]
    fn bundled_hosted_communities_reach_only_the_builderlab_origin() {
        let temp = tempfile::tempdir().unwrap();
        let manager =
            buzzodz_plugins::Manager::open(Some(temp.path().into()), "test", false).unwrap();
        let grants = manager
            .host_grants("block.hosted-communities", "bundled")
            .unwrap();
        assert_eq!(grants.network_origins, ["https://app.builderlab.xyz"]);
        assert!(grants.commands.is_empty());
        for (url, allowed) in [
            ("https://app.builderlab.xyz/api/goose/v1/auth/me", true),
            ("https://builderlab.xyz/api/goose/v1/auth/me", false),
            (
                "https://app.builderlab.xyz:8443/api/goose/v1/auth/me",
                false,
            ),
        ] {
            let (url, _, _) = validate_request(&request(url)).unwrap();
            assert_eq!(allows_origin(&grants, &url), allowed, "{url}");
        }
    }

    #[test]
    fn stream_text_keeps_a_character_split_across_chunks() {
        let mut pending = Vec::new();
        let bytes = "aé".as_bytes();
        assert_eq!(decode(&mut pending, &bytes[..2]).unwrap(), "a");
        assert_eq!(decode(&mut pending, &bytes[2..]).unwrap(), "é");
        assert!(pending.is_empty());
        assert!(decode(&mut pending, &[0xff]).is_err());
    }

    #[test]
    fn stream_ids_are_unique_bounded_and_released() {
        let streams = HostStreams::default();
        let _first = streams.open("a").unwrap();
        assert!(streams.open("a").is_err());
        assert!(streams.open("").is_err());
        for index in 1..MAX_STREAMS {
            std::mem::forget(streams.open(&index.to_string()).unwrap());
        }
        assert_eq!(
            streams.open("extra").err().as_deref(),
            Some("Too many open host streams")
        );
        assert!(streams.close("a").is_some());
        assert!(streams.close("a").is_none());
        assert!(streams.open("extra").is_ok());
    }

    async fn pumped(
        response: Vec<u8>,
        cancelled: tokio::sync::oneshot::Receiver<()>,
    ) -> Vec<FetchEvent> {
        let (url, server) = local_response(response);
        let response = client(None)
            .unwrap()
            .post(url)
            .body("{}")
            .send()
            .await
            .unwrap();
        let events = std::sync::Mutex::new(Vec::new());
        pump(response, cancelled, |event| {
            events.lock().unwrap().push(event);
            true
        })
        .await;
        server.join().unwrap();
        events.into_inner().unwrap()
    }

    #[tokio::test]
    async fn stream_delivers_the_body_in_order_then_ends() {
        let (_cancel, cancelled) = tokio::sync::oneshot::channel();
        let events = pumped(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n8\r\ndata: a\n\r\n8\r\ndata: b\n\r\n0\r\n\r\n".to_vec(),
            cancelled,
        )
        .await;
        assert_eq!(events.last(), Some(&FetchEvent::End));
        let text: String = events
            .iter()
            .filter_map(|event| match event {
                FetchEvent::Chunk { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(text, "data: a\ndata: b\n");
        assert_eq!(
            events
                .iter()
                .filter(|event| !matches!(event, FetchEvent::Chunk { .. }))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn stream_reports_a_truncated_or_non_text_body_as_an_error() {
        let (_cancel, cancelled) = tokio::sync::oneshot::channel();
        let events = pumped(
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\na\xc3".to_vec(),
            cancelled,
        )
        .await;
        assert_eq!(
            events,
            [
                FetchEvent::Chunk { text: "a".into() },
                FetchEvent::Error {
                    message: "Host response is not UTF-8".into()
                }
            ]
        );
    }

    #[tokio::test]
    async fn cancelled_stream_stops_without_a_terminal_event() {
        let (cancel, cancelled) = tokio::sync::oneshot::channel();
        cancel.send(()).unwrap();
        // The body is never finished: only cancellation lets the pump return.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n")
                .unwrap();
            // Hold the connection open until the client goes away.
            let _ = socket.read(&mut request);
        });
        let response = client(None).unwrap().get(url).send().await.unwrap();
        let events = std::sync::Mutex::new(Vec::new());
        pump(response, cancelled, |event| {
            events.lock().unwrap().push(event);
            true
        })
        .await;
        // Joining inline would block the runtime that has to close the connection.
        tokio::task::spawn_blocking(move || server.join().unwrap())
            .await
            .unwrap();
        assert!(events.into_inner().unwrap().is_empty());
    }

    #[tokio::test]
    async fn request_transport_does_not_follow_redirects_or_return_cookies() {
        // The handler rejects HTTP; loopback HTTP exercises the transport without external data.
        let (url, server) = local_response(
            b"HTTP/1.1 302 Found\r\nLocation: https://outside.example/\r\nSet-Cookie: secret=value\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_vec(),
        );
        let response = send_request(
            url,
            reqwest::Method::POST,
            HeaderMap::new(),
            Some("{}".into()),
        )
        .await
        .unwrap();
        server.join().unwrap();
        assert_eq!(response.status, 302);
        assert_eq!(response.body, "{}");
        assert_eq!(
            response.headers.get("location").unwrap(),
            "https://outside.example/"
        );
        assert!(!response.headers.contains_key("set-cookie"));
    }

    #[tokio::test]
    async fn request_transport_rejects_oversized_responses() {
        let body = vec![b'x'; MAX_RESPONSE_BYTES + 1];
        let mut response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        response.extend(body);
        let (url, server) = local_response(response);
        let result = send_request(url, reqwest::Method::POST, HeaderMap::new(), None).await;
        server.join().unwrap();
        assert_eq!(result.err().as_deref(), Some("Host response is too large"));
    }

    #[tokio::test]
    async fn request_transport_bounds_returned_headers() {
        let mut response = b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n".to_vec();
        for index in 0..65 {
            response.extend(format!("x-example-{index}: value\r\n").as_bytes());
        }
        response.extend(b"\r\n");
        let (url, server) = local_response(response);
        let result = send_request(url, reqwest::Method::POST, HeaderMap::new(), None).await;
        server.join().unwrap();
        assert_eq!(
            result.err().as_deref(),
            Some("Host response headers are too large")
        );
    }
}
