//! One process-local idle-sleep assertion. The main renderer supplies execution
//! demand, not telemetry. A native one-hour cap bounds stale renderer demand.
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;

#[derive(Clone, Serialize, Debug, Default, PartialEq)]
pub(crate) struct Status {
    supported: bool,
    active: bool,
    expired: bool,
    error: Option<String>,
}
#[derive(Default)]
struct State {
    lease: u32,
    generation: u64,
    assertion: Option<u32>,
    expired: bool,
    error: Option<String>,
    channel: Option<Channel<Status>>,
    timer: Option<tokio::task::JoinHandle<()>>,
}
#[derive(Clone, Default)]
pub(crate) struct KeepAwake(Arc<Mutex<State>>);
const CAP: std::time::Duration = std::time::Duration::from_secs(60 * 60);

impl State {
    fn status(&self) -> Status {
        Status {
            supported: cfg!(target_os = "macos"),
            active: self.assertion.is_some(),
            expired: self.expired,
            error: self.error.clone(),
        }
    }
    fn emit(&self) {
        if let Some(channel) = &self.channel {
            let _ = channel.send(self.status());
        }
    }
    fn cancel_timer(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        if let Some(timer) = self.timer.take() {
            timer.abort();
        }
    }
    fn release(&mut self) {
        self.cancel_timer();
        self.expired = false;
        self.error = None;
        if let Some(id) = self.assertion {
            match release(id) {
                Ok(()) => self.assertion = None,
                Err(error) => self.error = Some(error),
            }
        }
    }
}
impl KeepAwake {
    pub(crate) fn reset(&self) {
        if let Ok(mut state) = self.0.lock() {
            state.lease = state.lease.wrapping_add(1);
            state.release();
            state.channel = None;
        }
    }
    fn open(&self, channel: Channel<Status>) -> Result<u32, String> {
        let mut state = self.0.lock().map_err(|_| "Power state unavailable")?;
        state.release();
        state.lease = state.lease.wrapping_add(1);
        state.channel = Some(channel);
        state.emit();
        Ok(state.lease)
    }
    fn set(&self, lease: u32, active: bool) -> Result<Status, String> {
        let mut state = self.0.lock().map_err(|_| "Power state unavailable")?;
        if lease != state.lease {
            return Err("Keep-awake session changed. Reopen Buzz to try again.".into());
        }
        state.cancel_timer();
        state.expired = false;
        state.error = None;
        if !active {
            state.release();
        } else if cfg!(target_os = "macos") {
            if state.assertion.is_none() {
                match acquire() {
                    Ok(id) => state.assertion = Some(id),
                    Err(error) => state.error = Some(error),
                }
            }
            if state.assertion.is_some() {
                let generation = state.generation;
                let host = self.clone();
                let deadline = tokio::time::Instant::now() + CAP;
                state.timer = Some(tokio::spawn(async move {
                    tokio::time::sleep_until(deadline).await;
                    host.expire(generation);
                }));
            }
        }
        state.emit();
        Ok(state.status())
    }
    fn expire(&self, generation: u64) {
        let Ok(mut state) = self.0.lock() else {
            return;
        };
        if generation != state.generation || state.assertion.is_none() {
            return;
        }
        // This is the executing timer: do not abort its own task.
        state.timer = None;
        state.release();
        state.expired = state.assertion.is_none();
        state.emit();
    }
}
#[tauri::command]
pub(crate) fn agent_keep_awake_open(
    state: tauri::State<'_, KeepAwake>,
    channel: Channel<Status>,
) -> Result<u32, String> {
    state.open(channel)
}
#[tauri::command]
pub(crate) async fn agent_keep_awake_set(
    state: tauri::State<'_, KeepAwake>,
    lease: u32,
    active: bool,
) -> Result<Status, String> {
    state.set(lease, active)
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::{c_char, c_void};
    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        pub fn IOPMAssertionCreateWithName(
            kind: *const c_void,
            level: u32,
            name: *const c_void,
            id: *mut u32,
        ) -> i32;
        pub fn IOPMAssertionRelease(id: u32) -> i32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        pub fn CFStringCreateWithCString(
            allocator: *const c_void,
            text: *const c_char,
            encoding: u32,
        ) -> *const c_void;
        pub fn CFRelease(value: *const c_void);
    }
}
#[cfg(target_os = "macos")]
fn acquire() -> Result<u32, String> {
    unsafe {
        let kind = macos::CFStringCreateWithCString(
            std::ptr::null(),
            c"PreventUserIdleSystemSleep".as_ptr(),
            0x0800_0100,
        );
        let reason = macos::CFStringCreateWithCString(
            std::ptr::null(),
            c"Buzz — local agents are working".as_ptr(),
            0x0800_0100,
        );
        let mut id = 0;
        let result = if kind.is_null() || reason.is_null() {
            -1
        } else {
            macos::IOPMAssertionCreateWithName(kind, 255, reason, &mut id)
        };
        if !kind.is_null() {
            macos::CFRelease(kind);
        }
        if !reason.is_null() {
            macos::CFRelease(reason);
        }
        if result == 0 {
            Ok(id)
        } else {
            Err(format!(
                "Couldn’t prevent automatic sleep (system error {result})."
            ))
        }
    }
}
#[cfg(target_os = "macos")]
fn release(id: u32) -> Result<(), String> {
    let result = unsafe { macos::IOPMAssertionRelease(id) };
    if result == 0 {
        Ok(())
    } else {
        Err(format!(
            "Couldn’t release sleep prevention (system error {result})."
        ))
    }
}
#[cfg(not(target_os = "macos"))]
fn acquire() -> Result<u32, String> {
    Err("Sleep prevention is available on macOS only.".into())
}
#[cfg(not(target_os = "macos"))]
fn release(_: u32) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn leases_fence_old_renderers_and_native_cap_releases_real_assertion() {
        let host = KeepAwake::default();
        let first = host.open(Channel::new(|_| Ok(()))).unwrap();
        let lease = host.open(Channel::new(|_| Ok(()))).unwrap();
        assert!(host.set(first, true).is_err());
        let status = host.set(lease, true).unwrap();
        if !cfg!(target_os = "macos") {
            assert!(!status.supported);
            assert!(!status.active);
            return;
        }
        assert!(status.active, "{status:?}");
        let older = host.0.lock().unwrap().generation;
        tokio::time::advance(CAP / 2).await;
        host.set(lease, true).unwrap();
        tokio::time::advance(CAP / 2).await;
        host.expire(older); // An older timer cannot release the refreshed assertion.
        assert!(host.0.lock().unwrap().status().active);
        tokio::task::yield_now().await;
        tokio::time::advance(CAP).await;
        tokio::task::yield_now().await;
        assert!(host.0.lock().unwrap().status().expired);
        assert!(!host.0.lock().unwrap().status().active);
        assert!(host.set(lease, true).unwrap().active);
        assert!(!host.set(lease, false).unwrap().active);
        assert!(host.set(lease, true).unwrap().active);
        host.reset();
        assert!(!host.0.lock().unwrap().status().active);
        assert!(host.set(lease, true).is_err());
    }
}
