use super::*;

const SHA1: &str = "0123456789abcdef0123456789abcdef01234567";
const SHA256: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn wire(mode: &str, kind: &str, oid: &str, size: &str, path: &[u8]) -> Vec<u8> {
    let mut bytes = format!("{mode} {kind} {oid} {size}\t").into_bytes();
    bytes.extend_from_slice(path);
    bytes.push(0);
    bytes
}

#[test]
fn preserves_raw_path_and_object_bytes_with_padded_decimal_sizes() {
    for oid in [SHA1, SHA256] {
        let path = b"folder/tab\tnewline\nraw-\x80";
        let tree = parse(
            &wire("100755", "blob", oid, "   18446744073709551615", path),
            1,
        )
        .unwrap();
        let entry = &tree.entries()[0];
        assert_eq!(entry.path, path);
        assert_eq!(entry.oid, oid.as_bytes());
        assert_eq!(entry.size, Some(u64::MAX));
        assert_eq!(entry.kind, Kind::Regular);
        assert_eq!(tree.find(path), Some(0));
        assert_eq!(tree.find(b"folder/tab\tnewline\nraw-\xef\xbf\xbd"), None);
    }
}

#[test]
fn rejects_malformed_framing_metadata_identifiers_and_sizes() {
    let valid = wire("100644", "blob", SHA1, "0", b"file");
    let mut extra = valid.clone();
    extra.push(0);
    let cases = [
        (valid[..valid.len() - 1].to_vec(), Error::Framing),
        (extra, Error::Framing),
        (wire("100644", "blob", SHA1, "0", b""), Error::Path),
        (wire("100644", "tree", SHA1, "0", b"file"), Error::Metadata),
        (wire("100600", "blob", SHA1, "0", b"file"), Error::Metadata),
        (
            wire("100644", "blob", &SHA1[..39], "0", b"file"),
            Error::ObjectId,
        ),
        (
            wire(
                "100644",
                "blob",
                "g123456789abcdef0123456789abcdef01234567",
                "0",
                b"file",
            ),
            Error::ObjectId,
        ),
        (wire("100644", "blob", SHA1, "-", b"file"), Error::Size),
        (wire("100644", "blob", SHA1, "-1", b"file"), Error::Size),
        (
            wire("100644", "blob", SHA1, "18446744073709551616", b"file"),
            Error::Size,
        ),
        (
            wire("100644", "blob", SHA1, "1 extra", b"file"),
            Error::Size,
        ),
        (wire("160000", "commit", SHA1, "1", b"file"), Error::Size),
    ];
    for (bytes, error) in cases {
        assert_eq!(parse(&bytes, 10).err(), Some(error), "{bytes:?}");
    }
}

#[test]
fn duplicate_paths_and_entry_limits_fail_instead_of_overwriting() {
    assert!(parse(b"", 0).unwrap().entries().is_empty());
    let mut bytes = wire("100644", "blob", SHA1, "0", b"same");
    bytes.extend(wire("160000", "commit", SHA256, "-", b"same"));
    assert_eq!(parse(&bytes, 2).err(), Some(Error::Duplicate));
    assert_eq!(parse(&bytes, 1).err(), Some(Error::Count));
}

#[test]
fn index_retains_every_entry_at_the_twenty_thousand_entry_boundary() {
    let mut bytes = Vec::new();
    for i in (0..20_000).rev() {
        bytes.extend(wire(
            "100644",
            "blob",
            SHA1,
            "0",
            format!("folder/{i:05}").as_bytes(),
        ));
    }
    let tree = parse(&bytes, 20_000).unwrap();
    assert_eq!(tree.entries().len(), 20_000);
    for (path, index) in [
        (b"folder/00000", 19_999),
        (b"folder/10000", 9_999),
        (b"folder/19999", 0),
    ] {
        assert_eq!(tree.find(path), Some(index));
    }
    assert_eq!(tree.find(b"folder/20000"), None);
}

#[test]
fn package_selection_keeps_directory_object_and_size_provenance() {
    let mut bytes = wire("100644", "blob", SHA1, "4", b"one/manifest.json");
    bytes.extend(wire("100755", "blob", SHA256, "5", b"two/plugin.js"));
    bytes.extend(wire("100755", "blob", SHA256, "5", b"one/plugin.js"));
    let tree = parse(&bytes, 3).unwrap();
    assert_eq!(
        tree.package(b"one/", 5),
        Selection::Unsigned {
            manifest: 0,
            module: 2
        }
    );
    assert_eq!(tree.package(b"one/", 4), Selection::TooLarge);
    assert_eq!(tree.package(b"two/", 5), Selection::NoPackage);
    assert_eq!(tree.package(b"one", 5), Selection::InvalidParent);
}
