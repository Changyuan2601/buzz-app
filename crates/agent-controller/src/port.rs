//! Agent identities an earlier agent system saved on this machine, which Agents2
//! can take over: the harness controller's library and old Buzz's. Only the
//! identity and its public name and picture move; instructions, harness settings
//! and memberships stay behind. Neither store is ever written.
use crate::config::{agent_id, canonical_key, canonical_relay, MAX_AGENTS};
use crate::import::read_json;
use crate::{Credentials, LegacySource, Result, Secret};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PortSource {
    /// This app's harness agents, whose keys are already in its credential store.
    Harness,
    Installed,
    Development,
}
impl PortSource {
    fn legacy(self) -> Option<LegacySource> {
        match self {
            Self::Harness => None,
            Self::Installed => Some(LegacySource::Installed),
            Self::Development => Some(LegacySource::Development),
        }
    }
}

/// One identity another store holds, as it was last saved there.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Portable {
    pub source: PortSource,
    pub pubkey: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub picture: Option<String>,
    /// The community it was saved for there; the new identity uses the open one.
    pub relay: String,
}

#[derive(Debug, Default, Serialize)]
pub struct Portables {
    pub agents: Vec<Portable>,
    /// A store that could not be read; the others are still listed.
    pub warnings: Vec<String>,
}

/// The harness library file and the OS data directory old Buzz kept its own in.
#[derive(Clone)]
pub struct OldStores {
    pub harness: PathBuf,
    pub data_dir: PathBuf,
}
impl OldStores {
    /// Every identity on this machine, one per key. The harness copy wins, since
    /// reading its key needs no other app's keychain entry. A missing store adds
    /// nothing.
    pub fn list(&self) -> Portables {
        let mut found = Portables::default();
        let mut seen = BTreeSet::new();
        for source in [
            PortSource::Harness,
            PortSource::Installed,
            PortSource::Development,
        ] {
            match self.read(source) {
                Ok(agents) => found.agents.extend(
                    agents
                        .into_iter()
                        .map(|(agent, _)| agent)
                        .filter(|agent| seen.insert(agent.pubkey.clone())),
                ),
                Err(error) => found.warnings.push(error),
            }
        }
        found
    }
    /// One listed identity and its key, both re-read from the store it is in, so
    /// the caller names only its choice.
    pub fn take(
        &self,
        source: PortSource,
        pubkey: &str,
        credentials: &dyn Credentials,
    ) -> Result<(Portable, Secret)> {
        let (agent, saved) = self
            .read(source)?
            .into_iter()
            .find(|(agent, _)| agent.pubkey == pubkey)
            .ok_or("That agent is no longer saved there")?;
        let key = match source.legacy() {
            Some(_) if !saved.is_empty() => Secret::parse(&saved, pubkey)?,
            Some(legacy) => credentials.read_legacy(legacy, pubkey)?,
            None => credentials
                .read(&saved, pubkey)?
                .ok_or("That agent's key is no longer saved")?,
        };
        Ok((agent, key))
    }
    /// Its identities, each with where its key is: the harness credential ID, or
    /// the key old Buzz kept in the record itself, if it did.
    fn read(&self, source: PortSource) -> Result<Vec<(Portable, String)>> {
        let (path, records) = match source.legacy() {
            None => (self.harness.clone(), "agents"),
            Some(legacy) => (
                self.data_dir
                    .join(legacy.app_directory())
                    .join("agents/managed-agents.json"),
                "",
            ),
        };
        if !path.try_exists().unwrap_or(true) {
            return Ok(vec![]);
        }
        let file =
            read_json(&path, false).map_err(|_| format!("Could not read {}", path.display()))?;
        let records = if records.is_empty() {
            &file
        } else {
            &file[records]
        };
        let records = records
            .as_array()
            .filter(|records| records.len() <= MAX_AGENTS)
            .ok_or_else(|| format!("Could not read {}", path.display()))?;
        Ok(records
            .iter()
            .filter_map(|record| portable(source, record))
            .collect())
    }
}

fn portable(source: PortSource, record: &Value) -> Option<(Portable, String)> {
    let text = |key: &str| record.get(key).and_then(Value::as_str).unwrap_or("");
    let harness = source == PortSource::Harness;
    let pubkey = text("pubkey");
    let relay =
        canonical_relay(text(if harness { "relayUrl" } else { "relay_url" })).unwrap_or_default();
    let name = text("name").trim();
    if !canonical_key(pubkey) || name.is_empty() {
        return None;
    }
    let credential = if harness {
        Some(text("credentialId"))
            .filter(|id| !id.is_empty())
            .map_or_else(|| agent_id(pubkey, &relay), str::to_owned)
    } else {
        text("private_key_nsec").to_owned()
    };
    let picture = Some(text(if harness { "picture" } else { "avatar_url" }))
        .filter(|url| public_picture(url))
        .map(str::to_owned);
    Some((
        Portable {
            source,
            pubkey: pubkey.into(),
            name: name.into(),
            picture,
            relay,
        },
        credential,
    ))
}

/// A profile picture is a public HTTPS URL of bounded length, never inline data.
pub(crate) fn public_picture(url: &str) -> bool {
    url.len() <= 2048
        && url::Url::parse(url).is_ok_and(|url| {
            url.scheme() == "https" && url.username().is_empty() && url.password().is_none()
        })
}

#[cfg(test)]
mod tests;
