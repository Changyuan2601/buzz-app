use super::*;
#[cfg(unix)]
use tauri::ipc::InvokeResponseBody;
#[cfg(unix)]
use tokio::sync::mpsc;

#[cfg(unix)]
fn channel() -> (
    Channel<ProcessEvent>,
    mpsc::UnboundedReceiver<serde_json::Value>,
) {
    let (sender, receiver) = mpsc::unbounded_channel();
    let channel = Channel::new(move |body| {
        if let InvokeResponseBody::Json(json) = body {
            let _ = sender.send(serde_json::from_str(&json).unwrap());
        }
        Ok(())
    });
    (channel, receiver)
}

#[cfg(unix)]
fn command(program: &str, args: &[&str]) -> Command {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.as_std_mut().process_group(0);
    command
}

/// Collects output until the exit event, which it returns last.
#[cfg(unix)]
async fn until_exit(
    events: &mut mpsc::UnboundedReceiver<serde_json::Value>,
) -> (String, String, serde_json::Value) {
    let (mut stdout, mut stderr) = (String::new(), String::new());
    loop {
        let event = tokio::time::timeout(Duration::from_secs(10), events.recv())
            .await
            .expect("process event")
            .expect("open channel");
        match event["type"].as_str() {
            Some("stdout") => stdout.push_str(event["data"].as_str().unwrap()),
            Some("stderr") => stderr.push_str(event["data"].as_str().unwrap()),
            _ => return (stdout, stderr, event),
        }
    }
}

#[cfg(unix)]
#[tokio::test]
async fn streams_stdin_to_stdout_until_input_closes() {
    let processes = HostProcesses::default();
    let (channel, mut events) = channel();
    let handle = processes
        .start(
            0,
            "a.plugin".into(),
            "cat",
            command("cat", &[]),
            channel,
            false,
        )
        .unwrap();
    processes
        .write("a.plugin", handle, "one\n".into(), false, None)
        .await
        .unwrap();
    processes
        .write("a.plugin", handle, "two\n".into(), true, None)
        .await
        .unwrap();
    let (stdout, _, exit) = until_exit(&mut events).await;
    assert_eq!(stdout, "one\ntwo\n");
    assert_eq!(exit, serde_json::json!({"type": "exit", "code": 0}));
    assert!(processes.registry().entries.is_empty());
    assert_eq!(
        processes
            .write("a.plugin", handle, "late".into(), false, None)
            .await,
        Err("No such process".into())
    );
}

#[cfg(unix)]
#[tokio::test]
async fn reports_stderr_and_exit_code() {
    let processes = HostProcesses::default();
    let (channel, mut events) = channel();
    processes
        .start(
            0,
            "a.plugin".into(),
            "sh",
            command("sh", &["-c", "echo oops >&2; exit 3"]),
            channel,
            false,
        )
        .unwrap();
    let (_, stderr, exit) = until_exit(&mut events).await;
    assert_eq!(stderr, "oops\n");
    assert_eq!(exit["code"], 3);
}

#[cfg(unix)]
#[tokio::test]
async fn only_the_owning_plugin_can_write_or_kill() {
    let processes = HostProcesses::default();
    let (channel, mut events) = channel();
    let handle = processes
        .start(
            0,
            "a.plugin".into(),
            "cat",
            command("cat", &[]),
            channel,
            false,
        )
        .unwrap();
    assert!(processes
        .write("b.plugin", handle, "x".into(), false, None)
        .await
        .is_err());
    assert!(processes.kill("b.plugin", handle).is_err());
    processes.kill("a.plugin", handle).unwrap();
    let (_, _, exit) = until_exit(&mut events).await;
    assert_eq!(exit["type"], "exit");
}

