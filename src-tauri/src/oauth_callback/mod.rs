//! Browser sign-in startup and loopback OAuth authorization-code responses.
//! RFC 8252 §§7.3, 8.3, 8.4, 8.9; RFC 6749 §§4.1.2, 4.1.2.1; RFC 9700 §2.1.
//! See this folder's README.md for the command contract, ownership, and limits.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use std::{sync::Mutex, time::Duration};
use tauri_plugin_opener::OpenerExt;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::oneshot,
    task::JoinHandle,
};

#[derive(Debug, PartialEq, serde::Serialize)]
pub(crate) struct OAuthCallback {
    // Preserve ordering and duplicates so the plugin can validate known parameters.
    parameters: Vec<(String, String)>,
}
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OAuthAttempt {
    id: String,
    // Reuse this exact redirect_uri in token exchange (RFC 6749 §4.1.3).
    callback_url: String,
}
struct OAuthRequest {
    authorization_url: String,
    callback_path: String,
}
type CallbackResult = Result<OAuthCallback, String>;
struct Attempt {
    id: String,
    result: Option<oneshot::Receiver<CallbackResult>>,
    task: JoinHandle<()>,
}
impl Drop for Attempt {
    fn drop(&mut self) {
        self.task.abort();
    }
}
#[derive(Default)]
pub(crate) struct OAuthCallbackHost(Mutex<Option<Attempt>>);

impl OAuthCallbackHost {
    pub(crate) fn document_load(
        &self,
        label: &str,
        event: tauri::webview::PageLoadEvent,
    ) -> Result<(), String> {
        if label == "main" && event == tauri::webview::PageLoadEvent::Started {
            // The new document cannot recover the previous plugin's attempt ID.
            self.0.lock().map_err(|_| "Sign-in unavailable")?.take();
        }
        Ok(())
    }

    fn begin(
        &self,
        request: OAuthRequest,
        open: impl FnOnce(&str) -> Result<(), String>,
    ) -> Result<OAuthAttempt, String> {
        let mut authorization =
            url::Url::parse(&request.authorization_url).map_err(|_| "Invalid authorization URL")?;
        if authorization.scheme() != "https"
            || !authorization.username().is_empty()
            || authorization.password().is_some()
            || authorization.fragment().is_some()
        {
            return Err("Invalid authorization URL".into());
        }
        if authorization
            .query_pairs()
            .any(|(name, _)| name == "state" || name == "redirect_uri")
        {
            return Err("Invalid authorization parameters".into());
        }
        let path = request.callback_path;
        let redirect = url::Url::parse(&format!("http://127.0.0.1{path}"))
            .map_err(|_| "Invalid callback path")?;
        if !path.starts_with('/')
            || path.starts_with("//")
            || path.len() > 1024
            || redirect.path() != path
            || redirect.query().is_some()
            || redirect.fragment().is_some()
        {
            return Err("Invalid callback path".into());
        }
        let mut current = self.0.lock().map_err(|_| "Sign-in unavailable")?;
        if current
            .as_ref()
            .is_some_and(|attempt| !attempt.task.is_finished())
        {
            return Err("An OAuth callback is already pending".into());
        }
        // Binding is synchronous so cancellation cannot overtake listener registration.
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .map_err(|_| "Could not start the sign-in listener")?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "Could not start the sign-in listener")?;
        let authority = listener
            .local_addr()
            .map_err(|_| "Could not start the sign-in listener")?
            .to_string();
        let listener =
            TcpListener::from_std(listener).map_err(|_| "Could not start the sign-in listener")?;
        let callback = format!("http://{authority}{path}");
        // Native-owned, single-use CSRF correlation (RFC 8252 §8.9; RFC 9700 §2.1).
        let mut random = [0; 32];
        getrandom::fill(&mut random).map_err(|_| "Could not start sign-in")?;
        let expected_state = URL_SAFE_NO_PAD.encode(random);
        authorization
            .query_pairs_mut()
            .append_pair("redirect_uri", &callback)
            .append_pair("state", &expected_state);
        let (send, receive) = oneshot::channel();
        let task = tokio::spawn(async move {
            let result = tokio::time::timeout(
                Duration::from_secs(600),
                receive_callback(listener, &authority, &path, &expected_state),
            )
            .await
            .unwrap_or_else(|_| Err("Sign-in timed out. Try again.".into()));
            let _ = send.send(result);
        });
        let id = uuid::Uuid::new_v4().to_string();
        *current = Some(Attempt {
            id: id.clone(),
            result: Some(receive),
            task,
        });
        drop(current);
        if open(authorization.as_str()).is_err() {
            self.cancel(&id)?;
            return Err("Could not open the sign-in browser".into());
        }
        Ok(OAuthAttempt {
            id,
            callback_url: callback,
        })
    }

    async fn wait(&self, id: &str) -> CallbackResult {
        let receiver = {
            let mut current = self.0.lock().map_err(|_| "Sign-in unavailable")?;
            current
                .as_mut()
                .filter(|attempt| attempt.id == id)
                .and_then(|attempt| attempt.result.take())
                .ok_or("Sign-in is no longer available")?
        };
        let result = receiver
            .await
            .unwrap_or_else(|_| Err("Sign-in canceled.".into()));
        self.cancel(id)?;
        result
    }

    fn cancel(&self, id: &str) -> Result<(), String> {
        let mut current = self.0.lock().map_err(|_| "Sign-in unavailable")?;
        if current.as_ref().is_some_and(|attempt| attempt.id == id) {
            *current = None;
        }
        Ok(())
    }
}

