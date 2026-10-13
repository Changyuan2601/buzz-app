#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if let Some(code) = buzz_foundation_lib::tool_relay::run_if_requested(&args) {
        std::process::exit(code);
    }
    buzz_foundation_lib::run();
}
