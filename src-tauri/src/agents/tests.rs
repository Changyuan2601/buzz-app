use super::*;
use buzz_agent_controller::Secret;
use serde_json::{json, Value};
use tauri::test::{get_ipc_response, mock_builder, MockRuntime};

const RUNTIME_GATE: &str = "Synthetic runtime unavailable.";
const IMPORT_GATE: &str = "Synthetic credential refusal.";

// Test-only custody. Synthetic fixtures cannot reach PlatformCredentials.
struct RejectingCredentials;
impl Credentials for RejectingCredentials {
    fn delete(&self, _: &str, _: &str) -> Result<(), String> {
        Err(IMPORT_GATE.into())
    }
    fn read_legacy(&self, _: LegacySource, _: &str) -> Result<Secret, String> {
        Err(IMPORT_GATE.into())
    }
    fn read(&self, _: &str, _: &str) -> Result<Option<Secret>, String> {
        Err(IMPORT_GATE.into())
    }
    fn add(&self, _: &str, _: &Secret) -> Result<(), String> {
        Err(IMPORT_GATE.into())
    }
}

impl AgentHost {
    fn open(paths: Result<(PathBuf, PathBuf, PathBuf), String>) -> Self {
        Self(
            Arc::new(Mutex::new(paths.and_then(|(root, legacy, workspace)| {
                Host::open(
                    root,
                    legacy,
                    workspace,
                    Err(RUNTIME_GATE.into()),
                    Arc::new(RejectingCredentials),
                )
            }))),
            Arc::new(AtomicBool::new(false)),
            Arc::new(tokio::sync::Mutex::new(())),
            owner::Owner::Native(crate::identity::IdentityHost::fixture_owner()),
            None,
        )
    }
}

pub(crate) fn fixture() -> (
    tempfile::TempDir,
    AgentHost,
    tauri::App<MockRuntime>,
    tauri::WebviewWindow<MockRuntime>,
) {
    fixture_with_models(|dir| crate::agent_models::ModelHost::new(Ok(dir.join("store"))))
}
pub(crate) fn fixture_with_models(
    models: impl FnOnce(&std::path::Path) -> crate::agent_models::ModelHost,
) -> (
    tempfile::TempDir,
    AgentHost,
    tauri::App<MockRuntime>,
    tauri::WebviewWindow<MockRuntime>,
) {
    let dir = tempfile::tempdir().unwrap();
    let model_host = models(dir.path());
    let host = AgentHost::open(Ok((
        dir.path().join("store"),
        dir.path().join("legacy"),
        dir.path().join("workspace"),
    )));
    let app = mock_builder()
        .manage(host.clone())
        .manage(crate::harness_setup::HarnessSetup::default())
        .manage(model_host)
        .manage(crate::identity::IdentityHost::fixture())
        .invoke_handler(crate::commands())
        .build(crate::app_context())
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    (dir, host, app, view)
}
pub(crate) fn invoke(
    view: &tauri::WebviewWindow<MockRuntime>,
    cmd: &str,
    body: Value,
) -> Result<Value, Value> {
    get_ipc_response(
        view,
        tauri::webview::InvokeRequest {
            cmd: cmd.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: view.url().unwrap(),
            body: tauri::ipc::InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    )
    .map(|body| body.deserialize().unwrap())
}
pub(crate) fn seed(dir: &std::path::Path) -> String {
    let id = format!(
        "{}-{}",
        "ab".repeat(32),
        "733db93c5a38b650794422a480fab67f1dd8f6f40112c360f9814dfaec3bfcbb"
    );
    // Public artificial identity and write-only sample environment; no key custody.
    std::fs::write(dir.join("store/agents.json"), serde_json::to_vec(&json!({"version":1,"agents":[{
        "id":id, "pubkey":"ab".repeat(32), "relayUrl":"wss://relay.example", "name":"Sample", "systemPrompt":"Original",
        "workspace":dir.to_str().unwrap(), "harness":{"command":"buzz-agent","args":[],"model":"sample","provider":"sample"},
        "environment":{"SAMPLE_TOKEN":"DO_NOT_PROJECT"},"revision":1,"enabled":true,"credentialId":"missing-fixture-key", "authTag":null, "imported":{}
    }]})).unwrap()).unwrap();
    id
}
#[test]
fn native_host_provisions_cli_skill_before_agent_controls_are_used() {
    let (dir, _host, _app, _view) = fixture();
    let skill = dir
        .path()
        .join("workspace/.agents/skills/buzz-cli/SKILL.md");
    assert!(std::fs::read_to_string(skill)
        .unwrap()
        .contains("name: buzz-cli"));
}

#[test]
fn move_community_ipc_refuses_unsigned_owner_without_mutating_custody() {
    let (dir, _host, _app, view) = fixture();
    let id = seed(dir.path());
    let path = dir.path().join("store/agents.json");
    let before = std::fs::read(&path).unwrap();
    let result = invoke(
        &view,
        "agent_control_move_community",
        json!({
            "id": id, "expectedRevision": 1,
            "resolution": { "pubkey": "ab".repeat(32), "relayUrl": "wss://other.example", "owner": "cd".repeat(32), "signature": "00".repeat(64) }
        }),
    );
    assert_eq!(
        result.unwrap_err(),
        json!("Saved owner attestation is malformed")
    );
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[test]
fn move_community_ipc_preserves_custody_with_a_signed_destination() {
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use sha2::{Digest, Sha256};
    let (dir, _host, _app, view) = fixture();
    let id = seed(dir.path());
    let path = dir.path().join("store/agents.json");
    let mut document: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let key = "ab".repeat(32);
    let mut bytes = [0; 32];
    bytes[31] = 2;
    let secp = Secp256k1::new();
    let pair = Keypair::from_secret_key(&secp, &SecretKey::from_byte_array(bytes).unwrap());
    let owner = pair.x_only_public_key().0.to_string();
    let signature = |intent: String| {
        secp.sign_schnorr_no_aux_rand(&Sha256::digest(intent), &pair)
            .to_string()
    };
    document["agents"][0]["authTag"] = json!(serde_json::to_string(&[
        "auth",
        &owner,
        "",
        &signature(format!("nostr:agent-auth:{key}:"))
    ])
    .unwrap());
    document["agents"][0]["enabled"] = json!(false);
    std::fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
    let relay = "wss://other.example";
    let result = invoke(&view, "agent_control_move_community", json!({
        "id": id, "expectedRevision": 1,
        "resolution": { "pubkey": key, "relayUrl": relay, "owner": owner, "signature": signature(format!("nostr:agent-community:{key}:{relay}")) }
    })).unwrap();
    assert_eq!(result["agents"].as_array().unwrap().len(), 1);
    assert_eq!(result["agents"][0]["pubkey"], key);
    assert_eq!(result["agents"][0]["relayUrl"], relay);
    assert_eq!(result["agents"][0]["enabled"], false);
    let saved: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(
        saved["agents"][0]["credentialId"],
        document["agents"][0]["credentialId"]
    );
    assert_eq!(
        saved["agents"][0]["environment"],
        document["agents"][0]["environment"]
    );
    assert_eq!(
        saved["agents"][0]["authTag"],
        document["agents"][0]["authTag"]
    );
}

#[test]
fn production_acl_allows_delete_to_reach_native_credentials() {
    let (dir, _host, _app, view) = fixture();
    let id = seed(dir.path());
    let error = invoke(
        &view,
        "agent_control_delete",
        json!({"id": id, "expectedRevision": 1}),
    )
    .unwrap_err();
    assert_eq!(error, IMPORT_GATE);
    let stored: Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("store/agents.json")).unwrap())
            .unwrap();
    assert_eq!(stored["agents"][0]["enabled"], false);
}
#[test]
fn harnesses_classify_cli_and_adapter_separately() {
    assert_eq!(npm_status(false, false, false), "cli-needed");
    assert_eq!(npm_status(false, true, true), "cli-needed");
    assert_eq!(npm_status(true, false, false), "cli-needed");
    assert_eq!(npm_status(true, true, false), "cli-needed");
    assert_eq!(npm_status(true, false, true), "adapter-needed");
    assert_eq!(npm_status(true, true, true), "ready");
}

#[test]
fn hermes_is_a_manual_preset_with_presence_based_availability() {
    let preset = buzz_agent_controller::harness_preset("hermes-acp").unwrap();
    let missing = preset_option(preset, None);
    assert!(!missing.available);
    assert_eq!(missing.status, "cli-needed");
    assert_eq!(missing.command, "hermes-acp");
    let path = std::env::temp_dir().join("hermes-acp");
    let installed = preset_option(preset, Some(path.clone()));
    assert!(installed.available);
    assert_eq!(installed.status, "ready");
    assert_eq!(installed.command, path.to_string_lossy());
    for option in [missing, installed] {
        assert_eq!(option.install_supported, Some(false));
        assert_eq!(option.update_supported, Some(false));
        assert!(option.default_args.is_empty());
        assert!(option.providers.is_empty());
    }
}

#[test]
fn managed_pi_detection_prefers_a_complete_user_install_and_requires_managed_node() {
    let path = |name| Some(PathBuf::from(format!("/fixture/{name}")));
    let empty = || NpmTools {
        cli: None,
        adapter: None,
        node: None,
    };
    let managed = || NpmTools {
        cli: path("managed-pi"),
        adapter: path("managed-adapter"),
        node: path("managed-node"),
    };
    let (command, status, managed_selected) = npm_choice(empty(), managed());
    assert_eq!(command, path("managed-adapter"));
    assert_eq!(status, "ready");
    assert!(managed_selected);
    let (command, status, managed_selected) = npm_choice(
        NpmTools {
            cli: path("user-pi"),
            adapter: path("user-adapter"),
            node: path("user-node"),
        },
        managed(),
    );
    assert_eq!(command, path("user-adapter"));
    assert_eq!(status, "ready");
    assert!(!managed_selected);
    let (command, status, managed_selected) = npm_choice(
        NpmTools {
            cli: path("user-pi"),
            ..empty()
        },
        NpmTools {
            cli: None,
            ..managed()
        },
    );
    assert_eq!(command, path("managed-adapter"));
    assert_eq!(status, "ready");
    assert!(managed_selected);
    let (command, status, managed_selected) = npm_choice(
        empty(),
        NpmTools {
            node: None,
            ..managed()
        },
    );
    assert!(command.is_none());
    assert_eq!(status, "cli-needed");
    assert!(!managed_selected);
}

#[test]
fn restart_on_save_selects_only_live_agents_with_changed_effective_settings() {
    let before = BTreeMap::from([
        ("changed".to_owned(), json!({"model":"a"})),
        ("same".to_owned(), json!({"model":"a"})),
        ("stopped-after".to_owned(), json!({"model":"a"})),
    ]);
    let after = BTreeMap::from([
        ("changed".to_owned(), json!({"model":"b"})),
        ("same".to_owned(), json!({"model":"a"})),
        // Started during the save: not an effect of this save.
        ("started-after".to_owned(), json!({"model":"b"})),
    ]);
    assert_eq!(changed_running(before, after), ["changed"]);
}

#[test]
fn save_restart_failures_are_reported_separately_from_benign_skips() {
    let (dir, host, _app, _view) = fixture();
    let id = seed(dir.path());
    let snapshot = |enabled: bool, status, error: Option<&str>| {
        let mut snapshot = host.with(|host| host.snapshot()).unwrap();
        let agent = &mut snapshot.data.agents[0];
        agent.enabled = enabled;
        agent.status = status;
        agent.error = error.map(str::to_owned);
        Ok(snapshot)
    };
    use buzz_agent_controller::ProcessStatus::{Failed, Running, Stopped};
    assert_eq!(
        restart_outcome(&id, snapshot(true, Running, None)),
        RestartOutcome::Restarted
    );
    // A denied credential prompt returns a snapshot with the old process
    // still running the previous settings: nothing was restarted.
    let mut stale = snapshot(true, Running, Some("Keychain access was denied"));
    if let Ok(stale) = &mut stale {
        stale.data.agents[0].restart_diff = vec![buzz_agent_controller::RestartDiffEntry {
            field: "model".into(),
            change: buzz_agent_controller::RestartChange::Added,
        }];
    }
    assert_eq!(restart_outcome(&id, stale), RestartOutcome::Failed);
    // The settings were saved, but the new launch failed: warn, don't hide it.
    assert_eq!(
        restart_outcome(&id, snapshot(true, Failed, Some("Invalid launch"))),
        RestartOutcome::Failed
    );
    assert_eq!(
        restart_outcome(&id, Err("Saved agent key is unavailable".into())),
        RestartOutcome::Failed
    );
    // No longer needed, an explicit Stop, or a newer action are not failures.
    assert_eq!(
        restart_outcome(&id, Err(NO_SAVE_RESTART.into())),
        RestartOutcome::Skipped
    );
    assert_eq!(
        restart_outcome(&id, Err(START_CANCELLED.into())),
        RestartOutcome::Skipped
    );
    assert_eq!(
        restart_outcome(&id, snapshot(false, Stopped, None)),
        RestartOutcome::Skipped
    );
}

#[test]
fn disabled_live_agent_is_not_eligible_for_a_save_restart() {
    let (dir, host, _app, _view) = fixture();
    seed(dir.path());
    let mut agent = host
        .with(|host| Ok(host.controller.snapshot()?.agents.remove(0)))
        .unwrap();
    agent.status = buzz_agent_controller::ProcessStatus::Running;
    assert!(is_running(&agent));
    // A user Stop/Start after Save may already have applied the new settings.
    assert!(!needs_save_restart(&agent));
    agent.enabled = false;
    assert!(!is_running(&agent));
    assert!(!needs_save_restart(&agent));
}

