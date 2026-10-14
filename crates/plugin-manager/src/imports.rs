//! Read-only acquisition. Preview owns immutable artifacts; installation never rereads a source.
use crate::{
    artifact_from_text, err, hash, Catalog, Manager, Manifest, Release, ReloadSource, Result, LIMIT,
};
use buzz_git_tree::{Kind, Selection};
use nostr::event::Event;
use serde::Serialize;
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const MAX_ENTRIES: usize = 20_000;
const MAX_PLUGINS: usize = 32;
const MAX_PREVIEW_BYTES: usize = 32 * 1024 * 1024;
const MAX_REPO_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub path: String,
    pub manifest: Manifest,
    pub revision: String,
    pub publisher: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub token: String,
    pub source: String,
    pub commit: Option<String>,
    pub candidates: Vec<Candidate>,
    pub warnings: Vec<String>,
}

pub struct PreparedImport {
    pub preview: Preview,
    folder_root: Option<PathBuf>,
    artifacts: BTreeMap<String, Release>,
}
impl PreparedImport {
    fn new(source: String, commit: Option<String>, folder_root: Option<PathBuf>) -> Result<Self> {
        // An opaque per-preview identity, independent of plugin IDs or source paths.
        let nonce = tempfile::NamedTempFile::new().map_err(err)?;
        Ok(Self {
            preview: Preview {
                token: hash(nonce.path().as_os_str().as_encoded_bytes()),
                source,
                commit,
                candidates: vec![],
                warnings: vec![],
            },
            folder_root,
            artifacts: BTreeMap::new(),
        })
    }
    fn add(&mut self, path: String, artifact: Result<Release>) -> Result<()> {
        match artifact.and_then(|release| release.validate().map(|manifest| (release, manifest))) {
            Ok((release, manifest)) => {
                if self.artifacts.contains_key(&path) {
                    return Err("Duplicate plugin folder identity".into());
                }
                if self.artifacts.len() >= MAX_PLUGINS
                    || self
                        .artifacts
                        .values()
                        .map(|item| item.bytes.len())
                        .sum::<usize>()
                        + release.bytes.len()
                        > MAX_PREVIEW_BYTES
                {
                    return Err("Too many plugin artifacts; choose a smaller folder or repository (32 plugins / 32 MiB maximum)".into());
                }
                self.preview.candidates.push(Candidate {
                    path: path.clone(),
                    manifest,
                    revision: hash(&release.bytes),
                    publisher: release.publisher(),
                });
                self.artifacts.insert(path, release);
            }
            Err(reason) => {
                if self.preview.warnings.len() < MAX_PLUGINS {
                    self.preview.warnings.push(format!("{path}: {reason}"));
                }
            }
        }
        Ok(())
    }
    pub fn install(&self, manager: &Manager, token: &str, path: &str) -> Result<Catalog> {
        if token != self.preview.token {
            return Err("This import preview expired. Choose the source again.".into());
        }
        let release = self
            .artifacts
            .get(path)
            .ok_or("Choose a listed plugin folder")?;
        let source = self
            .folder_root
            .clone()
            .map(|root| ReloadSource::folder(root, path.to_owned()))
            .transpose()?;
        manager.install_artifact(release, source)
    }
}

pub fn prepare_folder(directory: &Path) -> Result<PreparedImport> {
    if !fs::symlink_metadata(directory)
        .map_err(err)?
        .file_type()
        .is_dir()
    {
        return Err("Choose a regular folder, not a symbolic link".into());
    }
    let root = directory.canonicalize().map_err(err)?;
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut prepared = PreparedImport::new(root.display().to_string(), None, Some(root.clone()))?;
    let directory =
        cap_std::fs::Dir::open_ambient_dir(&root, cap_std::ambient_authority()).map_err(err)?;
    let mut pending = vec![(PathBuf::new(), 0)];
    let mut entries = 0;
    while let Some((relative, depth)) = pending.pop() {
        if Instant::now() >= deadline {
            return Err("Folder scan exceeded 60 seconds".into());
        }
        if depth > 32 {
            return Err("Folder nesting exceeds 32 levels; choose a smaller folder".into());
        }
        let mut has_manifest = false;
        let mut has_release = false;
        for entry in directory
            .read_dir(if relative.as_os_str().is_empty() {
                Path::new(".")
            } else {
                &relative
            })
            .map_err(err)?
        {
            let entry = entry.map_err(err)?;
            entries += 1;
            if entries > MAX_ENTRIES {
                return Err("Folder exceeds 20,000 entries; choose a smaller folder".into());
            }
            let kind = entry.file_type().map_err(err)?;
            let name = entry.file_name();
            if name == "manifest.json" {
                has_manifest = true;
            }
            if name == "plugin.artifact.json" || name == "plugin.signature.json" {
                has_release = true;
            }
            // Hidden folders hold VCS and tool state, including other checkouts such as
            // .claude/worktrees; choose one of those folders directly to import from it.
            if kind.is_dir()
                && !name.as_encoded_bytes().starts_with(b".")
                && name != "node_modules"
                && name != "target"
            {
                pending.push((relative.join(name), depth + 1));
            }
        }
        if has_manifest || has_release {
            let path = candidate_path(&relative)?;
            let artifact = read_package(&directory, &relative).and_then(|release| {
                if has_release && release.signature.is_none() {
                    Err("Signed plugin release disappeared during folder scan".into())
                } else {
                    Ok(release)
                }
            });
            prepared.add(path, artifact)?;
        }
    }
    prepared
        .preview
        .candidates
        .sort_by(|a, b| a.path.cmp(&b.path));
    Ok(prepared)
}

