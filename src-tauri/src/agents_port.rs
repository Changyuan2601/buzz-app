//! The port between the screens' page and the page that runs agents. Each
//! page opens its end with a channel, and a frame one page sends goes to the
//! other's channel. Only those two webviews take part, and the sender is the
//! webview the frame came from, so neither page listens to app events and no
//! other page can speak for either.

use std::{collections::HashMap, sync::Mutex};

use serde_json::Value;
use tauri::{ipc::Channel, Runtime, State, Webview};

const PAGES: [&str; 2] = ["main", "agents"];

/// The other page of the pair, for `label`.
fn peer(label: &str) -> Option<&'static str> {
    match label {
        "main" => Some("agents"),
        "agents" => Some("main"),
        _ => None,
    }
}

/// Each page's open end, by its webview's label. A page that loads again
/// opens a new one, which replaces the last.
#[derive(Default)]
pub(crate) struct AgentsPort(Mutex<HashMap<&'static str, Channel<Value>>>);

impl AgentsPort {
    fn open(&self, label: &str, frames: Channel<Value>) -> Result<(), String> {
        let page = PAGES
            .into_iter()
            .find(|page| *page == label)
            .ok_or("Only Buzz's own pages use the agents port")?;
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(page, frames);
        Ok(())
    }
    /// Sends `frame` from `label`'s page to its peer's. A peer that is not
    /// open yet misses it; it says when it is, and the sender sends again.
    fn send(&self, label: &str, frame: Value) -> Result<(), String> {
        let to = peer(label).ok_or("Only Buzz's own pages use the agents port")?;
        let channel = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(to)
            .cloned();
        match channel {
            Some(channel) => channel.send(frame).map_err(|error| error.to_string()),
            None => Ok(()),
        }
    }
}

#[tauri::command]
pub(crate) fn agents_port_listen<R: Runtime>(
    webview: Webview<R>,
    port: State<'_, AgentsPort>,
    frames: Channel<Value>,
) -> Result<(), String> {
    port.open(webview.label(), frames)
}

#[tauri::command]
pub(crate) fn agents_port_send<R: Runtime>(
    webview: Webview<R>,
    port: State<'_, AgentsPort>,
    frame: Value,
) -> Result<(), String> {
    port.send(webview.label(), frame)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex as StdMutex};
    use tauri::ipc::InvokeResponseBody;

    fn end() -> (Channel<Value>, Arc<StdMutex<Vec<Value>>>) {
        let heard = Arc::new(StdMutex::new(Vec::new()));
        let into = heard.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                into.lock()
                    .unwrap()
                    .push(serde_json::from_str(&json).unwrap());
            }
            Ok(())
        });
        (channel, heard)
    }

    #[test]
    fn frames_go_only_to_the_other_page_of_the_pair() {
        let port = AgentsPort::default();
        let (main, to_main) = end();
        let (agents, to_agents) = end();
        // Before the other page is open, a frame for it is missed, not held.
        port.send("main", Value::from("early")).unwrap();
        port.open("main", main).unwrap();
        port.open("agents", agents).unwrap();
        port.send("main", Value::from(1)).unwrap();
        port.send("agents", Value::from(2)).unwrap();
        assert_eq!(*to_agents.lock().unwrap(), vec![Value::from(1)]);
        assert_eq!(*to_main.lock().unwrap(), vec![Value::from(2)]);
        // A reloaded page's new end replaces its old one.
        let (again, to_again) = end();
        port.open("agents", again).unwrap();
        port.send("main", Value::from(3)).unwrap();
        assert_eq!(*to_again.lock().unwrap(), vec![Value::from(3)]);
        assert_eq!(to_agents.lock().unwrap().len(), 1);
        // No other page opens an end or sends.
        let (huddle, _) = end();
        assert!(port.open("huddle", huddle).is_err());
        assert!(port.send("huddle", Value::from(4)).is_err());
    }
}
