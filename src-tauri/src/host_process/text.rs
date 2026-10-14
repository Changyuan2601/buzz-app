//! Incremental lossy UTF-8 for a single process pipe.
#[path = "utf8_tail.rs"]
mod utf8_tail;

#[derive(Default)]
pub(super) struct TextDecoder {
    pending: Vec<u8>,
}

impl TextDecoder {
    pub(super) fn push(&mut self, bytes: &[u8]) -> String {
        if self.pending.is_empty() {
            let complete = bytes.len() - utf8_tail::tail_len(bytes);
            self.pending.extend_from_slice(&bytes[complete..]);
            return String::from_utf8_lossy(&bytes[..complete]).into_owned();
        }
        self.pending.extend_from_slice(bytes);
        let complete = self.pending.len() - utf8_tail::tail_len(&self.pending);
        let text = String::from_utf8_lossy(&self.pending[..complete]).into_owned();
        self.pending.copy_within(complete.., 0);
        self.pending.truncate(self.pending.len() - complete);
        text
    }

    pub(super) fn finish(&mut self) -> String {
        let text = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        text
    }
}
