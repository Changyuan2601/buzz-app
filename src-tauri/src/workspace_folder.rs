use std::path::{Path, PathBuf};

/// Expand only home-relative forms; `~name` is not another spelling of home.
pub(crate) fn expand(path: &str, home: Option<&Path>) -> PathBuf {
    let relative = if path == "~" {
        Some("")
    } else {
        path.strip_prefix("~/").or_else(|| {
            if cfg!(windows) {
                path.strip_prefix("~\\")
            } else {
                None
            }
        })
    };
    match (relative, home) {
        (Some(rest), Some(home)) => home.join(rest.trim_start_matches(std::path::is_separator)),
        _ => PathBuf::from(path),
    }
}

/// Never return a different path by replacing bytes the text field cannot hold.
pub(crate) fn display(path: &Path, home: Option<&Path>) -> Result<String, String> {
    let text = |path: &Path| {
        path.to_str().map(str::to_owned).ok_or_else(|| {
            "This folder name cannot be represented as UTF-8. Choose another folder.".to_owned()
        })
    };
    match home.and_then(|home| path.strip_prefix(home).ok()) {
        Some(rest) if rest.as_os_str().is_empty() => Ok("~".to_owned()),
        Some(rest) => {
            let rest = text(rest)?;
            let rest = if cfg!(windows) {
                rest.replace('\\', "/")
            } else {
                rest
            };
            Ok(format!("~/{rest}"))
        }
        None => text(path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_paths_round_trip_without_reinterpreting_names() {
        let home = Path::new("/users/viewer");
        for path in ["~", "~/repo", "~/nested/repo"] {
            assert_eq!(
                display(&expand(path, Some(home)), Some(home)).unwrap(),
                path
            );
        }
        assert_eq!(
            expand("~someone/repo", Some(home)),
            PathBuf::from("~someone/repo")
        );
        assert_eq!(expand("~/repo", None), PathBuf::from("~/repo"));
        assert_eq!(
            display(Path::new("/outside/repo"), Some(home)).unwrap(),
            "/outside/repo"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_home_separator_keeps_the_home_directory() {
        let home = Path::new(r"C:\Users\viewer");
        assert_eq!(expand(r"~\repo", Some(home)), home.join("repo"));
        assert_eq!(expand(r"~\\repo", Some(home)), home.join("repo"));
    }

    #[cfg(unix)]
    #[test]
    fn unix_paths_keep_backslashes_and_reject_non_utf8_selections() {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;
        let home = Path::new("/users/viewer");
        assert_eq!(expand(r"~\repo", Some(home)), PathBuf::from(r"~\repo"));
        let folder = OsString::from_vec(vec![b'r', 0xff]);
        for path in [home.join(&folder), Path::new("/outside").join(&folder)] {
            assert!(display(&path, Some(home)).unwrap_err().contains("UTF-8"));
        }
    }
}
