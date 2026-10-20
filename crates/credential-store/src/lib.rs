//! Credential primitives shared by human and agent identity owners.
//! Password encoding matches keyring's native Windows UTF-16 / Linux UTF-8 format.
//! Create-only writes are serialized across cooperating app processes, not profiles.
//! Locks contain no secrets; missing/locked/broken secure storage never falls back.
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::path::Path;
#[cfg(any(target_os = "windows", target_os = "linux", test))]
use zeroize::Zeroize;
use zeroize::Zeroizing;

pub const HUMAN_ACCOUNT: &str = "human";
pub const HUMAN_SERVICE: &str = human_service(cfg!(debug_assertions));

pub const fn human_service(debug: bool) -> &'static str {
    if debug {
        "dev.local.buzz.foundation.identity.debug"
    } else {
        "dev.local.buzz.foundation.identity"
    }
}

/// Sanitized outcomes. Only `Absent` permits creation of a new credential.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Absent,
    Occupied,
    Changed,
    Denied,
    Corrupt,
    Unavailable,
    Busy,
}
type Result<T> = std::result::Result<T, Error>;

#[cfg(any(target_os = "windows", target_os = "linux", test))]
fn error(value: keyring::Error) -> Error {
    match value {
        keyring::Error::NoEntry => Error::Absent,
        keyring::Error::NoStorageAccess(_) => Error::Denied,
        keyring::Error::BadEncoding(mut bytes) => {
            bytes.zeroize();
            Error::Corrupt
        }
        keyring::Error::Ambiguous(_) => Error::Corrupt,
        _ => Error::Unavailable,
    }
}

#[cfg(any(target_os = "windows", target_os = "linux", test))]
trait Backend {
    fn read(&self) -> Result<Zeroizing<Vec<u8>>>;
    fn write(&self, value: &str) -> Result<()>;
    fn delete(&self) -> Result<()>;
}

// Unit tests cannot accidentally call the real OS adapter.
#[cfg(all(not(test), any(target_os = "windows", target_os = "linux")))]
impl Backend for keyring::Entry {
    fn read(&self) -> Result<Zeroizing<Vec<u8>>> {
        self.get_password()
            .map(|value| Zeroizing::new(value.into_bytes()))
            .map_err(error)
    }
    fn write(&self, value: &str) -> Result<()> {
        self.set_password(value).map_err(error)
    }
    fn delete(&self) -> Result<()> {
        self.delete_credential().map_err(error)
    }
}

#[cfg(all(not(test), any(target_os = "windows", target_os = "linux")))]
fn entry(service: &str, account: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(service, account).map_err(error)
}

fn lock_root() -> Result<std::path::PathBuf> {
    // Resolve the OS account, not HOME/XDG overrides, profile, worktree or temp
    // paths: all processes writing the same per-user entry must share its lock.
    #[cfg(unix)]
    let home = nix::unistd::User::from_uid(nix::unistd::Uid::effective())
        .map_err(|_| Error::Unavailable)?
        .map(|user| user.dir);
    #[cfg(windows)]
    let home = dirs::home_dir(); // Windows Known Folder API, not environment.
    home.filter(|path| path.is_absolute())
        .map(|path| path.join(".buzz-foundation/credential-locks"))
        .ok_or(Error::Unavailable)
}

/// Read an exact service/account without consulting any other credential.
#[cfg(all(not(test), any(target_os = "windows", target_os = "linux")))]
pub fn read(service: &str, account: &str) -> Result<Zeroizing<Vec<u8>>> {
    entry(service, account)?.read()
}

/// Add a credential only if a fresh read under its interprocess lock is absent.
#[cfg(all(not(test), any(target_os = "windows", target_os = "linux")))]
pub fn add(service: &str, account: &str, value: &[u8]) -> Result<()> {
    add_entry(
        &entry(service, account)?,
        &lock_root()?,
        service,
        account,
        value,
    )
}

