mod identity;
mod qr;
mod relay;

use buzz_pairing::{AbortReason, PairingSession, SessionState};
use buzz_pairing_policy::{Attempt, Completion, Native, Outcome, Release};
use futures_util::FutureExt;
use nostr_pairing::Event;
use serde::Serialize;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum Status {
    Connecting,
    Qr {
        svg: String,
        uri: String,
    },
    Code {
        code: String,
        #[serde(rename = "codeEntry")]
        code_entry: bool,
    },
    Transferring,
    Complete,
    Expired,
    Uncertain,
    Error {
        message: String,
    },
    Cancelled,
}
#[derive(Clone, Copy)]
enum Decision {
    Confirm,
    Deny,
}
struct Active {
    id: String,
    cancel: CancellationToken,
    confirm: mpsc::Sender<Decision>,
    finished: CancellationToken,
    status: Status,
}
#[derive(Default)]
struct Registry {
    active: Option<Active>,
    policy: Native,
    // Preserve possible delivery when a new attempt replaces the visible one.
    retired: std::collections::HashMap<String, Status>,
}
#[derive(Clone, Default)]
pub struct Pairing(Arc<Mutex<Registry>>);
fn status(outcome: Outcome, fallback: Status) -> Status {
    match outcome {
        Outcome::Cancelled => Status::Cancelled,
        Outcome::Uncertain => Status::Uncertain,
        Outcome::Complete => Status::Complete,
        Outcome::Expired => Status::Expired,
        _ => fallback,
    }
}
fn stop(registry: &mut Registry) -> Option<(CancellationToken, Status)> {
    let outcome = registry.policy.revoke();
    let active = registry.active.as_mut()?;
    active.cancel.cancel();
    active.status = status(outcome, active.status.clone());
    let stopped = (active.finished.clone(), active.status.clone());
    if active.status == Status::Cancelled {
        registry.active = None;
    }
    Some(stopped)
}
impl Pairing {
    pub fn cancel_all(&self) {
        stop(&mut self.0.lock().unwrap_or_else(|error| error.into_inner()));
    }
    pub(crate) fn close(&self) {
        let mut registry = self.0.lock().unwrap_or_else(|error| error.into_inner());
        registry.policy.close();
        stop(&mut registry);
    }
    fn admit(
        &self,
        active: Active,
        human: [u8; 32],
        community: Vec<u8>,
    ) -> Result<Attempt, String> {
        let mut registry = self
            .0
            .lock()
            .map_err(|_| "Pairing is unavailable. Restart Buzz.")?;
        if registry.retired.contains_key(&active.id)
            || registry
                .active
                .as_ref()
                .is_some_and(|old| old.id == active.id)
                && (registry.policy.has_release() || registry.policy.outcome() != Outcome::Pending)
        {
            return Err("Create a new pairing request before trying again.".into());
        }
        // Admit checks absorbing close and generation exhaustion before replacing.
        // Retiring first records the exact previous terminal/uncertain outcome.
        let previous = registry.policy.outcome();
        let released = registry.policy.has_release();
        let attempt = registry
            .policy
            .admit(human, community)
            .ok_or("Buzz is signing out or pairing is unavailable. Restart Buzz.")?;
        if let Some(old) = registry.active.take() {
            old.cancel.cancel();
            let terminal = status(
                if previous == Outcome::Pending {
                    if released {
                        Outcome::Uncertain
                    } else {
                        Outcome::Cancelled
                    }
                } else {
                    previous
                },
                old.status.clone(),
            );
            if matches!(
                terminal,
                Status::Uncertain | Status::Complete | Status::Expired | Status::Error { .. }
            ) {
                registry.retired.insert(old.id, terminal);
            }
        }
        registry.active = Some(active);
        Ok(attempt)
    }
    fn update(&self, attempt: &Attempt, next: Status) {
        if let Ok(mut registry) = self.0.lock() {
            if registry.policy.current(attempt) {
                if let Some(active) = registry.active.as_mut() {
                    active.status = next;
                }
            }
        }
    }
    fn bind_session(&self, attempt: &Attempt, session: &PairingSession) -> bool {
        self.0
            .lock()
            .is_ok_and(|mut registry| registry.policy.bind_session(attempt, session.session_id()))
    }
    /// Linearization point for a NEW grant. Clock, revocation and replacement
    /// checks run under the same mutex as cancellation and sign-out.
    fn release(
        &self,
        attempt: &Attempt,
        payload: &identity::Transfer,
        session: &PairingSession,
        deadline: tokio::time::Instant,
    ) -> Option<Release> {
        let mut registry = self.0.lock().ok()?;
        registry.policy.release(
            attempt,
            payload.proposal(),
            session.session_id(),
            session.peer()?.to_bytes(),
            tokio::time::Instant::now() < deadline,
        )
    }
    fn complete(&self, attempt: &Attempt, ack: &Completion) -> bool {
        let Ok(mut registry) = self.0.lock() else {
            return false;
        };
        if !registry
            .policy
            .finish(attempt, Some(ack), Outcome::Complete)
        {
            return false;
        }
        if let Some(active) = registry.active.as_mut() {
            active.status = Status::Complete;
        }
        true
    }
    fn expire(&self, attempt: &Attempt) {
        self.fail(attempt, Status::Expired, true);
    }
    fn fail(&self, attempt: &Attempt, failure: Status, ambiguous: bool) {
        if let Ok(mut registry) = self.0.lock() {
            let outcome = if failure == Status::Expired {
                Outcome::Expired
            } else if ambiguous {
                Outcome::Failed
            } else {
                Outcome::Rejected
            };
            if registry.policy.finish(attempt, None, outcome) {
                let next = status(registry.policy.outcome(), failure);
                if let Some(active) = registry.active.as_mut() {
                    active.status = next;
                }
            }
        }
    }
    async fn cancel(&self, id: &str) -> Result<Status, String> {
        let stopped = {
            let mut registry = self
                .0
                .lock()
                .map_err(|_| "Pairing is unavailable. Restart Buzz.")?;
            if registry.active.as_ref().is_some_and(|a| a.id == id) {
                stop(&mut registry)
            } else {
                return Ok(registry
                    .retired
                    .get(id)
                    .cloned()
                    .unwrap_or(Status::Cancelled));
            }
        };
        let Some((finished, status)) = stopped else {
            return Ok(Status::Cancelled);
        };
        tokio::time::timeout(Duration::from_secs(3), finished.cancelled())
            .await
            .map_err(|_| "Couldn’t cancel pairing. Close this window before trying again.")?;
        Ok(status)
    }
}