#[test]
fn create_draft_model_browsing_inherits_native_provider_and_environment() {
    let (dir, host, _app, _view) = fixture();
    host.with(|host| {
        host.controller
            .save_defaults(
                serde_json::from_value(json!({
                    "harness":"buzz-agent", "provider":"databricks_v2", "model":"",
                    "effort":"", "environment":{"DATABRICKS_HOST":"https://models.example",
                        "DATABRICKS_MODEL_FILTER":"inherited-*"}
                }))
                .unwrap(),
            )
            .map(drop)
    })
    .unwrap();
    let draft = json!({
        "name":"New agent", "systemPrompt":"", "workspace":dir.path(),
        "harness":{"command":"buzz-agent","args":[],"provider":"","model":""},
        "environment":{}
    });
    let context = tauri::async_runtime::block_on(host.model_context(
        None,
        None,
        serde_json::from_value(draft.clone()).unwrap(),
    ))
    .unwrap();
    assert_eq!(context.host.as_deref(), Some("https://models.example"));
    assert_eq!(context.filter.as_deref(), Some("inherited-*"));
    let mut own = draft;
    own["harness"]["databricks"] = json!({"host":"https://own.example", "filter":"own-*"});
    let context = tauri::async_runtime::block_on(host.model_context(
        None,
        None,
        serde_json::from_value(own).unwrap(),
    ))
    .unwrap();
    assert_eq!(context.host.as_deref(), Some("https://own.example"));
    assert_eq!(context.filter.as_deref(), Some("own-*"));

    #[cfg(unix)]
    {
        let goose = dir.path().join("goose");
        crate::test_executable::write_executable(&goose, "#!/bin/sh\n");
        host.with(|host| {
            host.controller
                .save_defaults(
                    serde_json::from_value(json!({
                        "harness":"goose", "provider":"openai", "model":"",
                        "effort":"", "environment":{"GOOSE_API_KEY":"write-only-key"}
                    }))
                    .unwrap(),
                )
                .map(drop)
        })
        .unwrap();
        let draft = json!({
            "name":"New agent", "systemPrompt":"", "workspace":dir.path(),
            "harness":{"command":goose,"args":["acp"],"provider":"","model":""},
            "environment":{}
        });
        let context = tauri::async_runtime::block_on(host.goose_model_context(
            None,
            None,
            serde_json::from_value(draft).unwrap(),
        ))
        .unwrap();
        assert_eq!(context.provider_id, "openai");
        assert_eq!(context.environment["GOOSE_API_KEY"], "write-only-key");
    }
}

#[test]
fn an_invalid_pi_defaults_switch_is_refused_before_persisting_or_restarting() {
    let (dir, _host, _app, view) = fixture();
    seed(dir.path());
    let save = |edit: Value| invoke(&view, "agent_control_save_defaults", json!({"edit":edit}));
    save(
        json!({"harness":"buzz-agent","provider":"anthropic","model":"m","effort":"",
        "environment":{}}),
    )
    .unwrap();
    let before = std::fs::read(dir.path().join("store/defaults.json")).unwrap();
    // Harness-only switch: the card clears model/effort but keeps the provider.
    let error = save(
        json!({"harness":"pi","provider":"anthropic","model":"","effort":"",
        "environment":{}}),
    )
    .unwrap_err();
    assert!(error.to_string().contains("Choose a Pi model"), "{error}");
    // Nothing was committed, so no effective change can trigger a Restart.
    assert_eq!(
        std::fs::read(dir.path().join("store/defaults.json")).unwrap(),
        before
    );
}

#[test]
fn saving_defaults_never_starts_or_enables_stopped_agents() {
    let (dir, host, _app, view) = fixture();
    let id = seed(dir.path());
    let path = dir.path().join("store/agents.json");
    let mut saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    saved["agents"][0]["enabled"] = json!(false);
    saved["agents"][0]["harness"]["model"] = json!("");
    std::fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
    let result = invoke(
        &view,
        "agent_control_save_defaults",
        json!({"edit":{"harness":"buzz-agent","provider":"","model":"new-default","effort":"high",
            "environment":{"GLOBAL_TOKEN":"DO_NOT_PROJECT"}}}),
    )
    .unwrap();
    assert_eq!(result["restarted"], 0);
    assert_eq!(result["restartFailures"], 0);
    assert_eq!(result["defaultSettings"]["model"], "new-default");
    assert_eq!(
        result["defaultSettings"]["environmentKeys"],
        json!(["GLOBAL_TOKEN"])
    );
    assert!(!result.to_string().contains("DO_NOT_PROJECT"));
    assert_eq!(result["agents"][0]["status"], "stopped");
    assert_eq!(result["agents"][0]["launchModel"], "new-default");
    let saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved["agents"][0]["enabled"], false);
    assert_eq!(saved["agents"][0]["harness"]["model"], "");
    // The guard refuses a restart for an agent that is not live.
    let refused = tauri::async_runtime::block_on(start_guarded(
        host,
        id,
        Action::Restart,
        false,
        None,
        Some((needs_save_restart, "Agent no longer needs a save restart")),
    ));
    assert_eq!(
        refused.err().as_deref(),
        Some("Agent no longer needs a save restart")
    );
    let saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved["agents"][0]["enabled"], false);
}

#[test]
fn real_ipc_snapshot_save_cas_stop_and_launch_gate() {
    let (dir, _host, _app, view) = fixture();
    let id = seed(dir.path());
    let before = invoke(&view, "agent_control_snapshot", json!({})).unwrap();
    assert_eq!(before["runtimeAvailable"], false);
    assert_eq!(before["importAvailable"], cfg!(target_os = "macos"));
    assert_eq!(before["createAvailable"], true);
    // Windows omits Databricks, whose sign-in it refuses; Unix lists it first.
    let openai = json!({"value":"openai", "label":"OpenAI"});
    let mut providers = if cfg!(windows) {
        json!([openai])
    } else {
        json!([{"value":"databricks_v2", "label":"Databricks v2"}, openai])
    };
    if cfg!(feature = "mesh") {
        providers
            .as_array_mut()
            .unwrap()
            .push(json!({"value":"relay-mesh", "label":"Buzz shared compute"}));
    }
    assert_eq!(
        before["harnessOptions"][0],
        json!({
            "command":"buzz-agent", "label":"Buzz Agent",
            "available":true, "status":"ready", "defaultArgs":[],
            "providers": providers,
            "configurationPolicy": {
                "authentication": "provider", "provider": "selector",
                "supportedModes": [], "model": "optional", "effortDiscovery": "unknown",
                "selectorEnvironment": {"model": "BUZZ_AGENT_MODEL", "provider": "BUZZ_AGENT_PROVIDER"}
            }
        })
    );
    assert_eq!(before["harnessOptions"][2]["label"], "Pi");
    assert_eq!(
        before["harnessOptions"][2]["configurationPolicy"],
        json!({
            "authentication": "harnessWithOverrides", "provider": "discovered",
            "supportedModes": [], "model": "withProvider", "effortDiscovery": "unknown",
            "selectorEnvironment": null
        })
    );
    assert_eq!(
        before["harnessOptions"][1]["configurationPolicy"],
        json!({
            "authentication": "harnessWithOverrides", "provider": "selector",
            "supportedModes": [], "model": "optional", "effortDiscovery": "unknown",
            "selectorEnvironment": {"model": "GOOSE_MODEL", "provider": "GOOSE_PROVIDER"}
        })
    );
    let external_policy = json!({
        "authentication": "external", "provider": "external",
        "supportedModes": [], "model": "optional", "effortDiscovery": "unknown",
        "selectorEnvironment": null
    });
    for label in ["Hermes Agent", "Claude Code"] {
        let option = before["harnessOptions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|option| option["label"] == label)
            .unwrap();
        assert_eq!(option["configurationPolicy"], external_policy);
    }
    assert_eq!(
        before["harnessOptions"][2]["available"],
        before["harnessOptions"][2]["status"] == "ready"
    );
    assert_eq!(before["harnessOptions"][2]["defaultArgs"], json!([]));
    assert_eq!(before["harnessOptions"][2]["updateSupported"], false);
    // Pi's signed-in providers come from its catalog, never a static list.
    assert_eq!(before["harnessOptions"][2]["providers"], json!([]));
    assert_eq!(
        before["harnessOptions"][2]["status"],
        npm_status(
            buzz_agent_controller::installed("pi").is_some(),
            buzz_agent_controller::installed("buzz-pi-acp").is_some(),
            buzz_agent_controller::installed("node").is_some(),
        )
    );
    assert_eq!(before["harnessOptions"][1]["label"], "Goose");
    assert!(before["harnessOptions"][1]
        .get("installSupported")
        .is_none());
    assert_eq!(before["harnessOptions"][1]["defaultArgs"], json!([]));
    assert_eq!(before["harnessOptions"][1]["status"], "ready");
    assert_eq!(before["harnessOptions"][1]["available"], true);
    assert_eq!(before["harnessOptions"][1]["command"], "goose");
    assert!(
        before["harnessOptions"][1]["providers"]
            .as_array()
            .unwrap()
            .len()
            > 5
    );
    assert!(before["harnessOptions"][1]["providers"]
        .as_array()
        .unwrap()
        .iter()
        .any(|provider| provider["value"] == "databricks"));
    assert_eq!(before["agents"][0]["name"], "Sample");
    assert_eq!(before["agents"][0]["enabled"], true);
    assert_eq!(before["agents"][0]["status"], "stopped");
    assert!(!before.to_string().contains("DO_NOT_PROJECT"));
    for action in ["start", "restart"] {
        let err = invoke(
            &view,
            "agent_control_action",
            json!({"id":id,"action":action}),
        )
        .unwrap_err();
        assert_eq!(err, RUNTIME_GATE);
    }
    let edit = json!({"name":"Edited","systemPrompt":"Saved via IPC","workspace":dir.path().to_str().unwrap(),
        "harness":{"command":"buzz-agent","args":["--literal space"],"model":"chosen","provider":"databricks_v2"},"environment":{}});
    let saved = invoke(
        &view,
        "agent_control_save",
        json!({"id":id,"expectedRevision":1,"edit":edit}),
    )
    .unwrap();
    assert_eq!(saved["harnessOptions"], before["harnessOptions"]);
    assert_eq!(saved["runtimeAvailable"], false);
    assert_eq!(saved["importAvailable"], cfg!(target_os = "macos"));
    assert_eq!(saved["agents"][0]["harness"]["provider"], "databricks_v2");
    assert_eq!(
        saved["agents"][0]["harness"]["args"],
        json!(["--literal space"])
    );
    assert_eq!(saved["agents"][0]["revision"], 2);
    assert_eq!(saved["agents"][0]["systemPrompt"], "Saved via IPC");
    assert!(invoke(
        &view,
        "agent_control_save",
        json!({"id":id,"expectedRevision":1,"edit":edit})
    )
    .is_err());
    let stopped = invoke(
        &view,
        "agent_control_action",
        json!({"id":id,"action":"stop"}),
    )
    .unwrap();
    assert_eq!(stopped["harnessOptions"], before["harnessOptions"]);
    assert_eq!(stopped["agents"][0]["enabled"], false);
    assert_eq!(stopped["agents"][0]["revision"], 2);
    let disk: Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("store/agents.json")).unwrap())
            .unwrap();
    assert_eq!(disk["agents"][0]["systemPrompt"], "Saved via IPC");
    assert_eq!(disk["agents"][0]["harness"]["provider"], "databricks_v2");
    assert_eq!(
        invoke(&view, "agent_control_snapshot", json!({})).unwrap()["agents"][0]["harness"],
        saved["agents"][0]["harness"]
    );
    assert_eq!(disk["agents"][0]["enabled"], false);
    assert_eq!(
        disk["agents"][0]["environment"]["SAMPLE_TOKEN"],
        "DO_NOT_PROJECT"
    );
}
#[test]
fn real_ipc_preview_source_no_import_and_shutdown_fence() {
    let (dir, host, _app, view) = fixture();
    let source = dir.path().join("legacy/xyz.block.buzz.app.dev/agents");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(
        source.join("managed-agents.json"),
        serde_json::to_vec(&json!([{
            "pubkey":"79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
            "name":"Synthetic", "agent_command":"buzz-agent", "agent_args":[]
        }]))
        .unwrap(),
    )
    .unwrap();
    let preview = invoke(
        &view,
        "agent_control_import_preview",
        json!({"source":"development","destination":"wss://chosen.example"}),
    )
    .unwrap();
    // Compare path components: Windows joins with `\`, Unix with `/`.
    assert!(
        std::path::Path::new(preview["sourcePath"].as_str().unwrap())
            .ends_with("xyz.block.buzz.app.dev/agents/managed-agents.json")
    );
    assert!(invoke(
        &view,
        "agent_control_import_preview",
        json!({"source":"installed","destination":"wss://chosen.example"})
    )
    .is_err());
    assert_eq!(
        invoke(
            &view,
            "agent_control_import_commit",
            json!({"token":preview["token"],"ids":[preview["candidates"][0]["id"]]})
        )
        .unwrap_err(),
        "Import preview expired; choose the source again"
    );
    let preview = invoke(
        &view,
        "agent_control_import_preview",
        json!({"source":"development","destination":"wss://chosen.example"}),
    )
    .unwrap();
    assert_eq!(
        invoke(
            &view,
            "agent_control_import_commit",
            json!({"token":preview["token"],"ids":[preview["candidates"][0]["id"]]})
        )
        .unwrap_err(),
        IMPORT_GATE
    );
    host.shutdown().unwrap();
    assert_eq!(
        invoke(&view, "agent_control_snapshot", json!({})).unwrap_err(),
        "Agent host is shutting down"
    );
}
#[test]
fn queued_restore_skips_agent_stopped_after_launch() {
    let (dir, host, _app, view) = fixture();
    let id = seed(dir.path());
    let path = dir.path().join("store/agents.json");
    let mut saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    saved["agents"][0]["startOnAppLaunch"] = json!(true);
    std::fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
    // Restore captured this id, then the user stopped it before its turn.
    let queued = host.with(|h| h.controller.launch_ids()).unwrap();
    assert_eq!(queued, vec![id.clone()]);
    let stopped = invoke(
        &view,
        "agent_control_action",
        json!({"id":id,"action":"stop"}),
    )
    .unwrap();
    assert_eq!(stopped["agents"][0]["startOnAppLaunch"], true);
    let restored =
        tauri::async_runtime::block_on(start(host.clone(), id, Action::Start, true, None, None));
    assert_eq!(
        restored.err().as_deref(),
        Some("Agent disabled before restore")
    );
    let after = invoke(&view, "agent_control_snapshot", json!({})).unwrap();
    assert_eq!(after["agents"][0]["enabled"], false);
    // Fenced before credential/runtime checks: nothing was attempted or recorded.
    assert!(after["agents"][0]["error"].is_null());
}

// A real subprocess gate, shared by the model and launch admission regressions.
#[cfg(unix)]
struct PiProbeGate(PathBuf);
#[cfg(unix)]
impl PiProbeGate {
    fn new(root: &std::path::Path) -> Self {
        let tools = root.join("pi-tools");
        std::fs::create_dir(&tools).unwrap();
        let fifo =
            std::ffi::CString::new(tools.join("release").as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        for name in ["pi", "node", "buzz-pi-acp"] {
            let script = if name == "pi" {
                format!(
                "#!/bin/sh\n[ \"$1\" = --version ] || exit 1\n/bin/sleep 300 &\nhelper=$!\nprintf '%s %s\\n' \"$$\" \"$helper\" > '{}'\nread release < '{}'\nkill \"$helper\"\nwait \"$helper\"\nprintf '0.99.1\\n'\n",
                tools.join("started").display(), tools.join("release").display()
            )
            } else {
                "#!/bin/sh\nexit 0\n".into()
            };
            let file = tools.join(name);
            crate::test_executable::write_executable(&file, script);
        }
        Self(tools)
    }
    async fn started(&self) -> Vec<i32> {
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            let mut ticks = tokio::time::interval(std::time::Duration::from_millis(10));
            loop {
                ticks.tick().await;
                if let Ok(text) = std::fs::read_to_string(self.0.join("started")) {
                    let pids: Vec<i32> = text
                        .split_whitespace()
                        .filter_map(|v| v.parse().ok())
                        .collect();
                    if pids.len() == 2 {
                        break pids;
                    }
                }
            }
        })
        .await
        .expect("Pi probe never started")
    }
    fn release(&self) {
        use std::{io::Write, os::unix::fs::OpenOptionsExt};
        if let Ok(mut fifo) = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(self.0.join("release"))
        {
            let _ = fifo.write_all(b"continue\n");
        }
    }
}
#[cfg(unix)]
impl Drop for PiProbeGate {
    fn drop(&mut self) {
        self.release();
    }
}

