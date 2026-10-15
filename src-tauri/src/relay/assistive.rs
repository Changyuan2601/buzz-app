//! Narrow self-encrypted assistive facts, never an arbitrary app-data codec.
use super::{origin, request_url, send, RelayResponse, Result, MAX_RESPONSE};
use crate::identity::{EventTemplate, IdentityHost};
use hmac::{Hmac, Mac};
use nostr::{
    event::Event,
    key::{Keys, SecretKey},
    nips::nip44,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
const TAG: &str = "buzz-assistive-v1";
const MAX_EVENT: usize = 4096;
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Fact {
    id: String,
    outcome: String,
}
fn validate(fact: &Fact) -> Result<()> {
    if fact.id != "threads.new-thread-placement"
        || !["seen", "dismissed", "completed"].contains(&fact.outcome.as_str())
    {
        return Err("Invalid assistive fact".into());
    }
    Ok(())
}
fn coordinate(key: &[u8], community: &str, fact: &Fact) -> Result<String> {
    validate(fact)?;
    let mut mac = Hmac::<Sha256>::new_from_slice(key).map_err(|_| "Invalid assistive key")?;
    mac.update(
        serde_json::to_string(&json!([TAG, community, fact.id, fact.outcome]))
            .map_err(|_| "Invalid assistive fact")?
            .as_bytes(),
    );
    let digest = mac.finalize().into_bytes();
    Ok(format!(
        "{TAG}:{}",
        digest
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u8,
    community: String,
    id: String,
    outcome: String,
}
async fn decode(host: &IdentityHost, community: String, events: Vec<Value>) -> Result<Value> {
    if events.len() > 96
        || serde_json::to_vec(&events)
            .map_err(|_| "Invalid assistive batch")?
            .len()
            > 96 * MAX_EVENT
    {
        return Err("Assistive decode capacity exceeded".into());
    }
    host.with_key(move |bytes, viewer| {
        let secret = SecretKey::from_slice(bytes).map_err(|_| "Invalid assistive key")?;
        let public = Keys::new(secret.clone()).public_key();
        let conversation = nip44::v2::ConversationKey::derive(&secret, &public)
            .map_err(|_| "Invalid assistive key")?;
        let mut result = Vec::new();
        for raw in events {
            if serde_json::to_vec(&raw)
                .map_err(|_| "Invalid assistive event")?
                .len()
                > MAX_EVENT
            {
                return Err("Invalid assistive event".into());
            }
            let event: Event =
                serde_json::from_value(raw.clone()).map_err(|_| "Invalid assistive event")?;
            event.verify().map_err(|_| "Invalid assistive event")?;
            if event.kind.as_u16() != 30078 || event.pubkey.to_hex() != viewer {
                return Err("Invalid assistive event".into());
            }
            let plaintext =
                crate::identity::decrypt_with_conversation(&conversation, &event.content)?;
            if plaintext.len() > 1024 {
                return Err("Assistive plaintext capacity exceeded".into());
            }
            let record: Record =
                serde_json::from_str(&plaintext).map_err(|_| "Invalid assistive record")?;
            let fact = Fact {
                id: record.id,
                outcome: record.outcome,
            };
            if record.version != 1
                || record.community != community
                || raw["tags"]
                    != json!([
                        ["d", coordinate(conversation.as_bytes(), &community, &fact)?],
                        ["t", TAG]
                    ])
            {
                return Err("Assistive coordinate mismatch".into());
            }
            result.push(json!({"eventId": event.id.to_hex(), "fact": fact}));
        }
        Ok(json!(result))
    })
    .await
}
#[tauri::command]
pub(crate) async fn relay_assistive_addresses(
    host: tauri::State<'_, IdentityHost>,
    community: String,
) -> Result<Value> {
    origin(&community)?;
    host.with_key(move |bytes, _| {
        let secret = SecretKey::from_slice(bytes).map_err(|_| "Invalid assistive key")?;
        let public = Keys::new(secret.clone()).public_key();
        let conversation = nip44::v2::ConversationKey::derive(&secret, &public).map_err(|_| "Invalid assistive key")?;
        let mut entries = Vec::new();
        for outcome in ["seen", "dismissed", "completed"] {
            let fact = Fact { id: "threads.new-thread-placement".into(), outcome: outcome.into() };
            entries.push(json!({"id": fact.id, "outcome": fact.outcome, "coordinate": coordinate(conversation.as_bytes(), &community, &fact)?}));
        }
        Ok(json!(entries))
    }).await
}
#[tauri::command]
pub(crate) async fn relay_assistive_decode(
    host: tauri::State<'_, IdentityHost>,
    community: String,
    events: Vec<Value>,
) -> Result<Value> {
    origin(&community)?;
    decode(host.inner(), community, events).await
}
#[tauri::command]
pub(crate) async fn relay_assistive_sign(
    host: tauri::State<'_, IdentityHost>,
    community: String,
    fact: Fact,
) -> Result<Value> {
    origin(&community)?;
    validate(&fact)?;
    let template = host.with_key(move |bytes, _| {
        let secret = SecretKey::from_slice(bytes).map_err(|_| "Invalid assistive key")?;
        let public = Keys::new(secret.clone()).public_key();
        let conversation = nip44::v2::ConversationKey::derive(&secret, &public).map_err(|_| "Invalid assistive key")?;
        let plaintext = serde_json::to_string(&json!({"version": 1, "community": community, "id": fact.id, "outcome": fact.outcome})).map_err(|_| "Invalid assistive record")?;
        Ok(EventTemplate { kind: 30078, created_at: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| "System clock unavailable")?.as_secs(),
            tags: vec![vec!["d".into(), coordinate(conversation.as_bytes(), &community, &fact)?], vec!["t".into(), TAG.into()]],
            content: nip44::encrypt(&secret, &public, plaintext, nip44::Version::V2).map_err(|_| "Assistive encryption failed")? })
    }).await?;
    host.sign_bounded(template, MAX_EVENT).await
}
#[tauri::command]
pub(crate) async fn relay_assistive_publish(
    host: tauri::State<'_, IdentityHost>,
    community: String,
    event: Value,
) -> Result<RelayResponse> {
    let url = request_url(&community, "/events", "POST")?;
    decode(host.inner(), community, vec![event.clone()]).await?;
    let body = serde_json::to_string(&event).map_err(|_| "Invalid assistive event")?;
    send(host.inner(), url, "POST", Some(body), true, MAX_RESPONSE).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::event::FinalizeEvent;
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};

    #[test]
    fn assistive_codec_matches_shared_vectors_and_enforces_ipc_purposes() {
        let app = mock_builder()
            .manage(IdentityHost::fixture())
            .invoke_handler(crate::commands())
            .build(crate::app_context())
            .unwrap();
        let view = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
            .build()
            .unwrap();
        let invoke = |cmd: &str, body: Value| {
            get_ipc_response(
                &view,
                tauri::webview::InvokeRequest {
                    cmd: cmd.into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: view.url().unwrap(),
                    body: tauri::ipc::InvokeBody::Json(body),
                    headers: Default::default(),
                    invoke_key: INVOKE_KEY.into(),
                },
            )
            .map(|body| body.deserialize::<Value>().unwrap())
        };
        let fixture: Value =
            serde_json::from_str(include_str!("../../../tests/assistive-codec.json")).unwrap();
        let community = fixture["community"].as_str().unwrap();
        assert_eq!(
            invoke("relay_assistive_addresses", json!({"community":community})).unwrap(),
            fixture["addresses"]
        );
        let fact = json!({"id":"threads.new-thread-placement","outcome":"dismissed"});
        let good = invoke(
            "relay_assistive_sign",
            json!({"community":community,"fact":fact}),
        )
        .unwrap();
        assert_eq!(good["tags"][0][1], fixture["addresses"][1]["coordinate"]);
        assert_eq!(
            invoke(
                "relay_assistive_decode",
                json!({"community":community,"events":[good.clone()]})
            )
            .unwrap()[0]["fact"],
            fact
        );
        assert!(invoke(
            "relay_assistive_decode",
            json!({"community":"https://other.test","events":[good.clone()]})
        )
        .is_err());
        assert!(invoke(
            "relay_assistive_decode",
            json!({"community":community,"events":vec![good.clone();97]})
        )
        .is_err());
        assert!(invoke("relay_sign", json!({"community":community,"event":{"kind":30078,"created_at":good["created_at"],"tags":good["tags"],"content":good["content"]}})).is_err());
        assert!(invoke(
            "relay_http",
            json!({"community":community,"path":"/events","method":"POST","body":good.to_string()})
        )
        .is_err());
        for tags in [
            json!([good["tags"][0], good["tags"][1], ["extra", "x"]]),
            json!([good["tags"][1], good["tags"][0]]),
        ] {
            let secret = SecretKey::from_slice(&[1; 32]).unwrap();
            let mut raw = good.clone();
            raw["tags"] = tags;
            let signed = nostr::event::EventBuilder::new(
                nostr::event::Kind::Custom(30078),
                raw["content"].as_str().unwrap(),
            )
            .tags(serde_json::from_value::<Vec<nostr::event::Tag>>(raw["tags"].clone()).unwrap())
            .custom_created_at(nostr::types::Timestamp::from(
                good["created_at"].as_u64().unwrap(),
            ))
            .finalize(&Keys::new(secret))
            .unwrap();
            assert!(invoke(
                "relay_assistive_decode",
                json!({"community":community,"events":[signed]})
            )
            .is_err());
        }
        for record in [
            json!({"version":2,"community":community,"id":fact["id"],"outcome":fact["outcome"]}),
            json!({"version":1,"community":community,"id":fact["id"],"outcome":fact["outcome"],"extra":true}),
        ] {
            let secret = SecretKey::from_slice(&[1; 32]).unwrap();
            let keys = Keys::new(secret.clone());
            let content = nip44::encrypt(
                &secret,
                &keys.public_key(),
                record.to_string(),
                nip44::Version::V2,
            )
            .unwrap();
            let event = nostr::event::EventBuilder::new(nostr::event::Kind::Custom(30078), content)
                .tags(
                    serde_json::from_value::<Vec<nostr::event::Tag>>(good["tags"].clone()).unwrap(),
                )
                .finalize(&keys)
                .unwrap();
            assert!(invoke(
                "relay_assistive_decode",
                json!({"community":community,"events":[event]})
            )
            .is_err());
        }
        let foreign = nostr::event::EventBuilder::new(
            nostr::event::Kind::Custom(30078),
            good["content"].as_str().unwrap(),
        )
        .tags(serde_json::from_value::<Vec<nostr::event::Tag>>(good["tags"].clone()).unwrap())
        .finalize(&Keys::new(SecretKey::from_slice(&[2; 32]).unwrap()))
        .unwrap();
        assert!(invoke(
            "relay_assistive_decode",
            json!({"community":community,"events":[foreign]})
        )
        .is_err());
    }
}