#[cfg(unix)]
#[tokio::test]
async fn kill_ends_the_process_and_its_descendants() {
    let processes = HostProcesses::default();
    let (channel, mut events) = channel();
    // The shell ignores the polite signal; its child would outlive it.
    let handle = processes
        .start(
            0,
            "a.plugin".into(),
            "sh",
            command("sh", &["-c", "trap '' TERM; sleep 30 & echo $!; wait"]),
            channel,
            false,
        )
        .unwrap();
    let child: i32 = loop {
        let event = events.recv().await.unwrap();
        if event["type"] == "stdout" {
            break event["data"].as_str().unwrap().trim().parse().unwrap();
        }
    };
    processes.kill("a.plugin", handle).unwrap();
    let (_, _, exit) = until_exit(&mut events).await;
    assert_eq!(exit["code"], serde_json::Value::Null);
    assert_dead(child).await;
}

#[cfg(unix)]
#[tokio::test]
async fn stop_all_ends_every_process() {
    let processes = HostProcesses::default();
    let (first, mut first_events) = channel();
    let (second, mut second_events) = channel();
    processes
        .start(
            0,
            "a.plugin".into(),
            "cat",
            command("cat", &[]),
            first,
            false,
        )
        .unwrap();
    processes
        .start(
            0,
            "b.plugin".into(),
            "cat",
            command("cat", &[]),
            second,
            false,
        )
        .unwrap();
    processes.stop_all();
    until_exit(&mut first_events).await;
    until_exit(&mut second_events).await;
    assert!(processes.registry().entries.is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn a_page_that_stops_listening_stops_the_process() {
    let processes = HostProcesses::default();
    let channel = Channel::new(|_| Err(tauri::Error::FailedToReceiveMessage));
    let handle = processes
        .start(
            0,
            "a.plugin".into(),
            "sh",
            command("sh", &["-c", "echo hi; sleep 30"]),
            channel,
            false,
        )
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while processes.registry().entries.contains_key(&handle) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("process stopped");
}

#[cfg(unix)]
#[tokio::test]
async fn a_spawn_from_before_a_reload_is_refused() {
    let processes = HostProcesses::default();
    let page = processes.page();
    processes.stop_all();
    let (channel, _events) = channel();
    let refused = processes.start(
        page,
        "a.plugin".into(),
        "cat",
        command("cat", &[]),
        channel,
        false,
    );
    assert_eq!(refused.err().as_deref(), Some("The page reloaded"));
    assert!(processes.registry().entries.is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn a_process_may_close_its_output_and_carry_on() {
    let processes = HostProcesses::default();
    let (channel, mut events) = channel();
    processes
        .start(
            0,
            "a.plugin".into(),
            "sh",
            command("sh", &["-c", "exec >&- 2>&-; sleep 1; exit 4"]),
            channel,
            false,
        )
        .unwrap();
    let (_, _, exit) = until_exit(&mut events).await;
    assert_eq!(exit["code"], 4);
}

#[cfg(unix)]
#[tokio::test]
async fn shutdown_kills_every_group_without_waiting() {
    let processes = HostProcesses::default();
    let (channel, mut events) = channel();
    processes
        .start(
            0,
            "a.plugin".into(),
            "sh",
            command("sh", &["-c", "trap '' TERM; sleep 30 & echo $!; wait"]),
            channel,
            false,
        )
        .unwrap();
    let child: i32 = loop {
        let event = events.recv().await.unwrap();
        if event["type"] == "stdout" {
            break event["data"].as_str().unwrap().trim().parse().unwrap();
        }
    };
    processes.shutdown();
    assert_dead(child).await;
}

#[test]
fn text_waits_for_a_split_character() {
    let mut pending = "héllo".as_bytes()[..2].to_vec();
    assert_eq!(take_text(&mut pending), "h");
    assert_eq!(pending, [0xc3]);
    pending.extend_from_slice(&"héllo".as_bytes()[2..]);
    assert_eq!(take_text(&mut pending), "éllo");
    assert!(pending.is_empty());
    let mut invalid = vec![b'a', 0xff, b'b'];
    assert_eq!(take_text(&mut invalid), "a\u{fffd}b");
}

#[test]
fn directories_are_absolute_or_under_home() {
    let home = home().unwrap();
    assert_eq!(expand_home("~").unwrap(), home);
    assert_eq!(expand_home("~/.buzz").unwrap(), home.join(".buzz"));
    assert!(expand_home("relative/dir").is_err());
    assert!(expand_home("~other/dir").is_err());
}

/// Waits until `pid` has died. A process its new parent has not reaped yet
/// still answers kill(0), as a zombie, so a zombie counts as dead.
#[cfg(unix)]
async fn assert_dead(pid: i32) {
    let dead = || {
        (unsafe { libc::kill(pid, 0) }) != 0
            || std::process::Command::new("ps")
                .args(["-o", "stat=", "-p", &pid.to_string()])
                .output()
                .is_ok_and(|out| out.stdout.trim_ascii_start().starts_with(b"Z"))
    };
    let until = std::time::Instant::now() + Duration::from_secs(5);
    while !dead() && std::time::Instant::now() < until {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(dead(), "descendant survived");
}

#[cfg(unix)]
#[tokio::test]
async fn native_turn_evidence_is_captured_before_renderer_delivery() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let processes = HostProcesses::default();
    let observer = processes.observer.clone();
    let captured = Arc::new(AtomicBool::new(false));
    let saw = captured.clone();
    let (sender, mut events) = mpsc::unbounded_channel();
    let delivered = Arc::new(Mutex::new(String::new()));
    let channel = Channel::new(move |body: InvokeResponseBody| {
        if let InvokeResponseBody::Json(json) = body {
            let value: serde_json::Value = serde_json::from_str(&json).unwrap();
            if value["type"] == "stdout" {
                let mut buffer = delivered.lock().unwrap();
                buffer.push_str(value["data"].as_str().unwrap());
                while let Some(end) = buffer.find('\n') {
                    let line: String = buffer.drain(..=end).collect();
                    let wire: serde_json::Value = serde_json::from_str(&line).unwrap();
                    if wire["id"] == 1 && wire.get("result").is_some() {
                        saw.store(
                            !observer.snapshot()["sessions"]
                                .as_array()
                                .unwrap()
                                .is_empty(),
                            Ordering::SeqCst,
                        );
                    }
                }
            }
            let _ = sender.send(value);
        }
        Ok(())
    });
    let script = r#"import sys,json
for line in sys.stdin:
 request=json.loads(line)
 thread=request['params']['threadId']
 print(json.dumps({'id':request['id'],'result':{'turn':{'id':'native-turn'}}}))
 print(json.dumps({'method':'turn/started','params':{'threadId':thread,'turn':{'id':'native-turn'}}}))
 print(json.dumps({'method':'turn/completed','params':{'threadId':thread,'turn':{'id':'native-turn','status':'completed'}}}))
 sys.stdout.flush()
"#;
    let handle = processes
        .start(
            0,
            "buzz.codex".into(),
            "python3",
            command("python3", &["-c", script]),
            channel,
            true,
        )
        .unwrap();
    let route = crate::plugin_observer::Route {
        relay: "wss://fixture.test".into(),
        owner: "a".repeat(64),
        agent: "b".repeat(64),
        channel_id: "fixture-channel".into(),
        root_id: "c".repeat(64),
        trigger_id: "d".repeat(64),
    };
    processes
        .write(
            "buzz.codex",
            handle,
            "{\"id\":1,\"method\":\"turn/start\",\"params\":{\"threadId\":\"native-thread\"}}\n"
                .into(),
            true,
            Some(route),
        )
        .await
        .unwrap();
    until_exit(&mut events).await;
    assert!(captured.load(Ordering::SeqCst));
    let snapshot = processes.observer.snapshot();
    assert_eq!(snapshot["sessions"][0]["codex_thread_id"], "native-thread");
    assert_eq!(snapshot["sessions"][0]["state"], "completed");
    assert_eq!(snapshot["sessions"][0]["trigger_ids"][0], "d".repeat(64));
}
