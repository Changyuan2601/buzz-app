//! Log-only IFC auditing attached to the existing relay history read.
use super::{send, RelayResponse, Result};
use crate::{app_agents::AppAgentHost, identity::IdentityHost};
use buzz_agent_controller::AppAgent;
use buzz_ifc::{
    derive_execution_domain, CapabilityPolicy, CapabilitySet, CommunityId, ConversationKind,
    DomainFacts, ExecutionDomain, IfcSession, OperationEffect, Principal, ResourceLabel,
};
use nostr::{event::Event, key::PublicKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeSet, time::Duration};
use tokio::sync::Semaphore;
use url::Url;
use uuid::Uuid;

const READ: &str = "channel.read";
// Match the existing read scheduler's lexicographic kind ordering.
const CHAT: [u16; 2] = [40002, 9];
// Bound policy work without queuing or denying the ordinary history read.
static AUDITS: Semaphore = Semaphore::const_new(2);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Context {
    agent: String,
    trigger: Event,
    history: Option<History>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct History {
    id: String,
    fresh: bool,
    binding: Value,
}

/// Versioned verified facts, stored by the trusted app with this actual history.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Binding {
    version: u8,
    session_id: String,
    community: String,
    channel: String,
    agent: String,
    owner: String,
    relay: String,
    requester: String,
    members: BTreeSet<String>,
}

impl Binding {
    fn domain(&self) -> Result<ExecutionDomain> {
        ensure(self.version == 1, "Unknown IFC binding version")?;
        let principal = |key: &str| Principal::from_hex(key).map_err(|error| error.to_string());
        let capabilities = CapabilitySet::from_operations([(READ, OperationEffect::NonEgressing)]);
        derive_execution_domain(
            DomainFacts {
                community: CommunityId::from_uuid(
                    Uuid::parse_str(&self.community).map_err(|_| "Invalid IFC bound community")?,
                ),
                channel_id: Uuid::parse_str(&self.channel)
                    .map_err(|_| "Invalid IFC bound channel")?,
                kind: ConversationKind::DirectMessage,
                members: self
                    .members
                    .iter()
                    .map(|key| principal(key))
                    .collect::<Result<_>>()?,
                executing_agent: principal(&self.agent)?,
                requesters: BTreeSet::from([principal(&self.requester)?]),
                owner: Some(principal(&self.owner)?),
                system_principal: Some(principal(&self.relay)?),
            },
            &CapabilityPolicy::new(capabilities.clone(), capabilities),
        )
        .map_err(|error| error.to_string())
    }
}

pub(super) async fn observe(
    host: &IdentityHost,
    agents: &AppAgentHost,
    url: Url,
    context: Value,
    filters: &str,
    response: &RelayResponse,
) -> Option<Binding> {
    let Ok(_permit) = AUDITS.try_acquire() else {
        eprintln!("IFC history audit skipped: audit capacity reached");
        return None;
    };

    match tokio::time::timeout(
        Duration::from_secs(3),
        audit(host, agents, url, context, filters, &response.body),
    )
    .await
    {
        Ok(Ok(binding)) => Some(binding),
        Ok(Err(error)) => {
            eprintln!("IFC history audit failed: {error}");
            None
        }
        Err(_) => {
            eprintln!("IFC history audit failed: policy lookup timed out");
            None
        }
    }
}

async fn audit(
    host: &IdentityHost,
    agents: &AppAgentHost,
    mut url: Url,
    context: Value,
    filters: &str,
    history: &str,
) -> Result<Binding> {
    let context: Context =
        serde_json::from_value(context).map_err(|_| "Invalid IFC read context")?;
    let channel = message_channel(&context.trigger)?;
    admit_history_filter(filters, channel)?;

    let agent = agents.agent(context.agent).await?;
    ensure(
        Url::parse(&agent.query_url())
            .map_err(|_| "Invalid agent community")?
            .origin()
            == url.origin(),
        "IFC history community does not match the agent",
    )?;

    // Resolve the community and relay identity from this HTTPS origin, never
    // from caller-provided keys or environment configuration.
    url.set_path("/");
    let info = send(host, url.clone(), "GET", None, false, 64 * 1024).await?;
    ensure(info.status == 200, "IFC community discovery failed")?;
    let info: Value =
        serde_json::from_str(&info.body).map_err(|_| "Invalid IFC community discovery")?;
    let relay = PublicKey::from_hex(info["self"].as_str().ok_or("Missing IFC relay identity")?)
        .map_err(|_| "Invalid IFC relay identity")?;
    ensure(
        info["read_state_snapshot"]["version"] == 1,
        "Missing IFC community identity",
    )?;
    let community = CommunityId::from_uuid(
        Uuid::parse_str(
            info["read_state_snapshot"]["community_id"]
                .as_str()
                .ok_or("Missing IFC community identity")?,
        )
        .map_err(|_| "Invalid IFC community identity")?,
    );

    url.set_path("/query");
    let policy = send(
        host,
        url,
        "POST",
        Some(
            json!([{ "kinds": [39000, 39002], "authors": [relay.to_hex()],
            "#d": [channel.to_string()], "limit": 2, "consistency": "strong" }])
            .to_string(),
        ),
        true,
        1024 * 1024,
    )
    .await?;
    ensure(policy.status == 200, "IFC DM policy lookup failed")?;

    evaluate(
        &agent,
        community,
        relay,
        &context.trigger,
        &policy.body,
        history,
        context.history.as_ref(),
    )
}

