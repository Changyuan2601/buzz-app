//! Native-only bootstrap. Neither the API credential nor verifier is delivered to website code.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;
use zeroize::Zeroizing;

const HANDOFF_PATH: &str = "/api/goose/v1/auth/hosted-site/handoff";
const BINDING_COOKIE: &str = "__Host-bbidentity_native_hosted_site_handoff";

#[derive(Deserialize)]
pub struct ViewerAuth {
    credential: String,
}

pub(super) struct Bootstrap {
    pub url: String,
    pub root: String,
    pub cookie: Zeroizing<String>,
    pub login_origin: String,
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

fn validate_handoff(value: &str, root: &str, domain: &str, hash: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Invalid Builderlab sign-in response")?;
    let pairs: Vec<_> = url.query_pairs().collect();
    let expected = [
        ("returnTo", root),
        ("hosted_handoff_binding", hash),
        ("native_handoff", "true"),
    ];
    let code = pairs
        .iter()
        .find(|(key, _)| key == "code")
        .map(|(_, value)| value.as_ref());
    if value.len() > 2048
        || url.scheme() != "https"
        || url.host_str() != Some(format!("login.{domain}").as_str())
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != HANDOFF_PATH
        || url.fragment().is_some()
        || pairs.len() != 4
        || !expected
            .iter()
            .all(|(key, value)| pairs.iter().filter(|(k, v)| k == key && v == value).count() == 1)
        || !code.is_some_and(|code| {
            code.len() == 43
                && code
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
        })
    {
        return Err("Invalid Builderlab sign-in response".into());
    }
    Ok(url)
}

/// Follow the alias through an app root redirect without replacing cross-origin login/consent pages.
pub(super) fn resume_app_target(
    pending: &mut Option<(String, String)>,
    landed: &str,
) -> Option<String> {
    let (root, _) = pending.as_ref()?;
    let root = Url::parse(root).ok()?;
    let landed = Url::parse(landed).ok()?;
    if root.origin() != landed.origin() {
        return None;
    }
    pending.take().map(|(_, target)| target)
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
    let mut random = [0; 32];
    getrandom::fill(&mut random).map_err(|_| "Builderlab browser proof is unavailable")?;
    let verifier = Zeroizing::new(URL_SAFE_NO_PAD.encode(random));
    let hash = URL_SAFE_NO_PAD.encode(Sha256::digest(format!(
        "bbidentity-builderlab-hosted-site-handoff:{}",
        &*verifier
    )));
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "Builderlab sign-in is unavailable")?;
    let body = Zeroizing::new(
        serde_json::json!({ "return_to": root, "browser_binding_verifier": &*verifier })
            .to_string(),
    );
    let mut response = client
        .post(format!(
            "{origin}/api/goose/v1/auth/hosted-site/native-handoff"
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
        handoff_url: String,
        expires_at: String,
    }
    let reply: Reply =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid Builderlab sign-in response")?;
    let url = validate_handoff(
        &reply.handoff_url,
        &root,
        app_domain(origin).unwrap(),
        &hash,
    )?;
    let expires_at = chrono::DateTime::parse_from_rfc3339(&reply.expires_at)
        .map_err(|_| "Invalid Builderlab sign-in expiry")?;
    let expires = expires_at.timestamp();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Invalid system clock")?
        .as_secs() as i64;
    let lifetime = expires - now;
    if !(1..=120).contains(&lifetime) {
        return Err("Builderlab sign-in expired. Reopen this app".into());
    }
    // Absolute expiry keeps the proof bounded by the ticket even if native cookie installation is delayed.
    let cookie_expiry = expires_at
        .with_timezone(&chrono::Utc)
        .format("%a, %d %b %Y %H:%M:%S GMT");
    Ok(Bootstrap {
        login_origin: url.origin().ascii_serialization(), url: url.into(), root,
        cookie: Zeroizing::new(format!("{BINDING_COOKIE}_{hash}={}; Path=/; Expires={cookie_expiry}; Secure; HttpOnly; SameSite=Lax", *verifier)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_root_redirect_restores_deep_target_only_after_same_origin_landing() {
        let target = "https://counter.apps.builderlab.xyz/report/42?q=1#part";
        let mut pending = Some(("https://counter.apps.builderlab.xyz/".into(), target.into()));
        assert_eq!(
            resume_app_target(&mut pending, "https://login.apps.builderlab.xyz/consent"),
            None
        );
        assert!(pending.is_some());
        // A root 302 to /dashboard finishes there, rather than at the exact root.
        assert_eq!(
            resume_app_target(
                &mut pending,
                "https://counter.apps.builderlab.xyz/dashboard"
            ),
            Some(target.into())
        );
        assert!(pending.is_none());
        assert_eq!(resume_app_target(&mut pending, target), None);
    }

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
    fn handoff_requires_exact_alias_root_native_binding_and_one_opaque_code() {
        let root = "https://counter.apps.builderlab.xyz/";
        let hash = "H".repeat(43);
        let mut good =
            Url::parse("https://login.apps.builderlab.xyz/api/goose/v1/auth/hosted-site/handoff")
                .unwrap();
        good.query_pairs_mut()
            .append_pair("code", &"C".repeat(43))
            .append_pair("returnTo", root)
            .append_pair("hosted_handoff_binding", &hash)
            .append_pair("native_handoff", "true");
        assert!(validate_handoff(good.as_str(), root, "apps.builderlab.xyz", &hash).is_ok());
        for (key, value) in [
            ("returnTo", "https://evil.test/"),
            ("hosted_handoff_binding", "wrong"),
            ("native_handoff", "false"),
            ("code", "short"),
        ] {
            let mut bad = good.clone();
            let pairs: Vec<_> = bad
                .query_pairs()
                .filter(|(k, _)| k != key)
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect();
            bad.set_query(None);
            bad.query_pairs_mut()
                .extend_pairs(pairs)
                .append_pair(key, value);
            assert!(validate_handoff(bad.as_str(), root, "apps.builderlab.xyz", &hash).is_err());
        }
        let mut duplicate = good.clone();
        duplicate
            .query_pairs_mut()
            .append_pair("code", &"C".repeat(43));
        assert!(validate_handoff(duplicate.as_str(), root, "apps.builderlab.xyz", &hash).is_err());
        for host in [
            "counter.apps.builderlab.xyz",
            "login.apps.block.builderlab.xyz",
            "login.apps.builderlab.xyz.evil.test",
        ] {
            let mut bad = good.clone();
            bad.set_host(Some(host)).unwrap();
            assert!(validate_handoff(bad.as_str(), root, "apps.builderlab.xyz", &hash).is_err());
        }
        let mut bad = good.clone();
        bad.set_fragment(Some("fragment"));
        assert!(validate_handoff(bad.as_str(), root, "apps.builderlab.xyz", &hash).is_err());
    }
}
