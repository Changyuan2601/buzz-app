//! One pending callback per sequential native turn; response IDs are host generated.
use crate::{ToolCall, ToolResult};
use anyhow::{bail, Result};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

pub struct Callback {
    next: AtomicU64,
    pending: Mutex<Option<(u64, oneshot::Sender<ToolResult>)>>,
    pub cancel: CancellationToken,
}
impl Default for Callback {
    fn default() -> Self {
        Self::new(CancellationToken::new())
    }
}
impl Callback {
    pub fn new(cancel: CancellationToken) -> Self {
        Self {
            next: AtomicU64::new(0),
            pending: Mutex::new(None),
            cancel,
        }
    }
}
impl Callback {
    pub async fn call(
        &self,
        call: ToolCall,
        emit: impl FnOnce(u64, ToolCall) -> Result<()>,
    ) -> Result<ToolResult> {
        if self.cancel.is_cancelled() {
            bail!("Turn cancelled");
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap();
            if pending.is_some() {
                bail!("A tool call is already pending");
            }
            *pending = Some((id, tx));
        }
        let result = async {
            emit(id, call)?;
            tokio::select! {
                biased;
                _ = self.cancel.cancelled() => bail!("Turn cancelled"),
                result = rx => Ok(result?),
            }
        }
        .await;
        self.pending.lock().unwrap().take();
        result
    }
    pub fn resolve(&self, id: u64, result: ToolResult) -> Result<()> {
        if self.cancel.is_cancelled() {
            bail!("Turn cancelled");
        }
        let mut pending = self.pending.lock().unwrap();
        if pending.as_ref().map(|p| p.0) != Some(id) {
            bail!("Stale tool result");
        }
        pending
            .take()
            .unwrap()
            .1
            .send(result)
            .map_err(|_| anyhow::anyhow!("Tool call ended"))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn rejects_wrong_duplicate_and_cancelled_results() {
        let callback = Callback::default();
        let call: ToolCall =
            serde_json::from_value(serde_json::json!({"name":"send","arguments":{}})).unwrap();
        let result = callback
            .call(call.clone(), |id, _| {
                assert!(callback.resolve(id + 1, ToolResult::default()).is_err());
                callback.resolve(id, ToolResult::default())?;
                assert!(callback.resolve(id, ToolResult::default()).is_err());
                Ok(())
            })
            .await;
        assert!(result.is_ok());
        let result = callback
            .call(call, |id, _| {
                callback.cancel.cancel();
                assert!(callback.resolve(id, ToolResult::default()).is_err());
                Ok(())
            })
            .await;
        assert!(result.is_err());
    }
}
