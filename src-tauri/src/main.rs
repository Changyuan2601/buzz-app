#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `buzz-agent-host` runs an agent with the app closed through this.
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() == Some("agent-host") {
        std::process::exit(buzz_foundation_lib::agent_host(args.next()));
    }
    buzz_foundation_lib::run();
}
