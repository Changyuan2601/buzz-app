//! A stdio MCP server an agent harness can launch whose tools the app runs.
//!
//! Harnesses such as goose (over ACP) only add tools as stdio servers they spawn
//! themselves, with no way to call the client back. So the app's own executable
//! doubles as both ends of a private, per-turn channel:
//!
//! - `--tool-listen` (started by a plugin as a declared host process): binds a
//!   Unix socket in a fresh 0700 directory under the per-user temp dir, prints
//!   `{"command","socket","token"}` as its first stdout line, accepts exactly
//!   one connection presenting the token, then copies that connection to and
//!   from its own stdio, so the plugin answers the MCP messages itself.
//! - `--tool-relay` (named by the plugin as the harness's stdio MCP server, with
//!   `BUZZ_TOOL_SOCKET` and `BUZZ_TOOL_TOKEN`): connects, presents the token,
//!   and copies its stdio to and from the socket.
//!
//! The socket and its directory are removed once the connection is accepted (or
//! after 5 minutes with none), so nothing else can connect; the listener exits
//! when either side closes.
use std::io::{BufRead, BufReader, Read, Write};

/// Runs a relay mode if `args` asks for one, returning its exit code.
pub fn run_if_requested(args: &[String]) -> Option<i32> {
    let mode = args.get(1)?.as_str();
    let result = match mode {
        "--tool-listen" => listen(),
        "--tool-relay" => relay(),
        _ => return None,
    };
    Some(match result {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("buzz tool relay: {error}");
            1
        }
    })
}

/// Copies `from` into `to` until either ends.
fn pump(mut from: impl Read, mut to: impl Write) {
    let mut buffer = [0u8; 16 * 1024];
    while let Ok(read) = from.read(&mut buffer) {
        if read == 0 || to.write_all(&buffer[..read]).is_err() || to.flush().is_err() {
            break;
        }
    }
}

#[cfg(unix)]
fn listen() -> Result<(), String> {
    use std::os::unix::fs::{DirBuilderExt as _, PermissionsExt as _};
    use std::os::unix::net::UnixListener;

    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "No randomness")?;
    let id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    getrandom::fill(&mut bytes).map_err(|_| "No randomness")?;
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    // macOS's temp dir is already per-user; the 0700 directory keeps others out
    // everywhere. Kept short: Unix socket paths are limited to ~104 bytes.
    let dir = std::env::temp_dir().join(format!("bt-{}", &id[..12]));
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&dir)
        .map_err(|e| format!("Could not create the tool directory: {e}"))?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| e.to_string())?;
    let socket = dir.join("s");
    let cleanup = || {
        let _ = std::fs::remove_file(&socket);
        let _ = std::fs::remove_dir(&dir);
    };
    let listener = UnixListener::bind(&socket).map_err(|e| {
        cleanup();
        format!("Could not bind the tool socket: {e}")
    })?;
    let command = std::env::current_exe().map_err(|e| e.to_string())?;
    let ready = serde_json::json!({
        "command": command,
        "socket": socket,
        "token": token,
    });
    {
        let mut out = std::io::stdout().lock();
        writeln!(out, "{ready}").map_err(|e| e.to_string())?;
        out.flush().map_err(|e| e.to_string())?;
    }
    // Nobody connecting within the turn's budget ends the listener.
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(300);
    let stream = loop {
        let stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if std::time::Instant::now() > deadline {
                    cleanup();
                    return Err("No harness connected".into());
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
                continue;
            }
            Err(e) => {
                cleanup();
                return Err(e.to_string());
            }
        };
        stream.set_nonblocking(false).map_err(|e| e.to_string())?;
        let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
        let mut line = String::new();
        if reader.read_line(&mut line).is_ok() && constant_eq(line.trim_end(), &token) {
            break (reader, stream);
        }
    };
    cleanup();
    drop(listener);
    let (reader, writer) = stream;
    // Anything the reader already buffered past the token line comes first.
    // Either side closing ends the turn's channel.
    std::thread::spawn(move || {
        pump(reader, std::io::stdout());
        std::process::exit(0);
    });
    pump(std::io::stdin(), writer);
    Ok(())
}

#[cfg(unix)]
fn relay() -> Result<(), String> {
    use std::os::unix::net::UnixStream;

    let socket = std::env::var("BUZZ_TOOL_SOCKET").map_err(|_| "BUZZ_TOOL_SOCKET is required")?;
    let token = std::env::var("BUZZ_TOOL_TOKEN").map_err(|_| "BUZZ_TOOL_TOKEN is required")?;
    let mut stream =
        UnixStream::connect(&socket).map_err(|e| format!("Could not reach Buzz: {e}"))?;
    writeln!(stream, "{token}").map_err(|e| e.to_string())?;
    let reader = stream.try_clone().map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        pump(reader, std::io::stdout());
        std::process::exit(0);
    });
    pump(std::io::stdin(), stream);
    Ok(())
}

#[cfg(not(unix))]
fn listen() -> Result<(), String> {
    Err("Buzz tools for this agent are not yet supported on this platform".into())
}
#[cfg(not(unix))]
fn relay() -> Result<(), String> {
    listen()
}

fn constant_eq(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}
