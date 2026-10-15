//! Same Tokio runtime/toolchain/profile, without a GDK call path linked.
#[tokio::main(flavor = "current_thread")]
async fn main() {
    println!("baseline {}", std::env::args().nth(1).unwrap_or_default());
}
