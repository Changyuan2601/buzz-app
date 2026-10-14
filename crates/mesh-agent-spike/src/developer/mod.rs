// Adapted from Goose at 69de89c5 (Apache-2.0); modified for the Mesh host.
// Origin, adaptation details and licence: PROVENANCE.md and LICENSE.
//! Selected Goose Developer implementation, not a new tool implementation.
//! See PROVENANCE.md. App integration supplies the workspace explicitly.
pub mod edit;

pub mod shell;
mod shell_output_streaming;

// Extracted from Goose tool_execution.rs and subprocess.rs at the same pin.
#[derive(Clone)]
pub struct ToolCallNotificationEmitter {
    sender: tokio::sync::mpsc::Sender<rmcp::model::ServerNotification>,
}
impl ToolCallNotificationEmitter {
    pub fn new(sender: tokio::sync::mpsc::Sender<rmcp::model::ServerNotification>) -> Self {
        Self { sender }
    }
    fn emit_best_effort(&self, notification: rmcp::model::ServerNotification) {
        let _ = self.sender.try_send(notification);
    }
}
trait SubprocessExt {
    fn set_no_window(&mut self) -> &mut Self;
}
impl SubprocessExt for tokio::process::Command {
    fn set_no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        self.creation_flags(0x08000000);
        self
    }
}
impl SubprocessExt for std::process::Command {
    fn set_no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(0x08000000);
        }
        self
    }
}
