//! NIP-AP agent instructions versions (kind 44300): owner-to-self ciphertext with no general decrypt.
use super::hex_key;
use crate::identity::{EventTemplate, IdentityHost};
use serde_json::{json, Value};

type Result<T> = std::result::Result<T, String>;

pub(crate) const TEXT_MAX_BYTES: usize = 131_072;
pub(crate) const CONTENT_MAX_BYTES: usize = 218_548;
pub(crate) const EVENT_MAX_BYTES: usize = CONTENT_MAX_BYTES + 2_048;
const PREFIX: &str = "v1:";
const KIND: u16 = 44300;
const REJECTED: &str = "Invalid instructions";

fn origin(community: &str) -> Result<()> {
    super::origin(community).map(|_| ())
}

fn text_error(text: &str) -> Option<&'static str> {
    if text.len() > TEXT_MAX_BYTES {
        Some("Instructions are too long")
    } else if text.contains('\0') {
        Some("Instructions can't contain a NUL character")
    } else {
        None
    }
}

/// The envelope a 44300 must have: exactly one lowercase-hex `p` subject and no `t`/`h`.
fn envelope(tags: &[Vec<String>]) -> Result<&str> {
    let mut subjects = tags
        .iter()
        .filter(|tag| tag.first().map(String::as_str) == Some("p"));
    let (Some(p), None) = (subjects.next(), subjects.next()) else {
        return Err(REJECTED.into());
    };
    if p.len() != 2
        || !hex_key(&p[1])
        || p[1].bytes().any(|b| b.is_ascii_uppercase())
        || tags
            .iter()
            .any(|tag| matches!(tag.first().map(String::as_str), Some("t" | "h") | None))
    {
        return Err(REJECTED.into());
    }
    Ok(&p[1])
}

/// The spec's reader order over a well-enveloped event's content; `Err` carries the invalid reason.
async fn read(host: &IdentityHost, content: &str) -> std::result::Result<String, &'static str> {
    if content.len() > CONTENT_MAX_BYTES {
        return Err("This version is too large");
    }
    let plaintext = host
        .instructions_cipher(content.to_owned(), false)
        .await
        .map_err(|_| "This version can't be decrypted")?;
    let text = plaintext
        .strip_prefix(PREFIX)
        .ok_or("This version uses an unknown format")?;
    text_error(text).map_or(Ok(text.to_owned()), Err)
}

#[tauri::command]
pub(crate) async fn relay_instructions_prepare(
    host: tauri::State<'_, IdentityHost>,
    community: String,
    subject: String,
    text: String,
) -> Result<String> {
    prepare(host.inner(), &community, &subject, &text).await
}

async fn prepare(
    host: &IdentityHost,
    community: &str,
    subject: &str,
    text: &str,
) -> Result<String> {
    origin(community)?;
    if !hex_key(subject) || subject.bytes().any(|b| b.is_ascii_uppercase()) {
        return Err(REJECTED.into());
    }
    if let Some(error) = text_error(text) {
        return Err(error.into());
    }
    let content = host
        .instructions_cipher(format!("{PREFIX}{text}"), true)
        .await?;
    if content.len() > CONTENT_MAX_BYTES {
        return Err("Instructions are too long".into());
    }
    Ok(content)
}

#[tauri::command]
pub(crate) async fn relay_instructions_decode(
    host: tauri::State<'_, IdentityHost>,
    community: String,
    subject: String,
    events: Vec<Value>,
) -> Result<Vec<Value>> {
    decode(host.inner(), &community, &subject, events).await
}

