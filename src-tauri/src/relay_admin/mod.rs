//! Native relay staff console transport. The webview names a closed request;
//! this module checks the expected context, connects only to vetted public
//! addresses, signs NIP-98 over the exact URL, method and body, and reports
//! outcomes without losing whether a write may have landed.

pub(crate) mod attachment;
mod net;
pub(crate) mod route;
mod shape;
#[cfg(test)]
mod tests;

use crate::identity::{EventTemplate, IdentityHost};
use base64::{engine::general_purpose::STANDARD, Engine};
use net::Net;
use route::{Built, StaffRequest, ERROR_CAP};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use url::Url;

/// What a request is bound to. See `StaffContext` in `contract.ts`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Context {
    relay: String,
    origin: String,
    signer: String,
}

#[derive(Debug, Serialize, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
enum Category {
    NotSent,
    Unauthorized,
    Forbidden,
    Unsupported,
    Rejected,
    Intercepted,
    Ambiguous,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Failure {
    category: Category,
    status: Option<u16>,
    body_complete: bool,
    body_empty: bool,
    code: Option<String>,
    not_sent: bool,
    /// A 401/403 arrived: re-check access. Says nothing about a sent write.
    auth_lost: bool,
    message: String,
}

impl Failure {
    fn not_sent(message: impl Into<String>) -> Self {
        Self {
            category: Category::NotSent,
            status: None,
            body_complete: false,
            body_empty: false,
            code: None,
            not_sent: true,
            auth_lost: false,
            message: message.into(),
        }
    }

    fn ambiguous(status: Option<u16>, body_complete: bool, message: &str) -> Self {
        Self {
            category: Category::Ambiguous,
            status,
            body_complete,
            body_empty: false,
            code: None,
            not_sent: false,
            auth_lost: false,
            message: message.into(),
        }
    }
}

fn outcome(result: Result<Value, Failure>) -> Value {
    match result {
        Ok(value) => json!({ "ok": true, "value": value }),
        Err(failure) => json!({ "ok": false, "failure": failure }),
    }
}

/// Unsigned: the validated `admin_api` origin a community advertises, if any.
#[tauri::command]
pub(crate) async fn relay_admin_discover(relay: String) -> Result<Option<String>, String> {
    discover(&relay).await
}

/// The relay's advertised admin origin, or why its relay info couldn't be read.
type Discovered = Result<Option<String>, String>;

async fn discover(relay: &str) -> Discovered {
    let info = crate::relay::relay_info(relay).await?;
    Ok(advertised(&info))
}

fn advertised(info: &Value) -> Option<String> {
    let value = info.get("admin_api")?.as_str()?;
    net::admin_origin(value)
        .ok()
        .map(|url| url.origin().ascii_serialization())
}

#[tauri::command]
pub(crate) async fn relay_admin_request(
    host: tauri::State<'_, IdentityHost>,
    context: Context,
    request: StaffRequest,
) -> Result<Value, String> {
    let discovered = discover(&context.relay).await;
    Ok(outcome(
        execute(&Net::system(), host.inner(), &context, discovered, &request).await,
    ))
}

async fn execute(
    net: &Net,
    host: &IdentityHost,
    context: &Context,
    discovered: Discovered,
    request: &StaffRequest,
) -> Result<Value, Failure> {
    let origin = expected_origin(host, context, discovered).await?;
    let built = request.build(&origin).map_err(Failure::not_sent)?;
    let response = dispatch(net, host, context, &origin, &built).await?;
    classify(response, built.success_cap, Some(request)).await
}

/// Refuses unless the signed-in identity and a fresh discovery still match
/// what the caller reviewed. A retry can never change signer or destination.
async fn expected_origin(
    host: &IdentityHost,
    context: &Context,
    discovered: Discovered,
) -> Result<Url, Failure> {
    crate::relay::origin(&context.relay).map_err(Failure::not_sent)?;
    let origin = net::admin_origin(&context.origin).map_err(Failure::not_sent)?;
    // Only a relay-info document that loads and omits the host means it moved;
    // failing to load it is a connection failure the caller can retry.
    let discovered = discovered
        .map_err(|_| Failure::not_sent("Could not reach the relay to confirm its admin host"))?;
    if discovered.as_deref() != Some(origin.origin().ascii_serialization().as_str()) {
        return Err(Failure::not_sent(
            "The relay no longer advertises this admin host",
        ));
    }
    let viewer = host.viewer().await.map_err(Failure::not_sent)?;
    if viewer != context.signer {
        return Err(Failure::not_sent("The signed-in identity changed"));
    }
    Ok(origin)
}

async fn dispatch(
    net: &Net,
    host: &IdentityHost,
    context: &Context,
    origin: &Url,
    built: &Built,
) -> Result<reqwest::Response, Failure> {
    let client = net.client(origin).await.map_err(Failure::not_sent)?;
    let auth = authorization(host, &context.signer, built)
        .await
        .map_err(Failure::not_sent)?;
    let mut request = client
        .request(
            reqwest::Method::from_bytes(built.method.as_bytes()).expect("static method"),
            built.url.clone(),
        )
        .header("Authorization", auth)
        .header("Accept", "application/json");
    if !built.body.is_empty() {
        request = request
            .header("Content-Type", "application/json")
            .body(built.body.clone());
    }
    request
        .send()
        .await
        .map_err(|_| Failure::ambiguous(None, false, "The admin request could not be confirmed"))
}

/// NIP-98 over the exact URL, method and body hash (the empty-body hash on
/// bodiless calls). Only `signer` may sign.
async fn authorization(host: &IdentityHost, signer: &str, built: &Built) -> Result<String, String> {
    let event = host
        .sign(EventTemplate {
            kind: 27235,
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| "System clock is unavailable")?
                .as_secs(),
            content: String::new(),
            tags: vec![
                vec!["u".into(), built.url.as_str().into()],
                vec!["method".into(), built.method.into()],
                vec![
                    "payload".into(),
                    format!("{:x}", Sha256::digest(&built.body)),
                ],
                vec!["nonce".into(), uuid::Uuid::new_v4().to_string()],
            ],
        })
        .await?;
    if event.get("pubkey").and_then(Value::as_str) != Some(signer) {
        return Err("The signed-in identity changed".into());
    }
    let encoded = serde_json::to_vec(&event).map_err(|_| "Could not encode authentication")?;
    Ok(format!("Nostr {}", STANDARD.encode(encoded)))
}