#[tauri::command]
pub async fn pairing_account(
    host: tauri::State<'_, crate::identity::IdentityHost>,
) -> Result<String, String> {
    host.with_key(|_, viewer| Ok(viewer.to_owned())).await
}
#[tauri::command]
pub fn pairing_status(pairing: tauri::State<'_, Pairing>, id: String) -> Result<Status, String> {
    let active = pairing
        .0
        .lock()
        .map_err(|_| "Pairing is unavailable. Restart Buzz.")?;
    Ok(active
        .active
        .as_ref()
        .filter(|a| a.id == id)
        .map(|a| a.status.clone())
        .unwrap_or_else(|| {
            active
                .retired
                .get(&id)
                .cloned()
                .unwrap_or(Status::Cancelled)
        }))
}
#[tauri::command]
pub async fn pairing_cancel(
    pairing: tauri::State<'_, Pairing>,
    id: String,
) -> Result<Status, String> {
    pairing.cancel(&id).await
}
fn decide(pairing: &Pairing, id: &str, decision: Decision) -> Result<(), String> {
    let mut active = pairing
        .0
        .lock()
        .map_err(|_| "Pairing is unavailable. Restart Buzz.")?;
    let active = active
        .active
        .as_mut()
        .filter(|a| {
            a.id == id
                && !a.cancel.is_cancelled()
                && matches!(
                    a.status,
                    Status::Code {
                        code_entry: false,
                        ..
                    }
                )
        })
        .ok_or("This comparison is no longer available.")?;
    active
        .confirm
        .try_send(decision)
        .map_err(|_| "A pairing decision is already in progress.")?;
    // Keep Code visible to the native owner until the bounded denial finishes.
    // The client holds its own "cancelling" display state while polling for the result.
    if matches!(decision, Decision::Confirm) {
        active.status = Status::Transferring;
    }
    Ok(())
}
#[tauri::command]
pub fn pairing_confirm(pairing: tauri::State<'_, Pairing>, id: String) -> Result<(), String> {
    decide(&pairing, &id, Decision::Confirm)
}
#[tauri::command]
pub fn pairing_deny(pairing: tauri::State<'_, Pairing>, id: String) -> Result<(), String> {
    decide(&pairing, &id, Decision::Deny)
}
#[tauri::command]
pub fn pairing_start(
    pairing: tauri::State<'_, Pairing>,
    host: tauri::State<'_, crate::identity::IdentityHost>,
    id: String,
    viewer: String,
    community: String,
) -> Result<(), String> {
    if id.len() != 36 || !id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') {
        return Err("Unsupported pairing request.".into());
    }
    if viewer.len() != 64 || !viewer.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Choose your Buzz account before pairing.".into());
    }
    let origin = relay::community(&community)?;
    let (tx, rx) = mpsc::channel(1);
    let cancel = CancellationToken::new();
    let finished = CancellationToken::new();
    let human = nostr_pairing::PublicKey::from_hex(&viewer)
        .map_err(|_| "Choose your Buzz account before pairing.")?
        .to_bytes();
    let attempt = pairing.admit(
        Active {
            id: id.clone(),
            cancel: cancel.clone(),
            finished: finished.clone(),
            confirm: tx,
            status: Status::Connecting,
        },
        human,
        origin.as_str().trim_end_matches('/').as_bytes().to_vec(),
    )?;
    let host = host.inner().clone();
    let pairing = pairing.inner().clone();
    tauri::async_runtime::spawn(async move {
        let result = guard(run(&pairing, &host, &attempt, viewer, origin, rx, &cancel)).await;
        match result {
            Ok(()) => {}
            Err(Failure::Expired) => pairing.expire(&attempt),
            Err(failure) => {
                let ambiguous = matches!(failure, Failure::Transport(_));
                let (Failure::Transport(message) | Failure::Rejected(message)) = failure else {
                    unreachable!()
                };
                pairing.fail(&attempt, Status::Error { message }, ambiguous);
            }
        }
        finished.cancel();
    });
    Ok(())
}

