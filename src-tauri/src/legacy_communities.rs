//! The relays installed old Buzz saved, read from its WebKit localStorage so the
//! app can add them once. Old Buzz kept its community list only there, outside
//! its data folder. Never written.
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use std::path::{Path, PathBuf};

const COMMUNITIES_KEY: &str = "buzz-communities";

/// One saved community: its relay and the identity it was saved for, when
/// old Buzz recorded one.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Saved {
    relay_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pubkey: Option<String>,
}

#[cfg(target_os = "macos")]
fn root() -> Option<PathBuf> {
    let identifier = buzz_agent_controller::LegacySource::Installed.app_directory();
    Some(
        dirs::home_dir()?
            .join("Library/WebKit")
            .join(identifier)
            .join("WebsiteData"),
    )
}
#[cfg(not(target_os = "macos"))]
fn root() -> Option<PathBuf> {
    None
}

fn databases(dir: &Path, found: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // `file_type` does not follow symlinks, so a link cannot loop the walk.
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => databases(&path, found),
            Ok(kind) if kind.is_file() && entry.file_name() == "localstorage.sqlite3" => {
                found.push(path)
            }
            _ => {}
        }
    }
}

/// WebKit stores values as UTF-16LE; UTF-8 is the fallback old Buzz's own reader used.
fn decode(bytes: &[u8]) -> Option<String> {
    let (pairs, rest) = bytes.as_chunks::<2>();
    if rest.is_empty() && pairs.iter().any(|pair| pair[1] == 0) {
        let units: Vec<u16> = pairs.iter().map(|pair| u16::from_le_bytes(*pair)).collect();
        if let Ok(value) = String::from_utf16(&units) {
            return Some(value.trim_end_matches('\0').to_owned());
        }
    }
    String::from_utf8(bytes.to_vec()).ok()
}

/// Each saved community with a `relayUrl`; a list that is not one reads as empty.
fn read(path: &Path) -> rusqlite::Result<Vec<Saved>> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let value: Option<Vec<u8>> = conn
        .query_row(
            "SELECT value FROM ItemTable WHERE key = ?1",
            [COMMUNITIES_KEY],
            |row| row.get(0),
        )
        .optional()?;
    let list = value
        .and_then(|bytes| decode(&bytes))
        .and_then(|text| serde_json::from_str::<Vec<serde_json::Value>>(&text).ok())
        .unwrap_or_default();
    Ok(list
        .iter()
        .filter_map(|entry| {
            Some(Saved {
                relay_url: entry.get("relayUrl")?.as_str()?.to_owned(),
                pubkey: entry
                    .get("pubkey")
                    .and_then(|pubkey| pubkey.as_str())
                    .map(str::to_owned),
            })
        })
        .collect())
}

/// Every saved community once, in saved order. Missing storage reads as none;
/// a database that cannot be read fails the whole read so the caller retries.
fn read_all(root: &Path) -> Result<Vec<Saved>, String> {
    let mut found = Vec::new();
    databases(root, &mut found);
    let mut communities = Vec::new();
    for path in found {
        let saved = read(&path).map_err(|error| {
            eprintln!(
                "buzz-desktop: legacy communities: {}: {error}",
                path.display()
            );
            "Could not read old Buzz's communities".to_string()
        })?;
        for community in saved {
            if !communities.contains(&community) {
                communities.push(community);
            }
        }
    }
    Ok(communities)
}

#[tauri::command]
pub(crate) async fn legacy_communities() -> Result<Vec<Saved>, String> {
    tauri::async_runtime::spawn_blocking(|| root().map_or(Ok(vec![]), |root| read_all(&root)))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16(value: &str) -> Vec<u8> {
        value.encode_utf16().flat_map(u16::to_le_bytes).collect()
    }
    fn store(dir: &Path, value: Option<Vec<u8>>) {
        std::fs::create_dir_all(dir).unwrap();
        let conn = Connection::open(dir.join("localstorage.sqlite3")).unwrap();
        conn.execute(
            "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB NOT NULL ON CONFLICT FAIL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ItemTable VALUES ('buzz-active-community-id', ?1)",
            [utf16("a")],
        )
        .unwrap();
        if let Some(value) = value {
            conn.execute(
                "INSERT INTO ItemTable VALUES (?1, ?2)",
                (COMMUNITIES_KEY, value),
            )
            .unwrap();
        }
    }

    #[test]
    fn reads_each_saved_community_once_with_its_identity() {
        let dir = tempfile::tempdir().unwrap();
        let list = r#"[{"id":"a","name":"Hive","relayUrl":"wss://hive.example.com","pubkey":"p","addedAt":"t"},
            {"id":"b","name":"Dev","relayUrl":"ws://localhost:3000","addedAt":"t"},
            {"id":"c","name":"Broken"},
            {"id":"d","name":"Hive again","relayUrl":"wss://hive.example.com","addedAt":"t"}]"#;
        store(
            &dir.path().join("Default/x/x/LocalStorage"),
            Some(utf16(list)),
        );
        let other =
            r#"[{"relayUrl":"wss://other.example.com"},{"relayUrl":"wss://hive.example.com"}]"#;
        store(
            &dir.path().join("Default/y/y/LocalStorage"),
            Some(other.as_bytes().to_vec()),
        );
        let saved = |relay_url: &str, pubkey: Option<&str>| Saved {
            relay_url: relay_url.into(),
            pubkey: pubkey.map(Into::into),
        };
        // Directory order is not fixed, so compare as a set.
        let mut found = read_all(dir.path()).unwrap();
        found.sort_by(|a, b| (&a.relay_url, &a.pubkey).cmp(&(&b.relay_url, &b.pubkey)));
        assert_eq!(
            found,
            [
                saved("ws://localhost:3000", None),
                saved("wss://hive.example.com", None),
                saved("wss://hive.example.com", Some("p")),
                saved("wss://other.example.com", None),
            ]
        );
    }

    #[test]
    fn missing_or_unusable_state_reads_as_none() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            read_all(&dir.path().join("absent")).unwrap(),
            Vec::<Saved>::new()
        );
        store(&dir.path().join("a"), None);
        store(&dir.path().join("b"), Some(utf16("not json")));
        store(
            &dir.path().join("c"),
            Some(utf16(r#"{"relayUrl":"wss://x.example.com"}"#)),
        );
        assert_eq!(read_all(dir.path()).unwrap(), Vec::<Saved>::new());
    }

    #[test]
    fn an_unreadable_database_fails_the_read() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("localstorage.sqlite3"), b"not a database").unwrap();
        assert!(read_all(dir.path()).is_err());
    }
}
