//! Native-only viewer exchange. Credentials never enter a URL or website JavaScript.
use serde::Deserialize;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;
use zeroize::Zeroizing;

const VIEWER_COOKIE: &str = "__Secure-bbidentity_hosted_site_session";

#[derive(Deserialize)]
pub struct ViewerAuth {
    credential: String,
}

pub(super) struct Bootstrap {
    #[cfg(target_os = "macos")]
    pub cookie: Zeroizing<String>,
    #[cfg(target_os = "macos")]
    pub app_origin: String,
    #[cfg(target_os = "macos")]
    pub cookie_domain: String,
}

fn app_root(domain: &str, target: &str) -> Result<String, String> {
    if domain.is_empty() {
        return Err("Builderlab Apps sign-in is not configured".into());
    }
    let url = Url::parse(target).map_err(|_| "Invalid Builderlab app URL")?;
    let label = url
        .host_str()
        .and_then(|host| host.strip_suffix(&format!(".{domain}")));
    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || !label.is_some_and(|label| {
            !label.is_empty() && !label.contains('.') && !matches!(label, "login" | "health")
        })
    {
        return Err("This app uses a different Builderlab environment".into());
    }
    Ok(format!("https://{}/", url.host_str().unwrap()))
}

fn cookie(
    credential: &str,
    expires_at: &str,
    domain: &str,
    now: i64,
) -> Result<Zeroizing<String>, String> {
    if !(32..=512).contains(&credential.len())
        || !credential
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
    {
        return Err("Invalid Builderlab viewer credential".into());
    }
    let expires_at = chrono::DateTime::parse_from_rfc3339(expires_at)
        .map_err(|_| "Invalid Builderlab sign-in expiry")?;
    if !(1..=8 * 60 * 60).contains(&(expires_at.timestamp() - now)) {
        return Err("Builderlab sign-in expired. Sign in again in Settings".into());
    }
    let expiry = expires_at
        .with_timezone(&chrono::Utc)
        .format("%a, %d %b %Y %H:%M:%S GMT");
    Ok(Zeroizing::new(format!(
        "{VIEWER_COOKIE}={credential}; Domain={domain}; Path=/; Expires={expiry}; Secure; HttpOnly; SameSite=Lax"
    )))
}

/// Only feature absence permits browser-login fallback. All authorization and transport failures stay closed.
fn exchange_available(status: reqwest::StatusCode) -> Result<bool, String> {
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(false);
    }
    if status.is_success() {
        return Ok(true);
    }
    Err(match status.as_u16() {
        401 => "Sign out and sign in to Builderlab again in Settings, then reopen this app",
        403 => "Your Builderlab account cannot open this app",
        _ => "Builderlab viewer sign-in is unavailable. Try reopening this app",
    }
    .into())
}

pub(super) async fn prepare(target: &str, auth: ViewerAuth) -> Result<Option<Bootstrap>, String> {
    let origin = buzzodz_plugins::BUILDERLAB_ORIGIN;
    let domain = buzzodz_plugins::BUILDERLAB_APPS_DOMAIN;
    let credential = Zeroizing::new(auth.credential);
    if domain.is_empty() {
        return Ok(None);
    }
    let root = app_root(domain, target)?;
    if !(32..=512).contains(&credential.len())
        || !credential
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
    {
        return Err("Sign in to Builderlab again in Settings".into());
    }
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "Builderlab sign-in is unavailable")?;
    let body = Zeroizing::new(serde_json::json!({ "return_to": root }).to_string());
    let mut response = client
        .post(format!(
            "{origin}/api/goose/v1/auth/hosted-site/native-session"
        ))
        .header("X-BB-Session-Credential", &*credential)
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|_| "Builderlab sign-in request failed")?;
    if !exchange_available(response.status())? {
        return Ok(None);
    }
    let mut bytes = Zeroizing::new(Vec::new());
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Invalid Builderlab sign-in response")?
    {
        if bytes.len() + chunk.len() > 4096 {
            return Err("Invalid Builderlab sign-in response".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    #[derive(Deserialize)]
    struct Reply {
        credential: String,
        expires_at: String,
    }
    let reply: Reply =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid Builderlab sign-in response")?;
    let viewer_credential = Zeroizing::new(reply.credential);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Invalid system clock")?
        .as_secs() as i64;
    let viewer_cookie = cookie(&viewer_credential, &reply.expires_at, domain, now)?;
    #[cfg(not(target_os = "macos"))]
    {
        drop(viewer_cookie);
        Err("Builderlab viewer sign-in is supported only on macOS".into())
    }
    #[cfg(target_os = "macos")]
    Ok(Some(Bootstrap {
        cookie: viewer_cookie,
        app_origin: root.trim_end_matches('/').into(),
        cookie_domain: domain.into(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_login_fallback_is_only_for_an_unavailable_feature() {
        assert!(!exchange_available(reqwest::StatusCode::NOT_FOUND).unwrap());
        assert!(exchange_available(reqwest::StatusCode::OK).unwrap());
        for code in [400, 401, 403, 429, 500, 503, 302] {
            assert!(exchange_available(reqwest::StatusCode::from_u16(code).unwrap()).is_err());
        }
    }

    #[test]
    fn credentials_are_only_used_for_same_tenant_exact_app_hosts() {
        let domain = "apps.example";
        assert_eq!(
            app_root(
                domain,
                "https://counter--bpsites.apps.example/second?q=1#part"
            )
            .unwrap(),
            "https://counter--bpsites.apps.example/"
        );
        for target in [
            "https://counter.apps.other.example/",
            "https://apps.example/",
            "https://login.apps.example/",
            "https://health.apps.example/",
            "https://nested.app.apps.example/",
            "https://app.apps.example.evil.test/",
            "http://counter.apps.example/",
            "https://user@counter.apps.example/",
            "https://counter.apps.example:8443/",
        ] {
            assert!(app_root(domain, target).is_err(), "{target}");
        }
        assert!(app_root("", "https://counter.apps.example/").is_err());
    }

    #[test]
    fn viewer_cookie_replaces_the_existing_domain_cookie_with_absolute_expiry() {
        let value = cookie(
            &"C".repeat(43),
            "2026-10-26T16:00:00Z",
            "apps.example",
            chrono::DateTime::parse_from_rfc3339("2026-10-26T15:00:00Z")
                .unwrap()
                .timestamp(),
        )
        .unwrap();
        assert!(value.starts_with("__Secure-bbidentity_hosted_site_session="));
        assert!(value.contains(
            "Path=/; Expires=Mon, 26 Oct 2026 16:00:00 GMT; Secure; HttpOnly; SameSite=Lax"
        ));
        assert!(value.contains("Domain=apps.example; Path=/"));
        for credential in [
            "short".to_string(),
            "C".repeat(513),
            format!("{}; injected=x", "C".repeat(43)),
        ] {
            assert!(cookie(
                &credential,
                "2026-10-26T16:00:00Z",
                "apps.example",
                chrono::DateTime::parse_from_rfc3339("2026-10-26T15:00:00Z")
                    .unwrap()
                    .timestamp()
            )
            .is_err());
        }
        for expiry in ["invalid", "2026-10-26T15:00:00Z", "2026-10-27T16:00:00Z"] {
            assert!(cookie(
                &"C".repeat(43),
                expiry,
                "apps.example",
                chrono::DateTime::parse_from_rfc3339("2026-10-26T15:00:00Z")
                    .unwrap()
                    .timestamp()
            )
            .is_err());
        }
    }
}