#[derive(Debug)]
enum Failure {
    Expired,
    Transport(String),
    Rejected(String),
}
impl From<String> for Failure {
    fn from(message: String) -> Self {
        Self::Transport(message)
    }
}
impl From<&str> for Failure {
    fn from(message: &str) -> Self {
        Self::Transport(message.into())
    }
}

async fn guard(
    future: impl std::future::Future<Output = Result<(), Failure>>,
) -> Result<(), Failure> {
    std::panic::AssertUnwindSafe(future)
        .catch_unwind()
        .await
        .unwrap_or_else(|_| {
            Err("Pairing stopped unexpectedly. Create a new code and try again.".into())
        })
}

async fn run(
    pairing: &Pairing,
    host: &crate::identity::IdentityHost,
    attempt: &Attempt,
    viewer: String,
    origin: url::Url,
    mut confirm: mpsc::Receiver<Decision>,
    cancel: &CancellationToken,
) -> Result<(), Failure> {
    let origin_string = origin.as_str().trim_end_matches('/').to_string();
    let payload = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Ok(()),
        result = identity::prepare(host, viewer, origin_string) => result?,
    };
    let setup = async {
        let relay_url = relay::discover(&origin).await?;
        let (session, qr) = PairingSession::new_source(relay_url.to_string());
        let connection_started = tokio::time::Instant::now();
        let mut socket = relay::connect(&relay_url, Duration::from_secs(10)).await?;
        let (pending, auth) = relay::subscribe(&mut socket, &session, &relay_url).await?;
        let uri = Zeroizing::new(buzz_pairing::qr::encode_qr(&qr));
        let svg = qr::render(&uri)?;
        Ok::<_, Failure>((
            Exchange {
                session,
                payload: Some(payload),
                code_entry: false,
            },
            socket,
            relay_url,
            pending,
            auth,
            svg,
            uri.to_string(),
            connection_started,
        ))
    };
    let (mut exchange, mut socket, relay_url, pending, mut auth, svg, uri, connection_started) = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Ok(()),
        result = tokio::time::timeout(Duration::from_secs(35), setup) =>
            result.map_err(|_| Failure::Transport("Pairing setup timed out. Check your connection and try again.".into()))??,
    };
    // Keep protocol expiry aligned with display, but renew before the transport cap.
    exchange.session.start_source_lifetime();
    if !pairing.bind_session(attempt, &exchange.session) {
        return Ok(());
    }
    let deadline = exchange_deadline(&exchange.session, connection_started);
    pairing.update(attempt, Status::Qr { svg, uri });
    exchange_until_deadline(
        ExchangeContext {
            pairing,
            attempt,
            deadline,
            relay_url: &relay_url,
            pending,
        },
        &mut exchange,
        &mut socket,
        &mut auth,
        &mut confirm,
        cancel,
    )
    .await
}

