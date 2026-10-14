use super::*;

fn skill(root: &Path, name: &str, body: &str) {
    let dir = root.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("SKILL.md"),
        format!(
            "---\nname: {name}\ndescription: fixture\nmetadata:\n  arguments: [thing]\n---\n{body}"
        ),
    )
    .unwrap();
}

#[test]
fn explicit_roots_precedence_and_arguments() {
    let local = tempfile::tempdir().unwrap();
    let global = tempfile::tempdir().unwrap();
    skill(local.path(), "example", "Local $thing");
    skill(global.path(), "example", "Global $thing");
    let skills = Skills::discover(&[local.path().into(), global.path().into()]);
    assert!(skills.instructions().contains("example - fixture"));
    let loaded = skills.load("example", Some("hello")).unwrap();
    assert!(loaded.contains("Local hello"));
    assert!(!loaded.contains("Global"));
    assert!(skills.load("unlisted", None).is_err());
}

#[test]
fn roots_do_not_share_another_agents_skills() {
    let alice = tempfile::tempdir().unwrap();
    let bob = tempfile::tempdir().unwrap();
    skill(alice.path(), "alice", "Alice only");
    skill(bob.path(), "bob", "Bob only");
    assert!(Skills::discover(&[alice.path().into()])
        .load("bob", None)
        .is_err());
    assert!(Skills::discover(&[bob.path().into()])
        .load("alice", None)
        .is_err());
}

#[cfg(unix)]
#[test]
fn loads_listed_supporting_files_but_not_traversal_or_symlinks() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    skill(root.path(), "example", "Use support");
    std::fs::write(root.path().join("example/guide.md"), "Guide").unwrap();
    std::fs::write(outside.path().join("secret.md"), "Secret").unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("secret.md"),
        root.path().join("example/link.md"),
    )
    .unwrap();
    let skills = Skills::discover(&[root.path().into()]);
    assert!(skills
        .load("example/guide.md", None)
        .unwrap()
        .contains("Guide"));
    assert!(skills.load("example/../secret.md", None).is_err());
    assert!(skills.load("example/link.md", None).is_err());
}