async fn decode(
    host: &IdentityHost,
    community: &str,
    subject: &str,
    events: Vec<Value>,
) -> Result<Vec<Value>> {
    origin(community)?;
    if events.len() > 16
        || serde_json::to_vec(&events).map_err(|_| REJECTED)?.len() > 4 * 1024 * 1024
    {
        return Err(REJECTED.into());
    }
    let viewer = host.viewer().await?;
    let mut decoded = Vec::with_capacity(events.len());
    for event in events {
        let raw: nostr::event::Event =
            serde_json::from_value(event.clone()).map_err(|_| REJECTED)?;
        raw.verify().map_err(|_| REJECTED)?;
        let tags: Vec<Vec<String>> =
            serde_json::from_value(event["tags"].clone()).map_err(|_| REJECTED)?;
        if event["pubkey"].as_str() != Some(&viewer)
            || event["kind"] != json!(KIND)
            || envelope(&tags)? != subject
        {
            return Err(REJECTED.into());
        }
        let content = event["content"].as_str().ok_or(REJECTED)?;
        decoded.push(match read(host, content).await {
            Ok(text) => json!({"id": event["id"], "text": text}),
            Err(invalid) => json!({"id": event["id"], "invalid": invalid}),
        });
    }
    Ok(decoded)
}

/// Signs a 44300 whose ciphertext decodes, or the kind 5 that deletes exactly one 44300.
#[tauri::command]
pub(crate) async fn relay_instructions_sign(
    host: tauri::State<'_, IdentityHost>,
    community: String,
    event: EventTemplate,
) -> Result<Value> {
    sign(host.inner(), &community, event).await
}

async fn sign(host: &IdentityHost, community: &str, event: EventTemplate) -> Result<Value> {
    origin(community)?;
    match event.kind {
        KIND => {
            envelope(&event.tags)?;
            read(host, &event.content).await.map_err(String::from)?;
            host.sign_bounded(event, EVENT_MAX_BYTES).await
        }
        5 if is_deletion(&event) => host.sign(event).await,
        _ => Err(REJECTED.into()),
    }
}

/// Exactly `["e", <id>]` and `["k","44300"]`, empty content, nothing else (so no `h`).
pub(crate) fn is_deletion(event: &EventTemplate) -> bool {
    event.kind == 5
        && event.content.is_empty()
        && event.created_at <= 9_007_199_254_740_991
        && event.tags.len() == 2
        && event.tags.iter().filter(|tag| matches!(tag.as_slice(), [k, v] if k == "k" && v == "44300")).count() == 1
        && event.tags.iter().filter(|tag| {
            matches!(tag.as_slice(), [e, id] if e == "e" && hex_key(id) && !id.bytes().any(|b| b.is_ascii_uppercase()))
        }).count() == 1
}