// The supported sidecar closes connections after 120 seconds. Start before the
// handshake and reserve five seconds so expiry wins over its disconnect. Setup
// consumes this budget; arbitrary transport failures still remain errors.
const CONNECTION_BUDGET: Duration = Duration::from_secs(115);

fn exchange_deadline(
    session: &PairingSession,
    connection_started: tokio::time::Instant,
) -> tokio::time::Instant {
    tokio::time::Instant::from_std(session.deadline()).min(connection_started + CONNECTION_BUDGET)
}

struct ExchangeContext<'a> {
    pairing: &'a Pairing,
    attempt: &'a Attempt,
    deadline: tokio::time::Instant,
    relay_url: &'a url::Url,
    pending: Vec<Event>,
}

async fn exchange_until_deadline(
    context: ExchangeContext<'_>,
    exchange: &mut Exchange,
    socket: &mut relay::Socket,
    auth: &mut relay::Authentication,
    confirm: &mut mpsc::Receiver<Decision>,
    cancel: &CancellationToken,
) -> Result<(), Failure> {
    let deadline = context.deadline;
    tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            // Once transfer construction has consumed the payload, publication may
            // already have reached the phone. An abort would interrupt its import.
            if exchange.payload.is_some() {
                abort(exchange, socket).await;
            }
            Ok(())
        }
        _ = tokio::time::sleep_until(deadline) => Err(Failure::Expired),
        result = exchange_loop(context, exchange, socket, auth, confirm) => result,
    }
}

// The same bounded best-effort notification serves explicit rejection and teardown.
async fn abort(exchange: &mut Exchange, socket: &mut relay::Socket) {
    if let Ok(Some(event)) = exchange.session.abort(AbortReason::UserDenied) {
        let _ = tokio::time::timeout(Duration::from_secs(2), relay::send(socket, &event)).await;
    }
}

async fn exchange_loop(
    context: ExchangeContext<'_>,
    exchange: &mut Exchange,
    socket: &mut relay::Socket,
    auth: &mut relay::Authentication,
    confirm: &mut mpsc::Receiver<Decision>,
) -> Result<(), Failure> {
    let ExchangeContext {
        pairing,
        attempt,
        deadline,
        relay_url,
        pending,
    } = context;
    let mut pending = std::collections::VecDeque::from(pending);
    loop {
        let output = if let Some(event) = pending.pop_front() {
            exchange.receive(&event).map_err(Failure::Rejected)?
        } else {
            loop {
                let output = tokio::select! {
                    Some(decision) = confirm.recv() => match decision {
                        Decision::Confirm => exchange.confirm().map_err(Failure::Rejected)?,
                        Decision::Deny => {
                            if exchange.code_entry || exchange.session.state() != SessionState::Confirming {
                                return Err(Failure::Rejected("This comparison is no longer available.".into()));
                            }
                            abort(exchange, socket).await;
                            return Err(Failure::Rejected("Pairing was canceled.".into()));
                        }
                    },
                    message = relay::next(socket) => {
                        let message = message?;
                        if auth.handle(socket, &exchange.session, relay_url, &message).await? { continue; }
                        if let Some(event) = relay::event(&message) {
                            exchange.receive(&event).map_err(Failure::Rejected)?
                        } else { continue; }
                    }
                };
                break output;
            }
        };
        for event in output.events {
            relay::send(socket, &event).await?;
            auth.retain_control(event);
        }
        if let Some(payload) = output.payload {
            let Some(release) = pairing.release(attempt, &payload, &exchange.session, deadline)
            else {
                if tokio::time::Instant::now() >= deadline {
                    return Err(Failure::Expired);
                }
                // Revoked/replaced workers may finish cleanup, but a current
                // provenance denial is a terminal source error.
                let current = pairing
                    .0
                    .lock()
                    .is_ok_and(|registry| registry.policy.current(attempt));
                if current {
                    return Err(Failure::Rejected(
                        "Couldn’t authorize the pairing transfer.".into(),
                    ));
                }
                abort(exchange, socket).await;
                return Ok(());
            };
            // Record possible delivery BEFORE awaiting the socket. Every replay
            // owns this same immutable grant and exact signed ciphertext bytes.
            auth.publish_payload(socket, payload.event().id.to_hex(), release)
                .await?;
        }
        if let Some(status) = output.status {
            if status == Status::Complete {
                let ack = exchange
                    .session
                    .completion()
                    .ok_or("Missing pairing acknowledgement.")?;
                pairing.complete(attempt, ack);
                return Ok(());
            }
            if let Status::Error { message } = status {
                return Err(Failure::Rejected(message));
            }
            pairing.update(attempt, status);
        }
    }
}

