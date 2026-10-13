//! Log-only IFC auditing attached to the existing relay history read.
use super::{send, RelayResponse, Result};
use crate::{app_agents::AppAgentHost, identity::IdentityHost};
use buzz_agent_controller::AppAgent;
use buzz_ifc::{
    derive_execution_domain, CapabilityPolicy, CapabilitySet, CommunityId, ConversationKind,
    DomainFacts, IfcSession, OperationEffect, Principal, ResourceLabel,
};
use nostr::{event::Event, key::PublicKey};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::BTreeSet, time::Duration};
use tokio::sync::Semaphore;
use url::Url;
use uuid::Uuid;

const READ: &str = "channel.read";
// Match the existing read scheduler's lexicographic kind ordering.
const CHAT: [u16; 2] = [40002, 9];
// Auditing must neither queue unbounded work nor hold up the normal read.
static AUDITS: Semaphore = Semaphore::const_new(2);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Context {
    agent: String,
    trigger: Event,
}

pub(super) fn observe(
    host: IdentityHost,
    agents: AppAgentHost,
    url: Url,
    context: Value,
    filters: String,
    response: &RelayResponse,
) {
    let Ok(permit) = AUDITS.try_acquire() else {
        eprintln!("IFC history audit skipped: audit capacity reached");
        return;
    };

    let history = response.body.clone();
    tauri::async_runtime::spawn(async move {
        let _permit = permit;
        match tokio::time::timeout(
            Duration::from_secs(3),
            audit(&host, &agents, url, context, &filters, &history),
        )
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(error)) => eprintln!("IFC history audit failed: {error}"),
            Err(_) => eprintln!("IFC history audit failed: policy lookup timed out"),
        }
    });
}

async fn audit(
    host: &IdentityHost,
    agents: &AppAgentHost,
    mut url: Url,
    context: Value,
    filters: &str,
    history: &str,
) -> Result<()> {
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
) -> Result<()> {
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

    let capabilities = CapabilitySet::from_operations([(READ, OperationEffect::NonEgressing)]);
    let domain = derive_execution_domain(
        DomainFacts {
            community,
            channel_id: channel,
            kind: ConversationKind::DirectMessage,
            members,
            executing_agent: Principal::from_hex(&agent.pubkey)
                .map_err(|error| error.to_string())?,
            requesters: BTreeSet::from([
                Principal::from_public_key(&trigger.pubkey).map_err(|error| error.to_string())?
            ]),
            owner: Some(Principal::from_hex(&agent.owner).map_err(|error| error.to_string())?),
            system_principal: Some(
                Principal::from_public_key(&relay).map_err(|error| error.to_string())?,
            ),
        },
        &CapabilityPolicy::new(capabilities.clone(), capabilities),
    )
    .map_err(|error| error.to_string())?;

    // This is a check of one read, not a binding to Claude's retained state.
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

    Ok(())
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
