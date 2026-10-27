//! Credential primitives shared by human and agent identity owners.
//! Password encoding matches keyring's native Windows UTF-16 / Linux UTF-8 format.
//! Create-only writes, copies and deletes are serialized across cooperating app processes, not profiles.
//! Locks contain no secrets; missing/locked/broken secure storage never falls back.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux", test))]
use sha2::{Digest, Sha256};
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux", test))]
use std::fs::{self, File, OpenOptions};
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux", test))]
use std::path::Path;
#[cfg(any(target_os = "windows", target_os = "linux", test))]
use zeroize::Zeroize;
use zeroize::Zeroizing;

pub const HUMAN_ACCOUNT: &str = "human";
pub const HUMAN_SERVICE: &str = human_service(cfg!(debug_assertions));
/// The human key's service before 1.0, which reads move from.
pub const PREVIOUS_HUMAN_SERVICE: &str = human_store(cfg!(debug_assertions));
/// Names the files kept for the human key store: sign-out records and locks,
/// backups. It stays the service from before 1.0, so files older builds wrote
/// are still found.
pub const HUMAN_STORE: &str = human_store(cfg!(debug_assertions));

pub const fn human_service(debug: bool) -> &'static str {
    if debug {
        "xyz.block.buzz.desktop.identity.debug"
    } else {
        "xyz.block.buzz.desktop.identity"
    }
}

pub const fn human_store(debug: bool) -> &'static str {
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

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux", test))]
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

