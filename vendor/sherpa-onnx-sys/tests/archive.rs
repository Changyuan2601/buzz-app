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
    assert_eq!(fs::read(lib.join("test.a")).unwrap(), b"trusted");
    fs::write(lib.join("test.a"), b"tampered").unwrap();
    let lib = verified_archive::unpack(&path, &digest, root.path()).unwrap();
    assert_eq!(fs::read(lib.join("test.a")).unwrap(), b"trusted");
    fs::write(&path, b"replaced cached archive").unwrap();
    let error = verified_archive::unpack(&path, &digest, root.path()).unwrap_err();
    assert!(error.to_string().contains("SHA-256 mismatch"));
}