#[cfg(unix)]
#[tokio::test]
async fn pi_model_probe_leaves_stop_usable_and_cancel_retires_its_group() {
    let (dir, _host, _app, view) = fixture();
    let id = seed(dir.path());
    let gate = PiProbeGate::new(dir.path());
    let ticket = invoke(&view, "agent_models_begin", json!({})).unwrap();
    let lookup = {
        let view = view.clone();
        let workspace = dir.path().to_owned();
        let adapter = gate.0.join("buzz-pi-acp");
        let ticket = ticket.clone();
        tokio::task::spawn_blocking(move || {
            invoke(
                &view,
                "agent_models_run",
                json!({"ticket": ticket, "request": {
                    "host":"", "filter":"", "action":"connect", "edit":{
                        "name":"Pi draft", "systemPrompt":"", "workspace":workspace,
                        "harness":{"command":adapter,"args":[],"provider":"","model":""}, "environment":{}
                    }
                }}),
            )
        })
    };
    let pids = gate.started().await;
    let stop = {
        let view = view.clone();
        tokio::task::spawn_blocking(move || {
            invoke(
                &view,
                "agent_control_action",
                json!({"id":id,"action":"stop"}),
            )
        })
    };
    // Observe recovery before releasing the version probe's explicit gate.
    let stopped = tokio::time::timeout(std::time::Duration::from_secs(2), stop).await;
    if stopped.is_err() {
        gate.release();
    }
    assert_eq!(
        stopped
            .expect("Stop blocked behind Pi verification")
            .unwrap()
            .unwrap()["agents"][0]["enabled"],
        false
    );
    invoke(&view, "agent_models_cancel", json!({"ticket":ticket})).unwrap();
    assert!(lookup.await.unwrap().is_err());
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let running = pids.iter().any(|pid| {
                let output = std::process::Command::new("/bin/ps")
                    .args(["-o", "stat=", "-p", &pid.to_string()])
                    .output()
                    .unwrap();
                let state = String::from_utf8(output.stdout).unwrap();
                !state.trim().is_empty() && !state.trim().starts_with('Z')
            });
            if !running {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("Cancelled probe still running");
}

// Unix-only: the synthetic bundle relies on executable-mode scripts.
#[cfg(unix)]
mod overlap {
    use super::*;

    const REFUSAL: &str = "Synthetic credential refusal";

    // Verified manifest over inert scripts. Credential refusal precedes any spawn.
    pub(super) fn synthetic_bundle(directory: &std::path::Path) -> RuntimeBundle {
        use sha2::{Digest, Sha256};
        std::fs::create_dir_all(directory).unwrap();
        let source: Value =
            serde_json::from_str(include_str!("../../../runtime/agent-runtime.json")).unwrap();
        let mut files = BTreeMap::new();
        for tool in source["tools"].as_array().unwrap() {
            let name = tool.as_str().unwrap();
            let path = directory.join(name);
            crate::test_executable::write_executable(&path, "#!/bin/sh\nexit 1\n");
            let digest = Sha256::digest(std::fs::read(&path).unwrap());
            files.insert(name.to_owned(), format!("{digest:x}"));
        }
        let manifest = json!({"version":2, "patch":source["patch"]["sha256"], "goose":source["goose"], "revision":source["revision"],
            "target":env!("TAURI_ENV_TARGET_TRIPLE"), "files":files});
        std::fs::write(
            directory.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        RuntimeBundle::new(directory.into()).unwrap()
    }

    // Each credential read reports entry, then blocks until the test releases that
    // exact credential id; an unplanned read fails fast instead of hanging.
    struct Gated {
        entered: std::sync::mpsc::Sender<String>,
        release: Mutex<BTreeMap<String, std::sync::mpsc::Receiver<()>>>,
    }
    impl Credentials for Gated {
        fn delete(&self, _: &str, _: &str) -> Result<(), String> {
            panic!("not a deletion")
        }
        fn read_legacy(&self, _: LegacySource, _: &str) -> Result<Secret, String> {
            panic!("not an import")
        }
        fn add(&self, _: &str, _: &Secret) -> Result<(), String> {
            panic!("not a write")
        }
        fn read(&self, id: &str, pubkey: &str) -> Result<Option<Secret>, String> {
            self.entered.send(id.to_owned()).unwrap();
            let gate = self.release.lock().unwrap().remove(id);
            gate.ok_or("Unplanned credential read")?.recv().unwrap();
            if pubkey == "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" {
                Secret::parse(
                    "0000000000000000000000000000000000000000000000000000000000000001",
                    pubkey,
                )
                .map(Some)
            } else {
                Err(REFUSAL.into())
            }
        }
    }
    struct Gate {
        entered: Arc<Mutex<std::sync::mpsc::Receiver<String>>>,
        release: BTreeMap<String, std::sync::mpsc::Sender<()>>,
    }
    impl Gate {
        fn install(host: &AgentHost, dir: &std::path::Path, ids: &[&str]) -> Self {
            let (entered, receive) = std::sync::mpsc::channel();
            let (mut release, mut wait) = (BTreeMap::new(), BTreeMap::new());
            for id in ids {
                let (send, receive) = std::sync::mpsc::channel();
                release.insert((*id).to_owned(), send);
                wait.insert((*id).to_owned(), receive);
            }
            let credentials: Arc<dyn Credentials> = Arc::new(Gated {
                entered,
                release: Mutex::new(wait),
            });
            host.with(|h| {
                // Drop the fixture's store lock before reopening the same store.
                h.controller = Controller::new(
                    Store::open(dir.join("replacement"))?,
                    credentials.clone(),
                    Err("placeholder".into()),
                    dir.join("ownership"),
                );
                h.controller = Controller::new(
                    Store::open(dir.join("store"))?,
                    credentials.clone(),
                    Ok(synthetic_bundle(&dir.join("tools"))),
                    dir.join("ownership"),
                );
                h.credentials = credentials;
                h.legacy_check = || Ok(());
                Ok(())
            })
            .unwrap();
            Self {
                entered: Arc::new(Mutex::new(receive)),
                release,
            }
        }
        async fn entered(&self) -> String {
            let entered = self.entered.clone();
            tokio::task::spawn_blocking(move || {
                entered
                    .lock()
                    .unwrap()
                    .recv_timeout(std::time::Duration::from_secs(5))
            })
            .await
            .unwrap()
            .expect("credential read did not start")
        }
        fn idle(&self) -> bool {
            self.entered.lock().unwrap().try_recv().is_err()
        }
    }
    // Two launch-enabled agents with distinct credential ids.
    fn seed_pair(dir: &std::path::Path) -> Vec<String> {
        let suffix = "733db93c5a38b650794422a480fab67f1dd8f6f40112c360f9814dfaec3bfcbb";
        let agents: Vec<Value> = ["ab", "cd"]
            .iter()
            .map(|byte| {
                let pubkey = byte.repeat(32);
                json!({"id":format!("{pubkey}-{suffix}"), "pubkey":pubkey, "relayUrl":"wss://relay.example",
                    "name":format!("Sample {byte}"), "systemPrompt":"Original", "workspace":dir.to_str().unwrap(),
                    "harness":{"command":"buzz-agent","args":[],"model":"sample","provider":"sample"},
                    "environment":{}, "revision":1, "enabled":true, "startOnAppLaunch":true,
                    "credentialId":format!("cred-{byte}"), "authTag":null, "imported":{}})
            })
            .collect();
        let ids = agents
            .iter()
            .map(|a| a["id"].as_str().unwrap().to_owned())
            .collect();
        std::fs::write(
            dir.join("store/agents.json"),
            serde_json::to_vec(&json!({"version":1,"agents":agents})).unwrap(),
        )
        .unwrap();
        ids
    }
    fn credential(id: &str) -> String {
        format!("cred-{}", &id[..2])
    }
    fn agent<'a>(snapshot: &'a Value, id: &str) -> &'a Value {
        snapshot["agents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["id"] == id)
            .unwrap()
    }
    async fn within<T>(task: tokio::task::JoinHandle<T>) -> T {
        tokio::time::timeout(std::time::Duration::from_secs(5), task)
            .await
            .expect("task did not finish")
            .unwrap()
    }

    #[tokio::test]
    async fn stop_during_pi_version_probe_fences_the_late_result() {
        let (dir, host, _app, view) = fixture();
        let ids = seed_pair(dir.path());
        let probe = PiProbeGate::new(dir.path());
        let path = dir.path().join("store/agents.json");
        let mut saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        saved["agents"][0]["harness"] =
            json!({"command":probe.0.join("buzz-pi-acp"),"args":[],"provider":"","model":""});
        std::fs::write(path, serde_json::to_vec(&saved).unwrap()).unwrap();
        let credentials = Gate::install(&host, dir.path(), &["cred-ab"]);
        let starting = {
            let host = host.clone();
            let id = ids[0].clone();
            tokio::spawn(start(host, id, Action::Start, false, None, None))
        };
        probe.started().await;
        let stop = {
            let view = view.clone();
            let id = ids[0].clone();
            tokio::task::spawn_blocking(move || {
                invoke(
                    &view,
                    "agent_control_action",
                    json!({"id":id,"action":"stop"}),
                )
            })
        };
        let stopped = tokio::time::timeout(std::time::Duration::from_secs(2), stop).await;
        probe.release();
        credentials.release["cred-ab"].send(()).unwrap();
        assert_eq!(
            stopped
                .expect("Stop blocked behind Pi verification")
                .unwrap()
                .unwrap()["agents"][0]["enabled"],
            false
        );
        assert_eq!(
            within(starting).await.err().as_deref(),
            Some(START_CANCELLED)
        );
        assert!(
            credentials.idle(),
            "Stopped launch opened credentials after the probe"
        );
        let snapshot = invoke(&view, "agent_control_snapshot", json!({})).unwrap();
        assert_eq!(agent(&snapshot, &ids[0])["enabled"], false);
        assert_eq!(agent(&snapshot, &ids[0])["status"], "stopped");
    }

    // A is ahead of B in restore's sorted queue; only B has a usable test key.
    fn seed_replay_pair(dir: &std::path::Path) -> (String, String) {
        seed_pair(dir);
        let path = dir.join("store/agents.json");
        let mut saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let mut ids = Vec::new();
        for (i, pubkey) in [
            "11".repeat(32),
            "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798".into(),
        ]
        .iter()
        .enumerate()
        {
            let id = saved["agents"][i]["id"].as_str().unwrap().replacen(
                &if i == 0 { "ab" } else { "cd" }.repeat(32),
                pubkey,
                1,
            );
            saved["agents"][i]["id"] = json!(id);
            saved["agents"][i]["pubkey"] = json!(pubkey);
            ids.push(id);
        }
        std::fs::write(path, serde_json::to_vec(&saved).unwrap()).unwrap();
        (ids.remove(0), ids.remove(0))
    }

    #[tokio::test]
    async fn mentions_coalesce_through_queued_waiting_and_starting_into_launch_input() {
        let (dir, host, _app, view) = fixture();
        let (_, id) = seed_replay_pair(dir.path());
        let gate = Gate::install(&host, dir.path(), &["cred-ab", "cred-cd"]);
        let owner = host.clone();
        let restore = tokio::spawn(async move { owner.restore().await });
        assert_eq!(gate.entered().await, "cred-ab");
        // A confirmed send already thirty seconds old, well beyond the runner's
        // five-second default window. No wall-clock sleep controls this ordering.
        let sent = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            - 30;
        for floor in [sent + 2, sent, sent + 1] {
            invoke(
                &view,
                "agent_control_attach_mention",
                json!({"id":id,"expectedRevision":1,"replayFloor":floor}),
            )
            .unwrap();
        }
        assert!(
            gate.idle(),
            "attaching a queued mention must not acquire credentials"
        );
        gate.release["cred-ab"].send(()).unwrap();
        assert_eq!(gate.entered().await, "cred-cd");
        assert_eq!(
            host.with(|h| Ok(h.starts[&id].replay_floor)).unwrap(),
            Some(sent)
        );
        invoke(
            &view,
            "agent_control_attach_mention",
            json!({"id":id,"expectedRevision":1,"replayFloor":sent - 1}),
        )
        .unwrap();
        // Starting is still before final launch admission and must accept input.
        host.with(|h| {
            h.starts.get_mut(&id).unwrap().status = ProcessStatus::Starting;
            Ok(())
        })
        .unwrap();
        invoke(
            &view,
            "agent_control_attach_mention",
            json!({"id":id,"expectedRevision":1,"replayFloor":sent - 2}),
        )
        .unwrap();
        // Consume the exact input at final admission without launching a native
        // test harness as the app supervisor. Controller's subprocess regression
        // separately checks action_with_key forwards this input into the runner.
        let replay = host
            .with(|h| {
                let ticket = h.starts[&id].ticket;
                h.take_start(&id, ticket)
            })
            .unwrap();
        gate.release["cred-cd"].send(()).unwrap();
        within(restore).await;
        assert_eq!(replay.replay_floor, Some(sent - 2));
        assert!(gate.idle());
        assert!(host.with(|h| Ok(h.starts.is_empty())).unwrap());
        assert!(invoke(
            &view,
            "agent_control_attach_mention",
            json!({"id":id,"expectedRevision":1,"replayFloor":sent})
        )
        .is_err());
        assert!(
            !std::fs::read_to_string(dir.path().join("store/agents.json"))
                .unwrap()
                .contains(&(sent - 2).to_string())
        );
    }

    #[tokio::test]
    async fn queued_replay_cannot_survive_stop_or_revision_change() {
        for stop in [true, false] {
            let (dir, host, _app, view) = fixture();
            let (_, id) = seed_replay_pair(dir.path());
            let gate = Gate::install(&host, dir.path(), &["cred-ab"]);
            let owner = host.clone();
            let restore = tokio::spawn(async move { owner.restore().await });
            assert_eq!(gate.entered().await, "cred-ab");
            invoke(
                &view,
                "agent_control_attach_mention",
                json!({"id":id,"expectedRevision":1,"replayFloor":100}),
            )
            .unwrap();
            if stop {
                invoke(
                    &view,
                    "agent_control_action",
                    json!({"id":id,"action":"stop"}),
                )
                .unwrap();
                assert!(invoke(
                    &view,
                    "agent_control_attach_mention",
                    json!({"id":id,"expectedRevision":1,"replayFloor":90})
                )
                .is_err());
            } else {
                let path = dir.path().join("store/agents.json");
                let mut saved: Value =
                    serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
                saved["agents"][1]["revision"] = json!(2);
                std::fs::write(path, serde_json::to_vec(&saved).unwrap()).unwrap();
                assert!(invoke(
                    &view,
                    "agent_control_attach_mention",
                    json!({"id":id,"expectedRevision":2,"replayFloor":90})
                )
                .is_err());
            }
            gate.release["cred-ab"].send(()).unwrap();
            within(restore).await;
            assert!(
                gate.idle(),
                "cancelled/changed queued replay must not acquire credentials"
            );
            let observed = invoke(&view, "agent_control_snapshot", json!({})).unwrap();
            assert_eq!(
                agent(&observed, &id)["status"],
                if stop { "stopped" } else { "failed" }
            );
        }
    }

    #[tokio::test]
    async fn restore_read_failure_clears_seeded_waiting_and_allows_explicit_retry() {
        let (dir, host, _app, _view) = fixture();
        let id = seed_pair(dir.path())[0].clone();
        // Reopen so Host::open, not the test, seeds the queue.
        *host.0.lock().unwrap() = Err("retired".into());
        let fresh = AgentHost::open(Ok((
            dir.path().join("store"),
            dir.path().join("legacy"),
            dir.path().join("workspace"),
        )));
        assert!(fresh
            .with(|h| Ok(h.snapshot()?.data.agents[0].status == ProcessStatus::Waiting))
            .unwrap());
        let path = dir.path().join("store/agents.json");
        let saved = std::fs::read(&path).unwrap();
        std::fs::write(&path, "malformed").unwrap();
        fresh.restore().await;
        std::fs::write(path, saved).unwrap();
        let snapshot = fresh.with(|h| h.snapshot()).unwrap();
        assert!(snapshot
            .data
            .agents
            .iter()
            .all(|a| a.status == ProcessStatus::Failed
                && a.error.as_deref() == Some("Saved agents are malformed; left unchanged")));
        assert!(fresh.with(|h| Ok(h.queued.is_empty())).unwrap());
        let gate = Gate::install(&fresh, dir.path(), &["cred-ab"]);
        gate.release["cred-ab"].send(()).unwrap();
        let retried = start(fresh.clone(), id.clone(), Action::Start, false, None, None)
            .await
            .unwrap();
        assert_eq!(gate.entered().await, "cred-ab");
        assert_eq!(
            retried
                .data
                .agents
                .iter()
                .find(|a| a.id == id)
                .unwrap()
                .error
                .as_deref(),
            Some(REFUSAL)
        );
    }

    #[tokio::test]
    async fn broker_owner_gates_restore_manual_restart_and_wake_before_credentials() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for lane in ["restore", "manual", "restart", "wake", "wrong-owner"] {
            let (dir, mut host, _app, _view) = fixture();
            let id = seed_pair(dir.path())[0].clone();
            let gate = Gate::install(&host, dir.path(), &[&credential(&id)]);
            let expected = crate::identity::IdentityHost::fixture_owner()
                .viewer()
                .await
                .unwrap();
            let attested = if lane == "wrong-owner" {
                crate::identity::IdentityHost::fixture()
                    .viewer()
                    .await
                    .unwrap()
            } else {
                expected.clone()
            };
            let path = dir.path().join("store/agents.json");
            let mut saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            saved["agents"]
                .as_array_mut()
                .unwrap()
                .retain(|a| a["id"] == id);
            saved["agents"][0]["authTag"] = json!(json!(["auth", attested, "", "sig"]).to_string());
            std::fs::write(path, serde_json::to_vec(&saved).unwrap()).unwrap();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap())
                .parse()
                .unwrap();
            host.3 = owner::Owner::select(
                crate::identity::IdentityHost::fixture(),
                true,
                Some(&expected),
                Some(&url),
            );
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                let received = stream.read(&mut request).await.unwrap();
                assert!(received > 0, "broker connection closed before request");
                let body = json!({"viewer":expected}).to_string();
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            });
            gate.release[&credential(&id)].send(()).unwrap();
            let result = if lane == "restore" {
                host.restore().await;
                host.with(|h| h.snapshot()).unwrap()
            } else {
                start(
                    host.clone(),
                    id.clone(),
                    if lane == "restart" {
                        Action::Restart
                    } else {
                        Action::Start
                    },
                    false,
                    (lane == "wake").then_some(1),
                    None,
                )
                .await
                .unwrap()
            };
            server.await.unwrap();
            let error = result
                .data
                .agents
                .iter()
                .find(|a| a.id == id)
                .unwrap()
                .error
                .as_deref()
                .unwrap();
            if lane == "wrong-owner" {
                assert!(error.contains("different Buzz identity"), "{error}");
                assert!(gate.idle());
            } else {
                assert_eq!(
                    error, REFUSAL,
                    "{lane}: matching broker passes ownership, not unrelated native key"
                );
                assert_eq!(gate.entered().await, credential(&id));
            }
            assert!(host.with(|h| Ok(h.starts.is_empty())).unwrap());
        }
    }

    #[tokio::test]
    async fn stop_during_broker_read_prevents_agent_key_access() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (dir, mut host, _app, _view) = fixture();
        let id = seed_pair(dir.path())[0].clone();
        let gate = Gate::install(&host, dir.path(), &[&credential(&id)]);
        let expected = crate::identity::IdentityHost::fixture_owner()
            .viewer()
            .await
            .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap())
            .parse()
            .unwrap();
        host.3 = owner::Owner::select(
            crate::identity::IdentityHost::fixture(),
            true,
            Some(&expected),
            Some(&url),
        );
        let (entered, entry) = tokio::sync::oneshot::channel();
        let (release, released) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let received = stream.read(&mut request).await.unwrap();
            assert!(received > 0, "broker connection closed before request");
            entered.send(()).unwrap();
            released.await.unwrap();
            let body = json!({"viewer":expected}).to_string();
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });
        let starting = tokio::spawn({
            let (host, id) = (host.clone(), id.clone());
            async move { start(host, id, Action::Start, false, None, None).await }
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), entry)
            .await
            .unwrap()
            .unwrap();
        let stopped = run(host.clone(), move |h| h.action(&id, Action::Stop))
            .await
            .unwrap();
        assert!(stopped.data.agents.iter().any(|a| !a.enabled));
        assert!(gate.idle());
        // Release credential gate too so a regressed implementation fails rather than hangs.
        for release in gate.release.values() {
            release.send(()).unwrap();
        }
        release.send(()).unwrap();
        assert_eq!(
            starting.await.unwrap().err().as_deref(),
            Some(START_CANCELLED)
        );
        server.await.unwrap();
        assert!(
            gate.idle(),
            "Stop must prevent agent-key access after broker read"
        );
        assert!(host.with(|h| Ok(h.starts.is_empty())).unwrap());
    }

    #[tokio::test]
    async fn queued_start_preparation_cannot_overtake_a_later_stop() {
        let (dir, host, _app, _view) = fixture();
        let id = seed_pair(dir.path())[0].clone();
        let credential = credential(&id);
        let gate = Gate::install(&host, dir.path(), &[&credential]);
        let admission = host.2.clone().lock_owned().await;
        let mut starting = std::pin::pin!(start(
            host.clone(),
            id.clone(),
            Action::Start,
            false,
            None,
            None
        ));
        assert_pending(starting.as_mut()).await;
        let target = id.clone();
        let mut stopping =
            std::pin::pin!(run(host.clone(), move |h| h.action(&target, Action::Stop)));
        assert_pending(stopping.as_mut()).await;
        drop(admission);
        let release = async {
            let stopped = stopping.await;
            // A Stop queued behind Start preparation cancels Start before
            // credential access after tool discovery.
            assert!(gate.idle(), "cancelled Start opened credentials");
            assert!(
                !stopped
                    .unwrap()
                    .data
                    .agents
                    .iter()
                    .find(|a| a.id == id)
                    .unwrap()
                    .enabled
            );
        };
        let (started, ()) = tokio::join!(starting, release);
        assert!(gate.idle(), "late credential read followed cancellation");
        assert_eq!(
            started.err().as_deref(),
            Some("Start cancelled by a newer action")
        );
    }

    #[tokio::test]
    async fn overlapping_restore_honors_intervening_stop_and_start_then_fresh_host_resets() {
        let (dir, host, _app, view) = fixture();
        let ids = seed_pair(dir.path());
        let creds: Vec<String> = ids.iter().map(|id| credential(id)).collect();
        let gate = Gate::install(&host, dir.path(), &[&creds[0], &creds[1]]);
        let queued = host.with(|h| h.controller.launch_ids()).unwrap();
        let (first, second) = (queued[0].clone(), queued[1].clone());
        let owner = host.clone();
        let restore = tokio::spawn(async move { owner.restore().await });
        // Restore waits on the first agent's credential while the user acts.
        assert_eq!(gate.entered().await, credential(&first));
        let waiting = invoke(&view, "agent_control_snapshot", json!({})).unwrap();
        assert_eq!(agent(&waiting, &first)["status"], "waiting");
        assert_eq!(agent(&waiting, &second)["status"], "waiting");
        // Native admission, not only disabled buttons, rejects overlapping Start.
        let duplicate = start(
            host.clone(),
            first.clone(),
            Action::Start,
            false,
            None,
            None,
        )
        .await;
        assert_eq!(
            duplicate.err().as_deref(),
            Some("Agent start already in progress; use Stop to cancel")
        );
        assert!(gate.idle());
        let stopped = invoke(
            &view,
            "agent_control_action",
            json!({"id":first,"action":"stop"}),
        )
        .unwrap();
        assert_eq!(agent(&stopped, &first)["enabled"], false);
        let explicit = tokio::task::spawn_blocking({
            let (view, second) = (view.clone(), second.clone());
            move || {
                invoke(
                    &view,
                    "agent_control_action",
                    json!({"id":second,"action":"start"}),
                )
            }
        });
        assert_eq!(gate.entered().await, credential(&second));
        // Late completion of the stopped restore; restore then reaches the agent
        // the user started and must neither read again nor cancel that Start.
        gate.release[&credential(&first)].send(()).unwrap();
        within(restore).await;
        assert!(
            gate.idle(),
            "restore read a credential after an explicit action"
        );
        assert!(host.with(|h| Ok(h.starts.contains_key(&second))).unwrap());
        let middle = invoke(&view, "agent_control_snapshot", json!({})).unwrap();
        assert!(agent(&middle, &first)["error"].is_null());
        assert_eq!(agent(&middle, &first)["enabled"], false);
        assert_eq!(agent(&middle, &first)["status"], "stopped");
        assert_eq!(agent(&middle, &second)["status"], "waiting");
        gate.release[&credential(&second)].send(()).unwrap();
        let started = within(explicit).await.unwrap();
        assert_eq!(agent(&started, &second)["error"], REFUSAL);
        assert_eq!(agent(&started, &second)["status"], "failed");
        assert!(agent(&started, &first)["error"].is_null());

        // A fresh host has no action history: both launch preferences restore.
        *host.0.lock().unwrap() = Err("retired".into());
        let fresh = AgentHost::open(Ok((
            dir.path().join("store"),
            dir.path().join("legacy"),
            dir.path().join("workspace"),
        )));
        let gate = Gate::install(&fresh, dir.path(), &[&creds[0], &creds[1]]);
        let owner = fresh.clone();
        let restore = tokio::spawn(async move { owner.restore().await });
        for id in [&first, &second] {
            assert_eq!(gate.entered().await, credential(id));
            gate.release[&credential(id)].send(()).unwrap();
        }
        within(restore).await;
        let after = fresh.with(|h| h.snapshot()).unwrap();
        let after = serde_json::to_value(after).unwrap();
        for id in [&first, &second] {
            assert_eq!(agent(&after, id)["error"], REFUSAL);
            assert_eq!(agent(&after, id)["startOnAppLaunch"], true);
        }
        fresh.shutdown().unwrap();
    }

    #[tokio::test]
    async fn refused_acquisition_never_projects_starting_between_admissions() {
        let (dir, host, _app, _view) = fixture();
        let id = seed_pair(dir.path())[0].clone();
        let credential = credential(&id);
        let gate = Gate::install(&host, dir.path(), &[&credential]);
        let mut pending = std::pin::pin!(start(
            host.clone(),
            id.clone(),
            Action::Start,
            false,
            None,
            None
        ));
        tokio::select! {
            result = &mut pending => panic!("start finished before credential release: {}", result.is_ok()),
            entered = gate.entered() => assert_eq!(entered, credential),
        }
        let waiting = host.with(|h| h.snapshot()).unwrap();
        assert_eq!(
            agent(&serde_json::to_value(waiting).unwrap(), &id)["status"],
            "waiting"
        );
        gate.release[&credential].send(()).unwrap();
        // Drive only one poll of Start between snapshots. FIFO admission makes
        // each scheduled transition observable before Start can schedule another,
        // including the former erroneous Starting admission after refusal.
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let completed = std::future::poll_fn(|cx| {
                    use std::future::Future;
                    std::task::Poll::Ready(match pending.as_mut().poll(cx) {
                        std::task::Poll::Ready(result) => Some(result),
                        std::task::Poll::Pending => None,
                    })
                })
                .await;
                let snapshot = run(host.clone(), |h| h.snapshot()).await.unwrap();
                let snapshot = serde_json::to_value(snapshot).unwrap();
                assert_ne!(agent(&snapshot, &id)["status"], "starting");
                if let Some(result) = completed {
                    result.unwrap();
                    assert_eq!(agent(&snapshot, &id)["status"], "failed");
                    assert_eq!(agent(&snapshot, &id)["error"], REFUSAL);
                    break;
                }
            }
        })
        .await
        .expect("refused start did not settle");
    }

    #[tokio::test]
    async fn native_start_projects_launch_integrity_failure_after_acquiring_key() {
        let (dir, host, _app, view) = fixture();
        seed_pair(dir.path());
        let path = dir.path().join("store/agents.json");
        let mut saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let pubkey = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
        let id = saved["agents"][0]["id"]
            .as_str()
            .unwrap()
            .replacen(&"ab".repeat(32), pubkey, 1);
        saved["agents"][0]["pubkey"] = json!(pubkey);
        saved["agents"][0]["id"] = json!(id);
        std::fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
        let gate = Gate::install(&host, dir.path(), &["cred-ab"]);
        // Bundle initialization succeeded, but launch must recheck these bytes.
        std::fs::write(dir.path().join("tools/buzz-agent"), "tampered").unwrap();
        let pending = tokio::task::spawn_blocking({
            let (view, id) = (view.clone(), id.clone());
            move || {
                invoke(
                    &view,
                    "agent_control_action",
                    json!({"id":id,"action":"start"}),
                )
            }
        });
        assert_eq!(gate.entered().await, "cred-ab");
        gate.release["cred-ab"].send(()).unwrap();
        let result = within(pending).await.unwrap();
        let failed = agent(&result, &id);
        assert_eq!(failed["status"], "failed");
        assert!(failed["error"].as_str().unwrap().contains("integrity"));
        assert!(failed["runningRevision"].is_null());
        assert_eq!(failed["enabled"], true);
        assert_eq!(failed["startOnAppLaunch"], true);
        assert!(host.with(|h| Ok(h.starts.is_empty())).unwrap());
        let observed = invoke(&view, "agent_control_snapshot", json!({})).unwrap();
        assert_eq!(agent(&observed, &id), failed);
    }

    #[tokio::test]
    async fn acquired_key_cannot_escape_stop_quit_or_saved_revision_fences() {
        for boundary in ["stop", "quit", "save"] {
            let (dir, host, _app, view) = fixture();
            seed_pair(dir.path());
            let path = dir.path().join("store/agents.json");
            let mut saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            let pubkey = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
            let id =
                saved["agents"][0]["id"]
                    .as_str()
                    .unwrap()
                    .replacen(&"ab".repeat(32), pubkey, 1);
            saved["agents"][0]["pubkey"] = json!(pubkey);
            saved["agents"][0]["id"] = json!(id);
            std::fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
            let gate = Gate::install(&host, dir.path(), &["cred-ab"]);
            let (owner, target) = (host.clone(), id.clone());
            let pending = tokio::spawn(async move {
                start(owner, target, Action::Start, false, None, None).await
            });
            assert_eq!(gate.entered().await, "cred-ab");
            let waiting = invoke(&view, "agent_control_snapshot", json!({})).unwrap();
            assert_eq!(agent(&waiting, &id)["status"], "waiting");
            invoke(
                &view,
                "agent_control_attach_mention",
                json!({"id":id,"expectedRevision":1,"replayFloor":100}),
            )
            .unwrap();
            match boundary {
                "stop" => {
                    invoke(
                        &view,
                        "agent_control_action",
                        json!({"id":id,"action":"stop"}),
                    )
                    .unwrap();
                }
                "quit" => {
                    host.shutdown().unwrap();
                }
                _ => {
                    saved["agents"][0]["revision"] = json!(2);
                    std::fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
                }
            }
            gate.release["cred-ab"].send(()).unwrap();
            let result = within(pending).await;
            if boundary == "save" {
                let result = serde_json::to_value(result.unwrap()).unwrap();
                assert_eq!(agent(&result, &id)["status"], "failed");
                assert!(agent(&result, &id)["error"]
                    .as_str()
                    .unwrap()
                    .contains("Saved settings changed"));
                assert!(agent(&result, &id)["runningRevision"].is_null());
            } else {
                assert!(result.is_err());
            }
        }
    }

    // Eligibility can lapse while the OS credential prompt is open (e.g. the
    // listener exits). The guard must be re-checked before Restart enables it.
    #[test]
    fn save_restart_rechecks_eligibility_after_the_credential_prompt() {
        use std::sync::atomic::{AtomicBool, Ordering};
        const KEY: &str = "0000000000000000000000000000000000000000000000000000000000000001";
        const PUB: &str = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
        static ELIGIBLE: AtomicBool = AtomicBool::new(true);
        struct Lapsing;
        impl Credentials for Lapsing {
            fn delete(&self, _: &str, _: &str) -> Result<(), String> {
                panic!("not a deletion")
            }
            fn read_legacy(&self, _: LegacySource, _: &str) -> Result<Secret, String> {
                panic!("not an import")
            }
            fn add(&self, _: &str, _: &Secret) -> Result<(), String> {
                panic!("not a write")
            }
            fn read(&self, _: &str, pubkey: &str) -> Result<Option<Secret>, String> {
                ELIGIBLE.store(false, Ordering::SeqCst);
                Secret::parse(KEY, pubkey).map(Some)
            }
        }
        fn eligible(_: &buzz_agent_controller::AgentView) -> bool {
            ELIGIBLE.load(Ordering::SeqCst)
        }
        let (dir, host, _app, _view) = fixture();
        let id = seed(dir.path());
        let path = dir.path().join("store/agents.json");
        let mut saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let id = id.replacen(&"ab".repeat(32), PUB, 1);
        saved["agents"][0]["id"] = json!(id);
        saved["agents"][0]["pubkey"] = json!(PUB);
        saved["agents"][0]["credentialId"] = json!(id);
        saved["agents"][0]["enabled"] = json!(false);
        std::fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
        let credentials: Arc<dyn Credentials> = Arc::new(Lapsing);
        host.with(|h| {
            h.controller = Controller::new(
                Store::open(dir.path().join("replacement"))?,
                credentials.clone(),
                Err("placeholder".into()),
                dir.path().join("ownership"),
            );
            h.controller = Controller::new(
                Store::open(dir.path().join("store"))?,
                credentials.clone(),
                Ok(overlap::synthetic_bundle(&dir.path().join("tools"))),
                dir.path().join("ownership"),
            );
            h.credentials = credentials;
            h.legacy_check = || Ok(());
            Ok(())
        })
        .unwrap();
        let result = tauri::async_runtime::block_on(start_guarded(
            host,
            id,
            Action::Restart,
            false,
            None,
            Some((eligible, "Agent no longer needs a save restart")),
        ));
        assert_eq!(
            result.err().as_deref(),
            Some("Agent no longer needs a save restart")
        );
        // Restart never ran, so it did not enable the agent.
        let saved: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(saved["agents"][0]["enabled"], false);
    }

    // A genuinely eligible agent: its Start failed on the missing Pi adapter.
    // Stop during the download must win over the install's late restart.
    #[test]
    fn install_restart_does_not_reenable_a_stopped_pi_agent() {
        const KEY: &str = "0000000000000000000000000000000000000000000000000000000000000001";
        const PUB: &str = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
        struct Stored;
        impl Credentials for Stored {
            fn delete(&self, _: &str, _: &str) -> Result<(), String> {
                panic!("not a deletion")
            }
            fn read_legacy(&self, _: LegacySource, _: &str) -> Result<Secret, String> {
                panic!("not an import")
            }
            fn add(&self, _: &str, _: &Secret) -> Result<(), String> {
                panic!("not a write")
            }
            fn read(&self, _: &str, pubkey: &str) -> Result<Option<Secret>, String> {
                Secret::parse(KEY, pubkey).map(Some)
            }
        }
        let (dir, host, _app, view) = fixture();
        let id = seed(dir.path());
        let path = dir.path().join("store/agents.json");
        let mut saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let id = id.replacen(&"ab".repeat(32), PUB, 1);
        saved["agents"][0]["id"] = json!(id);
        saved["agents"][0]["pubkey"] = json!(PUB);
        saved["agents"][0]["credentialId"] = json!(id);
        saved["agents"][0]["harness"]["command"] =
            json!(dir.path().join("missing").join("buzz-pi-acp"));
        saved["agents"][0]["harness"]["args"] = json!([]);
        std::fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
        let credentials: Arc<dyn Credentials> = Arc::new(Stored);
        host.with(|h| {
            h.controller = Controller::new(
                Store::open(dir.path().join("replacement"))?,
                credentials.clone(),
                Err("placeholder".into()),
                dir.path().join("ownership"),
            );
            h.controller = Controller::new(
                Store::open(dir.path().join("store"))?,
                credentials.clone(),
                Ok(overlap::synthetic_bundle(&dir.path().join("tools"))),
                dir.path().join("ownership"),
            );
            h.credentials = credentials;
            h.legacy_check = || Ok(());
            Ok(())
        })
        .unwrap();
        let started = tauri::async_runtime::block_on(start(
            host.clone(),
            id.clone(),
            Action::Start,
            false,
            None,
            None,
        ))
        .unwrap();
        assert_eq!(
            started.data.agents[0].error.as_deref(),
            Some("Required runtime executable is missing")
        );
        let waiting = tauri::async_runtime::block_on(host.waiting_for_pi()).unwrap();
        assert_eq!(waiting, vec![id.clone()]);
        invoke(
            &view,
            "agent_control_action",
            json!({"id":id,"action":"stop"}),
        )
        .unwrap();
        assert!(tauri::async_runtime::block_on(host.waiting_for_pi())
            .unwrap()
            .is_empty());
        let result = tauri::async_runtime::block_on(start(
            host,
            id,
            Action::Restart,
            false,
            None,
            Some(InstallRestart::Pi),
        ));
        assert_eq!(result.err().as_deref(), Some(NOT_WAITING_FOR_PI));
        let saved: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(saved["agents"][0]["enabled"], false);
    }
}

