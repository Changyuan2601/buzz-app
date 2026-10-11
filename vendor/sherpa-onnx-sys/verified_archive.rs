use std::{
    error::Error,
    fs::{self, File},
    io::{self, Seek},
    path::{Path, PathBuf},
};

use bzip2::read::BzDecoder;
use sha2::{Digest, Sha256};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

pub fn expected_digest(name: &str) -> Result<&'static str> {
    include_str!("archives.sha256")
        .lines()
        .filter_map(|line| line.split_once("  "))
        .find_map(|(digest, archive)| (archive == name).then_some(digest))
        .ok_or_else(|| format!("No approved native speech archive digest for {name}").into())
}

pub fn unpack(path: &Path, expected: &str, out_dir: &Path) -> Result<PathBuf> {
    // Hash the same private snapshot that is unpacked, including local/cache inputs.
    let mut snapshot = tempfile::tempfile_in(out_dir)?;
    io::copy(&mut File::open(path)?, &mut snapshot)?;
    snapshot.rewind()?;
    let mut digest = Sha256::new();
    io::copy(&mut snapshot, &mut digest)?;
    let actual = format!("{:x}", digest.finalize());
    if actual != expected {
        return Err(format!(
            "Native speech archive SHA-256 mismatch: expected {expected}, got {actual}"
        )
        .into());
    }
    snapshot.rewind()?;
    let staging = tempfile::tempdir_in(out_dir)?;
    tar::Archive::new(BzDecoder::new(snapshot)).unpack(staging.path())?;
    let stem = path
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.strip_suffix(".tar.bz2"))
        .ok_or("Invalid archive filename")?;
    if !staging.path().join(stem).join("lib").is_dir() {
        return Err("Verified native speech archive has no lib directory".into());
    }
    let destination = out_dir.join("verified-native");
    if destination.exists() {
        fs::remove_dir_all(&destination)?;
    }
    fs::rename(staging.path(), &destination)?;
    Ok(destination.join(stem).join("lib"))
}
