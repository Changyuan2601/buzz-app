//! Test adapter for production team validation and Serde serialization; no credentials or IPC.
use std::io::{self, Read};

fn preview() -> Result<(), Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();
    io::stdin().read_to_end(&mut bytes)?;
    let snapshot = buzz_agent_controller::TeamSnapshot::decode(&bytes)?;
    serde_json::to_writer(io::stdout(), &snapshot)?;
    Ok(())
}

fn main() {
    if let Err(error) = preview() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
