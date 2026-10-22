fn main() {
    if let Err(message) = buzzodz_plugins::cli::run(std::env::args().skip(1).collect()) {
        eprintln!("Error: {message}");
        std::process::exit(1);
    }
}
