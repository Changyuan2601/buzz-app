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
        .start(0, "a.plugin".into(), "cat", command("cat", &[]), channel)
        .unwrap();
    processes
        .write("a.plugin", handle, "one\n".into(), false)
        .await
        .unwrap();
    processes
        .write("a.plugin", handle, "two\n".into(), true)
        .await
        .unwrap();
    let (stdout, _, exit) = until_exit(&mut events).await;
    assert_eq!(stdout, "one\ntwo\n");
    assert_eq!(exit, serde_json::json!({"type": "exit", "code": 0}));
    assert!(processes.registry().entries.is_empty());
    assert_eq!(
        processes
            .write("a.plugin", handle, "late".into(), false)
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
        .start(0, "a.plugin".into(), "cat", command("cat", &[]), channel)
        .unwrap();
    assert!(processes
        .write("b.plugin", handle, "x".into(), false)
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
        .start(0, "a.plugin".into(), "cat", command("cat", &[]), first)
        .unwrap();
    processes
        .start(0, "b.plugin".into(), "cat", command("cat", &[]), second)
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
    let refused = processes.start(page, "a.plugin".into(), "cat", command("cat", &[]), channel);
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
    let mut decoder = TextDecoder::default();
    assert_eq!(decoder.push(&"héllo".as_bytes()[..2]), "h");
    assert_eq!(decoder.push(&"héllo".as_bytes()[2..]), "éllo");
    assert_eq!(decoder.finish(), "");
    assert_eq!(decoder.push(&[b'a', 0xff, b'b']), "a\u{fffd}b");
    assert_eq!(decoder.push(&[0xff, 0xe2]), "\u{fffd}");
    assert_eq!(decoder.push(&[0x82, 0xac]), "€");
    assert_eq!(decoder.finish(), "");
}

/// Check concatenated output, not event boundaries: reads may split anywhere.
fn assert_partitions(bytes: &[u8]) {
    let expected = String::from_utf8_lossy(bytes);
    for cuts in 0..(1usize << bytes.len().saturating_sub(1)) {
        let mut decoder = TextDecoder::default();
        let mut output = decoder.push(&[]);
        let mut start = 0;
        for end in 1..bytes.len() {
            if cuts & (1 << (end - 1)) != 0 {
                output.push_str(&decoder.push(&bytes[start..end]));
                start = end;
            }
        }
        output.push_str(&decoder.push(&bytes[start..]));
        output.push_str(&decoder.finish());
        assert_eq!(output, expected, "bytes={bytes:x?}, cuts={cuts:b}");
        assert_eq!(decoder.finish(), "");
    }
}

#[test]
fn lossy_text_is_independent_of_read_partitions() {
    // UTF-8 boundary classes, including overlongs, surrogates, out-of-range
    // scalars, stray continuations and truncated valid prefixes at EOF.
    for bytes in [
        &[][..],
        &[0xff, 0xe2, 0x82, 0xac],
        &[0xe2, 0xc2],
        &[0xe0, 0x80],
        &[0xed, 0xa0],
        &[0xf0, 0x80],
        &[0xf4, 0x90],
        &[0xf0, 0x90, 0x80],
        &[0xf4, 0x8f, 0xbf],
        &[0xe2, 0x82],
        "a€𐀀z".as_bytes(),
    ] {
        assert_partitions(bytes);
    }
    const BYTES: [u8; 15] = [
        0x61, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc2, 0xdf, 0xe0, 0xe2, 0xed, 0xf0, 0xf4, 0xff,
    ];
    for len in 1..=4 {
        for mut code in 0..BYTES.len().pow(len) {
            let mut bytes = vec![0; len as usize];
            for byte in &mut bytes {
                *byte = BYTES[code % BYTES.len()];
                code /= BYTES.len();
            }
            assert_partitions(&bytes);
        }
    }
}

#[cfg(unix)]
#[tokio::test]
async fn forwards_malformed_prefix_then_split_scalar_on_each_pipe() {
    for stream in [Stream::Stdout, Stream::Stderr] {
        let (mut writer, reader) = tokio::io::duplex(32);
        let (channel, mut events) = channel();
        let (gone, _closed) = oneshot::channel();
        let forwarding = forward(reader, stream, channel, Arc::new(Mutex::new(Some(gone))));
        writer.write_all(&[0xff, 0xe2]).await.unwrap();
        // This event is a barrier proving the first read was decoded before
        // the next write; the pipe cannot coalesce away the split we test.
        let first = tokio::time::timeout(Duration::from_secs(5), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            first["type"],
            match stream {
                Stream::Stdout => "stdout",
                Stream::Stderr => "stderr",
            }
        );
        assert_eq!(first["data"], "\u{fffd}");
        writer
            .write_all(&[0x82, 0xac, b'x', 0xe2, 0x82])
            .await
            .unwrap();
        writer.shutdown().await.unwrap();
        forwarding.await.unwrap();
        let mut output = first["data"].as_str().unwrap().to_owned();
        while let Some(event) = events.recv().await {
            assert_eq!(event["type"], first["type"]);
            output.push_str(event["data"].as_str().unwrap());
        }
        assert_eq!(
            output,
            String::from_utf8_lossy(&[0xff, 0xe2, 0x82, 0xac, b'x', 0xe2, 0x82])
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn incomplete_output_is_flushed_before_exit() {
    let processes = HostProcesses::default();
    let (channel, mut events) = channel();
    processes
        .start(
            0,
            "a.plugin".into(),
            "sh",
            command(
                "sh",
                &["-c", "printf '\\170\\342'; printf '\\342\\202' >&2"],
            ),
            channel,
        )
        .unwrap();
    let (stdout, stderr, exit) = until_exit(&mut events).await;
    assert_eq!(stdout, "x\u{fffd}");
    assert_eq!(stderr, "\u{fffd}");
    assert_eq!(exit, serde_json::json!({"type": "exit", "code": 0}));
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