/// Write a credential whether or not one is saved, under the same lock as
/// creates and deletes. For settings a person replaces, never for identities.
#[cfg(all(not(test), any(target_os = "windows", target_os = "linux")))]
pub fn replace(service: &str, account: &str, value: &[u8]) -> Result<()> {
    replace_entry(
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

/// Delete without the lock, for a caller that holds it.
#[cfg(all(not(test), any(target_os = "windows", target_os = "linux")))]
fn remove(service: &str, account: &str) -> Result<()> {
    entry(service, account)?.delete()
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
fn replace_entry(
    entry: &impl Backend,
    root: &Path,
    service: &str,
    account: &str,
    value: &[u8],
) -> Result<()> {
    let value = std::str::from_utf8(value).map_err(|_| Error::Corrupt)?;
    let _lock = acquire(root, service, account)?;
    entry.write(value)
}

#[cfg(any(target_os = "windows", target_os = "linux", test))]
fn delete_entry(entry: &impl Backend, root: &Path, service: &str, account: &str) -> Result<()> {
    let _lock = acquire(root, service, account)?;
    entry.delete()
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux", test))]
struct Lock(File);

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux", test))]
impl Drop for Lock {
    fn drop(&mut self) {
        // fork/dup can retain the open-file description after our descriptor
        // closes. Explicitly release ownership when the operation finishes.
        let _ = self.0.unlock();
    }
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux", test))]
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

/// Read an item under its current service after moving the one saved under
/// its service from before 1.0 there (see [`move_previous`]). A key saved under
/// the current service is returned even if the move failed: the next read
/// retries. A failure that leaves no key is returned, never absence.
pub fn read_or_move<T, E>(
    current: impl FnOnce() -> std::result::Result<Option<T>, E>,
    move_previous: impl FnOnce() -> std::result::Result<(), E>,
) -> std::result::Result<Option<T>, E> {
    let moved = move_previous();
    match current()? {
        Some(value) => Ok(Some(value)),
        None => moved.map(|()| None),
    }
}

/// Move the item saved under `previous` to `service`: copy it, create-only,
/// then delete it once the item under `service` equals it. A different item
/// there wins and the old one stays: an older build may have saved it after a
/// rollback. It holds the previous item's lock, which deleting that item takes
/// too, so no delete falls between the read and the write to have the move
/// bring a deleted key back. An absent previous item leaves nothing to do.
#[cfg(all(
    not(test),
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
pub fn move_previous(previous: &str, service: &str, account: &str) -> Result<()> {
    move_with(
        &lock_root()?,
        previous,
        account,
        || read(previous, account),
        || read(service, account),
        |value| add(service, account, value),
        || remove(previous, account),
    )
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux", test))]
fn move_with(
    root: &Path,
    previous: &str,
    account: &str,
    read_previous: impl FnOnce() -> Result<Zeroizing<Vec<u8>>>,
    read: impl FnOnce() -> Result<Zeroizing<Vec<u8>>>,
    add: impl FnOnce(&[u8]) -> Result<()>,
    remove_previous: impl FnOnce() -> Result<()>,
) -> Result<()> {
    let _lock = acquire(root, previous, account)?;
    let value = match read_previous() {
        Ok(value) => value,
        Err(Error::Absent) => return Ok(()),
        Err(error) => return Err(error),
    };
    match add(&value) {
        Ok(()) | Err(Error::Occupied) => {}
        Err(error) => return Err(error),
    }
    if *read()? != *value {
        return Ok(());
    }
    match remove_previous() {
        Ok(()) | Err(Error::Absent) => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(not(test))]
fn optional(result: Result<Zeroizing<Vec<u8>>>) -> Result<Option<Zeroizing<Vec<u8>>>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(Error::Absent) => Ok(None),
        Err(error) => Err(error),
    }
}

/// Read only the human identity used by the desktop app; never create or select
/// another key. One saved before 1.0 is moved to the current service first.
#[cfg(not(test))]
pub fn read_human() -> Result<Zeroizing<Vec<u8>>> {
    read_or_move(
        || optional(read(HUMAN_SERVICE, HUMAN_ACCOUNT)),
        || move_previous(PREVIOUS_HUMAN_SERVICE, HUMAN_SERVICE, HUMAN_ACCOUNT),
    )?
    .ok_or(Error::Absent)
}

/// Read the human identity without moving it: under the current service, else
/// the one from before 1.0. For tools other than the desktop app, since a
/// Keychain item trusts only the binary that created it.
#[cfg(not(test))]
pub fn find_human() -> Result<Zeroizing<Vec<u8>>> {
    match read(HUMAN_SERVICE, HUMAN_ACCOUNT) {
        Err(Error::Absent) => read(PREVIOUS_HUMAN_SERVICE, HUMAN_ACCOUNT),
        result => result,
    }
}

/// Read the human identity saved under its service from before 1.0.
#[cfg(not(test))]
pub fn read_previous_human() -> Result<Zeroizing<Vec<u8>>> {
    read(PREVIOUS_HUMAN_SERVICE, HUMAN_ACCOUNT)
}

/// Read an exact service/account from the default Keychain, which `add` writes.
#[cfg(all(not(test), target_os = "macos"))]
pub fn read(service: &str, account: &str) -> Result<Zeroizing<Vec<u8>>> {
    use security_framework::os::macos::keychain::SecKeychain;
    SecKeychain::default()
        .map_err(mac_error)?
        .find_generic_password(service, account)
        .map(|(password, _)| Zeroizing::new(password.to_vec()))
        .map_err(mac_error)
}

/// Add a credential; Keychain refuses to replace a saved one.
#[cfg(all(not(test), target_os = "macos"))]
pub fn add(service: &str, account: &str, value: &[u8]) -> Result<()> {
    use security_framework::os::macos::keychain::SecKeychain;
    SecKeychain::default()
        .map_err(mac_error)?
        .add_generic_password(service, account, value)
        .map_err(mac_error)
}

/// Delete only the exact credential, under the same lock as [`move_previous`],
/// and confirm it is gone: Keychain's delete reports no failure.
#[cfg(all(not(test), target_os = "macos"))]
pub fn delete(service: &str, account: &str) -> Result<()> {
    let _lock = acquire(&lock_root()?, service, account)?;
    remove(service, account)
}

/// Delete without the lock, for a caller that holds it.
#[cfg(all(not(test), target_os = "macos"))]
fn remove(service: &str, account: &str) -> Result<()> {
    use security_framework::os::macos::keychain::SecKeychain;
    let keychain = SecKeychain::default().map_err(mac_error)?;
    let (_, item) = keychain
        .find_generic_password(service, account)
        .map_err(mac_error)?;
    item.delete();
    match keychain.find_generic_password(service, account) {
        Ok(_) => Err(Error::Unavailable),
        Err(error) => match mac_error(error) {
            Error::Absent => Ok(()),
            error => Err(error),
        },
    }
}

#[cfg(all(not(test), target_os = "macos"))]
fn mac_error(error: security_framework::base::Error) -> Error {
    match error.code() {
        -25300 => Error::Absent,
        -25299 => Error::Occupied,
        -128 | -25293 | -25308 => Error::Denied,
        _ => Error::Unavailable,
    }
}

#[cfg(all(
    not(test),
    not(any(target_os = "macos", target_os = "windows", target_os = "linux"))
))]
fn read(_: &str, _: &str) -> Result<Zeroizing<Vec<u8>>> {
    Err(Error::Unavailable)
}

#[cfg(all(
    not(test),
    not(any(target_os = "macos", target_os = "windows", target_os = "linux"))
))]
fn move_previous(_: &str, _: &str, _: &str) -> Result<()> {
    Err(Error::Unavailable)
}

#[cfg(test)]
mod tests;
