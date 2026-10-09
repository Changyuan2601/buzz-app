//! Portable definitions only. Native identities, credentials and local paths never travel.
use crate::{
    config::{Agent, SessionPolicy},
    Controller, Result,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMeta {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub instructions: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Definition {
    pub name: String,
    #[serde(default)]
    pub source_is_builtin: bool,
    #[serde(default)]
    pub name_pool: Vec<String>,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub runtime: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default = "channel_policy")]
    pub session_policy: SessionPolicy,
    #[serde(default)]
    pub respond_to: Option<String>,
    #[serde(default)]
    pub respond_to_allowlist: Vec<String>,
    #[serde(default)]
    pub parallelism: Option<u32>,
    #[serde(default)]
    pub idle_timeout_seconds: Option<u64>,
    #[serde(default)]
    pub max_turn_duration_seconds: Option<u64>,
}
fn channel_policy() -> SessionPolicy {
    SessionPolicy::Channel
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub display_name: String,
    #[serde(default)]
    pub about: Option<String>,
    #[serde(default)]
    pub avatar_data_url: Option<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    pub slug: String,
    pub body: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub level: String,
    #[serde(default)]
    pub entries: Vec<MemoryEntry>,
}
impl Memory {
    pub fn validate(&self) -> Result<()> {
        let mut slugs = std::collections::BTreeSet::new();
        let mut bytes = 0usize;
        if !matches!(self.level.as_str(), "none" | "core" | "everything")
            || self.entries.len() > 256
            || (self.level == "none" && !self.entries.is_empty())
        {
            return Err("Invalid snapshot memory".into());
        }
        for entry in &self.entries {
            let valid_slug = entry.slug == "core"
                || entry.slug.strip_prefix("mem/").is_some_and(|path| {
                    path.split('/').all(|segment| {
                        !segment.is_empty()
                            && segment.len() <= 64
                            && segment.as_bytes()[0].is_ascii_alphanumeric()
                            && segment.bytes().all(|b| {
                                b.is_ascii_lowercase() || b.is_ascii_digit() || b"_-".contains(&b)
                            })
                    })
                });
            bytes = bytes.saturating_add(entry.body.len() + entry.slug.len());
            if !valid_slug
                || entry.slug.len() > 255
                || !slugs.insert(&entry.slug)
                || (self.level == "core" && entry.slug != "core")
                || bytes > 1024 * 1024
            {
                return Err("Invalid snapshot memory entry".into());
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberSnapshot {
    pub format: String,
    pub version: u32,
    pub definition: Definition,
    pub profile: Profile,
    pub memory: Memory,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSnapshot {
    pub format: String,
    pub version: u32,
    pub team: TeamMeta,
    pub members: Vec<MemberSnapshot>,
}
impl TeamSnapshot {
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > crate::config::MAX_BYTES {
            return Err("Team snapshot exceeds the size limit".into());
        }
        let value: Self =
            serde_json::from_slice(bytes).map_err(|_| "Invalid team snapshot JSON")?;
        value.validate()?;
        Ok(value)
    }
    pub fn validate(&self) -> Result<()> {
        if self.format != "buzz-team-snapshot" || self.version != 1 {
            return Err("Unsupported team snapshot format or version".into());
        }
        if self.team.name.trim().is_empty()
            || self.team.name.len() > 256
            || self
                .team
                .description
                .as_ref()
                .is_some_and(|s| s.len() > 4096)
            || self.members.is_empty()
            || self.members.len() > 32
        {
            return Err("Invalid team snapshot name or members".into());
        }
        crate::import::team_text(&json!(self.team.instructions))?;
        if serde_json::to_vec(self)
            .map_err(|_| "Invalid team snapshot")?
            .len()
            > crate::config::MAX_BYTES
        {
            return Err("Team snapshot exceeds the size limit".into());
        }
        for member in &self.members {
            member.memory.validate()?;
            let d = &member.definition;
            if member.format != "buzz-agent-snapshot"
                || member.version != 1
                || d.name.trim().is_empty()
                || d.name.len() > 256
                || member.profile.display_name.trim().is_empty()
                || member.profile.display_name.len() > 256
                || d.runtime.as_ref().is_some_and(|s| {
                    !matches!(
                        s.as_str(),
                        "buzz-agent" | "goose" | "pi" | "hermes" | "claude" | "codex"
                    )
                })
                || d.name_pool.len() > 256
                || d.name_pool
                    .iter()
                    .any(|s| s.is_empty() || s.len() > 256 || s.contains('\0'))
                || d.model.as_ref().is_some_and(|s| s.len() > 512)
                || d.provider.as_ref().is_some_and(|s| s.len() > 128)
                || d.parallelism.is_some_and(|n| !(1..=32).contains(&n))
                || d.respond_to
                    .as_ref()
                    .is_some_and(|s| !matches!(s.as_str(), "owner-only" | "allowlist" | "anyone"))
                || d.respond_to_allowlist.len() > 2000
                || d.respond_to_allowlist
                    .iter()
                    .any(|k| !crate::config::canonical_key(k))
                || [d.idle_timeout_seconds, d.max_turn_duration_seconds]
                    .into_iter()
                    .flatten()
                    .any(|n| n == 0 || n > 86400)
                || !matches!(member.memory.level.as_str(), "none" | "core" | "everything")
                || (member.memory.level == "none" && !member.memory.entries.is_empty())
            {
                return Err("Invalid team member snapshot".into());
            }
            crate::import::team_text(&json!(d.system_prompt))?;
            for picture in [&member.profile.avatar_data_url, &member.profile.avatar_url]
                .into_iter()
                .flatten()
            {
                crate::config::validate_picture(picture)?;
            }
            // Import prefers embedded artwork for team members, then a URL.
            let picture = member
                .profile
                .avatar_data_url
                .as_deref()
                .or(member.profile.avatar_url.as_deref());
            crate::profile::initial_content(
                &member.profile.display_name,
                member.profile.about.as_deref(),
                picture,
            )?;
        }
        Ok(())
    }
}
/// Signed private catalog head, including NIP-01 replaceable-event ordering.
#[derive(Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamCatalogEntry {
    pub created_at: u64,
    pub event_id: String,
    pub members: Vec<String>,
}
impl Controller {
    pub fn reconcile_team_bindings(
        &mut self,
        community: &str,
        owner: &str,
        teams: &std::collections::BTreeMap<String, TeamCatalogEntry>,
    ) -> Result<()> {
        let relay = crate::config::canonical_relay(community)?;
        if !crate::config::canonical_key(owner)
            || teams.len() > 500
            || teams.values().any(|head| {
                !crate::config::canonical_key(&head.event_id)
                    || head
                        .members
                        .iter()
                        .any(|member| !crate::config::canonical_key(member))
            })
        {
            return Err("Invalid team catalog".into());
        }
        self.store.reconcile_team_bindings(&relay, owner, teams)
    }
    pub fn apply_team_instructions(
        &mut self,
        id: &str,
        revision: u64,
        instructions: &str,
        owner: &str,
        binding: (&str, &str),
    ) -> Result<bool> {
        let (team, community) = binding;
        self.verify_team_member_owner(id, owner)?;
        let agent = self
            .store
            .agents()?
            .into_iter()
            .find(|a| a.id == id)
            .ok_or("Agent no longer exists")?;
        let relay = crate::config::canonical_relay(community)?;
        if agent.relay_url != relay {
            return Err("Team member belongs to another community".into());
        }
        self.store
            .team_instructions(id, revision, instructions, team)
    }
    pub fn team_member_authorization(&self, id: &str, owner: &str) -> Result<String> {
        self.verify_team_member_owner(id, owner)?;
        let agent = self
            .store
            .agents()?
            .into_iter()
            .find(|a| a.id == id)
            .ok_or("Agent no longer exists")?;
        let auth = agent.auth_tag.ok_or("Missing owner authorization")?;
        crate::secret::validate_attestation(&auth, &agent.pubkey)?;
        Ok(auth)
    }
    pub fn verify_team_member_owner(&self, id: &str, owner: &str) -> Result<()> {
        let agent = self
            .store
            .agents()?
            .into_iter()
            .find(|a| a.id == id)
            .ok_or("Agent no longer exists")?;
        let tag: Vec<String> = serde_json::from_str(
            agent
                .auth_tag
                .as_deref()
                .ok_or("Missing owner authorization")?,
        )
        .map_err(|_| "Invalid owner authorization")?;
        if tag.get(1).map(String::as_str) != Some(owner) {
            return Err("Agent belongs to another owner".into());
        }
        Ok(())
    }
    pub fn export_team(
        &self,
        team: TeamMeta,
        members: &[String],
        relay: &str,
    ) -> Result<TeamSnapshot> {
        let agents = self.store.agents()?;
        let defaults = self.store.defaults()?;
        let members = members
            .iter()
            .map(|id| {
                let agent = agents
                    .iter()
                    .find(|a| &a.pubkey == id && a.relay_url == relay)
                    .ok_or("A team member is unavailable")?;
                snapshot_member(agent, &defaults)
            })
            .collect::<Result<_>>()?;
        let snapshot = TeamSnapshot {
            format: "buzz-team-snapshot".into(),
            version: 1,
            team,
            members,
        };
        snapshot.validate()?;
        Ok(snapshot)
    }
}
fn snapshot_member(
    agent: &Agent,
    defaults: &crate::agent_defaults::AgentDefaults,
) -> Result<MemberSnapshot> {
    let view = agent.view(defaults);
    let workers = view.launch_parallelism;
    let effective = crate::agent_defaults::effective(agent, defaults);
    let runtime = crate::agent_defaults::harness_kind(&effective.harness.command)
        .ok_or("Team member harness is not portable")?;
    if crate::agent_defaults::effort(&effective).is_some_and(|effort| !effort.is_empty())
        || (matches!(runtime, "pi" | "goose")
            && effective
                .environment
                .get("BUZZ_ACP_EFFORT_LEVEL")
                .is_some_and(|effort| !effort.is_empty()))
    {
        return Err("Team member effort is not portable".into());
    }
    if view.launch_model_env.is_some() || view.launch_provider_env.is_some() {
        return Err("Team member environment-selected model or provider is not portable".into());
    }
    let agent = &effective;
    let record = &agent.imported["record"];
    Ok(MemberSnapshot {
        format: "buzz-agent-snapshot".into(),
        version: 1,
        definition: Definition {
            name: agent.name.clone(),
            source_is_builtin: record["source_is_builtin"].as_bool().unwrap_or(false),
            name_pool: serde_json::from_value(record["name_pool"].clone()).unwrap_or_default(),
            system_prompt: Some(agent.system_prompt.clone()),
            runtime: Some(runtime.to_owned()),
            model: Some(agent.harness.model.clone()),
            provider: Some(agent.harness.provider.clone()),
            session_policy: agent.selected_session_policy().unwrap_or_default(),
            respond_to: Some(agent.respond_to(false)?.into()),
            respond_to_allowlist: serde_json::from_value(record["respond_to_allowlist"].clone())
                .unwrap_or_default(),
            parallelism: workers,
            idle_timeout_seconds: record["idle_timeout_seconds"].as_u64(),
            max_turn_duration_seconds: record["max_turn_duration_seconds"].as_u64(),
        },
        profile: Profile {
            display_name: agent.name.clone(),
            about: record["profile"]["about"].as_str().map(str::to_owned),
            avatar_data_url: agent.picture.clone().filter(|p| p.starts_with("data:")),
            avatar_url: agent.picture.clone().filter(|p| !p.starts_with("data:")),
        },
        memory: Memory {
            level: "none".into(),
            entries: vec![],
        },
    })
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BundleMember {
    pub team: String,
    pub member: MemberSnapshot,
    pub instructions: String,
    pub keep_allowlist: bool,
}
impl BundleMember {
    pub fn validate(&self) -> Result<()> {
        if self.team.is_empty() || self.team.len() > 120 {
            return Err("Invalid team binding".into());
        }
        let snapshot = TeamSnapshot {
            format: "buzz-team-snapshot".into(),
            version: 1,
            team: TeamMeta {
                name: "Import".into(),
                description: None,
                instructions: Some(self.instructions.clone()),
            },
            members: vec![self.member.clone()],
        };
        snapshot.validate()?;
        if !self.member.memory.entries.is_empty() {
            return Err("Memory import is unavailable; export Team only".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
