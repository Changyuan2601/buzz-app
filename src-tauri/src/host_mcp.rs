//! Loopback MCP servers a plugin serves to the agents it runs, over MCP's
//! Streamable HTTP transport. The listener and its token live here; each
//! JSON-RPC message is handed to the page that started the server, which
//! answers it. So a tool that signs with an agent's key runs in the app, and
//! the agent is given only the server's address and token.
//!
//! - It binds only `127.0.0.1`, on a port the OS picks. A random 256-bit token
//!   per server authorizes every request as `Authorization: Bearer <token>`.
//!   `Host` must name the bound address, and a request that sends `Origin`
//!   (a web page) is refused. Nothing is logged.
//! - A refused request gets 404, never 401 or 403: MCP clients answer those
//!   by starting an OAuth sign-in.
//! - It is stateless and answers in JSON, never SSE. `POST /mcp` carries one
//!   message: a request is answered with the page's reply, and a notification
//!   or response with 202. `GET` and `DELETE` get 405, since there is no
//!   server stream or session to end.
//! - Each connection answers one request and closes. A client that closes
//!   before its answer drops the request; the page's late reply is refused.
//! - A server belongs to the plugin and the page that started it. It stops
//!   when the plugin closes it, when the page reloads, or when the app exits.
use crate::{with_manager, PluginManager};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::header::{self, HeaderName};
use hyper::{server::conn::http1, service::service_fn, Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::Serialize;
use std::collections::HashMap;
use std::convert::Infallible;
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;
use tauri::ipc::Channel;
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Semaphore};
use tokio_util::sync::CancellationToken;