#[cfg(unix)]
#[test]
fn real_ipc_start_on_app_launch_persists_reopens_and_recovers_from_write_failure() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, host, _app, view) = fixture();
    let id = seed(dir.path());
    let store = dir.path().join("store");
    let disk = || -> Value {
        serde_json::from_slice(&std::fs::read(store.join("agents.json")).unwrap()).unwrap()
    };
    let set = |enabled: bool| {
        invoke(
            &view,
            "agent_control_start_on_app_launch",
            json!({"id":id,"enabled":enabled}),
        )
    };
    // Legacy record: no explicit preference follows `enabled`.
    let before = invoke(&view, "agent_control_snapshot", json!({})).unwrap();
    assert_eq!(before["agents"][0]["startOnAppLaunch"], true);
    let off = set(false).unwrap();
    assert_eq!(off["agents"][0]["startOnAppLaunch"], false);
    assert_eq!(off["agents"][0]["enabled"], true);
    assert_eq!(off["agents"][0]["revision"], 1);
    assert_eq!(disk()["agents"][0]["startOnAppLaunch"], false);
    assert_eq!(disk()["agents"][0]["revision"], 1);
    assert!(host.with(|h| h.controller.launch_ids()).unwrap().is_empty());
    // A failed write reports an error and leaves the confirmed value.
    std::fs::set_permissions(&store, std::fs::Permissions::from_mode(0o500)).unwrap();
    let failed = set(true);
    std::fs::set_permissions(&store, std::fs::Permissions::from_mode(0o700)).unwrap();
    // Staging is private and writable; replacement into the read-only store fails.
    assert_eq!(failed.unwrap_err(), "Could not replace agent settings");
    let current = invoke(&view, "agent_control_snapshot", json!({})).unwrap();
    assert_eq!(current["agents"][0]["startOnAppLaunch"], false);
    assert_eq!(disk()["agents"][0]["startOnAppLaunch"], false);
    assert_eq!(
        invoke(
            &view,
            "agent_control_start_on_app_launch",
            json!({"id":"missing","enabled":true})
        )
        .unwrap_err(),
        "Agent no longer exists"
    );
    let retried = set(true).unwrap();
    assert_eq!(retried["agents"][0]["startOnAppLaunch"], true);
    // A fresh host reads the persisted preference and restores from it.
    *host.0.lock().unwrap() = Err("retired".into());
    let fresh = AgentHost::open(Ok((
        store.clone(),
        dir.path().join("legacy"),
        dir.path().join("workspace"),
    )));
    let reopened = serde_json::to_value(fresh.with(|h| h.snapshot()).unwrap()).unwrap();
    assert_eq!(reopened["agents"][0]["startOnAppLaunch"], true);
    assert_eq!(reopened["agents"][0]["revision"], 1);
    assert_eq!(fresh.with(|h| h.controller.launch_ids()).unwrap(), vec![id]);
    fresh.shutdown().unwrap();
}