/// Delete only the exact credential, serialized with this app's creates/deletes.
#[cfg(all(not(test), any(target_os = "windows", target_os = "linux")))]
pub fn delete(service: &str, account: &str) -> Result<()> {
    delete_entry(&entry(service, account)?, &lock_root()?, service, account)
}

#[cfg(any(target_os = "windows", target_os = "linux", test))]
fn add_entry(
    entry: &impl Backend,
    root: &Path,
    service: &str,
    account: &str,
    value: &[u8],
) -> Result<()> {
    let value = std::str::from_utf8(value).map_err(|_| Error::Corrupt)?;
    let _lock = acquire(root, service, account)?;
    match entry.read() {
        Ok(_) => return Err(Error::Occupied),
        Err(Error::Absent) => {}
        Err(error) => return Err(error),
    }
    entry.write(value)
}

#[cfg(any(target_os = "windows", target_os = "linux", test))]
fn delete_entry(entry: &impl Backend, root: &Path, service: &str, account: &str) -> Result<()> {
    let _lock = acquire(root, service, account)?;
    entry.delete()
}

struct Lock(File);

impl Drop for Lock {
    fn drop(&mut self) {
        // fork/dup can retain the open-file description after our descriptor
        // closes. Explicitly release ownership when the operation finishes.
        let _ = self.0.unlock();
    }
}

fn acquire(root: &Path, service: &str, account: &str) -> Result<Lock> {
    if !root.is_absolute() {
        return Err(Error::Unavailable);
    }
    fs::create_dir_all(root).map_err(|_| Error::Unavailable)?;
    let mut hash = Sha256::new();
    hash.update(service.as_bytes());
    hash.update([0]);
    hash.update(account.as_bytes());
    let path = root.join(format!("{:x}.lock", hash.finalize()));
    // The file is never read, written, truncated or removed; it contains no
    // secrets. These advisory locks coordinate this app, not hostile OS peers.
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|_| Error::Unavailable)?;
    // Unlike a blocking lock, contention cannot strand an IPC worker behind a
    // second process's credential-consent dialog. Retry is explicitly user-driven.
    file.try_lock().map_err(|e| match e {
        std::fs::TryLockError::WouldBlock => Error::Busy,
        std::fs::TryLockError::Error(_) => Error::Unavailable,
    })?;
    Ok(Lock(file))
}

/// Read only the human identity used by the desktop app; never create or select another key.
#[cfg(all(not(test), any(target_os = "windows", target_os = "linux")))]
pub fn read_human() -> Result<Zeroizing<Vec<u8>>> {
    read(HUMAN_SERVICE, HUMAN_ACCOUNT)
}

#[cfg(all(not(test), target_os = "macos"))]
pub fn read_human() -> Result<Zeroizing<Vec<u8>>> {
    use security_framework::os::macos::keychain::SecKeychain;
    let keychain = SecKeychain::default().map_err(mac_error)?;
    keychain
        .find_generic_password(HUMAN_SERVICE, HUMAN_ACCOUNT)
        .map(|(password, _)| Zeroizing::new(password.to_vec()))
        .map_err(mac_error)
}

#[cfg(all(not(test), target_os = "macos"))]
fn mac_error(error: security_framework::base::Error) -> Error {
    match error.code() {
        -25300 => Error::Absent,
        -128 | -25293 | -25308 => Error::Denied,
        _ => Error::Unavailable,
    }
}

#[cfg(all(
    not(test),
    not(any(target_os = "macos", target_os = "windows", target_os = "linux"))
))]
pub fn read_human() -> Result<Zeroizing<Vec<u8>>> {
    Err(Error::Unavailable)
}

#[cfg(test)]
mod tests;

