//! Local experiment: a Mesh-owned Rust loop, with GDK inference and inline tools.
//! No ACP or MCP transport; the desktop host injects tool authority.
pub mod callback;
pub mod developer;
pub mod local_tools;
mod operations;
pub mod skills;
pub use goose_provider_types::{
    conversation::message::Message as AgentMessage, model::ModelConfig as AgentModel,
};
pub use rmcp::model::{
    CallToolRequestParams as ToolCall, CallToolResult as ToolResult, ErrorData as ToolError,
    Tool as ToolDefinition,
};

use anyhow::{bail, ensure, Result};
use async_trait::async_trait;
use futures::StreamExt;
use goose_provider_types::{
    base::{collect_stream, Provider},
    conversation::message::{Message, MessageContent},
    conversation::token_usage::ProviderUsage,
    errors::ProviderError,
    model::ModelConfig,
};
use goose_providers::{
    api_client::{ApiClient, AuthMethod},
    openai::OpenAiProviderBuilder,
};
use rmcp::model::{CallToolRequestParams, CallToolResult, ErrorData, Tool};
use std::{collections::HashSet, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

/// Injected per-turn capability. The implementation, not model arguments, owns
/// agent/community authority. A production adapter must revalidate it at dispatch.
#[async_trait]
pub trait Tools: Send + Sync {
    /// Stable advertised tool catalog for this turn.
    fn definitions(&self) -> Vec<Tool>;
    /// Execute under the adapter's authority; cancellation cannot undo a send.
    async fn call(&self, call: CallToolRequestParams) -> Result<CallToolResult, ErrorData>;
}

/// Build the real GDK OpenAI-compatible provider without process-global config.
/// Caller supplies the host-approved Mesh endpoint; never expose this as model input.
pub fn provider(endpoint: String) -> Result<Arc<dyn Provider>> {
    let client = ApiClient::with_timeout_and_tls(
        endpoint,
        AuthMethod::NoAuth,
        Duration::from_secs(240),
        None,
    )?;
    Ok(Arc::new(
        OpenAiProviderBuilder::new(client)
            .name("mesh-spike")
            .build(),
    ))
}

pub const TOOL_RESULT_BYTES: usize = 32 * 1024;

/// Keep completed effects visible as a recoverable tool error, never replay the operation.
pub fn bounded_tool_result(mut result: ToolResult) -> ToolResult {
    let fits = |result: &ToolResult| {
        serde_json::to_vec(result).is_ok_and(|v| v.len() <= TOOL_RESULT_BYTES)
    };
    if fits(&result) {
        return result;
    }
    // Goose shell repeats its display in structuredContent; the model needs one copy.
    result.structured_content = None;
    if fits(&result) {
        return result;
    }
    ToolResult::error(vec![rmcp::model::ContentBlock::text(
        "Tool completed, but its result exceeded the 32 KiB response limit. Side effects are not rolled back. Do not repeat writes or sends; use a smaller read limit, pagination, or shell head/sed to inspect output. A skill with this error was not loaded in full."
    )])
}

async fn completion(
    provider: &dyn Provider,
    model: &ModelConfig,
    system: &str,
    messages: &[Message],
    tools: &[Tool],
) -> std::result::Result<(Message, ProviderUsage), ProviderError> {
    let mut stream = provider.stream(model, system, messages, tools).await?;
    let mut chunks = Vec::new();
    let mut bytes = 0usize;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if let Some(message) = &chunk.0 {
            for content in &message.content {
                bytes += match content {
                    MessageContent::Text(text) => text.text.len(),
                    MessageContent::Thinking(thinking) => {
                        thinking.thinking.len() + thinking.signature.len()
                    }
                    _ => serde_json::to_vec(content)
                        .map_err(|e| ProviderError::ExecutionError(e.to_string()))?
                        .len(),
                };
            }
        }
        if bytes > 64 * 1024 || chunks.len() >= 4096 {
            return Err(ProviderError::ExecutionError("response limit".into()));
        }
        chunks.push(Ok(chunk));
    }
    collect_stream(Box::pin(futures::stream::iter(chunks))).await
}

struct SummaryModel<'a> {
    previous_bytes: std::sync::atomic::AtomicUsize,
    provider: &'a dyn Provider,
    model: &'a ModelConfig,
}
#[async_trait]
impl goose_context_management::CompactionModel for SummaryModel<'_> {
    async fn complete(
        &self,
        system: &str,
        messages: &[Message],
    ) -> std::result::Result<(Message, ProviderUsage), ProviderError> {
        let bytes = system.len()
            + serde_json::to_vec(messages)
                .map_err(|e| ProviderError::ExecutionError(e.to_string()))?
                .len();
        let previous = self
            .previous_bytes
            .swap(bytes, std::sync::atomic::Ordering::Relaxed);
        if bytes > 300 * 1024 || bytes >= previous {
            return Err(ProviderError::ExecutionError(
                "summary input exceeds bound or retry made no progress".into(),
            ));
        }
        completion(self.provider, self.model, system, messages, &[]).await
    }
}

/// Bounded experimental turn, caller-owned history and injected tool capability.
/// A failed/cancelled turn leaves its supplied history unchanged. External tool
/// effects may already have happened; this loop has no turn replay. The GDK provider retains its own request retries.
pub async fn run(
    provider: &dyn Provider,
    model: &ModelConfig,
    system: &str,
    history: &mut Vec<Message>,
    tools: &dyn Tools,
    cancel: CancellationToken,
    max_rounds: usize,
) -> Result<String> {
    run_observed(
        provider,
        model,
        system,
        history,
        tools,
        cancel,
        max_rounds,
        |_| {},
    )
    .await
}

/// The observer receives accepted messages, including tool results, before the next request.
/// This lets the host retain partial effects even when a later inference fails.
#[allow(clippy::too_many_arguments)]
pub async fn run_observed(
    provider: &dyn Provider,
    model: &ModelConfig,
    system: &str,
    history: &mut Vec<Message>,
    tools: &dyn Tools,
    cancel: CancellationToken,
    max_rounds: usize,
    observe: impl Fn(&Message) + Send + Sync,
) -> Result<String> {
    ensure!((1..=32).contains(&max_rounds), "round limit must be 1..=32");
    ensure!(system.len() <= 32 * 1024, "system prompt byte limit");
    let definitions = tools.definitions();
    ensure!(definitions.len() <= 32, "tool catalog limit");
    ensure!(
        serde_json::to_vec(&definitions)?.len() <= 64 * 1024,
        "tool schema byte limit"
    );
    let names: HashSet<_> = definitions.iter().map(|t| t.name.as_ref()).collect();
    ensure!(names.len() == definitions.len(), "duplicate tool name");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(240);
    let turn = operations::drive(
        provider,
        model,
        system,
        history,
        tools,
        definitions,
        cancel.clone(),
        max_rounds,
        &observe,
    );
    tokio::select! {
        biased;
        _ = cancel.cancelled() => bail!("turn cancelled"),
        _ = tokio::time::sleep_until(deadline) => bail!("turn deadline exceeded"),
        result = turn => result,
    }
}

#[cfg(test)]
mod tests;