#[test]
fn malformed_store_does_not_prevent_native_host_construction() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("agents.json"), "RAW_SECRET_INVALID").unwrap();
    let host = AgentHost::open(Ok((
        dir.path().into(),
        dir.path().into(),
        dir.path().into(),
    )));
    let error = host.with(|h| h.snapshot()).err().unwrap();
    assert!(!error.contains("RAW_SECRET"));
    assert!(error.contains("malformed"));
    host.shutdown().unwrap();
}

#[test]
fn native_quit_preserves_enabled_intent() {
    let (dir, host, _app, view) = fixture();
    seed(dir.path());
    assert!(invoke(&view, "agent_control_snapshot", json!({})).is_ok());
    host.shutdown().unwrap();
    let disk: Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("store/agents.json")).unwrap())
            .unwrap();
    assert_eq!(disk["agents"][0]["enabled"], true);
    for (command, body) in [
        (
            "agent_control_action",
            json!({"id":"sample","action":"stop"}),
        ),
        (
            "agent_control_import_preview",
            json!({"source":"installed","destination":"wss://chosen.example"}),
        ),
    ] {
        assert_eq!(
            invoke(&view, command, body).unwrap_err(),
            "Agent host is shutting down"
        );
    }
}

#[test]
fn legacy_guard_is_process_path_evidence_not_name_substring_or_coexistence_claim() {
    for listing in [
        " 100 /Applications/Buzz.app/Contents/MacOS/buzz-desktop",
        " 200 /checkout/target/debug/buzz-desktop",
    ] {
        assert!(refuse_legacy_listing(listing).is_err());
    }
    assert!(refuse_legacy_listing(
        "123 /tmp/buzz-agent\n456 /tmp/buzz-foundation\n789 /tmp/buzz-desktop-notes"
    )
    .is_ok());
}