fn admit_history_filter(filters: &str, channel: Uuid) -> Result<()> {
    let filters: Value = serde_json::from_str(filters).map_err(|_| "Invalid IFC history filter")?;
    ensure(
        filters == json!([{ "kinds": CHAT, "#h": [channel.to_string()], "limit": 13 }]),
        "IFC audit requires the recent DM history filter",
    )
}

fn evaluate(
    agent: &AppAgent,
    community: CommunityId,
    relay: PublicKey,
    trigger: &Event,
    policy: &str,
    history: &str,
    retained: Option<&History>,
) -> Result<Binding> {
    let channel = message_channel(trigger)?;
    let events: Vec<Event> = serde_json::from_str(policy).map_err(|_| "Invalid IFC DM policy")?;
    let (mut metadata, mut membership) = (None, None);
    for event in &events {
        ensure(
            event.verify().is_ok()
                && event.pubkey == relay
                && exact_tag(event, "d", &channel.to_string()),
            "Unverified IFC DM policy",
        )?;
        let slot = match event.kind.as_u16() {
            39000 => &mut metadata,
            39002 => &mut membership,
            _ => return Err("Unexpected IFC DM policy event".into()),
        };
        ensure(
            slot.replace(event).is_none(),
            "Duplicate IFC DM policy event",
        )?;
    }

    let metadata = metadata.ok_or("Missing IFC DM metadata")?;
    ensure(
        exact_tag(metadata, "t", "dm")
            && metadata
                .tags
                .iter()
                .any(|tag| tag.as_slice() == ["private"])
            && !metadata.tags.iter().any(|tag| {
                matches!(
                    tag.as_slice().first().map(String::as_str),
                    Some("public" | "archived")
                )
            }),
        "IFC channel is not an active private DM",
    )?;

    let members = membership
        .ok_or("Missing IFC DM membership")?
        .tags
        .iter()
        .filter(|tag| tag.as_slice().first().is_some_and(|name| name == "p"))
        .map(|tag| {
            Principal::from_hex(tag.as_slice().get(1).ok_or("Invalid IFC member")?)
                .map_err(|error| error.to_string())
        })
        .collect::<Result<BTreeSet<_>>>()?;

    let label = ResourceLabel::from_conversation(
        community,
        channel,
        ConversationKind::DirectMessage,
        members.iter().copied(),
    )
    .map_err(|error| error.to_string())?;

    let retained = retained.ok_or("Unknown IFC retained history")?;
    ensure(!retained.id.is_empty(), "Missing IFC history id")?;
    let current = Binding {
        version: 1,
        session_id: retained.id.clone(),
        community: community.to_string(),
        channel: channel.to_string(),
        agent: agent.pubkey.clone(),
        owner: agent.owner.clone(),
        relay: relay.to_hex(),
        requester: trigger.pubkey.to_hex(),
        members: members.iter().map(Principal::to_hex).collect(),
    };
    let (binding, domain) = retained_domain(current, retained)?;

    // Reconstruct the pinned domain; unmediated input remains permanently unknown.
    let mut session = IfcSession::enter(domain);
    session.mark_unknown_input();
    session.call(READ).map_err(|error| error.to_string())?;
    session.read(&label).map_err(|error| error.to_string())?;

    let events: Vec<Event> = serde_json::from_str(history).map_err(|_| "Invalid IFC DM history")?;
    ensure(
        events.len() <= 13,
        "IFC history exceeds the requested limit",
    )?;
    for event in &events {
        ensure(
            message_channel(event)? == channel,
            "IFC history belongs to another DM",
        )?;
    }

    Ok(binding)
}

fn retained_domain(current: Binding, history: &History) -> Result<(Binding, ExecutionDomain)> {
    let current_domain = current.domain()?;
    if history.fresh && history.binding.is_null() {
        return Ok((current, current_domain));
    }
    let pinned: Binding = serde_json::from_value(history.binding.clone())
        .map_err(|_| "Unknown or invalid IFC retained-history binding")?;
    ensure(
        pinned.session_id == history.id,
        "IFC binding belongs to another history",
    )?;
    let pinned_domain = pinned.domain()?;
    if pinned_domain != current_domain {
        eprintln!("IFC retained history reused with an incompatible execution domain");
    }
    Ok((pinned, pinned_domain))
}

fn message_channel(event: &Event) -> Result<Uuid> {
    ensure(
        event.verify().is_ok() && CHAT.contains(&event.kind.as_u16()),
        "Unverified IFC DM message",
    )?;
    let channel = event
        .tags
        .iter()
        .find(|tag| tag.as_slice().first().is_some_and(|name| name == "h"))
        .and_then(|tag| tag.as_slice().get(1))
        .ok_or("Missing IFC message channel")?;
    ensure(
        exact_tag(event, "h", channel),
        "Ambiguous IFC message channel",
    )?;
    Uuid::parse_str(channel).map_err(|_| "Invalid IFC message channel".into())
}

fn exact_tag(event: &Event, name: &str, value: &str) -> bool {
    let mut tags = event
        .tags
        .iter()
        .filter(|tag| tag.as_slice().first().is_some_and(|key| key == name));
    tags.next()
        .is_some_and(|tag| tag.as_slice().get(1).is_some_and(|item| item == value))
        && tags.next().is_none()
}

fn ensure(condition: bool, message: &str) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(message.into())
    }
}

#[cfg(test)]
mod tests;