enum Read {
    Complete(Vec<u8>),
    Interrupted,
    Oversized,
}

async fn read_capped(response: &mut reqwest::Response, cap: usize) -> Read {
    if response.content_length().is_some_and(|n| n > cap as u64) {
        return Read::Oversized;
    }
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if chunk.len() > cap - bytes.len() => return Read::Oversized,
            Ok(Some(chunk)) => bytes.extend_from_slice(&chunk),
            Ok(None) => return Read::Complete(bytes),
            Err(_) => return Read::Interrupted,
        }
    }
}

fn intercepted(response: &reqwest::Response) -> bool {
    response.status().is_redirection()
        || response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.trim_start().to_ascii_lowercase().starts_with("text/html"))
}

/// `request` is `None` for attachment errors. Once a write has been sent, only
/// a complete answer from the relay itself is certain: gateway pages, 5xx,
/// cut-off bodies and unexpected success shapes all stay `Ambiguous`, so the
/// retry reuses the frozen request ID.
async fn classify(
    response: reqwest::Response,
    success_cap: usize,
    request: Option<&StaffRequest>,
) -> Result<Value, Failure> {
    // One rule for every exit: any 401/403, however its body looked, means
    // access must be re-checked. It never makes a sent write certain.
    let auth_lost = matches!(response.status().as_u16(), 401 | 403);
    classify_body(response, success_cap, request)
        .await
        .map_err(|failure| Failure {
            auth_lost,
            ..failure
        })
}

async fn classify_body(
    mut response: reqwest::Response,
    success_cap: usize,
    request: Option<&StaffRequest>,
) -> Result<Value, Failure> {
    let status = response.status().as_u16();
    let write = request.is_some_and(StaffRequest::is_write);
    if intercepted(&response) {
        let message = "A sign-in page or gateway answered instead of the admin API";
        if write {
            return Err(Failure::ambiguous(Some(status), false, message));
        }
        return Err(Failure {
            category: Category::Intercepted,
            status: Some(status),
            body_complete: false,
            body_empty: false,
            code: None,
            not_sent: false,
            auth_lost: false,
            message: message.into(),
        });
    }
    let success = response.status().is_success();
    let challenge = response
        .headers()
        .get("www-authenticate")
        .is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"nostr"));
    let body = match read_capped(&mut response, if success { success_cap } else { ERROR_CAP }).await
    {
        Read::Complete(body) => body,
        Read::Interrupted => {
            return Err(Failure::ambiguous(
                Some(status),
                false,
                "The admin response was cut off",
            ))
        }
        Read::Oversized => {
            return Err(Failure::ambiguous(
                Some(status),
                false,
                "The admin response was too large",
            ))
        }
    };
    if success {
        let value = if body.is_empty() {
            None
        } else {
            serde_json::from_slice::<Value>(&body).ok()
        };
        let valid = match request {
            Some(request) => {
                (body.is_empty() || value.is_some())
                    && shape::valid(request, status, value.as_ref())
            }
            None => false,
        };
        return match value {
            _ if !valid => Err(Failure {
                body_empty: body.is_empty(),
                ..Failure::ambiguous(
                    Some(status),
                    true,
                    "The admin API returned an unexpected response",
                )
            }),
            Some(value) => Ok(value),
            None => Ok(Value::Null),
        };
    }
    let envelope = shape::rejection(status, challenge, &body);
    let category = match status {
        404 | 405 if body.is_empty() => Category::Unsupported,
        500.. => Category::Ambiguous,
        // Once sent, a write is only definitively refused by the relay's own
        // error envelope; a gateway's 401/403/4xx says nothing about it.
        _ if write && envelope.is_none() => Category::Ambiguous,
        401 => Category::Unauthorized,
        403 => Category::Forbidden,
        _ => Category::Rejected,
    };
    let (code, message) = envelope.unzip();
    Err(Failure {
        category,
        status: Some(status),
        body_complete: true,
        body_empty: body.is_empty(),
        code,
        not_sent: false,
        auth_lost: false,
        message: message.unwrap_or_else(|| default_message(category).into()),
    })
}

fn default_message(category: Category) -> &'static str {
    match category {
        Category::Unauthorized => "The relay did not accept this identity",
        Category::Forbidden => "This identity is not allowed to do that",
        Category::Unsupported => "This relay doesn't support that yet",
        Category::Ambiguous => "The relay could not confirm the result",
        _ => "The relay rejected the request",
    }
}