#[tokio::test]
#[ignore = "requires staged immutable runtime resources; run explicitly after build-agent-runtime"]
async fn native_start_restore_disconnect_stop_and_quit_fence_late_credentials() {
    struct Delayed {
        entered: std::sync::mpsc::Sender<()>,
        release: Mutex<std::sync::mpsc::Receiver<()>>,
    }
    impl Credentials for Delayed {
        fn delete(&self, _: &str, _: &str) -> Result<(), String> {
            panic!("not a delete")
        }
        fn read_legacy(&self, _: LegacySource, _: &str) -> Result<Secret, String> {
            panic!("not an import")
        }
        fn add(&self, _: &str, _: &Secret) -> Result<(), String> {
            panic!("not a write")
        }
        fn read(&self, _: &str, _: &str) -> Result<Option<Secret>, String> {
            self.entered.send(()).unwrap();
            self.release.lock().unwrap().recv().unwrap();
            Err("Synthetic credential refusal".into())
        }
    }
    let (dir, host, _app, view) = fixture();
    let id = seed(dir.path());
    // Use the actual resource manifest when staged; no child is spawned and no
    // PlatformCredentials method is ever called by this fixture.
    let tools = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/agent-runtime");
    assert!(
        tools.join("manifest.json").is_file(),
        "Build immutable runtime resources first"
    );
    let (entered, receive) = std::sync::mpsc::channel();
    let receive = Arc::new(Mutex::new(receive));
    let (release, wait) = std::sync::mpsc::channel();
    let credentials: Arc<dyn Credentials> = Arc::new(Delayed {
        entered,
        release: Mutex::new(wait),
    });
    host.with(|h| {
        let replacement = Store::open(dir.path().join("replacement"))?;
        // Reopen the same durable fixture only after replacing/dropping its owner.
        h.controller = Controller::new(
            replacement,
            credentials.clone(),
            Err("placeholder".into()),
            dir.path().join("ownership"),
        );
        h.controller = Controller::new(
            Store::open(dir.path().join("store"))?,
            credentials.clone(),
            RuntimeBundle::new(tools),
            dir.path().join("ownership"),
        );
        h.credentials = credentials;
        h.legacy_check = || Ok(());
        Ok(())
    })
    .unwrap();
    let path = dir.path().join("store/agents.json");
    let mut saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    saved["agents"][0]["harness"]["provider"] = json!("databricks_v2");
    saved["agents"][0]["harness"]["databricks"] =
        json!({"host":"https://workspace.example", "filter":""});
    std::fs::write(path, serde_json::to_vec(&saved).unwrap()).unwrap();
    for action in ["disconnect", "stop", "quit"] {
        if action == "quit" {
            let path = dir.path().join("store/agents.json");
            let mut saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            saved["agents"][0]["enabled"] = json!(true);
            std::fs::write(path, serde_json::to_vec(&saved).unwrap()).unwrap();
            // A fresh launch has no explicit actions yet.
            host.with(|h| {
                h.acted.clear();
                Ok(())
            })
            .unwrap();
        }
        let owner = host.clone();
        let agent_id = id.clone();
        let running = tokio::spawn(async move {
            if action == "quit" {
                owner.restore().await;
                Err("restore completed".into())
            } else {
                start(owner, agent_id, Action::Start, false, None, None).await
            }
        });
        tokio::task::spawn_blocking({
            let receive = receive.clone();
            move || {
                receive
                    .lock()
                    .unwrap()
                    .recv_timeout(std::time::Duration::from_secs(5))
            }
        })
        .await
        .unwrap()
        .unwrap();
        if action == "quit" {
            host.shutdown().unwrap();
        } else if action == "disconnect" {
            host.disconnect("https://workspace.example").await.unwrap();
        } else {
            invoke(
                &view,
                "agent_control_action",
                json!({"id":id,"action":"stop"}),
            )
            .unwrap();
        }
        release.send(()).unwrap();
        assert!(running.await.unwrap().is_err());
        if action == "quit" {
            let mut state = host.0.lock().unwrap();
            let h = state.as_mut().unwrap_or_else(|_| panic!("fixture host"));
            let snapshot = h.controller.snapshot().unwrap();
            assert!(snapshot.agents[0].error.is_none());
            assert!(snapshot.agents[0].enabled);
        }
    }
}

#[test]
fn real_ipc_import_uses_selected_memory_custody_and_stays_disabled() {
    const KEY: &str = "0000000000000000000000000000000000000000000000000000000000000001";
    const PUB: &str = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    #[derive(Default)]
    struct Memory(Mutex<BTreeMap<String, String>>, Mutex<Vec<LegacySource>>);
    impl Credentials for Memory {
        fn delete(&self, id: &str, _: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(id);
            Ok(())
        }
        fn read_legacy(&self, source: LegacySource, pubkey: &str) -> Result<Secret, String> {
            assert!(matches!(source, LegacySource::Development));
            self.1.lock().unwrap().push(source);
            Secret::parse(KEY, pubkey)
        }
        fn read(&self, id: &str, pubkey: &str) -> Result<Option<Secret>, String> {
            self.0
                .lock()
                .unwrap()
                .get(id)
                .map(|v| Secret::parse(v, pubkey))
                .transpose()
        }
        fn add(&self, id: &str, key: &Secret) -> Result<(), String> {
            assert!(self
                .0
                .lock()
                .unwrap()
                .insert(id.into(), key.hex().to_string())
                .is_none());
            Ok(())
        }
    }
    let (dir, host, _app, view) = fixture();
    let source = dir.path().join("legacy/xyz.block.buzz.app.dev/agents");
    std::fs::create_dir_all(&source).unwrap();
    let bytes = serde_json::to_vec(&json!([
        {"pubkey":PUB, "auth_tag":"[\"auth\",\"c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5\",\"\",\"6fd97eb61e46846e184a567429e66cbb76e84aa4f70b51cdf41e18b423679952433e952ae1fc344c74c6beaad0055a7a276d512823fcba8c6512407bb1558dce\"]", "relay_url":"", "name":"Selected", "agent_command":"buzz-agent", "agent_args":[], "start_on_app_launch":true},
        {"pubkey":"ab".repeat(32), "relay_url":"wss://stale.example", "name":"Not selected"},
        {"pubkey":"cd".repeat(32), "relay_url":"wss://user:secret@raw.example/path", "name":"Unsupported old pin"}
    ])).unwrap();
    std::fs::write(source.join("managed-agents.json"), &bytes).unwrap();
    let memory = Arc::new(Memory::default());
    host.with(|h| {
        h.credentials = memory.clone();
        Ok(())
    })
    .unwrap();
    // Required IPC destination: a missing argument must not use a legacy pin.
    assert!(invoke(
        &view,
        "agent_control_import_preview",
        json!({"source":"development"})
    )
    .is_err());
    let invalid = invoke(
        &view,
        "agent_control_import_preview",
        json!({"source":"development","destination":"wss://user:private@raw.example/path"}),
    )
    .unwrap_err();
    assert_eq!(
        invalid,
        "Choose a secure community origin without credentials, path or query"
    );
    let prior = invoke(
        &view,
        "agent_control_import_preview",
        json!({"source":"development","destination":"wss://prior.example"}),
    )
    .unwrap();
    let preview = invoke(
        &view,
        "agent_control_import_preview",
        json!({"source":"development","destination":"https://CHOSEN.example/"}),
    )
    .unwrap();
    assert!(invoke(
        &view,
        "agent_control_import_commit",
        json!({"token":prior["token"],"ids":[prior["candidates"][0]["id"]]})
    )
    .is_err());
    assert!(memory.1.lock().unwrap().is_empty());
    assert!(memory.0.lock().unwrap().is_empty());
    assert_eq!(preview["candidates"].as_array().unwrap().len(), 3);
    for candidate in preview["candidates"].as_array().unwrap() {
        assert_eq!(candidate["relayUrl"], "wss://chosen.example");
    }
    for hidden in ["raw.example", "stale.example", "user:secret", KEY] {
        assert!(!preview.to_string().contains(hidden));
    }
    let selected = preview["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["pubkey"] == PUB)
        .unwrap();
    let imported = invoke(
        &view,
        "agent_control_import_commit",
        json!({"token":preview["token"],"ids":[selected["id"]]}),
    )
    .unwrap();
    assert_eq!(imported["agents"].as_array().unwrap().len(), 1);
    assert_eq!(imported["agents"][0]["pubkey"], PUB);
    assert_eq!(imported["agents"][0]["relayUrl"], "wss://chosen.example");
    assert_eq!(imported["agents"][0]["id"], selected["id"]);
    assert!(memory
        .0
        .lock()
        .unwrap()
        .contains_key(selected["id"].as_str().unwrap()));
    assert_eq!(imported["agents"][0]["configured"], true);
    let cloned = invoke(
        &view,
        "agent_control_local_clone_settings",
        json!({"id": selected["id"]}),
    )
    .unwrap();
    assert!(cloned.get("systemPrompt").is_some());
    assert_eq!(cloned.as_object().unwrap().len(), 2);
    assert_eq!(imported["agents"][0]["enabled"], false);
    assert_eq!(imported["agents"][0]["status"], "stopped");
    assert!(!imported.to_string().contains(KEY));
    assert_eq!(memory.1.lock().unwrap().len(), 1);
    assert_eq!(
        std::fs::read(source.join("managed-agents.json")).unwrap(),
        bytes
    );
    assert!(invoke(
        &view,
        "agent_control_import_commit",
        json!({"token":preview["token"],"ids":[selected["id"]]})
    )
    .is_err());
    host.shutdown().unwrap();
}

// The log path must pass the generated desktop ACL, not the permissive mock context.
fn log_acl_fixture() -> (
    tempfile::TempDir,
    AgentHost,
    tauri::App<MockRuntime>,
    tauri::WebviewWindow<MockRuntime>,
) {
    let dir = tempfile::tempdir().unwrap();
    let host = AgentHost::open(Ok((
        dir.path().join("store"),
        dir.path().join("legacy"),
        dir.path().join("workspace"),
    )));
    let app = mock_builder()
        .manage(host.clone())
        .manage(crate::agent_models::ModelHost::new(Ok(dir
            .path()
            .join("store"))))
        .invoke_handler(crate::commands())
        .build(crate::app_context())
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    (dir, host, app, view)
}

#[test]
fn log_ipc_requires_fresh_exact_owner_proof_and_consumes_challenge() {
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    use sha2::{Digest, Sha256};
    let (dir, host, _app, view) = log_acl_fixture();
    let key = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    let relay = "wss://relay.example";
    let id = format!("{key}-{:x}", Sha256::digest(relay.as_bytes()));
    let secp = Secp256k1::new();
    let mut owner_bytes = [0; 32];
    owner_bytes[31] = 2;
    let owner = Keypair::from_secret_key(&secp, &SecretKey::from_byte_array(owner_bytes).unwrap());
    let tag_digest = Sha256::digest(format!("nostr:agent-auth:{key}:"));
    let tag = serde_json::to_string(&[
        "auth",
        &owner.x_only_public_key().0.to_string(),
        "",
        &secp
            .sign_schnorr_no_aux_rand(&tag_digest, &owner)
            .to_string(),
    ])
    .unwrap();
    let row = |auth: Option<&str>| json!({"id":id,"pubkey":key,"relayUrl":relay,"name":"Fixture","systemPrompt":"","workspace":dir.path().to_str().unwrap(),"harness":{"command":"buzz-agent","args":[],"model":"","provider":""},"environment":{},"revision":1,"enabled":false,"credentialId":"fixture","authTag":auth,"imported":{}});
    let store = dir.path().join("store/agents.json");
    std::fs::write(
        &store,
        serde_json::to_vec(&json!({"version":1,"agents":[row(None)]})).unwrap(),
    )
    .unwrap();
    let target = json!({"id":id,"pubkey":key,"relayUrl":relay});
    assert!(invoke(&view, "agent_control_log_challenge", target.clone()).is_err());
    std::fs::write(
        &store,
        serde_json::to_vec(&json!({"version":1,"agents":[row(Some(&tag))]})).unwrap(),
    )
    .unwrap();
    for bad in [
        json!({"id":format!("{}-{}", "a".repeat(64), "b".repeat(64)),"pubkey":key,"relayUrl":relay}),
        json!({"id":id,"pubkey":key,"relayUrl":"wss://elsewhere.example"}),
    ] {
        assert!(invoke(&view, "agent_control_log_challenge", bad).is_err());
    }
    let challenge = || {
        invoke(&view, "agent_control_log_challenge", target.clone())
            .unwrap()
            .as_str()
            .unwrap()
            .to_string()
    };
    let proof = |nonce: &str, id: &str, relay: &str, pair: &Keypair| {
        let digest = Sha256::digest(format!(
            "buzz-app:harness-log:v1:{id}:{key}:{relay}:{nonce}"
        ));
        secp.sign_schnorr_no_aux_rand(&digest, pair).to_string()
    };
    let read = |nonce: &str, sig: &str, id: &str, relay: &str| {
        invoke(
            &view,
            "agent_control_read_log",
            json!({"id":id,"pubkey":key,"relayUrl":relay,"nonce":nonce,"signature":sig}),
        )
    };
    let nonce = challenge();
    let signature = proof(&nonce, &id, relay, &owner);
    assert_eq!(read(&nonce, &signature, &id, relay).unwrap(), "");
    assert!(read(&nonce, &signature, &id, relay).is_err());
    let nonce = challenge();
    assert!(read(
        &nonce,
        &proof(&nonce, &id, relay, &owner),
        &id,
        "wss://elsewhere.example"
    )
    .is_err());
    assert!(read(&nonce, &proof(&nonce, &id, relay, &owner), &id, relay).is_err());
    let nonce = challenge();
    assert!(read(
        &nonce,
        &proof(&nonce, &id, relay, &owner),
        "wrong-id",
        relay
    )
    .is_err());
    let nonce = challenge();
    let mut wrong_bytes = [0; 32];
    wrong_bytes[31] = 1;
    let wrong_owner =
        Keypair::from_secret_key(&secp, &SecretKey::from_byte_array(wrong_bytes).unwrap());
    assert!(read(&nonce, &proof(&nonce, &id, relay, &wrong_owner), &id, relay).is_err());
    assert!(read(&nonce, &proof(&nonce, &id, relay, &owner), &id, relay).is_err());
    let nonce = challenge();
    host.with(|h| {
        h.log_challenges.get_mut(&nonce).unwrap().issued -= std::time::Duration::from_secs(21);
        Ok(())
    })
    .unwrap();
    assert!(read(&nonce, &proof(&nonce, &id, relay, &owner), &id, relay).is_err());
    assert!(read(&nonce, &proof(&nonce, &id, relay, &owner), &id, relay).is_err());
    let nonce = challenge();
    let second = challenge();
    assert_ne!(nonce, second);
    assert_eq!(
        read(&second, &proof(&second, &id, relay, &owner), &id, relay).unwrap(),
        ""
    );
    assert_eq!(
        read(&nonce, &proof(&nonce, &id, relay, &owner), &id, relay).unwrap(),
        ""
    );
    assert!(read(&second, &proof(&second, &id, relay, &owner), &id, relay).is_err());
    assert!(read(&nonce, &proof(&nonce, &id, relay, &owner), &id, relay).is_err());
    let pending: Vec<_> = (0..4).map(|_| challenge()).collect();
    assert!(invoke(&view, "agent_control_log_challenge", target).is_err());
    assert_eq!(
        read(
            &pending[0],
            &proof(&pending[0], &id, relay, &owner),
            &id,
            relay
        )
        .unwrap(),
        ""
    );
}

#[cfg(unix)]
#[test]
fn pi_model_lookup_waits_out_brief_host_contention() {
    let (dir, host, _app, view) = fixture();
    let tools = dir.path().join("tools");
    std::fs::create_dir(&tools).unwrap();
    for tool in ["pi", "node", "buzz-pi-acp"] {
        let file = tools.join(tool);
        crate::test_executable::write_executable(&file, "#!/bin/sh\nif [ \"$1\" = --version ]; then printf '0.99.1\\n'; exit 0; fi\nread request\nprintf '%s\\n' '{\"id\":\"catalog\",\"type\":\"response\",\"command\":\"get_available_models\",\"success\":true,\"data\":{\"models\":[{\"provider\":\"databricks\",\"id\":\"model-a\"}]}}'\n");
    }
    // Another native operation (for example a snapshot refresh) briefly holds
    // the host while the lookup reads its settings.
    let (locked, wait) = std::sync::mpsc::channel();
    let holder = {
        let lock = host.0.clone();
        std::thread::spawn(move || {
            let _guard = lock.lock().unwrap();
            locked.send(()).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(400));
        })
    };
    wait.recv().unwrap();
    let ticket = invoke(&view, "agent_models_begin", json!({})).unwrap();
    let result = invoke(
        &view,
        "agent_models_run",
        json!({"ticket":ticket,"request":{
            "host":"","filter":"","action":"connect","edit":{
                "name":"Pi draft","systemPrompt":"","workspace":dir.path(),
                "harness":{"command":tools.join("buzz-pi-acp"),"args":[],"provider":"","model":""},
                "environment":{}
            }
        }}),
    )
    .unwrap();
    holder.join().unwrap();
    assert_eq!(
        result["models"],
        json!([{"id":"databricks/model-a","name":"databricks/model-a"}])
    );
}