/// Servers running at once across all plugins.
const MAX_SERVERS: usize = 64;
/// Open connections per server: an agent may call several tools at once.
const CONNECTIONS: usize = 32;
/// hyper's smallest read buffer, which bounds a request head.
const HEAD_LIMIT: usize = 8192;
const HEAD_TIMEOUT: Duration = Duration::from_secs(5);
const BODY_LIMIT: usize = 4 * 1024 * 1024;
const BODY_TIMEOUT: Duration = Duration::from_secs(30);
const REPLY_LIMIT: usize = 16 * 1024 * 1024;
const ENDPOINT: &str = "/mcp";

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum McpEvent {
    /// One JSON-RPC message, answered with `plugin_host_mcp_reply` naming
    /// `request`.
    Message { request: u64, body: String },
    /// The last event: the server stopped.
    Closed,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpServerInfo {
    handle: u64,
    /// `http://127.0.0.1:<port>/mcp`
    url: String,
    /// Sent by the agent as `Authorization: Bearer <token>`.
    token: String,
}

struct Shared {
    authority: String,
    token: String,
    events: Channel<McpEvent>,
    stop: CancellationToken,
    pending: Mutex<Pending>,
}
#[derive(Default)]
struct Pending {
    next: u64,
    replies: HashMap<u64, oneshot::Sender<Option<String>>>,
}
impl Shared {
    fn pending(&self) -> MutexGuard<'_, Pending> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

struct Entry {
    plugin: String,
    shared: Arc<Shared>,
}

#[derive(Clone, Default)]
pub(crate) struct HostMcpServers {
    inner: Arc<Mutex<Registry>>,
}
#[derive(Default)]
struct Registry {
    next: u64,
    /// Counts page loads, so a server the page asked for before it reloaded
    /// is refused rather than left running with nobody answering.
    page: u64,
    entries: HashMap<u64, Entry>,
}
impl HostMcpServers {
    fn registry(&self) -> MutexGuard<'_, Registry> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
    fn owned(&self, plugin: &str, handle: u64) -> Result<Arc<Shared>, String> {
        match self.registry().entries.get(&handle) {
            Some(entry) if entry.plugin == plugin => Ok(entry.shared.clone()),
            _ => Err("No such MCP server".into()),
        }
    }
    /// The current page load, for `serve`.
    pub(crate) fn page(&self) -> u64 {
        self.registry().page
    }
    /// Starts a server owned by `plugin` whose messages go to `events`, unless
    /// the page that asked during `page` has since gone.
    fn serve(
        &self,
        page: u64,
        plugin: String,
        events: Channel<McpEvent>,
    ) -> Result<McpServerInfo, String> {
        let mut registry = self.registry();
        if registry.page != page {
            return Err("The page reloaded".into());
        }
        if registry.entries.len() >= MAX_SERVERS {
            return Err("Too many MCP servers are running".into());
        }
        let failed = |_| "Could not start the MCP server".to_owned();
        // Bound synchronously, so the address is known before any agent connects.
        let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(failed)?;
        listener.set_nonblocking(true).map_err(failed)?;
        let authority = listener.local_addr().map_err(failed)?.to_string();
        let mut secret = [0; 32];
        getrandom::fill(&mut secret).map_err(|_| "Could not start the MCP server")?;
        let token = URL_SAFE_NO_PAD.encode(secret);
        let shared = Arc::new(Shared {
            authority: authority.clone(),
            token: token.clone(),
            events,
            stop: CancellationToken::new(),
            pending: Mutex::default(),
        });
        let handle = registry.next;
        registry.next += 1;
        registry.entries.insert(
            handle,
            Entry {
                plugin,
                shared: shared.clone(),
            },
        );
        drop(registry);
        let state = self.clone();
        tauri::async_runtime::spawn(async move {
            accept(listener, shared.clone()).await;
            state.registry().entries.remove(&handle);
            // Requests still waiting are answered 503 as their senders drop.
            shared.pending().replies.clear();
            let _ = shared.events.send(McpEvent::Closed);
        });
        Ok(McpServerInfo {
            handle,
            url: format!("http://{authority}{ENDPOINT}"),
            token,
        })
    }
    /// Answers `request` with `body`, or with 202 when there is none.
    fn reply(
        &self,
        plugin: &str,
        handle: u64,
        request: u64,
        body: Option<String>,
    ) -> Result<(), String> {
        if body.as_ref().is_some_and(|body| body.len() > REPLY_LIMIT) {
            return Err("Reply is too large".into());
        }
        let shared = self.owned(plugin, handle)?;
        let sender = shared.pending().replies.remove(&request);
        sender
            .ok_or("The request is no longer waiting")?
            .send(body)
            .map_err(|_| "The request is no longer waiting".into())
    }
    fn close(&self, plugin: &str, handle: u64) -> Result<(), String> {
        self.owned(plugin, handle)?.stop.cancel();
        Ok(())
    }
    /// Stops every server: the page that answered them is gone.
    pub(crate) fn stop_all(&self) {
        let mut registry = self.registry();
        registry.page += 1;
        for entry in registry.entries.values() {
            entry.shared.stop.cancel();
        }
    }
}

async fn accept(listener: std::net::TcpListener, shared: Arc<Shared>) {
    let Ok(listener) = TcpListener::from_std(listener) else {
        return;
    };
    let connections = Arc::new(Semaphore::new(CONNECTIONS));
    loop {
        let accepted = tokio::select! {
            accepted = async {
                let permit = connections.clone().acquire_owned().await.ok()?;
                Some((permit, listener.accept().await))
            } => accepted,
            () = shared.stop.cancelled() => return,
        };
        let Some((permit, accepted)) = accepted else {
            return;
        };
        let Ok((socket, _)) = accepted else {
            drop(permit);
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        };
        let shared = shared.clone();
        tauri::async_runtime::spawn(async move {
            let shared = &*shared;
            // One request per connection. hyper drops a request whose client
            // closes before its answer, so the page's late reply is refused.
            let connection = http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(HEAD_TIMEOUT)
                .max_buf_size(HEAD_LIMIT)
                .keep_alive(false)
                .serve_connection(
                    TokioIo::new(socket),
                    service_fn(move |request| answer(shared, request)),
                );
            tokio::select! {
                _ = connection => {}
                () = shared.stop.cancelled() => {}
            }
            drop(permit);
        });
    }
}

async fn answer(
    shared: &Shared,
    request: Request<Incoming>,
) -> Result<Response<Full<Bytes>>, Infallible> {
    let (status, body) = match refuse(shared, &request) {
        Some(status) => (status, None),
        None => {
            let body = Limited::new(request.into_body(), BODY_LIMIT).collect();
            match tokio::time::timeout(BODY_TIMEOUT, body).await {
                Ok(Ok(body)) => match String::from_utf8(body.to_bytes().into()) {
                    Ok(body) => forward(shared, body).await,
                    Err(_) => (StatusCode::BAD_REQUEST, None),
                },
                _ => (StatusCode::BAD_REQUEST, None),
            }
        }
    };
    let mut response = Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store");
    if status == StatusCode::OK {
        response = response.header(header::CONTENT_TYPE, "application/json");
    }
    if status == StatusCode::METHOD_NOT_ALLOWED {
        response = response.header(header::ALLOW, "POST");
    }
    Ok(response
        .body(Full::new(body.unwrap_or_default().into()))
        .unwrap_or_default())
}

/// Hands `body` to the page and waits for its answer.
async fn forward(shared: &Shared, body: String) -> (StatusCode, Option<String>) {
    struct Waiting<'a>(&'a Shared, u64);
    impl Drop for Waiting<'_> {
        fn drop(&mut self) {
            self.0.pending().replies.remove(&self.1);
        }
    }
    let (sender, receiver) = oneshot::channel();
    let request = {
        let mut pending = shared.pending();
        let request = pending.next;
        pending.next += 1;
        pending.replies.insert(request, sender);
        request
    };
    let _waiting = Waiting(shared, request);
    if shared
        .events
        .send(McpEvent::Message { request, body })
        .is_err()
    {
        // Nobody is listening: the page that started it is gone.
        shared.stop.cancel();
        return (StatusCode::SERVICE_UNAVAILABLE, None);
    }
    match receiver.await {
        Ok(Some(reply)) => (StatusCode::OK, Some(reply)),
        Ok(None) => (StatusCode::ACCEPTED, None),
        Err(_) => (StatusCode::SERVICE_UNAVAILABLE, None),
    }
}

