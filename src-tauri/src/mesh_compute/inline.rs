//! Mesh-owned GDK turns. Keys remain in AppAgentHost; Buzz tool callbacks carry no credentials.
use super::{agent::community_origin, MeshHost};
use buzz_mesh_agent_spike::{
    callback::Callback, local_tools::LocalTools, AgentMessage, AgentModel, ToolCall,
    ToolDefinition, ToolError, ToolResult, Tools,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::{ipc::Channel, Manager};

#[derive(Default)]
pub(super) struct Runs {
    active: Mutex<HashMap<String, Arc<Run>>>,
    page: Mutex<tokio_util::sync::CancellationToken>,
}
impl Runs {
    pub(super) fn cancel_all(&self) {
        let mut page = self.page.lock().unwrap();
        page.cancel();
        *page = tokio_util::sync::CancellationToken::new();
        for run in self.active.lock().unwrap().values() {
            run.callback.cancel.cancel();
        }
    }
}
struct Run {
    agent: String,
    lease: String,
    callback: Callback,
}
#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Frame {
    Ready {
        run: String,
    },
    Tool {
        run: String,
        id: u64,
        call: ToolCall,
    },
    Message {
        run: String,
        message: AgentMessage,
    },
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    id: String,
    agent: String,
    lease: String,
    model: String,
    workspace: String,
    system: String,
    messages: Vec<AgentMessage>,
    tools: Vec<ToolDefinition>,
}
struct TurnTools<R: tauri::Runtime> {
    local: LocalTools,
    definitions: Vec<ToolDefinition>,
    app: tauri::AppHandle<R>,
    run: Arc<Run>,
    id: String,
    events: Channel<Frame>,
}
const BUZZ_TOOLS: &[&str] = &[
    "buzz_send",
    "buzz_emoji",
    "buzz_edit",
    "buzz_react",
    "buzz_channels",
    "buzz_dm",
    "buzz_canvas",
    "buzz_media_get",
    "buzz_read",
    "buzz_members",
    "buzz_users",
    "buzz_mem_get",
    "buzz_mem_set",
];
fn current<R: tauri::Runtime>(app: &tauri::AppHandle<R>, run: &Run) -> Result<(), String> {
    if run.callback.cancel.is_cancelled() {
        return Err("Mesh turn cancelled".into());
    }
    let host = app.state::<MeshHost>();
    host.lease.community(&run.lease)?;
    if host.lifecycle.phase() != buzz_mesh_compute::lifecycle::Phase::Ready {
        return Err("Shared compute is not ready".into());
    }
    Ok(())
}
#[async_trait::async_trait]
impl<R: tauri::Runtime> Tools for TurnTools<R> {
    fn definitions(&self) -> Vec<ToolDefinition> {
        let mut tools = self.local.definitions();
        tools.extend(self.definitions.clone());
        tools
    }
    async fn call(&self, call: ToolCall) -> Result<ToolResult, ToolError> {
        let error = |e: String| ToolError::internal_error(e, None);
        current(&self.app, &self.run).map_err(error)?;
        // Recheck the native identity, not an identity supplied in tool arguments.
        let agents = self.app.state::<crate::app_agents::AppAgentHost>();
        let agent = agents.agent(self.run.agent.clone()).await.map_err(error)?;
        if agent.agent_type != "buzz.mesh-compute/mesh"
            || community_origin(&agent.relay).map_err(error)?
                != self
                    .app
                    .state::<MeshHost>()
                    .lease
                    .community(&self.run.lease)
                    .map_err(error)?
        {
            return Err(error("Agent community changed".into()));
        }
        current(&self.app, &self.run).map_err(error)?;
        if call.name.starts_with("buzz_") {
            if !self.definitions.iter().any(|t| t.name == call.name) {
                return Err(error("Tool is not available".into()));
            }
            self.run
                .callback
                .call(call, |id, call| {
                    self.events.send(Frame::Tool {
                        run: self.id.clone(),
                        id,
                        call,
                    })?;
                    Ok(())
                })
                .await
                .map_err(|e| error(e.to_string()))
        } else {
            self.local.call(call).await
        }
    }
}
struct Finish<R: tauri::Runtime>(tauri::AppHandle<R>, String);
impl<R: tauri::Runtime> Drop for Finish<R> {
    fn drop(&mut self) {
        let host = self.0.state::<MeshHost>();
        if let Some(run) = host.runs.active.lock().unwrap().remove(&self.1) {
            run.callback.cancel.cancel();
        };
    }
}
#[tauri::command]
pub async fn mesh_compute_agent_run<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request: Request,
    events: Channel<Frame>,
) -> Result<String, String> {
    let host = app.state::<MeshHost>();
    let page = host.runs.page.lock().unwrap().clone();
    if request.id.len() > 100
        || request.system.len() > 32 * 1024
        || request.messages.len() > 512
        || request.tools.len() > BUZZ_TOOLS.len()
    {
        return Err("Mesh turn input limit".into());
    }
    if request
        .tools
        .iter()
        .any(|t| !BUZZ_TOOLS.contains(&t.name.as_ref()))
    {
        return Err("Tool is not permitted".into());
    }
    let agents = app.state::<crate::app_agents::AppAgentHost>();
    let agent = agents.agent(request.agent.clone()).await?;
    if agent.agent_type != "buzz.mesh-compute/mesh"
        || community_origin(&agent.relay)? != host.lease.community(&request.lease)?
    {
        return Err("Agent is not bound to this Mesh community".into());
    }
    let run = Arc::new(Run {
        agent: request.agent,
        lease: request.lease,
        callback: Callback::new(page.child_token()),
    });
    current(&app, &run)?;
    // Capture existing selection cancellation without holding the inference lock while using its gateway.
    let (guard, selection_cancel) = host.preparing.request(&run.lease).await;
    drop(guard);
    current(&app, &run)?;
    let endpoint = host
        .inference
        .lock()
        .await
        .as_ref()
        .ok_or("Prepare inference first")?
        .base_url(&run.lease);
    {
        let mut runs = host.runs.active.lock().unwrap();
        if runs.len() >= 16 || runs.contains_key(&request.id) {
            return Err("Mesh turn already exists or capacity reached".into());
        }
        runs.insert(request.id.clone(), run.clone());
    }
    let _finish = Finish(app.clone(), request.id.clone());
    events
        .send(Frame::Ready {
            run: request.id.clone(),
        })
        .map_err(|e| e.to_string())?;
    let cwd = std::path::PathBuf::from(request.workspace);
    let roots = [
        cwd.join(".agents/skills"),
        cwd.join(".goose/skills"),
        dirs::home_dir()
            .ok_or("Home unavailable")?
            .join(".agents/skills"),
    ];
    let local =
        LocalTools::new(cwd, &roots, run.callback.cancel.clone()).map_err(|e| e.to_string())?;
    let system = format!("{}\n\n{}", request.system, local.instructions());
    let tools = TurnTools {
        local,
        definitions: request.tools,
        app: app.clone(),
        run: run.clone(),
        id: request.id.clone(),
        events: events.clone(),
    };
    let provider = buzz_mesh_agent_spike::provider(endpoint.trim_end_matches("/v1").to_owned())
        .map_err(|e| e.to_string())?;
    let mut messages = request.messages;
    let model = AgentModel::new(request.model);
    tokio::select! {
        biased;
        _ = selection_cancel.cancelled() => Err("Mesh selection retired".into()),
        result = buzz_mesh_agent_spike::run_observed(provider.as_ref(), &model, &system, &mut messages, &tools, run.callback.cancel.clone(), 24, |message| {
            if events.send(Frame::Message { run: request.id.clone(), message: message.clone() }).is_err() { run.callback.cancel.cancel(); }
        }) => result.map_err(|e| e.to_string()),
    }
}
fn find<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
    agent: &str,
) -> Result<Arc<Run>, String> {
    app.state::<MeshHost>()
        .runs
        .active
        .lock()
        .unwrap()
        .get(id)
        .filter(|r| r.agent == agent)
        .cloned()
        .ok_or("Mesh turn ended".into())
}
#[tauri::command]
pub fn mesh_compute_agent_cancel<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    id: String,
    agent: String,
) -> Result<(), String> {
    find(&app, &id, &agent)?.callback.cancel.cancel();
    Ok(())
}
#[tauri::command]
pub fn mesh_compute_agent_result<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    id: String,
    agent: String,
    call: u64,
    result: ToolResult,
) -> Result<(), String> {
    let run = find(&app, &id, &agent)?;
    current(&app, &run)?;
    run.callback
        .resolve(call, buzz_mesh_agent_spike::bounded_tool_result(result))
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn real_ipc_accepts_full_catalog_and_dispatches_run_cancel_and_result() {
        use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
        let app = mock_builder()
            .manage(MeshHost::default())
            // Stop after command admission/catalog validation, before real credentials or Mesh.
            .manage(crate::app_agents::AppAgentHost::new(
                Err("fixture identity boundary".into()),
                Err("fixture".into()),
                false,
            ))
            .invoke_handler(tauri::generate_handler![
                mesh_compute_agent_run,
                mesh_compute_agent_cancel,
                mesh_compute_agent_result
            ])
            .build(crate::app_context())
            .unwrap();
        let view = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
            .build()
            .unwrap();
        let invoke = |cmd: &str, body: serde_json::Value| {
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
            .map(|body| body.deserialize::<serde_json::Value>().unwrap())
        };
        let tools: Vec<_> = BUZZ_TOOLS.iter().map(|name| serde_json::json!({"name":name,"inputSchema":{"type":"object","properties":{}}})).collect();
        let body = serde_json::json!({"request":{"id":"fixture","agent":"agent","lease":"lease","model":"mesh","workspace":"/tmp","system":"system","messages":[],"tools":tools},"events":"__CHANNEL__:42"});
        assert_eq!(
            invoke("mesh_compute_agent_run", body),
            Err(serde_json::json!("fixture identity boundary"))
        );
        let run = Arc::new(Run {
            agent: "agent".into(),
            lease: "lease".into(),
            callback: Callback::new(tokio_util::sync::CancellationToken::new()),
        });
        app.state::<MeshHost>()
            .runs
            .active
            .lock()
            .unwrap()
            .insert("fixture".into(), run.clone());
        assert_eq!(
            invoke(
                "mesh_compute_agent_cancel",
                serde_json::json!({"id":"fixture","agent":"agent"})
            ),
            Ok(serde_json::Value::Null)
        );
        assert!(run.callback.cancel.is_cancelled());
        assert_eq!(
            invoke(
                "mesh_compute_agent_result",
                serde_json::json!({"id":"fixture","agent":"agent","call":1,"result":{"content":[]}})
            ),
            Err(serde_json::json!("Mesh turn cancelled"))
        );
    }
    #[tokio::test]
    async fn reload_fences_startup_before_registration() {
        let runs = Runs::default();
        let captured = runs.page.lock().unwrap().clone();
        let (started, entered) = tokio::sync::oneshot::channel();
        let (release, gate) = tokio::sync::oneshot::channel();
        let startup = async {
            started.send(()).unwrap();
            gate.await.unwrap();
            Callback::new(captured.child_token())
        };
        let reload = async {
            entered.await.unwrap();
            runs.cancel_all();
            release.send(()).unwrap();
        };
        let (callback, ()) = tokio::join!(startup, reload);
        assert!(callback.cancel.is_cancelled());
        assert!(!runs.page.lock().unwrap().is_cancelled());
        let call =
            serde_json::from_value(serde_json::json!({"name":"write","arguments":{}})).unwrap();
        assert!(callback
            .call(call, |_, _| panic!("retired page dispatched a tool"))
            .await
            .is_err());
    }
    #[test]
    fn renderer_request_and_native_frames_have_the_expected_wire_shape() {
        let request: Request = serde_json::from_value(serde_json::json!({
            "id":"run", "agent":"agent", "lease":"lease", "model":"mesh", "workspace":"/tmp", "system":"system",
            "messages":[{"role":"user","created":1,"content":[{"type":"text","text":"hello"}],"metadata":{"userVisible":true,"agentVisible":true}}],
            "tools":[]
        })).unwrap();
        assert_eq!(request.messages[0].as_concat_text(), "hello");
        let frame = serde_json::to_value(Frame::Tool {
            run: request.id,
            id: 2,
            call: serde_json::from_value(
                serde_json::json!({"name":"buzz_read","arguments":{"limit":10}}),
            )
            .unwrap(),
        })
        .unwrap();
        assert_eq!(
            frame,
            serde_json::json!({"type":"tool","run":"run","id":2,"call":{"name":"buzz_read","arguments":{"limit":10}}})
        );
    }
}
