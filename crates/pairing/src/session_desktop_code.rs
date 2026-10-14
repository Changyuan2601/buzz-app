use super::*;

impl PairingSession {
    /// Start source-only code verification once, after capability negotiation.
    /// Returns the code for local display and an encrypted challenge containing
    /// no code or verifier. Repeated calls cannot reset the guess budget.
    pub fn start_desktop_code(&mut self) -> Result<(String, Event), PairingError> {
        self.check_expired()?;
        self.expect_role(Role::Source)?;
        self.expect_state(SessionState::Confirming)?;
        let value = rand::random_range(0..1_000_000u32);
        if !self.policy.issue(value) {
            return Err(PairingError::SasMismatch);
        }
        let code = Zeroizing::new(format!("{value:06}"));
        let challenge = match self.build_event(&PairingMessage::DesktopCode {}) {
            Ok(event) => event,
            Err(error) => {
                self.policy.abort();
                return Err(error);
            }
        };
        self.desktop_code = Some(code.clone());
        Ok((code.to_string(), challenge))
    }

    /// Verify a signed submission from the locked peer. Only a separate random
    /// desktop code authorizes release; the QR-derived SAS/transcript cannot.
    /// The response is a source proof on success or a rejection with a remaining
    /// guess budget. Five wrong guesses permanently abort this QR session.
    pub fn handle_target_code(&mut self, event: &Event) -> Result<(Event, bool), PairingError> {
        self.check_expired()?;
        self.expect_role(Role::Source)?;
        self.expect_state(SessionState::Confirming)?;
        self.validate_event_from_peer(event)?;
        let (mut code, request_id) = match self.decrypt_message(event)? {
            PairingMessage::CodeSubmit { code, request_id } => (code, request_id),
            other => return Err(unexpected("code-submit", &other)),
        };
        let candidate = (code.len() == 6 && code.bytes().all(|byte| byte.is_ascii_digit()))
            .then(|| code.parse::<u32>().ok())
            .flatten();
        code.zeroize();
        let correct = self
            .policy
            .guess(event.pubkey.to_bytes(), candidate)
            .ok_or(PairingError::SasMismatch)?;
        self.record_event(event);
        if correct {
            self.desktop_code = None;
            return self.source_proof().map(|proof| (proof, true));
        }
        let remaining_attempts = 5u8.saturating_sub(self.policy.guesses());
        // Exhaustion is terminal even if serializing the rejection fails.
        if remaining_attempts == 0 {
            self.desktop_code = None;
            self.policy.abort();
        }
        let rejection = self.build_event(&PairingMessage::CodeRejected {
            request_id,
            remaining_attempts,
        })?;
        Ok((rejection, false))
    }
}
