// Charon follows this call into the exact production source, not a copy.
#[path = "../../../../src-tauri/src/host_process/utf8_tail.rs"]
mod kernel;

pub fn tail_len(bytes: &[u8]) -> usize {
    kernel::tail_len(bytes)
}
