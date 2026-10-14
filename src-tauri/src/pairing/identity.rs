use nostr_pairing::{Keys, ToBech32};
use zeroize::Zeroizing;

pub(super) struct Prepared {
    plaintext: Zeroizing<String>,
    binding: buzz_pairing_policy::IdentityBinding,
}

/// Only consuming a bound prepared identity can construct a native transfer.
pub(super) struct Transfer {
    encrypted: buzz_pairing::session::EncryptedPayload,
    binding: buzz_pairing_policy::IdentityBinding,
}
impl Prepared {
    pub(super) fn encrypt(
        self,
        session: &mut buzz_pairing::PairingSession,
    ) -> Result<Transfer, String> {
        let encrypted = session
            .send_authorized_payload(buzz_pairing::PayloadType::Custom, self.plaintext)
            .map_err(|_| "Couldn’t prepare the pairing transfer.")?;
        Ok(Transfer {
            encrypted,
            binding: self.binding,
        })
    }
}
impl Transfer {
    pub(super) fn event(&self) -> &nostr_pairing::Event {
        self.encrypted.event()
    }
    pub(super) fn proposal(&self) -> buzz_pairing_policy::PayloadProposal {
        self.encrypted.proposal(self.binding.duplicate())
    }
}

pub(super) async fn prepare(
    host: &crate::identity::IdentityHost,
    viewer: String,
    origin: String,
) -> Result<Prepared, String> {
    let requested = nostr_pairing::PublicKey::from_hex(&viewer)
        .map_err(|_| "Choose your Buzz account before pairing.")?
        .to_bytes();
    host.with_pairing_key(
        requested,
        origin.as_bytes().to_vec(),
        move |secret, current, binding| {
            if current != viewer {
                return Err("The active account changed. Reopen Pair mobile.".into());
            }
            let secret = nostr_pairing::SecretKey::from_slice(secret)
                .map_err(|_| "Couldn’t read your Buzz account.")?;
            payload(&Keys::new(secret), &viewer, &origin, binding)
        },
    )
    .await
}

pub(super) fn payload(
    keys: &Keys,
    expected: &str,
    relay: &str,
    binding: buzz_pairing_policy::IdentityBinding,
) -> Result<Prepared, String> {
    if keys.public_key().to_hex() != expected
        || !binding.matches(keys.public_key().to_bytes(), relay.as_bytes())
    {
        return Err("The saved Buzz account has changed. Reopen Pair mobile and try again.".into());
    }
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Payload<'a> {
        relay_url: &'a str,
        pubkey: &'a str,
        nsec: &'a str,
    }
    let secret = Zeroizing::new(
        keys.secret_key()
            .to_bech32()
            .map_err(|_| "Couldn’t prepare your Buzz account.")?,
    );
    serde_json::to_string(&Payload {
        relay_url: relay,
        pubkey: expected,
        nsec: &secret,
    })
    .map(|plaintext| Prepared {
        plaintext: Zeroizing::new(plaintext),
        binding,
    })
    .map_err(|_| "Couldn’t prepare your Buzz account.".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn current_native_identity_is_the_only_payload_source() {
        let host = crate::identity::IdentityHost::fixture();
        let viewer = host.viewer().await.unwrap();
        assert!(prepare(&host, "f".repeat(64), "https://relay.test".into())
            .await
            .is_err());
        let data = prepare(&host, viewer.clone(), "https://relay.test".into())
            .await
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&data.plaintext).unwrap();
        assert_eq!(parsed["pubkey"], viewer);
        assert_eq!(
            Keys::parse(parsed["nsec"].as_str().unwrap())
                .unwrap()
                .public_key()
                .to_hex(),
            viewer
        );
        assert!(prepare(
            &crate::identity::IdentityHost::default(),
            viewer,
            "https://relay.test".into()
        )
        .await
        .is_err());
    }
    #[test]
    fn account_pin_is_checked_before_export() {
        let keys = Keys::generate();
        let binding = || {
            buzz_pairing_policy::Custody::Ready(())
                .pairing_binding(
                    keys.public_key().to_bytes(),
                    keys.public_key().to_bytes(),
                    b"https://relay.test".to_vec(),
                )
                .unwrap()
        };
        assert!(payload(
            &keys,
            &Keys::generate().public_key().to_hex(),
            "https://relay.test",
            binding()
        )
        .is_err());
        let data = payload(
            &keys,
            &keys.public_key().to_hex(),
            "https://relay.test",
            binding(),
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&data.plaintext).unwrap();
        assert_eq!(parsed["relayUrl"], "https://relay.test");
        assert_eq!(
            Keys::parse(parsed["nsec"].as_str().unwrap())
                .unwrap()
                .public_key(),
            keys.public_key()
        );
    }
}