#[cfg(unix)]
#[test]
fn pi_connection_test_prompts_the_draft_selection() {
    let (dir, _host, _app, view) = fixture();
    let tools = dir.path().join("tools");
    std::fs::create_dir(&tools).unwrap();
    for tool in ["pi", "node", "buzz-pi-acp"] {
        let file = tools.join(tool);
        crate::test_executable::write_executable(
            &file,
            r#"#!/bin/sh
if [ "$1" = --version ]; then printf '0.99.1\n'; exit 0; fi
[ "$BUZZ_ACP_AGENTS" = "10" ] || exit 1
case "$*" in
    *'--model databricks/'*) provider=databricks;;
    *'--model openai/'*) provider=openai; [ "$OPENAI_API_KEY" = "draft-openai-key" ] || exit 1;;
    *'--model anthropic/'*) provider=anthropic; [ "$ANTHROPIC_API_KEY" = "draft-anthropic-key" ] || exit 1;;
    *) exit 1;;
esac
case "$*" in
    *'/model-a'*) model=model-a; stop=stop; error='';;
    *'/model-b'*) model=model-b; stop=error; error=401;;
    *) exit 1;;
esac
read request
case "$request" in *get_state*) ;; *) exit 1;; esac
printf '{"id":"selection","type":"response","command":"get_state","success":true,"data":{"model":{"provider":"%s","id":"%s"}}}\n' "$provider" "$model"
read request
case "$request" in *prompt*) ;; *) exit 1;; esac
printf '{"type":"message_end","message":{"role":"assistant","provider":"%s","model":"%s","content":[{"type":"text","text":"OK"}],"stopReason":"%s","errorMessage":"%s"}}\n' "$provider" "$model" "$stop" "$error"
"#,
        );
    }
    let test = |provider: &str, model: &str| {
        let ticket = invoke(&view, "agent_models_begin", json!({})).unwrap();
        invoke(
            &view,
            "agent_models_run",
            json!({"ticket":ticket,"request":{
                "host":"","filter":"","action":"test","edit":{
                    "name":"Pi draft","systemPrompt":"","workspace":dir.path(),
                    "harness":{"command":tools.join("buzz-pi-acp"),"args":[],"provider":provider,"model":model},
                    "environment":{"BUZZ_ACP_AGENTS":"10","OPENAI_API_KEY":"draft-openai-key","ANTHROPIC_API_KEY":"draft-anthropic-key"}
                }
            }}),
        )
    };
    for provider in ["databricks", "openai", "anthropic"] {
        let result = test(provider, "model-a").unwrap();
        assert_eq!(result["models"], json!([]));
        assert_eq!(result["testedModel"], format!("{provider}/model-a"));
        let error = test(provider, "model-b").unwrap_err();
        assert!(
            error.as_str().unwrap().contains("rejected the API key"),
            "{error}"
        );
    }
}