/// Session records have a distinct mutable owner. Human-key `add` remains create-only.
/// Erase an indexed session without reading its contents or knowing its schema.
#[cfg(not(test))]
pub fn delete_session(service: &str, account: &str) -> Result<()> {
    if !service.starts_with("dev.local.buzz.foundation.federated-session") {
        return Err(Error::Denied);
    }
    let _lock = acquire(&lock_root()?, service, account)?;
    #[cfg(target_os = "macos")]
    return security_framework::passwords::delete_generic_password(service, account)
        .map_err(mac_error);
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    return entry(service, account)?.delete();
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    Err(Error::Unavailable)
}

/// Session records have a distinct mutable owner. Human-key `add` remains create-only.
/// Compare the entire previously read record under the same interprocess lock.
#[cfg(not(test))]
pub fn compare_session(
    service: &str,
    account: &str,
    expected: Option<&[u8]>,
    replacement: Option<&[u8]>,
) -> Result<()> {
    if !service.starts_with("dev.local.buzz.foundation.federated-session") {
        return Err(Error::Denied);
    }
    let _lock = acquire(&lock_root()?, service, account)?;
    let current = match read_session(service, account) {
        Ok(value) => Some(value),
        Err(Error::Absent) => None,
        Err(error) => return Err(error),
    };
    if current.as_deref().map(|v| v.as_slice()) != expected {
        return Err(Error::Changed);
    }
    session_write(service, account, replacement)
}

#[cfg(all(not(test), any(target_os = "windows", target_os = "linux")))]
pub fn read_session(service: &str, account: &str) -> Result<Zeroizing<Vec<u8>>> {
    read(service, account)
}

#[cfg(all(not(test), any(target_os = "windows", target_os = "linux")))]
fn session_write(service: &str, account: &str, value: Option<&[u8]>) -> Result<()> {
    let entry = entry(service, account)?;
    match value {
        Some(value) => entry.write(std::str::from_utf8(value).map_err(|_| Error::Corrupt)?),
        None => match entry.delete() {
            Err(Error::Absent) => Ok(()),
            result => result,
        },
    }
}

#[cfg(all(not(test), target_os = "macos"))]
pub fn read_session(service: &str, account: &str) -> Result<Zeroizing<Vec<u8>>> {
    use security_framework::os::macos::keychain::SecKeychain;
    SecKeychain::default()
        .map_err(mac_error)?
        .find_generic_password(service, account)
        .map(|(password, _)| Zeroizing::new(password.to_vec()))
        .map_err(mac_error)
}

#[cfg(all(not(test), target_os = "macos"))]
fn session_write(service: &str, account: &str, value: Option<&[u8]>) -> Result<()> {
    use security_framework::os::macos::keychain::SecKeychain;
    let keychain = SecKeychain::default().map_err(mac_error)?;
    match (keychain.find_generic_password(service, account), value) {
        (Ok((_, mut item)), Some(value)) => item.set_password(value).map_err(mac_error),
        (Err(error), Some(value)) if mac_error(error) == Error::Absent => keychain
            .add_generic_password(service, account, value)
            .map(|_| ())
            .map_err(mac_error),
        (Ok((_, item)), None) => {
            item.delete();
            match read_session(service, account) {
                Err(Error::Absent) => Ok(()),
                Ok(_) => Err(Error::Unavailable),
                Err(error) => Err(error),
            }
        }
        (Err(error), None) if mac_error(error) == Error::Absent => Ok(()),
        (Err(error), _) => Err(mac_error(error)),
    }
}

#[cfg(all(
    not(test),
    not(any(target_os = "macos", target_os = "windows", target_os = "linux"))
))]
pub fn read_session(_: &str, _: &str) -> Result<Zeroizing<Vec<u8>>> {
    Err(Error::Unavailable)
}
#[cfg(all(
    not(test),
    not(any(target_os = "macos", target_os = "windows", target_os = "linux"))
))]
fn session_write(_: &str, _: &str, _: Option<&[u8]>) -> Result<()> {
    Err(Error::Unavailable)
}
