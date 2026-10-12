#[path = "../verified_archive.rs"]
mod verified_archive;

use sha2::{Digest, Sha256};
use std::fs;

#[test]
fn pins_all_supported_static_targets_and_rejects_other_assets() {
    for target in [
        "linux-x64",
        "linux-aarch64",
        "osx-x64",
        "osx-arm64",
        "win-x64",
    ] {
        let suffix = if target == "win-x64" {
            "static-MT-Release"
        } else {
            "static"
        };
        let digest = verified_archive::expected_digest(&format!(
            "sherpa-onnx-v1.13.4-{target}-{suffix}-lib.tar.bz2"
        ))
        .unwrap();
        assert_eq!(digest.len(), 64);
        assert!(digest.bytes().all(|b| b.is_ascii_hexdigit()));
    }
    assert!(verified_archive::expected_digest("unknown.tar.bz2").is_err());
}

#[test]
fn authenticates_cached_bytes_and_replaces_untrusted_extraction() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("fixture.tar.bz2");
    let encoder = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::best());
    let mut archive = tar::Builder::new(encoder);
    let mut header = tar::Header::new_gnu();
    header.set_size(7);
    header.set_mode(0o644);
    header.set_cksum();
    archive
        .append_data(&mut header, "fixture/lib/test.a", &b"trusted"[..])
        .unwrap();
    let bytes = archive.into_inner().unwrap().finish().unwrap();
    let digest = format!("{:x}", Sha256::digest(&bytes));
    fs::write(&path, &bytes).unwrap();
    let lib = verified_archive::unpack(&path, &digest, root.path()).unwrap();
    verified_archive::watch_libraries(&lib).unwrap();
    assert_eq!(fs::read(lib.join("test.a")).unwrap(), b"trusted");
    fs::write(lib.join("test.a"), b"tampered").unwrap();
    let lib = verified_archive::unpack(&path, &digest, root.path()).unwrap();
    assert_eq!(fs::read(lib.join("test.a")).unwrap(), b"trusted");
    fs::write(&path, b"replaced cached archive").unwrap();
    let error = verified_archive::unpack(&path, &digest, root.path()).unwrap_err();
    assert!(error.to_string().contains("SHA-256 mismatch"));
}

#[test]
fn unchanged_cargo_builds_stay_fresh_and_library_changes_invalidate() {
    let root = tempfile::tempdir().unwrap();
    let project = root.path();
    let archive_path = project.join("fixture.tar.bz2");
    let encoder = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::best());
    let mut archive = tar::Builder::new(encoder);
    let mut header = tar::Header::new_gnu();
    header.set_size(7);
    header.set_mode(0o644);
    header.set_mtime(1);
    header.set_cksum();
    archive
        .append_data(&mut header, "fixture/lib/test.a", &b"trusted"[..])
        .unwrap();
    let bytes = archive.into_inner().unwrap().finish().unwrap();
    let digest = format!("{:x}", Sha256::digest(&bytes));
    fs::write(&archive_path, bytes).unwrap();
    fs::write(
        project.join("Cargo.toml"),
        r#"
[package]
name = "speech-cache-probe"
version = "0.0.0"
edition = "2021"
[workspace]
[build-dependencies]
bzip2 = "0.4"
tar = "0.4"
sha2 = "0.10"
tempfile = "3"
"#,
    )
    .unwrap();
    fs::create_dir(project.join("src")).unwrap();
    fs::write(project.join("src/lib.rs"), "").unwrap();
    let module = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("verified_archive.rs");
    fs::write(project.join("build.rs"), format!(r#"
#[path = {module:?}]
mod verified_archive;
fn main() {{
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    println!("cargo:rerun-if-changed=fixture.tar.bz2");
    let lib = verified_archive::unpack(std::path::Path::new("fixture.tar.bz2"), "{digest}", &out).unwrap();
    verified_archive::watch_libraries(&lib).unwrap();
    std::fs::write("library-path", lib.to_str().unwrap()).unwrap();
    use std::io::Write;
    writeln!(std::fs::OpenOptions::new().create(true).append(true).open("invocations").unwrap(), "run").unwrap();
}}
"#)).unwrap();
    let build = || {
        let output = std::process::Command::new(env!("CARGO"))
            .current_dir(project)
            .env("CARGO_TARGET_DIR", project.join("target"))
            .args(["check", "--offline"])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    build();
    build();
    build();
    assert_eq!(
        fs::read_to_string(project.join("invocations")).unwrap(),
        "run\n"
    );
    let lib = fs::read_to_string(project.join("library-path")).unwrap();
    fs::write(std::path::Path::new(&lib).join("test.a"), "changed").unwrap();
    build();
    assert_eq!(
        fs::read_to_string(project.join("invocations")).unwrap(),
        "run\nrun\n"
    );
    assert_eq!(
        fs::read(std::path::Path::new(&lib).join("test.a")).unwrap(),
        b"trusted"
    );
    build();
    assert_eq!(
        fs::read_to_string(project.join("invocations")).unwrap(),
        "run\nrun\n"
    );
}
