use super::*;
use goose_provider_types::{base::MessageStream, errors::ProviderError};
use rmcp::model::ContentBlock;
use serde_json::json;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex,
};
use tokio::sync::Notify;
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

struct Capability {
    owner: &'static str,
    calls: Mutex<Vec<String>>,
    started: Notify,
    block: bool,
}
impl Capability {
    fn new(owner: &'static str) -> Self {
        Self {
            owner,
            calls: Mutex::new(vec![]),
            started: Notify::new(),
            block: false,
        }
    }
}
#[async_trait]
impl Tools for Capability {
    fn definitions(&self) -> Vec<Tool> {
        vec![Tool::new_with_raw("send", Some("Send as the host-bound agent".into()), Arc::new(
            json!({"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false}).as_object().unwrap().clone()
        ))]
    }
    async fn call(&self, call: CallToolRequestParams) -> Result<CallToolResult, ErrorData> {
        self.started.notify_one();
        if self.block {
            std::future::pending::<()>().await;
        }
        let args = call.arguments.unwrap_or_default();
        if args.len() != 1 || !args.get("text").is_some_and(|v| v.is_string()) {
            return Err(ErrorData::invalid_params("only text is accepted", None));
        }
        self.calls.lock().unwrap().push(format!(
            "{}:{}",
            self.owner,
            args["text"].as_str().unwrap()
        ));
        Ok(CallToolResult::success(vec![ContentBlock::text(format!(
            "sent by {}",
            self.owner
        ))]))
    }
}

struct Script(Mutex<Vec<Message>>);
#[async_trait]
impl Provider for Script {
    fn get_name(&self) -> &str {
        "script"
    }
    async fn stream(
        &self,
        _: &ModelConfig,
        _: &str,
        _: &[Message],
        _: &[Tool],
    ) -> Result<MessageStream, ProviderError> {
        let message = self.0.lock().unwrap().remove(0);
        Ok(Box::pin(futures::stream::iter(vec![Ok((
            Some(message),
            None,
        ))])))
    }
}
fn call(id: &str, name: &str, args: serde_json::Value) -> Message {
    Message::assistant().with_tool_request(
        id,
        Ok(serde_json::from_value(json!({"name":name,"arguments":args})).unwrap()),
    )
}
async fn scripted(messages: Vec<Message>, tools: &Capability, rounds: usize) -> Result<String> {
    run(
        &Script(Mutex::new(messages)),
        &ModelConfig::new("mesh"),
        "reply",
        &mut vec![Message::user().with_text("hi")],
        tools,
        CancellationToken::new(),
        rounds,
    )
    .await
}

#[tokio::test]
async fn actual_gdk_http_stream_runs_two_inline_sends_then_final_prose() {
    let server = MockServer::start().await;
    let count = Arc::new(AtomicUsize::new(0));
    let step = count.clone();
    Mock::given(method("POST")).and(path("/v1/chat/completions")).respond_with(move |request: &wiremock::Request| {
        let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
        assert_eq!(body["model"], "mesh");
        assert_eq!(body["tools"][0]["function"]["name"], "send");
        let round = step.fetch_add(1, Ordering::SeqCst);
        if round > 0 {
            assert!(body["messages"].as_array().unwrap().iter().any(|m| m["role"] == "tool" && m["content"].as_str().is_some_and(|s| s.contains("sent by alice"))));
        }
        let (delta, finish) = if round < 2 {
            (json!({"role":"assistant","tool_calls":[{"index":0,"id":format!("c{round}"),"type":"function","function":{"name":"send","arguments":format!("{{\"text\":\"update {round}\"}}")}}]}), "tool_calls")
        } else {
            (json!({"role":"assistant","content":"Final answer"}), "stop")
        };
        let chunk = json!({"id":"completion","object":"chat.completion.chunk","created":1,"model":"mesh","choices":[{"index":0,"delta":delta,"finish_reason":null}]});
        let end = json!({"id":"completion","object":"chat.completion.chunk","created":1,"model":"mesh","choices":[{"index":0,"delta":{},"finish_reason":finish}]});
        ResponseTemplate::new(200).insert_header("content-type", "text/event-stream").set_body_string(format!("data: {chunk}\n\ndata: {end}\n\ndata: [DONE]\n\n"))
    }).expect(3).mount(&server).await;
    let p = provider(server.uri()).unwrap();
    let tools = Capability::new("alice");
    let mut history = vec![Message::user().with_text("two updates then answer")];
    let result = run(
        p.as_ref(),
        &ModelConfig::new("mesh"),
        "be brief",
        &mut history,
        &tools,
        CancellationToken::new(),
        3,
    )
    .await
    .unwrap();
    assert_eq!(result, "Final answer");
    assert_eq!(
        *tools.calls.lock().unwrap(),
        ["alice:update 0", "alice:update 1"]
    );
    assert_eq!(history.len(), 6);
    server.verify().await;
}

#[tokio::test]
async fn unknown_tool_and_spoofed_identity_never_execute() {
    let tools = Capability::new("alice");
    assert_eq!(
        scripted(
            vec![
                call("a", "shell", json!({"text":"bad"})),
                call("b", "send", json!({"text":"bad","owner":"bob"})),
                Message::assistant().with_text("recovered")
            ],
            &tools,
            3
        )
        .await
        .unwrap(),
        "recovered"
    );
    assert!(tools.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn duplicate_ids_reject_whole_batch_before_effects() {
    let tools = Capability::new("alice");
    let mut batch = call("a", "send", json!({"text":"one"}));
    batch
        .content
        .extend(call("a", "send", json!({"text":"two"})).content);
    assert!(scripted(vec![batch], &tools, 1)
        .await
        .unwrap_err()
        .to_string()
        .contains("duplicate"));
    assert!(tools.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn cancellation_drops_pending_tool_and_does_not_commit_history() {
    let tools = Capability {
        block: true,
        ..Capability::new("alice")
    };
    let p = Script(Mutex::new(vec![call(
        "a",
        "send",
        json!({"text":"waiting"}),
    )]));
    let cancel = CancellationToken::new();
    let stop = async {
        tools.started.notified().await;
        cancel.cancel();
    };
    let mut history = vec![Message::user().with_text("original")];
    let model = ModelConfig::new("mesh");
    let (result, ()) = tokio::join!(
        run(&p, &model, "", &mut history, &tools, cancel.clone(), 2),
        stop
    );
    assert!(result.unwrap_err().to_string().contains("cancelled"));
    assert_eq!(history.len(), 1);
    assert!(tools.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn concurrent_agents_keep_capabilities_separate() {
    let alice = Capability::new("alice");
    let bob = Capability::new("bob");
    let messages = || {
        vec![
            call("a", "send", json!({"text":"hello"})),
            Message::assistant().with_text("done"),
        ]
    };
    let (a, b) = tokio::join!(
        scripted(messages(), &alice, 2),
        scripted(messages(), &bob, 2)
    );
    assert_eq!(a.unwrap(), "done");
    assert_eq!(b.unwrap(), "done");
    assert_eq!(*alice.calls.lock().unwrap(), ["alice:hello"]);
    assert_eq!(*bob.calls.lock().unwrap(), ["bob:hello"]);
}

#[tokio::test]
async fn round_and_response_limits_are_terminal() {
    let tools = Capability::new("alice");
    assert!(
        scripted(vec![call("a", "send", json!({"text":"one"}))], &tools, 1)
            .await
            .unwrap_err()
            .to_string()
            .contains("round limit")
    );
    assert!(scripted(
        vec![Message::assistant().with_text("x".repeat(65537))],
        &tools,
        1
    )
    .await
    .unwrap_err()
    .to_string()
    .contains("response limit"));
    assert!(scripted(vec![Message::assistant()], &tools, 1)
        .await
        .unwrap_err()
        .to_string()
        .contains("missing final prose"));
}

struct PendingProvider(Notify);
#[async_trait]
impl Provider for PendingProvider {
    fn get_name(&self) -> &str {
        "pending"
    }
    async fn stream(
        &self,
        _: &ModelConfig,
        _: &str,
        _: &[Message],
        _: &[Tool],
    ) -> Result<MessageStream, ProviderError> {
        self.0.notify_one();
        std::future::pending().await
    }
}

#[tokio::test]
async fn cancellation_interrupts_provider_setup() {
    let p = PendingProvider(Notify::new());
    let tools = Capability::new("alice");
    let cancel = CancellationToken::new();
    let stop = async {
        p.0.notified().await;
        cancel.cancel();
    };
    let mut history = vec![];
    let model = ModelConfig::new("mesh");
    let (result, ()) = tokio::join!(
        run(&p, &model, "", &mut history, &tools, cancel.clone(), 1),
        stop
    );
    assert!(result.unwrap_err().to_string().contains("cancelled"));
    assert!(history.is_empty());
}

#[tokio::test]
async fn provider_failure_propagates_without_tool_effects() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(400).set_body_json(json!({"error":{"message":"test rejection"}})),
        )
        // GDK retries this 400 three times; this is provider policy, not our loop.
        .expect(4)
        .mount(&server)
        .await;
    let p = provider(server.uri()).unwrap();
    let tools = Capability::new("alice");
    let mut history = vec![Message::user().with_text("original")];
    assert!(run(
        p.as_ref(),
        &ModelConfig::new("mesh"),
        "",
        &mut history,
        &tools,
        CancellationToken::new(),
        1
    )
    .await
    .is_err());
    assert_eq!(history.len(), 1);
    assert!(tools.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn compaction_uses_upstream_summary_and_keeps_tool_catalog() {
    struct Compact(AtomicUsize);
    #[async_trait]
    impl Provider for Compact {
        fn get_name(&self) -> &str {
            "compact-test"
        }
        async fn stream(
            &self,
            _: &ModelConfig,
            system: &str,
            messages: &[Message],
            tools: &[Tool],
        ) -> Result<MessageStream, ProviderError> {
            let message = match self.0.fetch_add(1, Ordering::SeqCst) {
                0 => {
                    assert!(tools.is_empty());
                    assert!(system.contains("older detail"));
                    Message::assistant().with_text("Summary: user needs the final answer.")
                }
                1 => {
                    assert_eq!(system, "original system");
                    assert_eq!(tools[0].name, "send");
                    assert_eq!(messages.len(), 1);
                    assert!(messages[0].as_concat_text().contains("Summary:"));
                    call("after-compact", "send", json!({"text":"still working"}))
                }
                2 => {
                    assert!(matches!(
                        messages.last().unwrap().content[0],
                        MessageContent::ToolResponse(_)
                    ));
                    Message::assistant().with_text("Final answer")
                }
                _ => panic!("unexpected request"),
            };
            Ok(Box::pin(futures::stream::iter([Ok((Some(message), None))])))
        }
    }
    let p = Compact(AtomicUsize::new(0));
    let tools = Capability::new("alice");
    let mut history = vec![Message::user().with_text("older detail ".repeat(2500))];
    let trace = Mutex::new(Vec::new());
    let result = run_observed(
        &p,
        &ModelConfig::new("mesh"),
        "original system",
        &mut history,
        &tools,
        CancellationToken::new(),
        3,
        |message| trace.lock().unwrap().push(message.clone()),
    )
    .await
    .unwrap();
    assert_eq!(result, "Final answer");
    assert_eq!(*tools.calls.lock().unwrap(), ["alice:still working"]);
    assert!(trace.lock().unwrap()[0]
        .as_concat_text()
        .contains("Context compacted"));
    assert_eq!(p.0.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn compaction_failure_and_cancellation_do_not_dispatch_tools() {
    let tools = Capability::new("alice");
    let original = Message::user().with_text("x".repeat(30 * 1024));
    let mut history = vec![original.clone()];
    let error = run(
        &Script(Mutex::new(vec![Message::assistant()])),
        &ModelConfig::new("mesh"),
        "",
        &mut history,
        &tools,
        CancellationToken::new(),
        2,
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("empty context summary"));
    assert_eq!(history[0], original);
    let p = PendingProvider(Notify::new());
    let cancel = CancellationToken::new();
    let stop = async {
        p.0.notified().await;
        cancel.cancel();
    };
    let model = ModelConfig::new("mesh");
    let (result, ()) = tokio::join!(
        run(&p, &model, "", &mut history, &tools, cancel.clone(), 2),
        stop
    );
    assert!(result.unwrap_err().to_string().contains("cancelled"));
    assert_eq!(history[0], original);
    assert!(tools.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn response_limit_is_independent_of_token_chunking() {
    struct Chunks(usize);
    #[async_trait]
    impl Provider for Chunks {
        fn get_name(&self) -> &str {
            "chunks"
        }
        async fn stream(
            &self,
            _: &ModelConfig,
            _: &str,
            _: &[Message],
            _: &[Tool],
        ) -> Result<MessageStream, ProviderError> {
            let text = "a".repeat(2048);
            let messages: Vec<_> = text
                .as_bytes()
                .chunks(self.0)
                .map(|chunk| {
                    Ok((
                        Some(Message::assistant().with_text(std::str::from_utf8(chunk).unwrap())),
                        None,
                    ))
                })
                .collect();
            Ok(Box::pin(futures::stream::iter(messages)))
        }
    }
    let tools = Capability::new("alice");
    for chunk_size in [1, 2048] {
        let result = run(
            &Chunks(chunk_size),
            &ModelConfig::new("mesh"),
            "",
            &mut vec![],
            &tools,
            CancellationToken::new(),
            1,
        )
        .await
        .unwrap();
        assert_eq!(result, "a".repeat(2048));
    }
}

#[tokio::test]
async fn real_local_tools_write_edit_shell_and_skill_results_are_bounded() {
    let dir = tempfile::tempdir().unwrap();
    let skill = dir.path().join("skills/example");
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(
        skill.join("SKILL.md"),
        format!(
            "---\nname: example\ndescription: fixture\n---\n{}",
            "x".repeat(40 * 1024)
        ),
    )
    .unwrap();
    let tools = local_tools::LocalTools::new(
        dir.path().to_path_buf(),
        &[dir.path().join("skills")],
        CancellationToken::new(),
    )
    .unwrap();
    let names: Vec<_> = tools
        .definitions()
        .iter()
        .map(|t| t.name.to_string())
        .collect();
    assert_eq!(names, ["shell", "write", "edit", "load_skill"]);
    let p = Script(Mutex::new(vec![
        call("w", "write", json!({"path":"trial.txt","content":"before"})),
        call(
            "e",
            "edit",
            json!({"path":"trial.txt","before":"before","after":"after"}),
        ),
        call(
            "s",
            "shell",
            json!({"command":"cat trial.txt; head -c 18000 /dev/zero | tr '\\000' x"}),
        ),
        call("skill", "load_skill", json!({"name":"example"})),
        Message::assistant().with_text("Done"),
    ]));
    let mut history = vec![];
    assert_eq!(
        run(
            &p,
            &ModelConfig::new("mesh"),
            "",
            &mut history,
            &tools,
            CancellationToken::new(),
            6
        )
        .await
        .unwrap(),
        "Done"
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("trial.txt")).unwrap(),
        "after"
    );
    let results: Vec<_> = history
        .iter()
        .flat_map(|m| &m.content)
        .filter_map(|c| {
            if let MessageContent::ToolResponse(r) = c {
                Some(r.tool_result.as_ref().unwrap())
            } else {
                None
            }
        })
        .collect();
    assert_eq!(results.len(), 4);
    assert!(results
        .iter()
        .all(|r| serde_json::to_vec(r).unwrap().len() <= TOOL_RESULT_BYTES));
    assert_eq!(results[2].is_error, Some(false));
    assert_eq!(results[3].is_error, Some(true));
}