pub(crate) fn read_package(directory: &cap_std::fs::Dir, relative: &Path) -> Result<Release> {
    let artifact_path = relative.join("plugin.artifact.json");
    let signature_path = relative.join("plugin.signature.json");
    let present = |path| match directory.symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(err(error)),
    };
    let has_artifact = present(&artifact_path)?;
    let has_signature = present(&signature_path)?;
    if has_artifact || has_signature {
        if !has_artifact || !has_signature {
            return Err("Incomplete signed plugin release pair".into());
        }
        return Ok(Release {
            bytes: read_source_file(directory, &artifact_path)?.into_bytes(),
            signature: Some(
                serde_json::from_str(&read_source_file(directory, &signature_path)?)
                    .map_err(err)?,
            ),
        });
    }
    Ok(Release {
        bytes: artifact_from_text(
            &read_source_file(directory, &relative.join("manifest.json"))?,
            read_source_file(directory, &relative.join("plugin.js"))?,
        )?,
        signature: None,
    })
}

fn candidate_path(relative: &Path) -> Result<String> {
    if relative.as_os_str().is_empty() {
        return Ok(".".into());
    }
    Ok(relative
        .components()
        .map(|c| {
            c.as_os_str()
                .to_str()
                .ok_or("Plugin folder names must be UTF-8")
        })
        .collect::<std::result::Result<Vec<_>, _>>()?
        .join("/"))
}

// All descendant resolution is relative to an opened directory capability: an ancestor
// swapped for an escaping symlink cannot redirect reads outside the selected folder.
pub(crate) fn read_source_file(directory: &cap_std::fs::Dir, path: &Path) -> Result<String> {
    if !directory
        .symlink_metadata(path)
        .map_err(err)?
        .file_type()
        .is_file()
    {
        return Err("Plugin files must be regular files, not symbolic links".into());
    }
    let mut options = cap_std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = directory.open_with(path, &options).map_err(err)?;
    if !file.metadata().map_err(err)?.is_file() {
        return Err("Plugin files must be regular files".into());
    }
    crate::read_file_limited(file.into_std())
}

/// Only explicit HTTPS/SSH transports. No local paths, URL helpers, credentials in HTTPS,
/// GitHub web tree URLs, or shell interpretation. A separate ref avoids ambiguous slash parsing.
pub fn repository_url(input: &str) -> Result<String> {
    let input = input.trim();
    if input.len() > 2048 {
        return Err("Repository URL is too long".into());
    }
    let expanded = if input.starts_with("git@") && !input.contains("://") {
        let (host, path) = input
            .split_once(':')
            .ok_or("Expected git@host:owner/repository.git")?;
        format!("ssh://{host}/{path}")
    } else if input.starts_with("github.com/") {
        format!("https://{input}")
    } else if !input.contains(':') && input.split('/').count() == 2 {
        format!("https://github.com/{input}")
    } else {
        input.into()
    };
    let url = url::Url::parse(&expanded).map_err(|_| "Enter an HTTPS or SSH repository URL")?;
    if !["https", "ssh"].contains(&url.scheme())
        || url.host_str().is_none()
        || url.host_str().is_some_and(|host| host.starts_with('-'))
        || url.username().starts_with('-')
        || url.password().is_some()
        || (url.scheme() == "https" && !url.username().is_empty())
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path().trim_matches('/').is_empty()
        || expanded
            .chars()
            .any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(
            "Use an HTTPS or SSH repository URL without a password, query or fragment".into(),
        );
    }
    if url.host_str() == Some("github.com") && url.path().trim_matches('/').split('/').count() != 2
    {
        return Err("Use the GitHub repository URL, not a tree/file URL. Enter the branch or tag separately, then select a plugin folder.".into());
    }
    Ok(url.to_string())
}