/// The status that refuses `request`, unless it is an authorized `POST /mcp`.
fn refuse(shared: &Shared, request: &Request<Incoming>) -> Option<StatusCode> {
    let token = header(request, header::AUTHORIZATION)
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default();
    if header(request, header::HOST) != Some(shared.authority.as_str())
        // An agent never sends one; a web page always does.
        || request.headers().contains_key(header::ORIGIN)
        || request.uri().path() != ENDPOINT
        || !same(token.as_bytes(), shared.token.as_bytes())
    {
        return Some(StatusCode::NOT_FOUND);
    }
    // No server stream for `GET` and no session for `DELETE` to end.
    if request.method() != Method::POST {
        return Some(StatusCode::METHOD_NOT_ALLOWED);
    }
    let json = header(request, header::CONTENT_TYPE)
        .and_then(|value| value.split(';').next())
        .is_some_and(|kind| kind.trim().eq_ignore_ascii_case("application/json"));
    if !json {
        return Some(StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }
    let length = header(request, header::CONTENT_LENGTH).and_then(|value| value.parse().ok());
    if length.is_some_and(|length: usize| length > BODY_LIMIT) {
        return Some(StatusCode::PAYLOAD_TOO_LARGE);
    }
    None
}

fn header(request: &Request<Incoming>, name: HeaderName) -> Option<&str> {
    request.headers().get(name)?.to_str().ok()
}

/// Compares the token without exposing how much of it matched.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0, |diff, (x, y)| diff | (x ^ y)) == 0
}

/// Starts a loopback MCP server for a plugin that declares `host.mcp`. Each
/// message arrives on `on_event` and is answered with `plugin_host_mcp_reply`.
#[tauri::command]
pub(crate) async fn plugin_host_mcp_serve(
    manager: tauri::State<'_, PluginManager>,
    servers: tauri::State<'_, HostMcpServers>,
    id: String,
    revision: String,
    on_event: Channel<McpEvent>,
) -> Result<McpServerInfo, String> {
    let page = servers.page();
    let plugin = id.clone();
    let granted = with_manager(manager, move |manager| {
        Ok(manager.host_grants(&id, &revision)?.mcp)
    })
    .await?;
    if !granted {
        return Err("MCP servers are not declared".into());
    }
    servers.serve(page, plugin, on_event)
}

/// Answers a message with the JSON-RPC `body`; without one, with 202.
#[tauri::command]
pub(crate) fn plugin_host_mcp_reply(
    servers: tauri::State<'_, HostMcpServers>,
    id: String,
    handle: u64,
    request: u64,
    body: Option<String>,
) -> Result<(), String> {
    servers.reply(&id, handle, request, body)
}

/// Stops the server. Its `closed` event follows.
#[tauri::command]
pub(crate) fn plugin_host_mcp_close(
    servers: tauri::State<'_, HostMcpServers>,
    id: String,
    handle: u64,
) -> Result<(), String> {
    servers.close(&id, handle)
}

#[cfg(test)]
mod tests;