/// Any kind 5 that names kind 44300, which only `relay_instructions_sign` may sign.
pub(crate) fn names_instructions(event: &EventTemplate) -> bool {
    event.kind == KIND
        || (event.kind == 5
            && event.tags.iter().any(|tag| {
                tag.first().map(String::as_str) == Some("k")
                    && tag.get(1).map(String::as_str) == Some("44300")
            }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const COMMUNITY: &str = "https://relay.test";
    const SUBJECT: &str = "2222222222222222222222222222222222222222222222222222222222222222";

    fn template(content: String) -> EventTemplate {
        EventTemplate {
            created_at: 1_700_000_000,
            kind: KIND,
            tags: vec![vec!["p".into(), SUBJECT.into()]],
            content,
        }
    }

    async fn signed(host: &IdentityHost, text: &str) -> Value {
        let content = prepare(host, COMMUNITY, SUBJECT, text).await.unwrap();
        sign(host, COMMUNITY, template(content)).await.unwrap()
    }

    async fn one(host: &IdentityHost, event: Value) -> Result<Value> {
        decode(host, COMMUNITY, SUBJECT, vec![event])
            .await
            .map(|mut v| v.remove(0))
    }

    #[tokio::test]
    async fn t1_round_trips_at_boundaries_and_rejects_over_limit() {
        let host = IdentityHost::fixture();
        for len in [0, 1, 65_535, 65_536, TEXT_MAX_BYTES] {
            let text = "a".repeat(len);
            let decoded = one(&host, signed(&host, &text).await).await.unwrap();
            assert_eq!(decoded["text"].as_str().unwrap().len(), len, "{len}");
        }
        assert!(
            prepare(&host, COMMUNITY, SUBJECT, &"a".repeat(TEXT_MAX_BYTES + 1))
                .await
                .is_err()
        );
        assert!(prepare(&host, COMMUNITY, SUBJECT, "a\0b").await.is_err());
    }

    #[tokio::test]
    async fn t2_envelope_failures_are_errors_and_content_failures_are_invalid() {
        let host = IdentityHost::fixture();
        let event = signed(&host, "hello").await;
        let mut forged = event.clone();
        forged["content"] = json!("tampered");
        assert!(one(&host, forged).await.is_err(), "bad signature");
        assert!(
            decode(&host, COMMUNITY, &"3".repeat(64), vec![event.clone()])
                .await
                .is_err()
        );
        let foreign = IdentityHost::fixture_with([2; 32]);
        let theirs = signed(&foreign, "x").await;
        assert!(one(&host, theirs).await.is_err(), "foreign author");

        let invalid = |content: String| {
            let host = host.clone();
            async move {
                let raw = host
                    .sign_bounded(template(content), usize::MAX)
                    .await
                    .unwrap();
                one(&host, raw).await.unwrap()["invalid"]
                    .as_str()
                    .map(str::to_owned)
            }
        };
        assert!(invalid("a".repeat(CONTENT_MAX_BYTES + 1)).await.is_some());
        let cipher = |plain: &str| host.instructions_cipher(plain.to_owned(), true);
        assert!(invalid(cipher("no prefix").await.unwrap()).await.is_some());
        assert!(invalid(cipher("v2:hello").await.unwrap()).await.is_some());
        assert!(invalid(cipher("v1:a\0b").await.unwrap()).await.is_some());
        assert!(invalid("not ciphertext".into()).await.is_some());
    }

    #[tokio::test]
    async fn t2_signer_bounds_and_shapes() {
        let host = IdentityHost::fixture();
        let content = prepare(&host, COMMUNITY, SUBJECT, "x").await.unwrap();
        let mut event = template(content.clone());
        event.tags.push(vec!["t".into(), "x".into()]);
        assert!(sign(&host, COMMUNITY, event).await.is_err());
        let mut event = template(content.clone());
        event.tags.push(vec!["p".into(), SUBJECT.into()]);
        assert!(sign(&host, COMMUNITY, event).await.is_err());
        assert!(sign(&host, COMMUNITY, template("garbage".into()))
            .await
            .is_err());

        let delete = |tags: Vec<Vec<String>>| EventTemplate {
            created_at: 1,
            kind: 5,
            tags,
            content: String::new(),
        };
        let e = vec!["e".to_string(), "a".repeat(64)];
        let k = vec!["k".to_string(), "44300".to_string()];
        assert!(sign(&host, COMMUNITY, delete(vec![e.clone(), k.clone()]))
            .await
            .is_ok());
        assert!(sign(
            &host,
            COMMUNITY,
            delete(vec![e.clone(), k.clone(), vec!["h".into(), "c".into()]])
        )
        .await
        .is_err());
        assert!(sign(
            &host,
            COMMUNITY,
            delete(vec![e.clone(), e.clone(), k.clone()])
        )
        .await
        .is_err());
        assert!(sign(
            &host,
            COMMUNITY,
            delete(vec![e, vec!["k".into(), "9".into()]])
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn t2_event_bound_is_220_596_bytes() {
        let host = IdentityHost::fixture();
        let shell = serde_json::to_vec(&json!([
            0,
            host.viewer().await.unwrap(),
            1_700_000_000u64,
            KIND,
            [["p", SUBJECT]],
            ""
        ]))
        .unwrap()
        .len();
        let fits = template("a".repeat(EVENT_MAX_BYTES - shell));
        assert!(host.sign_bounded(fits, EVENT_MAX_BYTES).await.is_ok());
        let over = template("a".repeat(EVENT_MAX_BYTES - shell + 1));
        assert!(host.sign_bounded(over, EVENT_MAX_BYTES).await.is_err());
        assert_eq!(EVENT_MAX_BYTES, 220_596);
    }
}
