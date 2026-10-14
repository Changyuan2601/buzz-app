//! Size probe and localhost-only manual driver. Sends are console callbacks, not Buzz publications.
use anyhow::{ensure, Result};
use async_trait::async_trait;
use buzz_mesh_agent_spike::{provider, run, Tools};
use goose_provider_types::{conversation::message::Message, model::ModelConfig};
use rmcp::model::{CallToolRequestParams, CallToolResult, ContentBlock, ErrorData, Tool};
use serde_json::json;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

struct ConsoleTools;
#[async_trait]
impl Tools for ConsoleTools {
    fn definitions(&self) -> Vec<Tool> {
        vec![Tool::new_with_raw(
            "send",
            Some("Record a test message (not a real Buzz send)".into()),
            Arc::new(serde_json::Map::from_iter([
                ("type".into(), json!("object")),
                ("properties".into(), json!({"text":{"type":"string"}})),
                ("required".into(), json!(["text"])),
                ("additionalProperties".into(), json!(false)),
            ])),
        )]
    }
    async fn call(&self, call: CallToolRequestParams) -> Result<CallToolResult, ErrorData> {
        let arguments = call.arguments.unwrap_or_default();
        let text = arguments
            .get("text")
            .and_then(|v| v.as_str())
            .filter(|_| arguments.len() == 1)
            .ok_or_else(|| ErrorData::invalid_params("only text is accepted", None))?;
        println!("INLINE SEND (test only): {text}");
        Ok(CallToolResult::success(vec![ContentBlock::text(
            "recorded",
        )]))
    }
}
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let endpoint = std::env::args().nth(1).unwrap_or_default();
    ensure!(
        endpoint.starts_with("http://127.0.0.1:"),
        "usage: linked_probe http://127.0.0.1:PORT [model]; test callback only"
    );
    let model = std::env::args().nth(2).unwrap_or_else(|| "mesh".into());
    let provider = provider(endpoint)?;
    let mut history =
        vec![Message::user().with_text("Call send twice with short updates, then answer briefly.")];
    let answer = run(
        provider.as_ref(),
        &ModelConfig::new(model),
        "You are an integration test agent.",
        &mut history,
        &ConsoleTools,
        CancellationToken::new(),
        8,
    )
    .await?;
    println!("FINAL: {answer}");
    Ok(())
}
