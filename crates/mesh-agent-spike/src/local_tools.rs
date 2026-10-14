//! Small explicit catalog around the extracted upstream tools.
use crate::{
    developer::{
        edit::{EditTools, FileEditParams, FileWriteParams},
        shell::{ShellParams, ShellTool},
    },
    skills::Skills,
    Tools,
};
use anyhow::Result;
use async_trait::async_trait;
use rmcp::model::{CallToolRequestParams, CallToolResult, ContentBlock, ErrorData, Tool};
use schemars::{schema_for, JsonSchema};
use serde::Deserialize;
use std::path::PathBuf;
use tokio_util::sync::CancellationToken;

pub struct LocalTools {
    cwd: PathBuf,
    shell: ShellTool,
    skills: Skills,
    cancel: CancellationToken,
}
#[derive(Deserialize, JsonSchema)]
struct LoadSkill {
    name: String,
    args: Option<String>,
}
fn definition<T: JsonSchema>(name: &'static str, description: &'static str) -> Tool {
    Tool::new(
        name,
        description,
        serde_json::to_value(schema_for!(T))
            .unwrap()
            .as_object()
            .unwrap()
            .clone(),
    )
}
impl LocalTools {
    pub fn new(cwd: PathBuf, skill_roots: &[PathBuf], cancel: CancellationToken) -> Result<Self> {
        anyhow::ensure!(
            cwd.is_absolute() && cwd.is_dir(),
            "Workspace must be an existing absolute directory"
        );
        Ok(Self {
            cwd,
            shell: ShellTool::new(false)?,
            skills: Skills::discover(skill_roots),
            cancel,
        })
    }
    pub fn instructions(&self) -> String {
        format!("Developer tools run in {} with the user's filesystem access, not a sandbox. Use shell for reading/searching, write/edit for changes. Shell jobs end with their tool call; do not start background services. Read applicable AGENTS.md before editing. Do not load relay-backed skills.\n{}", self.cwd.display(), self.skills.instructions())
    }
}
#[async_trait]
impl Tools for LocalTools {
    fn definitions(&self) -> Vec<Tool> {
        vec![
            definition::<ShellParams>("shell", "Run a shell command in the agent workspace. Bounded to 120 seconds; background jobs are not retained."),
            definition::<FileWriteParams>("write", "Create or overwrite a file; relative paths start in the workspace."),
            definition::<FileEditParams>("edit", "Replace one exact unique text match in a file."),
            definition::<LoadSkill>("load_skill", "Load an available filesystem skill, optionally with arguments, or skill-name/supporting-file."),
        ]
    }
    async fn call(&self, call: CallToolRequestParams) -> Result<CallToolResult, ErrorData> {
        if self.cancel.is_cancelled() {
            return Err(ErrorData::internal_error("Turn cancelled", None));
        }
        let args = serde_json::Value::Object(call.arguments.unwrap_or_default());
        let parse = |e: serde_json::Error| ErrorData::invalid_params(e.to_string(), None);
        let result = match call.name.as_ref() {
            "shell" => {
                let mut params: ShellParams = serde_json::from_value(args).map_err(parse)?;
                params.timeout_secs = Some(params.timeout_secs.unwrap_or(120).clamp(1, 120));
                self.shell
                    .shell_with_cwd(params, Some(&self.cwd), None, self.cancel.clone())
                    .await
            }
            "write" => EditTools::new().file_write_with_cwd(
                serde_json::from_value(args).map_err(parse)?,
                Some(&self.cwd),
            ),
            "edit" => EditTools::new().file_edit_with_cwd(
                serde_json::from_value(args).map_err(parse)?,
                Some(&self.cwd),
            ),
            "load_skill" => {
                let params: LoadSkill = serde_json::from_value(args).map_err(parse)?;
                match self.skills.load(&params.name, params.args.as_deref()) {
                    Ok(text) => CallToolResult::success(vec![ContentBlock::text(text)]),
                    Err(e) => CallToolResult::error(vec![ContentBlock::text(e.to_string())]),
                }
            }
            _ => return Err(ErrorData::invalid_params("Tool is not available", None)),
        };
        Ok(result)
    }
}
