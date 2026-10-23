//! The app's custody of one agent without its window, for `buzz-agent-host`,
//! which runs the agent while the app is closed. It answers the requests the
//! WebView sends for its agents (`app_agents.rs`, `agent_state.rs`) with the
//! same code: one JSON line per request on stdin, one per answer on stdout.
//! Like a dev build, it runs the agent only while the installed app does not.
//! It exits when stdin closes, and the OS then lets go of its hosting locks.
use crate::agent_state::{self, AgentState};
use crate::app_agents::{self, AppAgentHost};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex, PoisonError};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: u64,
    command: String,
    #[serde(default)]
    args: Value,
}

/// Serves custody of agent `pubkey` of the app `identifier` until stdin closes.
pub(crate) fn serve(identifier: &str, pubkey: &str) -> i32 {
    let Some(data) = dirs::data_dir() else {
        eprintln!("Could not resolve local agent storage");
        return 1;
    };
    let agents = data.join(identifier).join(crate::sign_out::AGENTS);
    let host = Arc::new(AppAgentHost::new(
        Ok(agents.join("identities.json")),
        Err("Not available without the app".into()),
        false,
    ));
    let state = Arc::new(AgentState::new(Ok(agents.join("state"))));
    let out = Arc::new(Mutex::new(std::io::stdout()));
    let pubkey: Arc<str> = pubkey.into();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let (host, state, out, pubkey) = (host.clone(), state.clone(), out.clone(), pubkey.clone());
        tauri::async_runtime::spawn(async move {
            let (id, answer) = match serde_json::from_str::<Request>(&line) {
                Ok(request) => (
                    json!(request.id),
                    answer(&host, &state, &pubkey, &request.command, &request.args).await,
                ),
                Err(_) => (Value::Null, Err("Invalid request".into())),
            };
            let line = match answer {
                Ok(value) => json!({ "id": id, "ok": value }),
                Err(error) => json!({ "id": id, "error": error }),
            };
            let mut out = out.lock().unwrap_or_else(PoisonError::into_inner);
            let _ = writeln!(out, "{line}");
            let _ = out.flush();
        });
    }
    0
}

fn arg<T: DeserializeOwned>(args: &Value, name: &str) -> Result<T, String> {
    serde_json::from_value(args.get(name).cloned().unwrap_or(Value::Null))
        .map_err(|_| format!("Invalid {name}"))
}

fn reply(value: impl Serialize) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|_| "Invalid answer".into())
}

async fn answer(
    host: &AppAgentHost,
    state: &AgentState,
    agent: &str,
    command: &str,
    args: &Value,
) -> Result<Value, String> {
    // Every agent's name, for team instructions; anything else only for its own.
    if command != "app_agent_list"
        && !command.starts_with("app_agent_state_")
        && arg::<String>(args, "pubkey")? != agent
    {
        return Err("Not this host's agent".into());
    }
    let pubkey = agent.to_owned();
    match command {
        "app_agent_list" => reply(app_agents::list(host).await?),
        "app_agent_claim" => reply(app_agents::claim(host, pubkey).await?),
        "app_agent_release" => {
            app_agents::release(host, &pubkey);
            Ok(Value::Null)
        }
        "app_agent_publish" => app_agents::publish(host, pubkey, arg(args, "event")?).await,
        "app_agent_query" => app_agents::query(host, pubkey, arg(args, "filters")?).await,
        "app_agent_search_profiles" => reply(
            app_agents::find_profiles(host, pubkey, arg(args, "query")?, arg(args, "limit")?)
                .await?,
        ),
        "app_agent_upload" => {
            app_agents::upload_blob(host, pubkey, arg(args, "data")?, arg(args, "mime")?).await
        }
        "app_agent_media" => reply(app_agents::media(host, pubkey, arg(args, "url")?).await?),
        "app_agent_git_auth" => {
            app_agents::git_auth(host, pubkey, arg(args, "owner")?, arg(args, "repo")?).await
        }
        "app_agent_remember" => {
            app_agents::remember(
                host,
                pubkey,
                arg(args, "slug")?,
                arg(args, "body")?,
                arg(args, "after")?,
            )
            .await
        }
        "app_agent_state_load" => reply(state.load()?),
        "app_agent_state_set" => reply(agent_state::save(
            state,
            arg(args, "key")?,
            arg(args, "value")?,
            arg(args, "absent")?,
        )?),
        // What the app does as the owner, this host does as the agent: it
        // hears the agent's community and reads its memory with the agent's key.
        "app_agent_login" => {
            app_agents::login(host, pubkey, arg(args, "relay")?, arg(args, "challenge")?).await
        }
        "app_agent_read_auth" => {
            app_agents::read_auth(host, pubkey, arg(args, "url")?, arg(args, "body")?).await
        }
        "app_agent_memories" => app_agents::memories(host, pubkey, arg(args, "slug")?).await,
        _ => Err("Not available without the app".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn serves_only_its_agent_and_the_shared_state() {
        let dir = tempfile::tempdir().unwrap();
        let host = AppAgentHost::new(
            Ok(dir.path().join("identities.json")),
            Err("unused".into()),
            false,
        );
        let state = AgentState::new(Ok(dir.path().join("state")));
        let agent = "a".repeat(64);
        let ask = |command: &'static str, args: Value| {
            let (host, state, agent) = (&host, &state, agent.clone());
            async move { answer(host, state, &agent, command, &args).await }
        };
        let other = json!({ "pubkey": "b".repeat(64) });
        for command in ["app_agent_claim", "app_agent_publish", "app_agent_login"] {
            assert_eq!(
                ask(command, other.clone()).await,
                Err("Not this host's agent".into())
            );
        }
        assert_eq!(
            ask("app_agent_create", json!({ "pubkey": agent })).await,
            Err("Not available without the app".into())
        );
        assert_eq!(ask("app_agent_list", Value::Null).await, Ok(json!([])));
        // A missing agent is refused by the app's own custody.
        assert!(ask(
            "app_agent_publish",
            json!({ "pubkey": agent, "event": { "kind": 9, "content": "" } })
        )
        .await
        .is_err());
        assert_eq!(
            ask("app_agent_claim", json!({ "pubkey": agent })).await,
            Ok(json!(true))
        );
        ask("app_agent_state_set", json!({ "key": "k", "value": "v" }))
            .await
            .unwrap();
        assert_eq!(
            ask(
                "app_agent_state_set",
                json!({ "key": "k", "value": "w", "absent": true })
            )
            .await,
            Ok(json!("v"))
        );
        assert_eq!(
            ask("app_agent_state_load", Value::Null).await,
            Ok(json!({ "k": "v" }))
        );
    }
}