#[tauri::command]
pub(crate) fn oauth_callback_begin<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, OAuthCallbackHost>,
    authorization_url: String,
    callback_path: String,
) -> Result<OAuthAttempt, String> {
    // Register and launch inline so reload cleanup cannot overtake a queued begin.
    // Enter the runtime for the Tokio listener; startup does not await anything.
    tauri::async_runtime::block_on(async {
        state.begin(
            OAuthRequest {
                authorization_url,
                callback_path,
            },
            |url| {
                app.opener()
                    .open_url(url, None::<&str>)
                    .map_err(|_| "Could not open the sign-in browser".into())
            },
        )
    })
}
#[tauri::command]
pub(crate) async fn oauth_callback_wait(
    state: tauri::State<'_, OAuthCallbackHost>,
    id: String,
) -> CallbackResult {
    state.wait(&id).await
}
#[tauri::command]
pub(crate) fn oauth_callback_cancel(
    state: tauri::State<'_, OAuthCallbackHost>,
    id: String,
) -> Result<(), String> {
    state.cancel(&id)
}

async fn receive_callback(
    listener: TcpListener,
    authority: &str,
    path: &str,
    expected_state: &str,
) -> CallbackResult {
    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|_| "Sign-in listener failed")?;
        // Bound slow/oversize requests; malformed callbacks do not consume the attempt.
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            callback(&mut stream, authority, path, expected_state),
        )
        .await;
        if let Ok(Some(response)) = result {
            // Release the socket before publishing completion to the waiting caller.
            drop(listener);
            return Ok(response);
        }
    }
}

async fn callback(
    stream: &mut TcpStream,
    authority: &str,
    path: &str,
    expected_state: &str,
) -> Option<OAuthCallback> {
    let mut bytes = Vec::new();
    let mut chunk = [0; 1024];
    while !bytes.windows(4).any(|part| part == b"\r\n\r\n") {
        let count = stream.read(&mut chunk).await.ok()?;
        if count == 0 {
            return None;
        }
        bytes.extend_from_slice(&chunk[..count]);
        if bytes.len() > 8192 {
            reply(stream, 400, "Invalid callback").await;
            return None;
        }
    }
    let (status, message, result) = parse_callback(&bytes, authority, path, expected_state);
    reply(stream, status, message).await;
    result
}

fn parse_callback(
    bytes: &[u8],
    authority: &str,
    path: &str,
    expected_state: &str,
) -> (u16, &'static str, Option<OAuthCallback>) {
    let invalid = (400, "Invalid callback", None);
    let Ok(text) = std::str::from_utf8(bytes) else {
        return invalid;
    };
    let mut lines = text.split("\r\n");
    let mut first = lines.next().unwrap_or_default().split_whitespace();
    let (Some("GET"), Some(target), Some("HTTP/1.1" | "HTTP/1.0"), None) =
        (first.next(), first.next(), first.next(), first.next())
    else {
        return invalid;
    };
    if !target.starts_with('/') || target.starts_with("//") {
        return invalid;
    }
    let mut hosts = Vec::new();
    for line in lines.take_while(|line| !line.is_empty()) {
        let Some((name, value)) = line.split_once(':') else {
            return invalid;
        };
        if name.eq_ignore_ascii_case("origin") {
            return invalid;
        }
        if name.eq_ignore_ascii_case("host") {
            hosts.push(value.trim());
        }
    }
    if hosts != [authority] {
        return invalid;
    }
    let Ok(url) = url::Url::parse(&format!("http://{authority}{target}")) else {
        return invalid;
    };
    if target.split('?').next() != Some(path) || url.path() != path {
        return (404, "Not found", None);
    }
    if url.fragment().is_some() {
        return invalid;
    }
    let fields: Vec<_> = url.query_pairs().into_owned().collect();
    let mut states = fields.iter().filter(|(name, _)| name == "state");
    if states.next().map(|(_, value)| value.as_str()) != Some(expected_state)
        || states.next().is_some()
    {
        return invalid;
    }
    if fields.iter().any(|(name, _)| name == "error") {
        return (
            400,
            "Sign-in failed. Return to the app to retry.",
            Some(OAuthCallback { parameters: fields }),
        );
    }
    let codes: Vec<_> = fields.iter().filter(|(name, _)| name == "code").collect();
    if codes.len() != 1 || codes[0].1.is_empty() || codes[0].1.len() > 4096 {
        return invalid;
    }
    (
        200,
        "Sign-in received. Return to the app to finish verification.",
        Some(OAuthCallback { parameters: fields }),
    )
}

async fn reply(stream: &mut TcpStream, status: u16, message: &str) {
    let body = format!("<!doctype html><title>Sign-in callback</title><p>{message}</p>");
    let reason = match status {
        200 => "OK",
        404 => "Not Found",
        _ => "Bad Request",
    };
    let response = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'; base-uri 'none'; frame-ancestors 'none'\r\nReferrer-Policy: no-referrer\r\n\r\n{body}", body.len());
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

#[cfg(test)]
mod tests;
