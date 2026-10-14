//! Location of legacy encrypted backup records, retained only for sign-out cleanup.
use std::path::PathBuf;

pub(crate) fn root() -> Option<PathBuf> {
    #[cfg(unix)]
    let home = nix::unistd::User::from_uid(nix::unistd::Uid::effective())
        .ok()
        .flatten()
        .map(|user| user.dir);
    #[cfg(windows)]
    let home = dirs::home_dir();
    #[cfg(not(any(unix, windows)))]
    let home: Option<PathBuf> = None;
    home.filter(|path| path.is_absolute()).map(|path| {
        path.join(".buzz-foundation/nsec-backups")
            .join(buzz_credential_store::HUMAN_SERVICE)
    })
}
