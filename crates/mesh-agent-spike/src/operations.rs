//! Ordered GDK operations with Mesh's bounded turn policy. No storage service.
use super::*;
use goose_agent::{
    machine::{MachineSession, StateMachine, Step},
    operation::{
        applied, not_applicable, yielded, ConversationEffect, Emitter, Inference, InferenceInput,
        Operation, OperationResult, RunStatus,
    },
};
use goose_provider_types::conversation::Conversation;

struct Session {
    conversation: Conversation,
    rounds: usize,
    ids: HashSet<String>,
}
impl MachineSession for Session {
    fn id(&self) -> &str {
        "mesh-turn"
    }
    fn conversation(&self) -> Option<&Conversation> {
        Some(&self.conversation)
    }
}
struct Finish;
#[async_trait]
impl Operation<Session> for Finish {
    fn name(&self) -> &'static str {
        "finish"
    }
    async fn run(&self, s: &Session, c: &Conversation, _: &Emitter) -> Result<OperationResult> {
        if s.rounds > 0
            && c.messages().last().is_some_and(|m| {
                m.role == rmcp::model::Role::Assistant && m.get_tool_request_ids().is_empty()
            })
        {
            ensure!(
                !c.messages()
                    .last()
                    .unwrap()
                    .as_concat_text()
                    .trim()
                    .is_empty(),
                "missing final prose"
            );
            return yielded();
        }
        not_applicable()
    }
}
struct Dispatch<'a> {
    tools: &'a dyn Tools,
    definitions: Vec<Tool>,
    observe: &'a (dyn Fn(&Message) + Send + Sync),
}
#[async_trait]
impl Operation<Session> for Dispatch<'_> {
    fn name(&self) -> &'static str {
        "tools"
    }
    async fn inference_tools(&self, _: &Session) -> Result<Vec<Tool>> {
        Ok(self.definitions.clone())
    }
    async fn run(&self, s: &Session, c: &Conversation, _: &Emitter) -> Result<OperationResult> {
        let Some(message) = c
            .messages()
            .last()
            .filter(|m| m.role == rmcp::model::Role::Assistant)
        else {
            return not_applicable();
        };
        let requests: Vec<_> = message
            .content
            .iter()
            .filter_map(MessageContent::as_tool_request)
            .collect();
        if requests.is_empty() {
            return not_applicable();
        }
        ensure!(requests.len() <= 8, "tool call limit");
        let mut ids = s.ids.clone();
        for request in &requests {
            ensure!(ids.insert(request.id.clone()), "duplicate tool call id");
        }
        let mut effects = Vec::new();
        for request in requests {
            let result = match &request.tool_call {
                Ok(call) if self.definitions.iter().any(|t| t.name == call.name) => {
                    self.tools.call(call.clone()).await
                }
                Ok(_) => Err(ErrorData::invalid_params("Tool is not available", None)),
                Err(error) => Err(error.clone()),
            }
            .map(bounded_tool_result);
            let response = Message::user().with_tool_response(request.id.clone(), result);
            (self.observe)(&response);
            effects.push(response.into());
        }
        applied(effects)
    }
}
struct Budget(usize);
#[async_trait]
impl Operation<Session> for Budget {
    fn name(&self) -> &'static str {
        "budget"
    }
    async fn run(&self, s: &Session, c: &Conversation, _: &Emitter) -> Result<OperationResult> {
        ensure!(s.rounds < self.0, "round limit reached");
        ensure!(
            serde_json::to_vec(c.messages())?.len() <= 256 * 1024,
            "context byte limit"
        );
        not_applicable()
    }
}
struct Compact<'a> {
    provider: &'a dyn Provider,
    model: &'a ModelConfig,
    observe: &'a (dyn Fn(&Message) + Send + Sync),
}
#[async_trait]
impl Operation<Session> for Compact<'_> {
    fn name(&self) -> &'static str {
        "compact"
    }
    async fn run(&self, _: &Session, c: &Conversation, _: &Emitter) -> Result<OperationResult> {
        if serde_json::to_vec(c.messages())?.len() <= 24 * 1024 {
            return not_applicable();
        }
        let summary = goose_context_management::summarize(
            &SummaryModel {
                provider: self.provider,
                model: self.model,
            },
            None,
            &goose_context_management::Templates::default(),
            c.messages(),
        )
        .await?;
        ensure!(
            !summary.message.as_concat_text().trim().is_empty(),
            "empty context summary"
        );
        ensure!(
            serde_json::to_vec(&summary.message)?.len() < 12 * 1024,
            "context summary too large"
        );
        (self.observe)(
            &Message::assistant()
                .with_text("[Context compacted for inference; original tool trace retained.]"),
        );
        applied([ConversationEffect::ReplaceConversation(
            Conversation::new_unvalidated([summary.message]),
        )])
    }
}
// Unlike InferenceRunner's retry/repair policy, this trial rejects empty output
// and enforces its byte/chunk bounds before accepting a model response.
struct Infer<'a> {
    provider: &'a dyn Provider,
    model: &'a ModelConfig,
    system: &'a str,
}
#[async_trait]
impl Operation<Session> for Infer<'_> {
    fn name(&self) -> &'static str {
        "inference"
    }
}
#[async_trait]
impl Inference<Session> for Infer<'_> {
    fn applies(&self, _: &Conversation) -> bool {
        true
    }
    async fn infer(
        &self,
        _: &Session,
        c: &Conversation,
        input: InferenceInput,
        _: &Emitter,
    ) -> Result<OperationResult> {
        let (message, _) = completion(
            self.provider,
            self.model,
            self.system,
            c.messages(),
            &input.tools,
        )
        .await?;
        applied([message.into()])
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn drive(
    provider: &dyn Provider,
    model: &ModelConfig,
    system: &str,
    history: &mut Vec<Message>,
    tools: &dyn Tools,
    definitions: Vec<Tool>,
    cancel: CancellationToken,
    max_rounds: usize,
    observe: &(dyn Fn(&Message) + Send + Sync),
) -> Result<String> {
    let machine = StateMachine::new(
        vec![
            Step::Operation(Arc::new(Finish)),
            Step::Operation(Arc::new(Dispatch {
                tools,
                definitions,
                observe,
            })),
            Step::Operation(Arc::new(Budget(max_rounds))),
            Step::Operation(Arc::new(Compact {
                provider,
                model,
                observe,
            })),
            Step::Inference(Arc::new(Infer {
                provider,
                model,
                system,
            })),
        ],
        cancel.clone(),
    );
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    drop(rx); // The host observes accepted effects directly, not a second event buffer.
    let emit = Emitter::new(tx, cancel);
    let mut session = Session {
        conversation: Conversation::new_unvalidated(history.clone()),
        rounds: 0,
        ids: HashSet::new(),
    };
    loop {
        let step = machine.step(&session, &emit).await?;
        if step.status == RunStatus::Cancelled {
            bail!("turn cancelled")
        }
        if step.applied_step == Some("inference") {
            session.rounds += 1;
        }
        for effect in step.effects {
            match effect {
                ConversationEffect::AppendMessage(message) => {
                    if step.applied_step == Some("inference") {
                        observe(&message);
                    }
                    for id in message.get_tool_response_ids() {
                        session.ids.insert(id.to_string());
                    }
                    session.conversation.push(message);
                }
                ConversationEffect::ReplaceConversation(c) => session.conversation = c,
                _ => unreachable!("Mesh operations only append or compact"),
            }
        }
        if step.status == RunStatus::Yielded {
            let text = session
                .conversation
                .messages()
                .last()
                .unwrap()
                .as_concat_text();
            *history = session.conversation.messages().clone();
            return Ok(text);
        }
    }
}
