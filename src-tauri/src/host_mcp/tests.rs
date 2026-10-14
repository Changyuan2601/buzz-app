use super::*;
use tauri::ipc::InvokeResponseBody;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

fn channel() -> (
    Channel<McpEvent>,
    mpsc::UnboundedReceiver<serde_json::Value>,
) {
    let (sender, receiver) = mpsc::unbounded_channel();
    let channel = Channel::new(move |body| {
        if let InvokeResponseBody::Json(json) = body {
            let _ = sender.send(serde_json::from_str(&json).unwrap());
        }
        Ok(())
    });
    (channel, receiver)
}

async fn next(events: &mut mpsc::UnboundedReceiver<serde_json::Value>) -> serde_json::Value {
    tokio::time::timeout(Duration::from_secs(5), events.recv())
        .await
        .expect("MCP event")
        .expect("open channel")
}

/// The `host:port` of `info`'s server.
fn authority(info: &McpServerInfo) -> &str {
    info.url
        .trim_start_matches("http://")
        .trim_end_matches(ENDPOINT)
}

/// Sends a raw request to `info`'s server and returns the whole response.
async fn send(info: &McpServerInfo, request: String) -> String {
    let authority = authority(info);
    let mut socket = TcpStream::connect(authority).await.unwrap();
    socket.write_all(request.as_bytes()).await.unwrap();
    let mut response = String::new();
    socket.read_to_string(&mut response).await.unwrap();
    response
}

fn post(info: &McpServerInfo, token: &str, extra: &str, body: &str) -> String {
    let authority = authority(info);
    format!(
        "POST /mcp HTTP/1.1\r\nHost: {authority}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\n{extra}Content-Length: {}\r\n\r\n{body}",
        body.len()
    )
}

fn status(response: &str) -> &str {
    response.split(' ').nth(1).unwrap_or_default()
}

#[tokio::test]
async fn answers_a_request_with_the_page_reply() {
    let servers = HostMcpServers::default();
    let (channel, mut events) = channel();
    let info = servers
        .serve(servers.page(), "plugin".into(), channel)
        .unwrap();
    assert!(info.url.starts_with("http://127.0.0.1:"));
    let request = post(
        &info,
        &info.token,
        "",
        r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#,
    );
    let client = tokio::spawn({
        let info = info.clone();
        async move { send(&info, request).await }
    });
    let event = next(&mut events).await;
    assert_eq!(event["type"], "message");
    assert_eq!(
        event["body"],
        r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#
    );
    let reply = r#"{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}"#;
    // Another plugin cannot answer it.
    assert!(servers
        .reply(
            "other",
            info.handle,
            event["request"].as_u64().unwrap(),
            Some(reply.into())
        )
        .is_err());
    servers
        .reply(
            "plugin",
            info.handle,
            event["request"].as_u64().unwrap(),
            Some(reply.into()),
        )
        .unwrap();
    let response = client.await.unwrap();
    assert_eq!(status(&response), "200");
    assert!(response
        .to_ascii_lowercase()
        .contains("content-type: application/json\r\n"));
    assert!(response.ends_with(reply));
}

#[tokio::test]
async fn accepts_a_notification_without_a_body() {
    let servers = HostMcpServers::default();
    let (channel, mut events) = channel();
    let info = servers
        .serve(servers.page(), "plugin".into(), channel)
        .unwrap();
    let request = post(
        &info,
        &info.token,
        "",
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
    );
    let client = tokio::spawn({
        let info = info.clone();
        async move { send(&info, request).await }
    });
    let event = next(&mut events).await;
    servers
        .reply(
            "plugin",
            info.handle,
            event["request"].as_u64().unwrap(),
            None,
        )
        .unwrap();
    assert_eq!(status(&client.await.unwrap()), "202");
}

#[tokio::test]
async fn refuses_without_starting_oauth() {
    let servers = HostMcpServers::default();
    let (channel, mut events) = channel();
    let info = servers
        .serve(servers.page(), "plugin".into(), channel)
        .unwrap();
    let body = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
    // A wrong token and a web page are both told there is nothing here.
    for request in [
        post(&info, "wrong", "", body),
        post(&info, &info.token, "Origin: https://example.test\r\n", body),
    ] {
        assert_eq!(status(&send(&info, request).await), "404");
    }
    let authority = authority(&info);
    let get = format!(
        "GET /mcp HTTP/1.1\r\nHost: {authority}\r\nAuthorization: Bearer {}\r\nAccept: text/event-stream\r\n\r\n",
        info.token
    );
    assert_eq!(status(&send(&info, get).await), "405");
    assert!(events.try_recv().is_err());
}

#[tokio::test]
async fn stops_with_the_page() {
    let servers = HostMcpServers::default();
    let (events_channel, mut events) = channel();
    let page = servers.page();
    let info = servers
        .serve(page, "plugin".into(), events_channel)
        .unwrap();
    let request = post(
        &info,
        &info.token,
        "",
        r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#,
    );
    let client = tokio::spawn({
        let info = info.clone();
        async move { send(&info, request).await }
    });
    assert_eq!(next(&mut events).await["type"], "message");
    servers.stop_all();
    assert_eq!(next(&mut events).await["type"], "closed");
    // The request waiting on the page is dropped, not left hanging.
    assert!(!client.await.unwrap().contains("200 OK"));
    assert!(servers.reply("plugin", info.handle, 0, None).is_err());
    let (late, _events) = channel();
    assert!(servers.serve(page, "plugin".into(), late).is_err());
}
