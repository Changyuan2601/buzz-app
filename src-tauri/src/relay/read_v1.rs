//! `/buzz/v1/me` server-owned read state: fixed routes, NIP-98 signed by the
//! person's key. Mirrors the web broker's read-v1 routes (browser-host/relay-broker.mjs).
use super::{origin, send, workflow_uuid, IdentityHost, RelayResponse, Result};
use url::Url;

/// Matches the relay's per-request channel cap (`max_channels`).
const MAX_CHANNEL_IDS: usize = 20;
/// A batch of read intents or coverage IDs never needs more.
const MAX_BODY: usize = 64 * 1024;
/// Sidebar pages and outcomes are compact JSON.
const MAX_RESPONSE: usize = 1024 * 1024;

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ReadV1Operation {
    Sidebar,
    Write,
    Coverage,
}

impl ReadV1Operation {
    fn route(self) -> &'static str {
        match self {
            Self::Sidebar => "sidebar",
            Self::Write => "read-state",
            Self::Coverage => "coverage",
        }
    }
}

fn read_v1_url(
    community: &str,
    op: ReadV1Operation,
    cursor: Option<&str>,
    channel_ids: Option<&[String]>,
) -> Result<Url> {
    let mut url = origin(community)?
        .join(&format!("/buzz/v1/me/{}", op.route()))
        .map_err(|_| "Invalid relay path".to_string())?;
    match op {
        ReadV1Operation::Sidebar => {
            let cursor = cursor
                .map(|cursor| {
                    if cursor.is_empty()
                        || cursor.len() > 512
                        || !cursor.bytes().all(|b| b.is_ascii_graphic())
                    {
                        return Err("Invalid read-state cursor".to_string());
                    }
                    Ok(cursor)
                })
                .transpose()?;
            if let Some(ids) = channel_ids {
                if ids.is_empty()
                    || ids.len() > MAX_CHANNEL_IDS
                    || ids.iter().any(|id| !workflow_uuid(id))
                {
                    return Err("Invalid read-state channels".into());
                }
            }
            if cursor.is_some() || channel_ids.is_some() {
                let mut query = url.query_pairs_mut();
                if let Some(cursor) = cursor {
                    query.append_pair("cursor", cursor);
                }
                if let Some(ids) = channel_ids {
                    query.append_pair("channel_ids", &ids.join(","));
                }
            }
        }
        _ => {
            if cursor.is_some() || channel_ids.is_some() {
                return Err("Invalid read-state request".into());
            }
        }
    }
    Ok(url)
}

/// The relay reads one non-empty array; reserializing drops anything else.
fn read_v1_body(op: ReadV1Operation, body: Option<String>) -> Result<String> {
    let body = body.ok_or("Invalid read-state request")?;
    if body.len() > MAX_BODY {
        return Err("Read-state request is too large".into());
    }
    let key = match op {
        ReadV1Operation::Write => "intents",
        ReadV1Operation::Coverage => "message_ids",
        ReadV1Operation::Sidebar => return Err("Invalid read-state request".into()),
    };
    let value: serde_json::Value =
        serde_json::from_str(&body).map_err(|_| "Invalid read-state request")?;
    let items = value
        .get(key)
        .and_then(serde_json::Value::as_array)
        .filter(|items| !items.is_empty())
        .ok_or("Invalid read-state request")?;
    serde_json::to_string(&serde_json::json!({ key: items }))
        .map_err(|_| "Invalid read-state request".into())
}

#[tauri::command]
pub(crate) async fn relay_read_v1(
    host: tauri::State<'_, IdentityHost>,
    community: String,
    op: ReadV1Operation,
    cursor: Option<String>,
    channel_ids: Option<Vec<String>>,
    body: Option<String>,
) -> Result<RelayResponse> {
    let url = read_v1_url(&community, op, cursor.as_deref(), channel_ids.as_deref())?;
    let (method, body) = match op {
        ReadV1Operation::Sidebar => {
            if body.is_some() {
                return Err("Invalid read-state request".into());
            }
            ("GET", None)
        }
        _ => ("POST", Some(read_v1_body(op, body)?)),
    };
    send(host.inner(), url, method, body, true, MAX_RESPONSE).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidebar_url_bounds_its_query() {
        let url = read_v1_url("https://relay.test", ReadV1Operation::Sidebar, None, None).unwrap();
        assert_eq!(url.as_str(), "https://relay.test/buzz/v1/me/sidebar");

        let id = "550e8400-e29b-41d4-a716-446655440000";
        let url = read_v1_url(
            "https://relay.test",
            ReadV1Operation::Sidebar,
            Some("cursor=evil&x=1"),
            Some(&[id.into()]),
        )
        .unwrap();
        assert_eq!(
            url.as_str(),
            "https://relay.test/buzz/v1/me/sidebar?cursor=cursor%3Devil%26x%3D1&channel_ids=550e8400-e29b-41d4-a716-446655440000"
        );

        let long = "x".repeat(513);
        let rejected_cursors = ["", long.as_str(), "line\nbreak"];
        for cursor in rejected_cursors {
            assert!(
                read_v1_url(
                    "https://relay.test",
                    ReadV1Operation::Sidebar,
                    Some(cursor),
                    None
                )
                .is_err(),
                "cursor {cursor:?}"
            );
        }
        let rejected_ids: Vec<Vec<String>> = vec![
            vec![],
            vec!["not-a-uuid".into()],
            vec!["550E8400-E29B-41D4-A716-446655440000".into()],
            vec![id.into(); MAX_CHANNEL_IDS + 1],
        ];
        for ids in rejected_ids {
            assert!(
                read_v1_url(
                    "https://relay.test",
                    ReadV1Operation::Sidebar,
                    None,
                    Some(&ids)
                )
                .is_err(),
                "ids {ids:?}"
            );
        }
    }

    #[test]
    fn writes_take_no_query_and_keep_only_their_array() {
        for op in [ReadV1Operation::Write, ReadV1Operation::Coverage] {
            assert!(read_v1_url("https://relay.test", op, Some("c"), None).is_err());
            assert!(read_v1_url("https://relay.test", op, None, Some(&["x".into()])).is_err());
        }
        assert_eq!(
            read_v1_body(
                ReadV1Operation::Write,
                Some(r#"{"intents":[{"type":"follow"}],"extra":1}"#.into())
            )
            .unwrap(),
            r#"{"intents":[{"type":"follow"}]}"#
        );
        assert_eq!(
            read_v1_body(
                ReadV1Operation::Coverage,
                Some(r#"{"message_ids":["ab"]}"#.into())
            )
            .unwrap(),
            r#"{"message_ids":["ab"]}"#
        );
        for (op, body) in [
            (ReadV1Operation::Write, None),
            (ReadV1Operation::Write, Some("not json".into())),
            (ReadV1Operation::Write, Some(r#"{"intents":[]}"#.into())),
            (
                ReadV1Operation::Write,
                Some(r#"{"message_ids":["ab"]}"#.into()),
            ),
            (
                ReadV1Operation::Coverage,
                Some(r#"{"intents":[{}]}"#.into()),
            ),
            (ReadV1Operation::Coverage, Some("x".repeat(MAX_BODY + 1))),
            (ReadV1Operation::Sidebar, Some(r#"{"intents":[{}]}"#.into())),
        ] {
            assert!(read_v1_body(op, body).is_err());
        }
    }
}