async fn assert_pending<F: std::future::Future>(mut future: std::pin::Pin<&mut F>) {
    std::future::poll_fn(|cx| {
        assert!(future.as_mut().poll(cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
}

#[tokio::test]
async fn native_admission_waits_in_order_without_replaying_operations() {
    let (_dir, host, _app, _view) = fixture();
    let gate = host.2.clone().lock_owned().await;
    let calls = Arc::new(Mutex::new(Vec::new()));
    let first_calls = calls.clone();
    let mut first = std::pin::pin!(run(host.clone(), move |h| {
        first_calls.lock().unwrap().push("snapshot");
        h.snapshot()
    }));
    assert_pending(first.as_mut()).await;
    let second_calls = calls.clone();
    let mut second = std::pin::pin!(run(host.clone(), move |_| {
        second_calls.lock().unwrap().push("command");
        Err::<(), _>("Synthetic uncertain write".into())
    }));
    assert_pending(second.as_mut()).await;
    assert!(calls.lock().unwrap().is_empty());
    drop(gate);
    let (snapshot, command) = tokio::join!(first, second);
    assert!(snapshot.is_ok());
    assert_eq!(command.unwrap_err(), "Synthetic uncertain write");
    assert_eq!(*calls.lock().unwrap(), ["snapshot", "command"]);
}

#[tokio::test]
async fn queued_native_operation_observes_shutdown_before_mutation() {
    let (_dir, host, _app, _view) = fixture();
    let gate = host.2.clone().lock_owned().await;
    let mut pending = std::pin::pin!(run(host.clone(), |_| {
        panic!("a queued write must not run after shutdown")
    }));
    assert_pending(pending.as_mut()).await;
    host.shutdown().unwrap();
    drop(gate);
    let result: Result<(), String> = pending.await;
    assert_eq!(result.unwrap_err(), "Agent host is shutting down");
}

#[test]
fn poisoned_native_state_is_not_reported_as_transient_contention() {
    let (_dir, host, _app, _view) = fixture();
    let owner = host.clone();
    assert!(std::thread::spawn(move || {
        let _guard = owner.0.lock().unwrap();
        panic!("synthetic native failure");
    })
    .join()
    .is_err());
    let error = host.with(|_| Ok(())).unwrap_err();
    assert!(error.contains("restart the app"));
    assert!(!error.contains("operation is in progress"));
}

#[tokio::test]
async fn native_create_waits_for_a_snapshot_and_keeps_its_prepared_identity() {
    use tauri::Manager;
    let (_dir, host, app, _view) = fixture();
    let (entered, acquired) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let snapshot = tokio::spawn(run(host.clone(), move |h| {
        entered.send(()).unwrap();
        wait.recv().unwrap();
        h.snapshot()
    }));
    acquired.await.unwrap();
    let request_id = uuid::Uuid::new_v4().to_string();
    let mut creating = std::pin::pin!(agent_control_create_prepare(
        app.state(),
        request_id.clone(),
        "wss://relay.example".into(),
        "ab".repeat(32),
    ));
    assert_pending(creating.as_mut()).await;
    release.send(()).unwrap();
    let prepared = creating.await.unwrap();
    assert!(snapshot.await.unwrap().is_ok());
    let retried = agent_control_create_prepare(
        app.state(),
        request_id,
        "wss://relay.example".into(),
        "ab".repeat(32),
    )
    .await
    .unwrap();
    assert_eq!(prepared, retried);
}

#[test]
fn native_create_authorization_binds_the_prepared_key_owner_and_identity() {
    let (dir, _host, _app, view) = fixture();
    let identity = invoke(&view, "identity_restore", json!({})).unwrap();
    let identity = identity.as_str().unwrap();
    let other = "cd".repeat(32);
    let prepare = |owner: &str| {
        let request = uuid::Uuid::new_v4().to_string();
        let prepared = invoke(
            &view,
            "agent_control_create_prepare",
            json!({"requestId": request, "destination": "https://relay.example", "owner": owner}),
        )
        .unwrap();
        (request, prepared["pubkey"].as_str().unwrap().to_owned())
    };
    let authorize = |owner: &str, pubkey: &str| {
        invoke(
            &view,
            "agent_control_create_authorize",
            json!({"destination": "https://relay.example", "owner": owner, "pubkey": pubkey}),
        )
    };
    let mismatch = json!("Authorization does not match the pending create request");
    assert_eq!(
        authorize(identity, &"ab".repeat(32)).unwrap_err(),
        json!("Create request expired; reopen Add agent")
    );
    // The request matches its prepared owner, but that owner is not this identity.
    let (_, pubkey) = prepare(&other);
    assert_eq!(
        authorize(&other, &pubkey).unwrap_err(),
        json!("The agent owner is not your signed-in identity")
    );
    let (request, pubkey) = prepare(identity);
    // A requested owner or key other than the prepared one is never signed.
    assert_eq!(authorize(&other, &pubkey).unwrap_err(), mismatch);
    assert_eq!(authorize(identity, &"ab".repeat(32)).unwrap_err(), mismatch);
    assert_eq!(
        invoke(
            &view,
            "agent_control_create_authorize",
            json!({
                "destination": "https://other.example", "owner": identity, "pubkey": pubkey
            })
        )
        .unwrap_err(),
        mismatch
    );
    let auth = authorize(identity, &pubkey).unwrap();
    assert_eq!(auth[1], identity);
    let commit = |auth: &Value| {
        let edit = json!({"name":"Created","systemPrompt":"","workspace":dir.path().to_str().unwrap(),
            "harness":{"command":"buzz-agent","args":[],"model":"chosen","provider":"databricks_v2"},"environment":{}});
        invoke(
            &view,
            "agent_control_create_commit",
            json!({"requestId": request, "edit": edit, "auth": auth.to_string()}),
        )
        .unwrap_err()
    };
    let mut forged = auth.clone();
    forged[3] = json!("00".repeat(64));
    assert_eq!(
        commit(&forged),
        json!("Owner attestation does not authorize this agent key")
    );
    // The unchanged verifier accepts the real attestation; only synthetic custody refuses.
    assert_eq!(commit(&auth), json!(IMPORT_GATE));
}

#[tokio::test]
async fn dropped_caller_does_not_release_a_running_native_operation() {
    let (_dir, host, _app, _view) = fixture();
    let (entered, acquired) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let worker = tokio::spawn(run(host.clone(), move |_| {
        entered.send(()).unwrap();
        wait.recv().unwrap();
        Ok(())
    }));
    acquired.await.unwrap();
    worker.abort();
    assert!(worker.await.unwrap_err().is_cancelled());
    // The caller has definitively dropped; the worker is still explicitly gated.
    assert!(host.2.try_lock().is_err());
    let mut next = std::pin::pin!(run(host.clone(), |h| h.snapshot()));
    assert_pending(next.as_mut()).await;
    release.send(()).unwrap();
    assert!(next.await.is_ok());
}

#[tokio::test]
async fn restore_uses_serialized_launch_preference_not_enabled_alone() {
    let (dir, host, _app, _view) = fixture();
    let id = seed(dir.path());
    let path = dir.path().join("store/agents.json");
    let mut data: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    data["agents"][0]["startOnAppLaunch"] = json!(false);
    std::fs::write(&path, serde_json::to_vec(&data).unwrap()).unwrap();
    host.restore().await;
    let data = host.with(|h| h.snapshot()).unwrap().data;
    assert!(data.agents[0].enabled);
    assert!(!data.agents[0].start_on_app_launch);
    assert!(data.agents[0].status == ProcessStatus::Stopped);
    assert!(data.agents[0].error.is_none());
    host.with(|h| h.controller.set_start_on_app_launch(&id, true))
        .unwrap();
    host.restore().await;
    let data = host.with(|h| h.snapshot()).unwrap().data;
    assert!(data.agents[0].start_on_app_launch);
    assert!(data.agents[0].status == ProcessStatus::Failed);
    assert_eq!(data.agents[0].error.as_deref(), Some(RUNTIME_GATE));
}

#[test]
fn startup_parks_metadata_without_credentials_or_runtime_and_follows_removal() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("store");
    let legacy = dir.path().join("legacy");
    let source = legacy
        .join(LegacySource::Installed.app_directory())
        .join("agents");
    std::fs::create_dir_all(&source).unwrap();
    let bytes = serde_json::to_vec(&json!([{
        "pubkey": "ab".repeat(32), "name": "Parked fixture",
        "start_on_app_launch": true, "auth_tag": "DO_NOT_COPY",
        "env_vars": {"TOKEN": "DO_NOT_COPY"}
    }]))
    .unwrap();
    std::fs::write(source.join("managed-agents.json"), &bytes).unwrap();
    let paths = || Ok((root.clone(), legacy.clone(), dir.path().join("workspace")));
    let host = AgentHost::open(paths());
    let snapshot = host.with(|host| host.snapshot()).unwrap();
    let value = serde_json::to_value(snapshot).unwrap();
    assert_eq!(value["parked"][0]["name"], "Parked fixture");
    assert_eq!(value["agents"], json!([]));
    assert_eq!(value["inventoryWarnings"], json!([]));
    assert!(!value.to_string().contains("DO_NOT_COPY"));
    assert_eq!(
        std::fs::read(source.join("managed-agents.json")).unwrap(),
        bytes
    );
    drop(host);
    std::fs::remove_dir_all(&legacy).unwrap();
    let host = AgentHost::open(paths());
    let reopened = serde_json::to_value(host.with(|host| host.snapshot()).unwrap()).unwrap();
    // Without the old installation nothing is importable, so nothing is listed.
    assert_eq!(reopened["parked"], json!([]));
    assert_eq!(reopened["agents"], json!([]));
    assert_eq!(reopened["inventoryWarnings"], json!([]));
}

#[tokio::test]
async fn protection_registration_waits_for_initialization_without_retrying() {
    use buzz_agent_controller::security::Request;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let (release, held) = std::sync::mpsc::channel();
    let host = AgentHost::initialize_with(
        owner::Owner::Native(crate::identity::IdentityHost::fixture_owner()),
        move || {
            held.recv().map_err(|_| "Initialization gate closed")?;
            Host::open(
                root.join("store"),
                root.join("legacy"),
                root.join("workspace"),
                Err(RUNTIME_GATE.into()),
                Arc::new(RejectingCredentials),
            )
        },
    );
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = calls.clone();
    let executable = dir.path().join("launcher");
    crate::test_executable::write_executable(&executable, "synthetic launcher bytes");
    let mut registration = std::pin::pin!(run(host.clone(), move |h| {
        counted.fetch_add(1, Ordering::SeqCst);
        h.controller.security(Request::Register {
            provider: "fixture.security".into(),
            executable,
        })
    }));
    assert_pending(registration.as_mut()).await;
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    release.send(()).unwrap();
    assert!(registration.await.unwrap()["lease"].is_string());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let snapshot = run(host.clone(), |h| h.controller.security(Request::Snapshot))
        .await
        .unwrap();
    assert_eq!(snapshot["availableProviders"], json!(["fixture.security"]));
    host.shutdown().unwrap();
}

#[tokio::test]
async fn initialization_failure_and_shutdown_refuse_queued_registration() {
    for shutdown in [false, true] {
        let (release, held) = std::sync::mpsc::channel();
        let host = AgentHost::initialize_with(
            owner::Owner::Native(crate::identity::IdentityHost::fixture_owner()),
            move || {
                held.recv().map_err(|_| "Initialization gate closed")?;
                Err("Synthetic initialization failure".into())
            },
        );
        let mut registration = std::pin::pin!(run::<()>(host.clone(), |_| {
            panic!("registration must not execute without a usable host")
        }));
        assert_pending(registration.as_mut()).await;
        if shutdown {
            host.shutdown().unwrap();
        }
        release.send(()).unwrap();
        assert_eq!(
            registration.await.unwrap_err(),
            if shutdown {
                "Agent host is shutting down"
            } else {
                "Synthetic initialization failure"
            }
        );
    }
}

#[cfg(feature = "mesh")]
#[tokio::test]
async fn shared_compute_restore_waits_for_community_before_attempting_credentials() {
    let (dir, host, _app, _view) = fixture();
    let id = seed(dir.path());
    let path = dir.path().join("store/agents.json");
    let mut data: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    data["agents"][0]["harness"]["provider"] = json!("relay-mesh");
    data["agents"][0]["startOnAppLaunch"] = json!(true);
    std::fs::write(&path, serde_json::to_vec(&data).unwrap()).unwrap();
    host.restore().await;
    host.with(|h| {
        assert!(h.queued.contains_key(&id));
        assert!(h.snapshot()?.data.agents[0].error.is_none());
        Ok(())
    })
    .unwrap();
    let mesh = crate::mesh_compute::MeshHost::default();
    crate::mesh_compute::retire_selection(&mesh, &host, "https://other.example", "viewer")
        .await
        .unwrap();
    assert!(host.with(|h| Ok(h.queued.contains_key(&id))).unwrap());
    host.restore_mesh("https://other.example".into()).await;
    assert!(host.with(|h| Ok(h.queued.contains_key(&id))).unwrap());
    let relay = host
        .with(|h| Ok(h.controller.mesh_request(&id)?.unwrap().relay))
        .unwrap();
    host.restore_mesh(crate::mesh_compute::agent_community(&relay).unwrap())
        .await;
    let data = host.with(|h| h.snapshot()).unwrap().data;
    // Matching selection resumes the normal start gate; the synthetic runtime refuses it.
    assert_eq!(data.agents[0].error.as_deref(), Some(RUNTIME_GATE));
}

#[cfg(windows)]
#[test]
fn windows_claude_manual_setup_uses_runnable_launchers() {
    if let Some(root) = std::env::var_os("BUZZ_DISCOVERY_FIXTURE") {
        let root = PathBuf::from(root);
        let app_data = root.join("app-data");
        let setup = claude_setup(&app_data);
        assert_eq!(setup.status, "ready");
        assert!(!setup.install_supported);
        assert_eq!(setup.cli, Some(root.join("claude.cmd")));
        let options = harness_options(&app_data);
        let option = options
            .iter()
            .find(|option| option.label == "Claude Code")
            .unwrap();
        assert!(option.available);
        assert_eq!(
            option.command,
            root.join("claude-agent-acp.cmd").to_string_lossy()
        );
        assert!(option.default_args.is_empty());
        assert!(option.providers.is_empty());
        assert!(setup
            .login_command
            .unwrap()
            .ends_with("claude.cmd' auth login"));
        assert!(claude_setup(&app_data)
            .login_command
            .unwrap()
            .starts_with("& '"));
        // Do not activate Windows Pi paths that its preflight does not support.
        assert_eq!(buzz_agent_controller::installed("node"), None);
        assert!(
            !harness_options(&app_data)
                .iter()
                .find(|h| h.label == "Pi")
                .unwrap()
                .available
        );
        // Native CLI wins within a directory; a later PATH entry did not outrank .cmd.
        std::fs::write(root.join("claude.exe"), "fixture bytes").unwrap();
        assert_eq!(claude_setup(&app_data).cli, Some(root.join("claude.exe")));
        std::fs::remove_file(root.join("claude-agent-acp.cmd")).unwrap();
        assert_eq!(claude_setup(&app_data).status, "adapter-needed");
        assert!(
            !harness_options(&app_data)
                .iter()
                .find(|option| option.label == "Claude Code")
                .unwrap()
                .available
        );
        std::fs::write(root.join("claude-agent-acp.bat"), "fixture bytes").unwrap();
        assert_eq!(claude_setup(&app_data).status, "ready");
        std::fs::remove_file(root.join("node.exe")).unwrap();
        assert_eq!(claude_setup(&app_data).status, "cli-needed");
        assert!(
            !harness_options(&app_data)
                .iter()
                .find(|option| option.label == "Claude Code")
                .unwrap()
                .available
        );
        return;
    }
    let directory = tempfile::Builder::new()
        .prefix("Buzz tools ")
        .tempdir()
        .unwrap();
    let root = directory.path();
    let later = root.join("later");
    std::fs::create_dir(&later).unwrap();
    for name in [
        "claude",
        "claude.cmd",
        "node.exe",
        "claude-agent-acp",
        "claude-agent-acp.cmd",
        "pi.cmd",
        "buzz-pi-acp.cmd",
    ] {
        std::fs::write(root.join(name), "fixture bytes").unwrap();
    }
    std::fs::write(later.join("claude.exe"), "fixture bytes").unwrap();
    // A subprocess isolates discovery from the developer and parallel native tests.
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "agents::tests::windows_claude_manual_setup_uses_runnable_launchers",
            "--nocapture",
        ])
        .env("BUZZ_DISCOVERY_FIXTURE", root)
        .env("HOME", root.join("empty-home"))
        .env(
            "PATH",
            std::env::join_paths([root, later.as_path()]).unwrap(),
        )
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[cfg(any(unix, windows))]
#[tokio::test]
async fn claude_auth_check_exposes_only_confirmed_status() {
    let directory = tempfile::Builder::new()
        .prefix("Claude tools ")
        .tempdir()
        .unwrap();
    let cli = directory.path().join(if cfg!(windows) {
        "claude.cmd"
    } else {
        "claude"
    });
    for (output, exit, expected) in [
        (
            r#"{"loggedIn":true,"email":"private@example.com"}"#,
            0,
            Some(true),
        ),
        (r#"{"loggedIn":false}"#, 1, Some(false)),
        (r#"{"loggedIn":false}"#, 0, None),
        (r#"{"loggedIn":true}"#, 1, None),
        (r#"{"loggedIn":false}"#, 2, None),
        (r#"{"loggedIn":"true"}"#, 0, None),
        (r#"{"email":"private@example.com"}"#, 0, None),
        ("not JSON", 0, None),
    ] {
        #[cfg(unix)]
        {
            crate::test_executable::write_executable(&cli, format!("#!/bin/sh\n[ \"$1\" = auth ] && [ \"$2\" = status ] || exit 3\nprintf '%s' '{output}'\nexit {exit}\n"));
        }
        #[cfg(windows)]
        std::fs::write(&cli, format!("@echo off\r\nif not \"%~1\"==\"auth\" exit /b 3\r\nif not \"%~2\"==\"status\" exit /b 3\r\necho {output}\r\nexit /b {exit}\r\n")).unwrap();
        assert_eq!(
            probe_claude_auth(&cli, &crate::host_command::effective_path()).await,
            expected
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn claude_auth_uses_the_discovered_node_path() {
    const FIXTURE: &str = "BUZZ_CLAUDE_AUTH_PATH_FIXTURE";
    if let Some(root) = std::env::var_os(FIXTURE) {
        let root = PathBuf::from(root);
        prepare_tools_path().await;
        let setup = claude_setup(&root.join("app-data"));
        assert_eq!(setup.status, "ready");
        let cli = setup.cli.as_ref().unwrap();
        assert_eq!(cli, &root.join("shell tools/claude"));
        assert!(setup.node.is_none(), "global install became managed");
        assert_eq!(
            probe_claude_auth(cli, &claude_auth_path(&setup).unwrap()).await,
            Some(true)
        );
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let tools = root.path().join("shell tools");
    std::fs::create_dir(&tools).unwrap();
    // A real env-node shebang must resolve the shell-only interpreter.
    crate::test_executable::write_executable(
        &tools.join("node"),
        "#!/bin/sh\nprintf '%s' '{\"loggedIn\":true}'\n",
    );
    crate::test_executable::write_executable(&tools.join("claude"), "#!/usr/bin/env node\n");
    crate::test_executable::write_executable(
        &tools.join("claude-agent-acp"),
        "#!/bin/sh\nexit 0\n",
    );
    let shell = root.path().join("shell");
    crate::test_executable::write_executable(
        &shell,
        format!(
            "#!/bin/sh\nexport PATH='{}:/usr/bin:/bin'\n/bin/sh -c \"$2\"\n",
            tools.display()
        ),
    );
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "agents::tests::claude_auth_uses_the_discovered_node_path",
            "--nocapture",
        ])
        .env(FIXTURE, root.path())
        .env("HOME", root.path())
        .env("SHELL", shell)
        .env("PATH", "/nonexistent-inherited-tools")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[cfg(unix)]
#[tokio::test]
async fn shell_discovery_does_not_block_native_stop_or_resurrect_cancelled_start() {
    use tauri::Manager as _;
    const FIXTURE: &str = "BUZZ_TOOL_PATH_QUEUE_FIXTURE";
    if let Some(root) = std::env::var_os(FIXTURE) {
        let root = PathBuf::from(root);
        let (dir, host, app, _view) = fixture();
        let id = seed(dir.path());
        host.with(|h| {
            // Retire the previous controller before claiming its store lock.
            h.controller = Controller::new(
                Store::open(dir.path().join("replacement"))?,
                Arc::new(RejectingCredentials),
                Err(RUNTIME_GATE.into()),
                dir.path().join("ownership"),
            );
            h.controller = Controller::new(
                Store::open(dir.path().join("store"))?,
                Arc::new(RejectingCredentials),
                Ok(overlap::synthetic_bundle(&dir.path().join("tools"))),
                dir.path().join("ownership"),
            );
            h.legacy_check = || Ok(());
            Ok(())
        })
        .unwrap();
        buzz_agent_controller::warm_tools_path();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !root.join("entered").exists() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let handle = app.handle().clone();
        let snapshot = tokio::spawn(async move { agent_control_snapshot(handle.state()).await });
        let owner = host.clone();
        let target = id.clone();
        let starting =
            tokio::spawn(
                async move { start(owner, target, Action::Start, false, None, None).await },
            );
        // Start is admitted before the PATH wait, so recovery Stop owns cancellation.
        let ticket = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if host.with(|h| Ok(h.starts.contains_key(&id))).unwrap() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
        let owner = host.clone();
        let target = id.clone();
        let stop = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            run(owner, move |h| h.action(&target, Action::Stop)),
        )
        .await;
        let snapshot_pending = !snapshot.is_finished();
        // Explicit FIFO release, never a sleep masquerading as synchronization.
        std::fs::write(root.join("release"), "go\n").unwrap();
        assert!(
            ticket.is_ok(),
            "Start did not establish cancellation ownership"
        );
        assert!(stop.unwrap().is_ok(), "Stop could not run during discovery");
        assert!(snapshot_pending, "snapshot did not await discovered tools");
        assert_eq!(starting.await.unwrap().err().unwrap(), START_CANCELLED);
        assert!(snapshot.await.unwrap().is_ok());
        assert!(host.with(|h| Ok(h.starts.is_empty())).unwrap());
        host.shutdown().unwrap();
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let release = root.path().join("release");
    use std::os::unix::ffi::OsStrExt;
    let fifo = std::ffi::CString::new(release.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    let shell = root.path().join("shell");
    crate::test_executable::write_executable(&shell, format!("#!/bin/sh\nprintf entered > '{}/entered'\nread ready < '{}/release'\n/bin/sh -c \"$2\"\n", root.path().display(), root.path().display()));
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "agents::tests::shell_discovery_does_not_block_native_stop_or_resurrect_cancelled_start", "--nocapture"])
        .env(FIXTURE, root.path()).env("HOME", root.path()).env("SHELL", shell).env("PATH", "/usr/bin:/bin")
        .output().unwrap();
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn kept_agents_of_another_or_missing_owner_never_reach_their_credentials() {
    let (dir, host, _app, _view) = fixture();
    let id = seed(dir.path());
    let path = dir.path().join("store/agents.json");
    let mut saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    saved["agents"][0]["authTag"] = json!(json!(["auth", "cd".repeat(32), "", "sig"]).to_string());
    std::fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
    // A usable runtime, so only the owner check can stop the start.
    host.with(|h| {
        let credentials = h.credentials.clone();
        h.controller = Controller::new(
            Store::open(dir.path().join("replacement"))?,
            credentials.clone(),
            Err("placeholder".into()),
            dir.path().join("ownership"),
        );
        h.controller = Controller::new(
            Store::open(dir.path().join("store"))?,
            credentials,
            Ok(overlap::synthetic_bundle(&dir.path().join("tools"))),
            dir.path().join("ownership"),
        );
        h.legacy_check = || Ok(());
        Ok(())
    })
    .unwrap();
    let start = |host: AgentHost| {
        tauri::async_runtime::block_on(start_guarded(
            host,
            id.clone(),
            Action::Start,
            false,
            None,
            None,
        ))
        .unwrap()
        .data
        .agents[0]
            .error
            .clone()
            .unwrap()
    };
    // RejectingCredentials answers IMPORT_GATE, so any credential read would show here.
    let mismatched = start(host.clone());
    assert!(
        mismatched.contains("different Buzz identity"),
        "{mismatched}"
    );
    // A native read failure remains a custody error, not an owner mismatch.
    let signed_out = AgentHost(
        host.0.clone(),
        host.1.clone(),
        host.2.clone(),
        owner::Owner::Native(crate::identity::IdentityHost::default()),
        host.4.clone(),
    );
    let missing = start(signed_out);
    assert!(!missing.contains("different Buzz identity"), "{missing}");
    assert_ne!(missing, IMPORT_GATE);
}
