//! Per-agent snapshot restore. Team composition and binding authorization stay with teams.
use super::{profile_http, run, AgentHost};
use crate::relay::agent::slug as valid_slug;
use buzz_agent_controller::{CreationProfile, ProcessStatus};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

type Result<T> = std::result::Result<T, String>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SnapshotMemoryEntry {
    slug: String,
    body: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryWriteResult {
    written: usize,
    total: usize,
    errors: Vec<String>,
}

fn validate(entries: &[SnapshotMemoryEntry]) -> Result<()> {
    if entries.len() > 128
        || entries.iter().any(|entry| entry.body.len() > 64 * 1024)
        || entries.iter().map(|entry| entry.body.len()).sum::<usize>() > 1024 * 1024
    {
        return Err("Snapshot memory exceeds the import limit".into());
    }
    if entries.iter().any(|entry| !valid_slug(&entry.slug)) {
        return Err("Invalid snapshot memory slug".into());
    }
    for entry in entries {
        buzz_agent_controller::validate_snapshot_memory_envelope(&entry.slug, &entry.body)
            .map_err(|_| "Snapshot memory contains hidden text or exceeds the readable limit")?;
    }
    // Same serialized DTO budget as the native reader. Reserve a full u64 timestamp;
    // publication confirms each entry by reading this exact representation back.
    let reader_bytes = entries
        .iter()
        .map(|entry| {
            serde_json::to_vec(&serde_json::json!({
                "slug":entry.slug, "body":entry.body,
                "eventId":"0".repeat(64), "createdAt":u64::MAX
            }))
            .map_or(usize::MAX, |bytes| bytes.len())
        })
        .try_fold(0usize, |sum, bytes| sum.checked_add(bytes))
        .ok_or("Snapshot memory exceeds the readable limit")?;
    if reader_bytes > 1024 * 1024 {
        return Err("Snapshot memory exceeds the readable limit".into());
    }
    let mut slugs = BTreeSet::new();
    if entries.iter().any(|entry| !slugs.insert(&entry.slug)) {
        return Err("Duplicate snapshot memory slug".into());
    }
    Ok(())
}

async fn target(owner: AgentHost, id: String, viewer: String) -> Result<CreationProfile> {
    run(owner, move |host| {
        let profile = host.controller.memory_target(&id)?;
        // memory_target verifies the native-created marker and signed owner attestation.
        let authorization: Vec<String> =
            serde_json::from_str(&profile.auth).map_err(|_| "Invalid owner authorization")?;
        if authorization.get(1) != Some(&viewer) {
            return Err("Snapshot memory belongs to another owner".into());
        }
        let agent = host
            .snapshot()?
            .data
            .agents
            .into_iter()
            .find(|agent| agent.id == id)
            .ok_or("Agent no longer exists")?;
        if agent.status != ProcessStatus::Stopped {
            return Err("Stop the imported agent before restoring memories".into());
        }
        Ok(profile)
    })
    .await
}

async fn current_target(
    owner: AgentHost,
    identity: &crate::identity::IdentityHost,
    id: &str,
    viewer: &str,
    expected: &CreationProfile,
) -> Result<()> {
    owner.ensure_open().await?;
    let current = identity.with_key(|_, viewer| Ok(viewer.to_owned())).await?;
    if current != viewer {
        return Err("Identity changed during memory restore".into());
    }
    let current = target(owner, id.to_owned(), viewer.to_owned()).await?;
    if current.pubkey != expected.pubkey
        || current.revision != expected.revision
        || current.credential_id != expected.credential_id
        || current.auth != expected.auth
        || current.url != expected.url
    {
        return Err("Agent changed during memory restore".into());
    }
    Ok(())
}

pub(super) async fn restore(
    owner: AgentHost,
    identity: tauri::State<'_, crate::identity::IdentityHost>,
    id: String,
    entries: Vec<SnapshotMemoryEntry>,
) -> Result<MemoryWriteResult> {
    validate(&entries)?;
    let viewer = identity.with_key(|_, viewer| Ok(viewer.to_owned())).await?;
    // Check custody before reading the credential store, not only before publication.
    let profile = target(owner.clone(), id.clone(), viewer.clone()).await?;
    let credentials = run(owner.clone(), |host| Ok(host.credentials.clone())).await?;
    let credential = profile.credential_id.clone();
    let pubkey = profile.pubkey.clone();
    let key = tauri::async_runtime::spawn_blocking(move || {
        credentials.retry();
        credentials.read(&credential, &pubkey)
    })
    .await
    .map_err(|_| "Native credential operation failed")??
    .ok_or("Agent key unavailable")?;
    if key.pubkey() != profile.pubkey {
        return Err("Agent key changed".into());
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|_| "Memory client unavailable")?;
    let community = profile.url.trim_end_matches("/events").to_owned();
    let previous = crate::relay::agent::relay_agent_memories_read(
        identity.clone(),
        community.clone(),
        profile.pubkey.clone(),
    )
    .await?;
    require_complete(&previous)?;
    let mut result = MemoryWriteResult {
        written: 0,
        total: entries.len(),
        errors: vec![],
    };
    for entry in entries {
        let operation = async {
            current_target(owner.clone(), identity.inner(), &id, &viewer, &profile).await?;
            // A retry preserves already-current entries rather than emitting new ciphertext.
            if existing(&previous, &entry.slug)
                .is_some_and(|item| item["body"].as_str() == Some(entry.body.as_str()))
            {
                return Ok(());
            }
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| "System clock is unavailable")?
                .as_secs();
            let timestamp = existing(&previous, &entry.slug)
                .and_then(|item| item["createdAt"].as_u64())
                .map_or(now, |at| now.max(at.saturating_add(1)));
            let event = key.memory_event(&viewer, &entry.slug, &entry.body, timestamp)?;
            let event_id = event["id"]
                .as_str()
                .ok_or("Invalid memory event")?
                .to_owned();
            // Encryption/signing may take time; recheck immediately before the send.
            current_target(owner.clone(), identity.inner(), &id, &viewer, &profile).await?;
            profile_http::publish_memory(&client, &profile, &key, event).await?;
            let listing = crate::relay::agent::relay_agent_memories_read(
                identity.clone(),
                community.clone(),
                profile.pubkey.clone(),
            )
            .await?;
            current_target(owner.clone(), identity.inner(), &id, &viewer, &profile).await?;
            confirm_current(&listing, &entry.slug, &event_id)
        }
        .await;
        match operation {
            Ok(()) => result.written += 1,
            Err(_) => result.errors.push(format!(
                "{}: memory restore failed; retry this agent",
                entry.slug
            )),
        }
    }
    Ok(result)
}

fn existing<'a>(listing: &'a Value, slug: &str) -> Option<&'a Value> {
    listing["entries"]
        .as_array()?
        .iter()
        .find(|item| item["slug"].as_str() == Some(slug))
}
fn require_complete(listing: &Value) -> Result<()> {
    if listing["partial"].as_bool() != Some(false) || !listing["entries"].is_array() {
        return Err("Memory listing is incomplete; restore was not started".into());
    }
    Ok(())
}
fn confirm_current(listing: &Value, slug: &str, event_id: &str) -> Result<()> {
    require_complete(listing)?;
    if existing(listing, slug).and_then(|item| item["eventId"].as_str()) != Some(event_id) {
        return Err("Memory restore is not confirmed as current".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests;
