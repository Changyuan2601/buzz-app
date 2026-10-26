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

fn app_domain(origin: &str) -> Option<&'static str> {
    match origin {
        "https://app.builderlab.xyz" => Some("apps.builderlab.xyz"),
        "https://app.builderlabstaging.xyz" => Some("apps.builderlabstaging.xyz"),
        "https://block.builderlab.xyz" => Some("apps.block.builderlab.xyz"),
        _ => None,
    }
}

fn app_root(origin: &str, target: &str) -> Result<String, String> {
    let domain = app_domain(origin).ok_or("Builderlab Apps sign-in is not configured")?;
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

pub(super) async fn prepare(target: &str, auth: ViewerAuth) -> Result<Bootstrap, String> {
    let origin = buzzodz_plugins::BUILDERLAB_ORIGIN;
    let root = app_root(origin, target)?;
    let credential = Zeroizing::new(auth.credential);
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
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            401 => "Sign out and sign in to Builderlab again in Settings, then reopen this app",
            403 => "Your Builderlab account cannot open this app",
            404 => "Builderlab viewer sign-in is not enabled yet",
            _ => "Builderlab viewer sign-in is unavailable. Try reopening this app",
        }
        .into());
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
    let viewer_cookie = cookie(
        &viewer_credential,
        &reply.expires_at,
        app_domain(origin).unwrap(),
        now,
    )?;
    #[cfg(not(target_os = "macos"))]
    {
        drop(viewer_cookie);
        Err("Builderlab viewer sign-in is supported only on macOS".into())
    }
    #[cfg(target_os = "macos")]
    Ok(Bootstrap {
        cookie: viewer_cookie,
        app_origin: root.trim_end_matches('/').into(),
        cookie_domain: app_domain(origin).unwrap().into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_are_only_used_for_same_tenant_exact_app_hosts() {
        let origin = "https://app.builderlab.xyz";
        assert_eq!(
            app_root(
                origin,
                "https://counter--bpsites.apps.builderlab.xyz/second?q=1#part"
            )
            .unwrap(),
            "https://counter--bpsites.apps.builderlab.xyz/"
        );
        for target in [
            "https://counter.apps.block.builderlab.xyz/",
            "https://apps.builderlab.xyz/",
            "https://login.apps.builderlab.xyz/",
            "https://health.apps.builderlab.xyz/",
            "https://nested.app.apps.builderlab.xyz/",
            "https://app.apps.builderlab.xyz.evil.test/",
            "http://counter.apps.builderlab.xyz/",
            "https://user@counter.apps.builderlab.xyz/",
            "https://counter.apps.builderlab.xyz:8443/",
        ] {
            assert!(app_root(origin, target).is_err(), "{target}");
        }
        assert!(app_root("https://evil.test", "https://counter.apps.builderlab.xyz/").is_err());
    }

    #[test]
    fn viewer_cookie_replaces_the_existing_domain_cookie_with_absolute_expiry() {
        let value = cookie(
            &"C".repeat(43),
            "2026-10-26T16:00:00Z",
            "apps.builderlab.xyz",
            chrono::DateTime::parse_from_rfc3339("2026-10-26T15:00:00Z")
                .unwrap()
                .timestamp(),
        )
        .unwrap();
        assert!(value.starts_with("__Secure-bbidentity_hosted_site_session="));
        assert!(value.contains(
            "Path=/; Expires=Mon, 26 Oct 2026 16:00:00 GMT; Secure; HttpOnly; SameSite=Lax"
        ));
        assert!(value.contains("Domain=apps.builderlab.xyz; Path=/"));
        for credential in [
            "short".to_string(),
            "C".repeat(513),
            format!("{}; injected=x", "C".repeat(43)),
        ] {
            assert!(cookie(
                &credential,
                "2026-10-26T16:00:00Z",
                "apps.builderlab.xyz",
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
                "apps.builderlab.xyz",
                chrono::DateTime::parse_from_rfc3339("2026-10-26T15:00:00Z")
                    .unwrap()
                    .timestamp()
            )
            .is_err());
        }
    }
}