struct Git {
    scratch: tempfile::TempDir,
    deadline: Instant,
    /// Repository URL and its NIP-98 token. Git sends the header only to that URL prefix.
    authorization: Option<(String, String)>,
}
impl Git {
    fn new() -> Result<Self> {
        Ok(Self {
            scratch: tempfile::tempdir().map_err(err)?,
            deadline: Instant::now() + Duration::from_secs(60),
            authorization: None,
        })
    }
    fn command(&self) -> Command {
        let mut command = Command::new("git");
        command.env_clear();
        // Retain SSH-agent authentication and platform tool lookup, but not Git's ambient
        // repository/config/transport overrides. No credential helpers or interactive prompts.
        for key in ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "SSH_AUTH_SOCK"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
        command
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", null)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env(
                "GIT_SSH_COMMAND",
                format!("ssh -F {null} -oBatchMode=yes -oStrictHostKeyChecking=yes"),
            )
            .args([
                "-c",
                "protocol.allow=never",
                "-c",
                "protocol.https.allow=always",
                "-c",
                "protocol.ssh.allow=always",
                "-c",
                "core.fsmonitor=false",
                "-c",
                &format!("core.hooksPath={null}"),
            ])
            .current_dir(self.scratch.path());
        if let Some((url, token)) = &self.authorization {
            // Environment, not argv: other processes cannot read the token from `ps`.
            // No redirects, so the header never follows the request to another URL.
            for (index, (key, value)) in [
                (
                    format!("http.{url}.extraHeader"),
                    format!("Authorization: Nostr {token}"),
                ),
                ("http.followRedirects".into(), "false".into()),
            ]
            .into_iter()
            .enumerate()
            {
                command
                    .env(format!("GIT_CONFIG_KEY_{index}"), key)
                    .env(format!("GIT_CONFIG_VALUE_{index}"), value);
            }
            command.env("GIT_CONFIG_COUNT", "2");
        }
        command
    }
    fn run(&self, args: &[&str], limit: u64) -> Result<Vec<u8>> {
        let mut command = self.command();
        command.args(args);
        self.run_command(command, limit)
    }
    fn run_command(&self, mut command: Command, limit: u64) -> Result<Vec<u8>> {
        let output = tempfile::tempfile().map_err(err)?;
        let errors = tempfile::tempfile().map_err(err)?;
        command
            .stdin(Stdio::null())
            .stdout(output.try_clone().map_err(err)?)
            .stderr(errors.try_clone().map_err(err)?);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("Could not start Git: {e}. Install Git to load repositories."))?;
        let result = (|| loop {
            if Instant::now() >= self.deadline {
                return Err("Repository import exceeded 60 seconds".into());
            }
            if output.metadata().map_err(err)?.len() > limit
                || errors.metadata().map_err(err)?.len() > LIMIT
            {
                return Err("Git output exceeds the import size limit".into());
            }
            if directory_size(self.scratch.path())? > MAX_REPO_BYTES {
                return Err("Repository exceeds the 256 MiB import limit".into());
            }
            if let Some(status) = child.try_wait().map_err(err)? {
                if !status.success() {
                    let text = read_output(errors, 4096)?;
                    return Err(format!(
                        "Git could not read this repository: {}",
                        String::from_utf8_lossy(&text).trim()
                    ));
                }
                return read_output(output, limit);
            }
            thread::sleep(Duration::from_millis(50));
        })();
        if result.is_err() {
            // Stop the complete Git/SSH transport group, not just its parent, before cleanup.
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill")
                    .args(["/PID", &child.id().to_string(), "/T", "/F"])
                    .output();
            }
            let _ = child.kill();
            let _ = child.wait();
        }
        result
    }
    fn read_plugins(&self, source: String) -> Result<PreparedImport> {
        let commit = String::from_utf8(self.run(&["-C", "repository", "rev-parse", "HEAD"], 1024)?)
            .map_err(err)?
            .trim()
            .to_string();
        let bytes = self.run(
            &[
                "-C",
                "repository",
                "ls-tree",
                "-r",
                "-t",
                "-l",
                "-z",
                "--full-tree",
                &commit,
            ],
            2 * 1024 * 1024,
        )?;
        // The existing stdout bound also bounds records; directories retain marker evidence
        // without consuming the recursive leaf-file allowance.
        let tree = buzz_git_tree::parse(&bytes, bytes.len())
            .map_err(|reason| format!("Invalid Git tree: {reason:?}"))?;
        if tree
            .entries()
            .iter()
            .filter(|entry| entry.kind != Kind::Tree)
            .count()
            > MAX_ENTRIES
        {
            return Err("Repository exceeds 20,000 files; use a smaller repository".into());
        }
        let paths = tree
            .entries()
            .iter()
            .map(|entry| {
                std::str::from_utf8(&entry.path).map_err(|_| "Repository filenames must be UTF-8")
            })
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut prepared = PreparedImport::new(source, Some(commit), None)?;
        let parents: std::collections::BTreeSet<&str> = paths
            .iter()
            .filter_map(|path| {
                [
                    "manifest.json",
                    "plugin.artifact.json",
                    "plugin.signature.json",
                ]
                .iter()
                .find_map(|name| {
                    path.strip_suffix(name)
                        .filter(|parent| parent.is_empty() || parent.ends_with('/'))
                })
            })
            .collect();
        for parent in parents {
            if parent
                .split('/')
                .any(|s| s == "node_modules" || s == "target")
            {
                continue;
            }
            let display = if parent.is_empty() {
                "."
            } else {
                parent.trim_end_matches('/')
            };
            let blob = |index: usize| {
                let oid = std::str::from_utf8(&tree.entries()[index].oid).map_err(err)?;
                self.read_blob(oid)
            };
            let artifact = match tree.package(parent.as_bytes(), LIMIT) {
                Selection::Signed {
                    artifact,
                    signature,
                } => (|| {
                    Ok(Release {
                        bytes: blob(artifact)?,
                        signature: Some(
                            serde_json::from_slice::<Event>(&blob(signature)?).map_err(err)?,
                        ),
                    })
                })(),
                Selection::Unsigned { manifest, module } => (|| {
                    let manifest = String::from_utf8(blob(manifest)?).map_err(err)?;
                    let module = String::from_utf8(blob(module)?).map_err(err)?;
                    artifact_from_text(&manifest, module).map(|bytes| Release {
                        bytes,
                        signature: None,
                    })
                })(),
                Selection::InvalidSigned => {
                    Err("Incomplete or nonregular signed plugin release pair".into())
                }
                Selection::MissingModule => {
                    Err("No built plugin.js beside manifest.json; build the plugin first".into())
                }
                Selection::TooLarge => Err("File exceeds 8 MiB".into()),
                Selection::NoPackage => continue,
                Selection::InvalidParent => return Err("Invalid Git plugin directory".into()),
            };
            prepared.add(display.into(), artifact)?;
        }
        Ok(prepared)
    }

    fn read_blob(&self, oid: &str) -> Result<Vec<u8>> {
        let size = String::from_utf8(self.run(&["-C", "repository", "cat-file", "-s", oid], 1024)?)
            .map_err(err)?;
        if size.trim().parse::<u64>().map_err(err)? > LIMIT {
            return Err("File exceeds 8 MiB".into());
        }
        self.run(&["-C", "repository", "cat-file", "blob", oid], LIMIT)
    }
}