struct Exchange {
    session: PairingSession,
    payload: Option<identity::Prepared>,
    code_entry: bool,
}
#[derive(Default)]
struct Output {
    events: Vec<Event>,
    payload: Option<identity::Transfer>,
    status: Option<Status>,
}
impl Exchange {
    fn transfer(&mut self, proof: Event) -> Result<Output, String> {
        let payload = self
            .payload
            .take()
            .ok_or("This pairing code has already been used.")?;
        let event = payload.encrypt(&mut self.session)?;
        Ok(Output {
            events: vec![proof],
            payload: Some(event),
            status: Some(Status::Transferring),
        })
    }
    fn confirm(&mut self) -> Result<Output, String> {
        if self.code_entry {
            return Err("Enter the code on your phone to continue.".into());
        }
        let proof = self
            .session
            .confirm_sas()
            .map_err(|_| "This confirmation has expired. Try pairing again.")?;
        self.transfer(proof)
    }
    fn receive(&mut self, event: &Event) -> Result<Output, String> {
        if self.session.handle_abort(event).is_ok() {
            return Err("Pairing was cancelled on your phone. Try again when you’re ready.".into());
        }
        if let Ok((code, code_entry)) = self.session.handle_offer_with_confirmation(event) {
            self.code_entry = code_entry;
            let (code, events) = if code_entry {
                let (code, challenge) = self
                    .session
                    .start_desktop_code()
                    .map_err(|_| "Couldn’t create the desktop verification code.")?;
                (code, vec![challenge])
            } else {
                (code, vec![])
            };
            return Ok(Output {
                events,
                payload: None,
                status: Some(Status::Code { code, code_entry }),
            });
        }
        if self.code_entry && self.session.state() == SessionState::Confirming {
            if let Ok((reply, accepted)) = self.session.handle_target_code(event) {
                if accepted {
                    return self.transfer(reply);
                }
                let status =
                    (self.session.state() == SessionState::Aborted).then(|| Status::Error {
                        message: "Too many incorrect codes. Try pairing again.".into(),
                    });
                return Ok(Output {
                    events: vec![reply],
                    payload: None,
                    status,
                });
            } else if self.session.state() == SessionState::Aborted {
                return Err(
                    "Couldn’t verify the desktop code. Create a new pairing code and try again."
                        .into(),
                );
            }
        }

        match self.session.handle_complete(event) {
            Ok(()) => {
                return Ok(Output {
                    events: vec![],
                    payload: None,
                    status: Some(Status::Complete),
                })
            }
            Err(_) if self.session.state() == SessionState::Aborted => {
                return Err("Your phone couldn’t save the account. Try pairing again.".into())
            }
            Err(_) => {}
        }
        Ok(Output::default())
    }
}
#[cfg(test)]
mod tests;

#[cfg(test)]
mod relay_tests;
