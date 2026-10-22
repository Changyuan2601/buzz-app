#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|arg| {
        matches!(
            arg.as_str(),
            "plugin" | "--home" | "--profile" | "--help" | "-h"
        )
    }) {
        #[cfg(all(windows, not(debug_assertions)))]
        unsafe {
            windows_sys::Win32::System::Console::AttachConsole(
                windows_sys::Win32::System::Console::ATTACH_PARENT_PROCESS,
            );
        }
        if let Err(message) = buzzodz_plugins::cli::run(args) {
            eprintln!("Error: {message}");
            std::process::exit(1);
        }
        return;
    }
    buzz_foundation_lib::run();
}