/// `authorization` is a NIP-98 token that the caller signed for exactly this repository URL.
pub fn prepare_git(
    repository: &str,
    reference: &str,
    authorization: Option<&str>,
) -> Result<PreparedImport> {
    let url = repository_url(repository)?;
    let reference = reference.trim();
    if !reference.is_empty()
        && (reference.starts_with('-')
            || reference.len() > 200
            || !reference
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "._/-".contains(c)))
    {
        return Err("Enter a branch or tag name using letters, digits, dots, underscores, slashes or hyphens".into());
    }
    let mut git = Git::new()?;
    if let Some(token) = authorization {
        if token.is_empty()
            || token.len() > 8192
            || !token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b))
        {
            return Err("Invalid repository authorization".into());
        }
        git.authorization = Some((url.clone(), token.into()));
    }
    let mut args = vec![
        "clone",
        "--depth=1",
        "--single-branch",
        "--no-tags",
        "--no-checkout",
        "--template=",
    ];
    if !reference.is_empty() {
        args.extend(["--branch", reference]);
    }
    args.extend(["--", &url, "repository"]);
    git.run(&args, LIMIT)?;
    git.read_plugins(url)
}
fn read_output(mut file: File, limit: u64) -> Result<Vec<u8>> {
    use std::io::{Seek, SeekFrom};
    file.seek(SeekFrom::Start(0)).map_err(err)?;
    let mut bytes = vec![];
    file.take(limit + 1).read_to_end(&mut bytes).map_err(err)?;
    if bytes.len() as u64 > limit {
        return Err("Git output exceeds the import size limit".into());
    }
    Ok(bytes)
}
fn directory_size(root: &Path) -> Result<u64> {
    let mut pending = vec![root.to_path_buf()];
    let mut bytes = 0;
    let mut count = 0;
    while let Some(path) = pending.pop() {
        for entry in fs::read_dir(path).map_err(err)? {
            let entry = entry.map_err(err)?;
            count += 1;
            if count > MAX_ENTRIES {
                return Err("Repository exceeds the import entry limit".into());
            }
            let meta = match entry.metadata() {
                Ok(meta) => meta,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(err(e)),
            };
            if meta.is_dir() {
                pending.push(entry.path());
            } else {
                bytes += meta.len();
            }
            if bytes > MAX_REPO_BYTES {
                return Ok(bytes);
            }
        }
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn plugin(root: &Path, folder: &str, id: &str) -> PathBuf {
        let path = root.join(folder);
        fs::create_dir_all(&path).unwrap();
        fs::write(
            path.join("manifest.json"),
            format!(r#"{{"id":"{id}","name":"{id}","apiVersion":1}}"#),
        )
        .unwrap();
        fs::write(
            path.join("plugin.js"),
            "export function apply() {} // first",
        )
        .unwrap();
        path
    }
    #[test]
    fn folder_discovers_nested_dist_and_installs_exact_preview_without_execution() {
        let root = tempfile::tempdir().unwrap();
        let source = plugin(root.path(), "pages/one/dist", "example.one");
        plugin(root.path(), "panels/two", "example.two");
        plugin(root.path(), "node_modules/skipped", "example.skipped");
        fs::write(root.path().join("manifest.json"), "{}").unwrap();
        let prepared = prepare_folder(root.path()).unwrap();
        assert_eq!(prepared.preview.candidates.len(), 2);
        assert_eq!(prepared.preview.candidates[0].path, "pages/one/dist");
        assert_eq!(prepared.preview.warnings.len(), 1);
        let home = tempfile::tempdir().unwrap();
        let manager = Manager::open(Some(home.path().into()), "test", false).unwrap();
        assert!(prepared
            .install(&manager, "wrong", "pages/one/dist")
            .is_err());
        assert!(prepared
            .install(&manager, &prepared.preview.token, "../escape")
            .is_err());
        fs::write(
            source.join("plugin.js"),
            "throw Error('changed'); while(true) {}",
        )
        .unwrap();
        let catalog = prepared
            .install(&manager, &prepared.preview.token, "pages/one/dist")
            .unwrap();
        let installed = catalog
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.one")
            .unwrap();
        assert!(!installed.enabled);
        manager.change("enable", "example.one").unwrap();
        assert!(manager
            .module("example.one", &installed.revision)
            .unwrap()
            .contains("first"));
        // Repeating the exact preview is idempotent; update/rollback retain ordinary semantics.
        let again = prepared
            .install(&manager, &prepared.preview.token, "pages/one/dist")
            .unwrap();
        assert!(again
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.one")
            .unwrap()
            .previous
            .is_none());
        let update = prepare_folder(root.path()).unwrap();
        let next = update
            .install(&manager, &update.preview.token, "pages/one/dist")
            .unwrap();
        let installed = next
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.one")
            .unwrap();
        assert!(installed.enabled);
        assert!(installed.previous.is_some());
    }
    #[test]
    fn folder_skips_hidden_descendants_but_accepts_a_hidden_selection() {
        let root = tempfile::tempdir().unwrap();
        plugin(root.path(), "", "example.root");
        plugin(root.path(), "dist", "example.root");
        plugin(root.path(), ".cache/built", "example.root");
        let worktree = plugin(root.path(), ".claude/worktrees/feature", "example.root");
        plugin(&worktree, "dist", "example.root");
        let paths = |directory: &Path| {
            prepare_folder(directory)
                .unwrap()
                .preview
                .candidates
                .into_iter()
                .map(|candidate| candidate.path)
                .collect::<Vec<_>>()
        };
        assert_eq!(paths(root.path()), [".", "dist"]);
        assert_eq!(
            paths(&root.path().join(".claude")),
            ["worktrees/feature", "worktrees/feature/dist"]
        );
    }
    #[cfg(unix)]
    #[test]
    fn folder_never_follows_symlinks_or_reads_special_files() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        plugin(outside.path(), "outside", "example.outside");
        symlink(outside.path(), root.path().join("escape")).unwrap();
        let folder = plugin(root.path(), "bad", "example.bad");
        fs::remove_file(folder.join("plugin.js")).unwrap();
        symlink(
            outside.path().join("outside/plugin.js"),
            folder.join("plugin.js"),
        )
        .unwrap();
        let fifo = plugin(root.path(), "fifo", "example.fifo");
        fs::remove_file(fifo.join("plugin.js")).unwrap();
        let name =
            std::ffi::CString::new(fifo.join("plugin.js").as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let prepared = prepare_folder(root.path()).unwrap();
        assert!(prepared.preview.candidates.is_empty());
        assert_eq!(prepared.preview.warnings.len(), 2);
    }
    #[cfg(unix)]
    #[test]
    fn folder_identity_is_lossless_and_capability_rejects_replaced_ancestors() {
        use std::os::unix::{ffi::OsStringExt, fs::symlink};
        let root = tempfile::tempdir().unwrap();
        plugin(root.path(), "a\\b", "example.backslash");
        plugin(root.path(), "a/b", "example.slash");
        let prepared = prepare_folder(root.path()).unwrap();
        assert_eq!(prepared.preview.candidates.len(), 2);
        assert_eq!(prepared.artifacts.len(), 2);
        let home = tempfile::tempdir().unwrap();
        let manager = Manager::open(Some(home.path().into()), "test", false).unwrap();
        for candidate in &prepared.preview.candidates {
            let catalog = prepared
                .install(&manager, &prepared.preview.token, &candidate.path)
                .unwrap();
            assert!(catalog.plugins.iter().any(
                |p| p.manifest.id == candidate.manifest.id && p.revision == candidate.revision
            ));
        }
        let outside = tempfile::tempdir().unwrap();
        plugin(outside.path(), "b", "example.outside");
        let directory =
            cap_std::fs::Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();
        fs::rename(root.path().join("a"), root.path().join("old-a")).unwrap();
        symlink(outside.path(), root.path().join("a")).unwrap();
        assert!(read_source_file(&directory, Path::new("a/b/plugin.js")).is_err());
        let invalid = root
            .path()
            .join(std::ffi::OsString::from_vec(vec![b'p', 0xff]));
        // macOS filesystems reject invalid UTF-8 names at creation; exercise the production
        // key conversion directly so this check is meaningful on Linux and macOS.
        assert!(candidate_path(&invalid).is_err());
    }
    #[test]
    fn rejects_invalid_artifacts_and_bounds_preview_size() {
        let root = tempfile::tempdir().unwrap();
        plugin(root.path(), "bundled", "buzz.channels");
        let bad = plugin(root.path(), "unsupported", "example.bad");
        fs::write(
            bad.join("manifest.json"),
            r#"{"id":"example.bad","name":"Bad","apiVersion":2}"#,
        )
        .unwrap();
        let empty = plugin(root.path(), "empty", "example.empty");
        fs::write(empty.join("plugin.js"), " ").unwrap();
        let large = plugin(root.path(), "large", "example.large");
        File::create(large.join("plugin.js"))
            .unwrap()
            .set_len(LIMIT + 1)
            .unwrap();
        let prepared = prepare_folder(root.path()).unwrap();
        assert!(prepared.preview.candidates.is_empty());
        assert_eq!(prepared.preview.warnings.len(), 4);
        for n in 0..=MAX_PLUGINS {
            plugin(root.path(), &format!("many/{n}"), &format!("example.p{n}"));
        }
        assert!(prepare_folder(root.path()).is_err());
    }
    #[test]
    fn accepts_explicit_transports_and_github_shorthand_only() {
        assert_eq!(
            repository_url("block/plugins").unwrap(),
            "https://github.com/block/plugins"
        );
        assert_eq!(
            repository_url("git@github.com:block/plugins.git").unwrap(),
            "ssh://git@github.com/block/plugins.git"
        );
        assert!(repository_url("https://git.example.org/team/repo.git").is_ok());
        for input in [
            "/tmp/repo",
            "file:///tmp/repo",
            "ext::sh -c bad",
            "git://example.com/repo",
            "https://me:secret@example.com/repo",
            "https://example.com/repo?token=secret",
            "https://github.com/block/repo/tree/main/plugins",
            "--upload-pack=bad",
            "ssh://-oProxyCommand=bad/repo",
        ] {
            assert!(repository_url(input).is_err(), "{input}");
        }
        assert!(prepare_git("block/plugins", "--upload-pack=bad", None).is_err());
    }
    #[test]
    fn git_reads_committed_blobs_without_checkout_filters_symlinks_or_scripts() {
        let git = Git::new().unwrap();
        git.run(&["init", "--template=", "repository"], LIMIT)
            .unwrap();
        let repo = git.scratch.path().join("repository");
        let signed = plugin(&repo, "plugins/one/dist", "example.one");
        crate::sign_release(&signed, &nostr::key::SecretKey::generate().to_secret_hex()).unwrap();
        // Keep unsigned siblings: the signed pair must take precedence.

        plugin(&repo, "plugins/two", "example.two");
        plugin(&repo, ".hidden/three", "example.three");
        plugin(&repo, "node_modules/skipped", "example.skipped");
        plugin(&repo, "target/skipped", "example.skipped");
        fs::write(
            repo.join("package.json"),
            r#"{"scripts":{"postinstall":"exit 1"}}"#,
        )
        .unwrap();
        fs::write(repo.join(".gitattributes"), "*.js filter=must-not-run").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc", repo.join("outside")).unwrap();
        git.run(&["-C", "repository", "add", "."], LIMIT).unwrap();
        git.run(
            &[
                "-C",
                "repository",
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "fixture",
            ],
            LIMIT,
        )
        .unwrap();
        fs::write(
            repo.join("plugins/one/dist/plugin.js"),
            "uncommitted change",
        )
        .unwrap();
        let prepared = git.read_plugins("fixture".into()).unwrap();
        assert_eq!(prepared.preview.candidates.len(), 3);
        assert!(prepared
            .preview
            .candidates
            .iter()
            .any(|candidate| candidate.path == ".hidden/three"));
        assert!(prepared
            .preview
            .candidates
            .iter()
            .find(|candidate| candidate.path == "plugins/one/dist")
            .unwrap()
            .publisher
            .is_some());
        assert_eq!(prepared.preview.commit.as_ref().unwrap().len(), 40);
        let text = String::from_utf8(prepared.artifacts["plugins/one/dist"].bytes.clone()).unwrap();
        assert!(text.contains("first"));
        assert!(!text.contains("uncommitted"));
        let home = tempfile::tempdir().unwrap();
        let manager = Manager::open(Some(home.path().into()), "test", false).unwrap();
        let catalog = prepared
            .install(&manager, &prepared.preview.token, "plugins/one/dist")
            .unwrap();
        let installed = catalog
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.one")
            .unwrap();
        manager.change("enable", "example.one").unwrap();
        assert!(manager
            .module("example.one", &installed.revision)
            .unwrap()
            .contains("first"));
    }
    #[test]
    fn git_directory_records_do_not_consume_the_leaf_file_allowance() {
        let git = Git::new().unwrap();
        git.run(&["init", "--template=", "repository"], LIMIT)
            .unwrap();
        let repo = git.scratch.path().join("repository");
        plugin(&repo, "dist", "example.count");
        git.run(&["-C", "repository", "add", "."], LIMIT).unwrap();
        let blob = String::from_utf8(
            git.run(
                &["-C", "repository", "hash-object", "dist/plugin.js"],
                LIMIT,
            )
            .unwrap(),
        )
        .unwrap();
        // 10,002 leaves plus 10,001 directories exceeds 20,000 total records.
        // Reuse one blob; the large fixture exists only for the host count contract.
        let entries: String = (0..10_000)
            .map(|i| format!("100644 {}\tdirectory-{i:05}/leaf\0", blob.trim()))
            .collect();
        let mut child = git
            .command()
            .args(["-C", "repository", "update-index", "-z", "--index-info"])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        std::io::Write::write_all(&mut child.stdin.take().unwrap(), entries.as_bytes()).unwrap();
        assert!(child.wait().unwrap().success());
        git.run(
            &[
                "-C",
                "repository",
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "fixture",
            ],
            LIMIT,
        )
        .unwrap();
        let prepared = git
            .read_plugins("fixture".into())
            .expect("directories must not consume the leaf allowance");
        assert_eq!(prepared.preview.candidates.len(), 1);
        assert_eq!(prepared.preview.candidates[0].path, "dist");
    }
    #[test]
    fn git_signed_markers_never_fall_back_when_nonregular() {
        let git = Git::new().unwrap();
        git.run(&["init", "--template=", "repository"], LIMIT)
            .unwrap();
        let repo = git.scratch.path().join("repository");
        let cases = [
            ("artifact-link", "plugin.artifact.json", "120000"),
            ("signature-link", "plugin.signature.json", "120000"),
            ("artifact-gitlink", "plugin.artifact.json", "160000"),
            ("signature-gitlink", "plugin.signature.json", "160000"),
            ("artifact-directory", "plugin.artifact.json", "directory"),
            ("signature-directory", "plugin.signature.json", "directory"),
        ];
        for (folder, name, mode) in cases {
            let package = plugin(&repo, folder, &format!("example.{folder}"));
            if mode == "directory" {
                fs::create_dir(package.join(name)).unwrap();
                fs::write(package.join(name).join("note"), "not a release blob").unwrap();
            }
        }
        git.run(&["-C", "repository", "add", "."], LIMIT).unwrap();
        let commit = || {
            git.run(
                &[
                    "-C",
                    "repository",
                    "-c",
                    "user.name=Fixture",
                    "-c",
                    "user.email=fixture@example.invalid",
                    "-c",
                    "commit.gpgsign=false",
                    "commit",
                    "-m",
                    "fixture",
                ],
                LIMIT,
            )
            .unwrap();
        };
        commit();
        let head = String::from_utf8(
            git.run(&["-C", "repository", "rev-parse", "HEAD"], 1024)
                .unwrap(),
        )
        .unwrap();
        let blob = String::from_utf8(
            git.run(
                &[
                    "-C",
                    "repository",
                    "rev-parse",
                    "HEAD:artifact-link/plugin.js",
                ],
                1024,
            )
            .unwrap(),
        )
        .unwrap();
        for (folder, name, mode) in cases {
            if mode == "directory" {
                continue;
            }
            let oid = if mode == "160000" {
                head.trim()
            } else {
                blob.trim()
            };
            git.run(
                &[
                    "-C",
                    "repository",
                    "update-index",
                    "--add",
                    "--cacheinfo",
                    mode,
                    oid,
                    &format!("{folder}/{name}"),
                ],
                LIMIT,
            )
            .unwrap();
        }
        commit();
        let prepared = git.read_plugins("fixture".into()).unwrap();
        assert!(
            prepared.preview.candidates.is_empty(),
            "signed-marker evidence must forbid unsigned fallback: {:?}",
            prepared
                .preview
                .candidates
                .iter()
                .map(|c| &c.path)
                .collect::<Vec<_>>()
        );
        assert_eq!(prepared.preview.warnings.len(), cases.len());
        for (folder, _, _) in cases {
            assert!(prepared
                .preview
                .warnings
                .iter()
                .any(|warning| warning.starts_with(&format!("{folder}:"))
                    && warning.contains("signed")));
        }
    }
    #[test]
    fn signed_folder_import_load_reload_and_publisher_continuity() {
        let root = tempfile::tempdir().unwrap();
        let source = plugin(root.path(), "dist", "example.signed");
        let first_key = nostr::key::SecretKey::generate().to_secret_hex();
        let publisher = crate::sign_release(&source, &first_key).unwrap();
        let pair_only = tempfile::tempdir().unwrap();
        for name in ["plugin.artifact.json", "plugin.signature.json"] {
            fs::copy(source.join(name), pair_only.path().join(name)).unwrap();
        }
        assert_eq!(
            prepare_folder(pair_only.path())
                .unwrap()
                .preview
                .candidates
                .len(),
            1
        );
        let prepared = prepare_folder(root.path()).unwrap();
        assert_eq!(
            prepared.preview.candidates[0].publisher.as_deref(),
            Some(publisher.as_str())
        );
        let home = tempfile::tempdir().unwrap();
        let manager = Manager::open(Some(home.path().into()), "test", false).unwrap();
        let installed = prepared
            .install(&manager, &prepared.preview.token, "dist")
            .unwrap();
        let first = installed
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.signed")
            .unwrap();
        assert_eq!(first.publisher.as_deref(), Some(publisher.as_str()));
        let first_revision = first.revision.clone();
        manager.change("enable", "example.signed").unwrap();
        assert!(manager
            .module("example.signed", &first_revision)
            .unwrap()
            .contains("first"));
        let stored = manager.artifact_path("example.signed", &first_revision);
        let original = fs::read(&stored).unwrap();
        fs::write(&stored, b"{}").unwrap();
        assert!(manager.module("example.signed", &first_revision).is_err());
        fs::write(&stored, original).unwrap();
        manager.change("disable", "example.signed").unwrap();
        fs::write(source.join("plugin.js"), "export const changed = true;").unwrap();
        crate::sign_release(&source, &first_key).unwrap();
        let second = manager.reload("example.signed").unwrap();
        let second = second
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.signed")
            .unwrap();
        assert_eq!(second.publisher.as_deref(), Some(publisher.as_str()));
        manager.change("enable", "example.signed").unwrap();
        assert!(manager
            .module("example.signed", &second.revision)
            .unwrap()
            .contains("changed"));
        manager.change("disable", "example.signed").unwrap();
        manager.change("rollback", "example.signed").unwrap();
        assert_eq!(
            manager
                .catalog()
                .unwrap()
                .plugins
                .iter()
                .find(|p| p.manifest.id == "example.signed")
                .unwrap()
                .publisher
                .as_deref(),
            Some(publisher.as_str())
        );
        manager.change("enable", "example.signed").unwrap();
        assert!(manager
            .module("example.signed", &first_revision)
            .unwrap()
            .contains("first"));
        manager.change("disable", "example.signed").unwrap();
        crate::sign_release(&source, &nostr::key::SecretKey::generate().to_secret_hex()).unwrap();
        let different = prepare_folder(root.path()).unwrap();
        assert!(different
            .install(&manager, &different.preview.token, "dist")
            .err()
            .unwrap()
            .contains("Publisher changed"));
        assert!(manager
            .reload("example.signed")
            .err()
            .unwrap()
            .contains("Publisher changed"));
        fs::remove_file(source.join("plugin.artifact.json")).unwrap();
        fs::remove_file(source.join("plugin.signature.json")).unwrap();
        assert!(manager
            .install(&source)
            .err()
            .unwrap()
            .contains("Publisher changed"));
        manager.change("remove", "example.signed").unwrap();
        assert!(manager.install(&source).is_ok());
    }
    #[test]
    fn signed_pair_never_falls_back_to_unsigned_files() {
        let root = tempfile::tempdir().unwrap();
        let source = plugin(root.path(), "dist", "example.signed");
        crate::sign_release(&source, &nostr::key::SecretKey::generate().to_secret_hex()).unwrap();
        fs::remove_file(source.join("plugin.signature.json")).unwrap();
        let preview = prepare_folder(root.path()).unwrap();
        assert!(preview.preview.candidates.is_empty());
        assert!(preview.preview.warnings[0].contains("Incomplete signed"));
        fs::write(source.join("plugin.signature.json"), "{}").unwrap();
        assert!(prepare_folder(root.path())
            .unwrap()
            .preview
            .candidates
            .is_empty());
    }
    #[test]
    fn signed_update_cannot_roll_back_to_unsigned_revision() {
        let root = tempfile::tempdir().unwrap();
        let source = plugin(root.path(), "dist", "example.signed");
        let home = tempfile::tempdir().unwrap();
        let manager = Manager::open(Some(home.path().into()), "test", false).unwrap();
        manager.install(&source).unwrap();
        fs::write(source.join("plugin.js"), "export const signed = true;").unwrap();
        crate::sign_release(&source, &nostr::key::SecretKey::generate().to_secret_hex()).unwrap();
        manager.install(&source).unwrap();
        assert!(manager
            .change("rollback", "example.signed")
            .err()
            .unwrap()
            .contains("unsigned"));
    }
    #[test]
    fn authorization_reaches_only_its_repository_and_never_follows_a_redirect() {
        use std::io::{BufRead, BufReader, Write};
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", server.local_addr().unwrap());
        let requests = thread::spawn(move || {
            let mut seen = vec![];
            for _ in 0..2 {
                let (stream, _) = server.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut head = vec![];
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line.trim().is_empty() {
                        break;
                    }
                    head.push(line.trim().to_string());
                }
                // Each repository redirects; Git must report it, not follow it with the header.
                let mut stream = stream;
                write!(stream, "HTTP/1.1 302 Found\r\nLocation: /elsewhere/info/refs?service=git-upload-pack\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
                seen.push(head);
            }
            seen
        });
        let mut git = Git::new().unwrap();
        let repository = format!("{base}/git/{}/plugin", "a".repeat(64));
        git.authorization = Some((repository.clone(), "dG9rZW4=".into()));
        for url in [
            repository,
            format!("{base}/git/{}/plugin-other", "a".repeat(64)),
        ] {
            let error = git
                .run(
                    &["-c", "protocol.http.allow=always", "ls-remote", "--", &url],
                    LIMIT,
                )
                .unwrap_err();
            assert!(error.contains("error: 302"), "{error}");
        }
        let seen = requests.join().unwrap();
        let authorization = |head: &Vec<String>| {
            head.iter()
                .any(|line| line == "Authorization: Nostr dG9rZW4=")
        };
        assert!(seen[0][0].contains("/plugin/info/refs"), "{:?}", seen[0]);
        assert!(authorization(&seen[0]));
        // A sibling whose name shares the prefix is a different repository.
        assert!(
            seen[1][0].contains("/plugin-other/info/refs"),
            "{:?}",
            seen[1]
        );
        assert!(!authorization(&seen[1]));
    }
    #[test]
    fn rejects_malformed_authorization_before_running_git() {
        for token in ["", "a\r\nX-Injected: 1", &"a".repeat(8193)] {
            let error = prepare_git("https://example.invalid/git/owner/repo", "", Some(token))
                .err()
                .unwrap();
            assert_eq!(error, "Invalid repository authorization");
        }
    }
    #[test]
    fn git_deadline_and_output_limits_fail() {
        let mut git = Git::new().unwrap();
        assert!(git.run(&["--version"], 1).is_err());
        git.deadline = Instant::now();
        assert!(git
            .run(&["--version"], LIMIT)
            .unwrap_err()
            .contains("60 seconds"));
    }
    #[cfg(unix)]
    #[test]
    fn timeout_terminates_spawned_descendant_before_it_can_write() {
        let mut git = Git::new().unwrap();
        git.deadline = Instant::now() + Duration::from_millis(500);
        let mut command = Command::new("sh");
        command
            .current_dir(git.scratch.path())
            .args(["-c", "(touch child-started; sleep 1; touch escaped) & wait"]);
        let result = git.run_command(command, LIMIT);
        assert!(result.unwrap_err().contains("60 seconds"));
        assert!(git.scratch.path().join("child-started").exists());
        thread::sleep(Duration::from_millis(1200));
        assert!(!git.scratch.path().join("escaped").exists());
        // Positive control: the same delayed descendant really can write without a timeout.
        git.deadline = Instant::now() + Duration::from_secs(5);
        let mut control = Command::new("sh");
        control
            .current_dir(git.scratch.path())
            .args(["-c", "(sleep 1; touch escaped) & wait"]);
        git.run_command(control, LIMIT).unwrap();
        assert!(git.scratch.path().join("escaped").exists());
    }
}
