//! Bounded host-owned archive. Signed envelopes reach SQLite encrypted; only
//! NIP-AM metrics (44200) also keep their decrypted content, for usage tools.
mod store;
use crate::{
    identity::IdentityHost,
    relay::agent::{decode_archive, AgentEvent},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::Manager;

type Result<T> = std::result::Result<T, String>;
#[derive(Clone, Default)]
pub(crate) struct ArchiveHost(Arc<Mutex<Option<store::Store>>>);
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
pub(crate) enum Request {
    Settings,
    Configure {
        observer: bool,
        metrics: bool,
        #[serde(rename = "observerDays")]
        observer_days: u32,
        #[serde(rename = "metricsDays")]
        metrics_days: u32,
        revision: i64,
    },
    Read {
        kind: u16,
        agent: Option<String>,
        before: Option<i64>,
    },
    Clear {
        kind: Option<u16>,
    },
    Ingest {
        event: AgentEvent,
        revision: i64,
    },
}
#[tauri::command]
pub(crate) async fn relay_archive<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    identity: tauri::State<'_, IdentityHost>,
    archive: tauri::State<'_, ArchiveHost>,
    community: String,
    viewer: String,
    request: Request,
) -> Result<Value> {
    let community = crate::relay::origin(&community)?
        .origin()
        .ascii_serialization();
    // Initialization failure stays retryable and cannot disable unrelated app startup.
    let path = app
        .path()
        .app_data_dir()
        .map_err(|_| "Archive location unavailable")?
        .join(if cfg!(debug_assertions) {
            "archive-debug"
        } else {
            "archive"
        })
        .join("events.sqlite3");
    execute(
        identity.inner(),
        archive.inner().clone(),
        path,
        community,
        viewer,
        request,
    )
    .await
}
async fn execute(
    identity: &IdentityHost,
    archive: ArchiveHost,
    path: std::path::PathBuf,
    community: String,
    viewer: String,
    request: Request,
) -> Result<Value> {
    if !matches!(request, Request::Ingest { .. }) && identity.viewer().await? != viewer {
        return Err("Archive viewer changed".into());
    }
    // Admitted ingest keeps the content decrypted during validation.
    let (request, content) = if let Request::Ingest { event, revision } = request {
        let expected = viewer.clone();
        identity
            .with_key(move |secret, current| {
                if current != expected {
                    return Err("Archive viewer changed".into());
                }
                // The trusted main renderer supplies fresh envelopes. This verifies
                // cryptography/recipient, not relay delivery or agent ownership.
                let frame = decode_archive(secret, current, &event, false)?;
                let content = frame["plaintext"].as_str().map(str::to_owned);
                Ok((Request::Ingest { event, revision }, content))
            })
            .await?
    } else {
        (request, None)
    };
    enum Reply {
        Complete(Value),
        Page {
            rows: Vec<(i64, i64, String)>,
            agents: Vec<String>,
            revision: i64,
        },
    }
    let read_only = matches!(request, Request::Settings);
    let partition = viewer.clone();
    let backfill_host = archive.clone();
    // Neither waiting for the archive mutex nor any SQLite work holds the key
    // owner's lock. An admitted write stays in its original account partition.
    let reply = tauri::async_runtime::spawn_blocking(move || {
        let mut guard = archive.0.lock().map_err(|_| "Archive unavailable")?;
        if guard.is_none() {
            *guard = Some(store::Store::open(path)?);
        }
        let store = guard.as_mut().ok_or("Archive unavailable")?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "Invalid clock")?
            .as_secs() as i64;
        let current = partition.as_str();
        store.seed(current, &community)?;
        store.prune(now)?;
        Ok::<_, String>(match request {
            Request::Settings => Reply::Complete(store.settings(current, &community)?),
            Request::Configure {
                observer,
                metrics,
                observer_days,
                metrics_days,
                revision,
            } => Reply::Complete(store.configure(
                current,
                &community,
                store::CaptureSettings {
                    observer,
                    metrics,
                    days: observer_days,
                    metrics_days,
                    revision,
                },
                now,
            )?),
            Request::Clear { kind } => {
                store.clear(current, &community, kind)?;
                Reply::Complete(json!({"cleared":true}))
            }
            Request::Ingest { event, revision } => {
                store.ingest(
                    current,
                    &community,
                    &event,
                    content.as_deref(),
                    revision,
                    now,
                )?;
                Reply::Complete(json!({"saved":true}))
            }
            Request::Read {
                kind,
                agent,
                before,
            } => {
                let (rows, revision) =
                    store.read(current, &community, kind, agent.as_deref(), before)?;
                Reply::Page {
                    rows,
                    revision,
                    agents: store.agents(current, &community, kind)?,
                }
            }
        })
    })
    .await
    .map_err(|_| "Archive task failed")??;
    // Best effort: a failed batch leaves rows pending for the next host call.
    let _ = backfill(identity, backfill_host, viewer.clone()).await;
    match reply {
        Reply::Complete(value) => {
            if read_only && identity.viewer().await? != viewer { return Err("Archive viewer changed".into()); }
            Ok(value)
        }
        Reply::Page { rows, agents, revision } => identity.with_key(move |secret, current| {
            // Recheck after the database wait, before decrypting for the renderer.
            if current != viewer { return Err("Archive viewer changed".into()); }
            let cursor = if rows.len() == 100 { rows.last().map(|row| row.0) } else { None };
            let mut records = Vec::new();
            let mut skipped = 0;
            for (_, received, raw) in rows {
                let decoded = serde_json::from_str(&raw)
                    .map_err(|_| "Invalid saved archive record".into())
                    .and_then(|event| decode_archive(secret, current, &event, true));
                match decoded {
                    Ok(mut frame) => {
                        frame["receivedAt"] = json!(received * 1000);
                        records.push(frame);
                    }
                    Err(_) => skipped += 1,
                }
            }
            Ok(json!({"records":records,"skipped":skipped,"agents":agents,"before":cursor,"revision":revision}))
        }).await
    }
}

/// Decrypts one batch of this account's metrics saved before v3 stored plaintext.
/// Other accounts' rows wait until their own key is unlocked.
async fn backfill(identity: &IdentityHost, archive: ArchiveHost, viewer: String) -> Result<()> {
    let host = archive.clone();
    let target = viewer.clone();
    let rows = tauri::async_runtime::spawn_blocking(move || {
        let guard = host.0.lock().map_err(|_| "Archive unavailable")?;
        guard
            .as_ref()
            .ok_or("Archive unavailable")?
            .pending(&target)
    })
    .await
    .map_err(|_| "Archive task failed")??;
    if rows.is_empty() {
        return Ok(());
    }
    let filled = identity
        .with_key(move |secret, current| {
            if current != viewer {
                return Err("Archive viewer changed".into());
            }
            Ok(rows
                .into_iter()
                .map(|(seq, raw)| {
                    let content = serde_json::from_str(&raw)
                        .ok()
                        .and_then(|event| decode_archive(secret, current, &event, true).ok())
                        .and_then(|frame| frame["plaintext"].as_str().map(str::to_owned));
                    (seq, content)
                })
                .collect::<Vec<_>>())
        })
        .await?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = archive.0.lock().map_err(|_| "Archive unavailable")?;
        guard.as_mut().ok_or("Archive unavailable")?.fill(filled)
    })
    .await
    .map_err(|_| "Archive task failed")?
}

#[cfg(test)]
pub(crate) mod tests;
