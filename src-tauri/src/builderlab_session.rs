//! The saved Builderlab sign-in, so a person stays signed in across launches.
//! The bundled Builderlab plugin owns the credential and every use of it;
//! native code only keeps the blob the plugin hands it in the OS credential
//! store, under Buzz's own item. On macOS the item is created by the Buzz
//! binary, so only that binary reads it without a prompt; an agent's shell
//! cannot. Unlike the TypeSafe key (`jev.rs`), the plugin reads it back: it
//! sends the credential with every Builderlab request.
use zeroize::Zeroizing;

#[cfg_attr(test, allow(dead_code))]
pub(crate) const SERVICE: &str = if cfg!(debug_assertions) {
    "xyz.block.buzz.desktop.builderlab-session.debug"
} else {
    "xyz.block.buzz.desktop.builderlab-session"
};
#[cfg_attr(test, allow(dead_code))]
pub(crate) const ACCOUNT: &str = "builderlab";
/// The plugin's JSON blob: a credential of up to 4 KiB and the verified account.
const LIMIT: usize = 16 * 1024;
const UNAVAILABLE: &str = "The Keychain is unavailable";

/// Refuse what the plugin never writes, so a damaged or foreign blob is not
/// saved as the sign-in.
fn validate(blob: &str) -> Result<(), String> {
    if blob.is_empty() || blob.len() > LIMIT || blob.chars().any(char::is_control) {
        return Err("That does not look like a Builderlab sign-in".into());
    }
    Ok(())
}

/// A blank item is no sign-in. Anything else is handed over as text, bytes that
/// are not UTF-8 included: the plugin's decoder refuses what is not its JSON
/// and deletes the item, so a damaged one cannot fail every launch.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux", test))]
fn decode(bytes: Zeroizing<Vec<u8>>) -> Option<String> {
    let text = String::from_utf8_lossy(&bytes);
    (!text.trim().is_empty()).then(|| text.into_owned())
}

/// The store can block on a consent dialog; a caller's deadline still applies
/// while it waits.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| UNAVAILABLE.to_string())?
}

#[cfg(all(target_os = "macos", not(test)))]
mod platform {
    use super::*;
    use buzz_credential_store as credentials;
    use security_framework::os::macos::keychain::SecKeychain;
    const NOT_FOUND: i32 = -25300;
    fn error(error: security_framework::base::Error) -> String {
        match error.code() {
            -128 | -25293 | -25308 => "Keychain access was denied. Allow access and retry",
            _ => UNAVAILABLE,
        }
        .into()
    }
    /// Only "item not found" means no sign-in; a locked or refused Keychain
    /// is an error, so it neither hides nor removes a saved one.
    pub(super) fn read() -> Result<Option<String>, String> {
        match SecKeychain::default()
            .map_err(error)?
            .find_generic_password(SERVICE, ACCOUNT)
        {
            Ok((password, _)) => Ok(decode(Zeroizing::new(password.to_vec()))),
            Err(e) if e.code() == NOT_FOUND => Ok(None),
            Err(e) => Err(error(e)),
        }
    }
    /// A saved item is updated in place, so a failed write leaves the sign-in
    /// as it was. A new item's access list trusts only this binary.
    pub(super) fn replace(blob: &str) -> Result<(), String> {
        SecKeychain::default()
            .map_err(error)?
            .set_generic_password(SERVICE, ACCOUNT, blob.as_bytes())
            .map_err(error)
    }
    /// The delete confirms the item is gone.
    pub(super) fn clear() -> Result<(), String> {
        match credentials::delete(SERVICE, ACCOUNT) {
            Ok(()) | Err(credentials::Error::Absent) => Ok(()),
            Err(credentials::Error::Denied) => {
                Err("Keychain access was denied. Allow access and retry".into())
            }
            Err(credentials::Error::Busy) => {
                Err("Another Buzz app is using secure storage. Retry shortly".into())
            }
            Err(_) => Err(UNAVAILABLE.into()),
        }
    }
}

#[cfg(all(any(target_os = "windows", target_os = "linux"), not(test)))]
mod platform {
    use super::*;
    use buzz_credential_store::{self as credentials, Error};
    fn error(error: Error) -> String {
        match error {
            Error::Denied => "Secure storage access was denied. Allow access and retry",
            Error::Busy => "Another Buzz app is using secure storage. Retry shortly",
            Error::Corrupt => "The saved Builderlab sign-in is damaged",
            _ => "Secure storage is unavailable. Unlock it and retry",
        }
        .into()
    }
    pub(super) fn read() -> Result<Option<String>, String> {
        match credentials::read(SERVICE, ACCOUNT) {
            Ok(bytes) => Ok(decode(bytes)),
            Err(Error::Absent) => Ok(None),
            Err(e) => Err(error(e)),
        }
    }
    pub(super) fn replace(blob: &str) -> Result<(), String> {
        credentials::replace(SERVICE, ACCOUNT, blob.as_bytes()).map_err(error)
    }
    pub(super) fn clear() -> Result<(), String> {
        match credentials::delete(SERVICE, ACCOUNT) {
            Ok(()) | Err(Error::Absent) => Ok(()),
            Err(e) => Err(error(e)),
        }
    }
}

// Native tests never touch an OS credential store.
#[cfg(any(
    not(any(target_os = "macos", target_os = "windows", target_os = "linux")),
    test
))]
mod platform {
    const MISSING: &str = "Secure storage is not available here";
    pub(super) fn read() -> Result<Option<String>, String> {
        Err(MISSING.into())
    }
    pub(super) fn replace(_blob: &str) -> Result<(), String> {
        Err(MISSING.into())
    }
    pub(super) fn clear() -> Result<(), String> {
        Err(MISSING.into())
    }
}

/// The saved blob, or `None` when there is none. A store that cannot be read
/// is an error, not a missing sign-in.
#[tauri::command]
pub(crate) async fn builderlab_session_read() -> Result<Option<String>, String> {
    blocking(platform::read).await
}

#[tauri::command]
pub(crate) async fn builderlab_session_replace(blob: String) -> Result<(), String> {
    let blob = Zeroizing::new(blob);
    validate(&blob)?;
    blocking(move || platform::replace(&blob)).await
}

#[tauri::command]
pub(crate) async fn builderlab_session_clear() -> Result<(), String> {
    blocking(platform::clear).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_plugins_json_blob_and_refuses_anything_else() {
        validate(r#"{"value":"tok","account":{"subject":"u","email":"é@x.y"}}"#).unwrap();
        for bad in ["", "a\nb", "a\u{7f}b", &"x".repeat(LIMIT + 1)] {
            assert!(validate(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_blank_item_is_no_sign_in_and_a_damaged_one_reaches_the_plugin_as_text() {
        assert_eq!(decode(Zeroizing::new(b"  ".to_vec())), None);
        assert_eq!(
            decode(Zeroizing::new(b"{}".to_vec())).as_deref(),
            Some("{}")
        );
        assert_eq!(
            decode(Zeroizing::new(vec![0xff, 0xfe])).as_deref(),
            Some("\u{fffd}\u{fffd}")
        );
    }

    #[tokio::test]
    async fn commands_report_a_missing_store_without_panicking() {
        assert!(builderlab_session_read().await.is_err());
        assert!(builderlab_session_replace("{}".into()).await.is_err());
        assert!(builderlab_session_replace(String::new()).await.is_err());
        assert!(builderlab_session_clear().await.is_err());
    }
}
