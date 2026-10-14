//! The production decision owner. Crypto, parsing and I/O supply facts; they do
//! not authorize release. The same executable code is compiled by Cargo and Verus.
use vstd::prelude::*;

verus! {

pub type Key = [u8; 32];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Structural)]
pub enum Role { Source, Target }
#[derive(Debug, Clone, Copy, PartialEq, Eq, Structural)]
pub enum SessionState {
    Waiting, Confirming, AwaitingConfirmation, Transferring,
    PayloadExchanged, Completed, Aborted,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Structural)]
pub enum Approval { None, Legacy, Code, Target }

pub fn key_eq(a: &Key, b: &Key) -> (equal: bool)
    ensures equal == (a@ == b@),
{
    let mut i = 0usize;
    let mut equal = true;
    while i < 32
        invariant i <= 32,
            equal == (forall|j: int| 0 <= j < i ==> a@[j] == b@[j]),
        decreases 32 - i,
    {
        equal = equal && a[i] == b[i];
        i += 1;
    }
    proof { assert(a@ =~= b@ <==> equal);  }
    equal
}

/// An immutable authorization witness; only Protocol can construct one.
#[derive(Debug, Clone, Copy)]
pub struct AuthorizationView { pub session: Key, pub peer: Key, pub approval: Approval, pub guesses: u8, pub code_witness: Option<(u32, u32, u8)> }

#[derive(Clone, Copy)]
pub struct Authorization {
    session: Key,
    peer: Key,
    approval: Approval,
    guesses: u8,
    #[allow(dead_code)] // Erased proof witness; never read by ordinary Rust.
    code_witness: Ghost<Option<(u32, u32, u8)>>,
}
impl Authorization {
    pub closed spec fn view(&self) -> AuthorizationView { AuthorizationView { session: self.session, peer: self.peer, approval: self.approval, guesses: self.guesses, code_witness: self.code_witness@ } }

    #[verifier::type_invariant]
    pub closed spec fn valid(&self) -> bool {
        matches!(self.approval, Approval::Legacy)
            || (matches!(self.approval, Approval::Code) && 0 < self.guesses <= 5
                && self.code_witness@.is_some() && self.code_witness@.unwrap().0 == self.code_witness@.unwrap().1
                && self.code_witness@.unwrap().2 == self.guesses)
    }
    pub fn session(&self) -> (key: Key) ensures key@ == self.view().session@ { self.session }
    pub fn peer(&self) -> (key: Key) ensures key@ == self.view().peer@ { self.peer }
}

pub struct ProtocolView { pub role: Role, pub state: SessionState, pub session: Key, pub peer: Option<Key>, pub code_mode: bool, pub issued: bool, pub code: u32, pub guesses: u8, pub approval: Approval, pub code_witness: Option<(u32, u32, u8)> }

pub struct Protocol {
    role: Role,
    state: SessionState,
    session: Key,
    peer: Option<Key>,
    code_mode: bool,
    issued: bool,
    code: u32,
    guesses: u8,
    approval: Approval,
    code_witness: Ghost<Option<(u32, u32, u8)>>,
}
/// Common transition contract proved by every production mutator. It carries
/// terminal absorption, immutable peer/session, and nonrefundable budget through
/// arbitrary compositions, including failed adapters between calls.
pub open spec fn protocol_step(before: ProtocolView, after: ProtocolView) -> bool {
    before.role == after.role && before.session@ == after.session@
    && (before.peer.is_some() ==> after.peer.is_some() && before.peer.unwrap()@ == after.peer.unwrap()@)
    && after.guesses >= before.guesses && (before.issued ==> after.issued)
    && ((before.state == SessionState::Completed || before.state == SessionState::Aborted) ==> before == after)
}

pub proof fn protocol_trace_pair(trace: Seq<ProtocolView>, i: int, j: int)
    requires 0 <= i <= j < trace.len(),
        forall|k: int| 0 <= k < trace.len() - 1 ==> protocol_step(#[trigger] trace[k], trace[k + 1]),
    ensures trace[j].guesses >= trace[i].guesses,
        (trace[i].state == SessionState::Completed || trace[i].state == SessionState::Aborted) ==> trace[i] == trace[j],
    decreases j - i,
{
    if i < j {
        protocol_trace_pair(trace, i, j - 1);
        assert(protocol_step(trace[j - 1], trace[j]));
    }
}

pub proof fn protocol_trace(trace: Seq<ProtocolView>)
    requires trace.len() > 0,
        forall|k: int| 0 <= k < trace.len() - 1 ==> protocol_step(#[trigger] trace[k], trace[k + 1]),
    ensures forall|i: int, j: int| #![trigger trace[i], trace[j]]
        0 <= i <= j < trace.len() ==> trace[j].guesses >= trace[i].guesses
            && ((trace[i].state == SessionState::Completed || trace[i].state == SessionState::Aborted) ==> trace[i] == trace[j]),
{
    assert forall|i: int, j: int| #![trigger trace[i], trace[j]]
        0 <= i <= j < trace.len() implies trace[j].guesses >= trace[i].guesses
            && ((trace[i].state == SessionState::Completed || trace[i].state == SessionState::Aborted) ==> trace[i] == trace[j]) by {
        protocol_trace_pair(trace, i, j);
    }
}

// Coupled fields change atomically with respect to the owning type invariant.
fn enter_transfer(state: &mut SessionState, approval: &mut Approval, authorized: Approval)
    ensures *final(state) == SessionState::Transferring, *final(approval) == authorized,
    no_unwind
{
    *approval = authorized;
    *state = SessionState::Transferring;
}

impl Protocol {
    pub closed spec fn view(&self) -> ProtocolView { ProtocolView { role: self.role, state: self.state, session: self.session, peer: self.peer, code_mode: self.code_mode, issued: self.issued, code: self.code, guesses: self.guesses, approval: self.approval, code_witness: self.code_witness@ } }

    #[verifier::type_invariant]
    pub closed spec fn invariant(&self) -> bool {
        self.guesses <= 5
        && (matches!(self.state, SessionState::Waiting | SessionState::Confirming | SessionState::AwaitingConfirmation) ==> matches!(self.approval, Approval::None))
        && (matches!(self.approval, Approval::Legacy) ==> !self.code_mode && matches!(self.role, Role::Source))
        && (matches!(self.approval, Approval::Code) ==> self.code_mode && self.issued
            && 0 < self.guesses <= 5 && matches!(self.role, Role::Source)
            && self.code_witness@ == Some((self.code, self.code, self.guesses)))
        && (matches!(self.approval, Approval::Target) ==> matches!(self.role, Role::Target))
        && (matches!(self.state, SessionState::Transferring) || matches!(self.state, SessionState::PayloadExchanged)
            || matches!(self.state, SessionState::Completed) ==> !(matches!(self.approval, Approval::None)))
        && (!(matches!(self.approval, Approval::None)) ==> self.peer.is_some())
    }
    pub fn source(session: Key) -> (p: Self)
        ensures p.invariant(), p.view().state == SessionState::Waiting,
    {
        Self { role: Role::Source, state: SessionState::Waiting, session,
            peer: None, code_mode: false, issued: false, code: 0, guesses: 0,
            approval: Approval::None, code_witness: Ghost(None) }
    }
    pub fn target(session: Key, peer: Key) -> (p: Self)
        ensures p.invariant(), p.view().state == SessionState::Confirming,
    {
        Self { role: Role::Target, state: SessionState::Confirming, session,
            peer: Some(peer), code_mode: false, issued: false, code: 0, guesses: 0,
            approval: Approval::None, code_witness: Ghost(None) }
    }
    pub fn state(&self) -> (s: SessionState) ensures s == self.view().state { self.state }
    pub fn role(&self) -> (r: Role) ensures r == self.view().role { self.role }
    pub fn guesses(&self) -> (n: u8) ensures n == self.view().guesses { self.guesses }
    pub fn accepts_peer(&self, peer: &Key) -> (ok: bool)
        ensures ok == (self.view().peer.is_some() && self.view().peer.unwrap()@ == peer@),
    {
        match &self.peer { Some(expected) => key_eq(expected, peer), None => false }
    }
    pub fn offer(&mut self, session: Key, peer: Key, code_mode: bool) -> (ok: bool)
        ensures protocol_step(old(self).view(), final(self).view()),
            old(self).invariant() ==> final(self).invariant(),
            ok ==> final(self).view().peer.is_some() && final(self).view().peer.unwrap()@ == peer@ && final(self).view().session@ == session@
                && final(self).view().state == SessionState::Confirming && final(self).view().approval == Approval::None,
            !ok ==> *final(self) == *old(self),
    {
        proof { use_type_invariant(&*self); }
        if !(matches!(self.role, Role::Source)) || !(matches!(self.state, SessionState::Waiting))
            || self.peer.is_some() || !key_eq(&self.session, &session) { return false; }
        self.peer = Some(peer);
        self.approval = Approval::None;
        self.code_mode = code_mode;
        self.state = SessionState::Confirming;
        true
    }
    pub fn issue(&mut self, code: u32) -> (ok: bool)
        ensures protocol_step(old(self).view(), final(self).view()),
            old(self).invariant() ==> final(self).invariant(),
            ok ==> !old(self).view().issued && final(self).view().issued && final(self).view().guesses == old(self).view().guesses,
            !ok ==> *final(self) == *old(self),
    {
        proof { use_type_invariant(&*self); }
        if !(matches!(self.role, Role::Source)) || !(matches!(self.state, SessionState::Confirming))
            || !self.code_mode || self.issued || code >= 1_000_000 { return false; }
        self.issued = true;
        self.code = code;
        true
    }
    pub fn legacy(&mut self) -> (ok: bool)
        ensures protocol_step(old(self).view(), final(self).view()),
            old(self).invariant() ==> final(self).invariant(),
            ok ==> !final(self).view().code_mode && final(self).view().approval == Approval::Legacy
                && final(self).view().state == SessionState::Transferring,
            !ok ==> *final(self) == *old(self),
    {
        proof { use_type_invariant(&*self); }
        if !(matches!(self.role, Role::Source)) || !(matches!(self.state, SessionState::Confirming))
            || self.code_mode || self.peer.is_none() { return false; }
        enter_transfer(&mut self.state, &mut self.approval, Approval::Legacy);
        true
    }
    /// Parsed authenticated submission from the locked peer. A malformed code
    /// still consumes a guess. Construction failures cannot refund this operation.
    pub fn guess(&mut self, peer: Key, candidate: Option<u32>) -> (result: Option<bool>)
        ensures protocol_step(old(self).view(), final(self).view()),
            old(self).invariant() ==> final(self).invariant(),
            result.is_some() ==> final(self).view().guesses == old(self).view().guesses + 1 && final(self).view().guesses <= 5,
            result == Some(true) ==> final(self).view().approval == Approval::Code && final(self).view().issued
                && candidate == Some(old(self).view().code) && final(self).view().peer.is_some() && final(self).view().peer.unwrap()@ == peer@
                && final(self).view().state == SessionState::Transferring,
            result == Some(false) && final(self).view().guesses == 5 ==> final(self).view().state == SessionState::Aborted,
            result.is_none() ==> *final(self) == *old(self),
    {
        proof { use_type_invariant(&*self); }
        if !(matches!(self.role, Role::Source)) || !(matches!(self.state, SessionState::Confirming))
            || !self.code_mode || !self.issued || self.guesses >= 5
            || !self.accepts_peer(&peer) { return None; }
        self.guesses += 1;
        if candidate.is_some() && candidate.unwrap() == self.code {
            self.code_witness = Ghost(Some((self.code, candidate.unwrap(), self.guesses)));
            enter_transfer(&mut self.state, &mut self.approval, Approval::Code);
            Some(true)
        } else {
            if self.guesses == 5 { self.state = SessionState::Aborted; }
            Some(false)
        }
    }
    pub fn transcript(&mut self, peer: Key, matches: bool) -> (ok: bool)
        ensures protocol_step(old(self).view(), final(self).view()),
            old(self).invariant() ==> final(self).invariant(),
            ok ==> final(self).view().state == SessionState::AwaitingConfirmation && matches,
    {
        proof { use_type_invariant(&*self); }
        if !(matches!(self.role, Role::Target)) || !(matches!(self.state, SessionState::Confirming))
            || !self.accepts_peer(&peer) { return false; }
        self.state = if matches { SessionState::AwaitingConfirmation } else { SessionState::Aborted };
        matches
    }
    pub fn approve_target(&mut self) -> (ok: bool)
        ensures protocol_step(old(self).view(), final(self).view()),
            old(self).invariant() ==> final(self).invariant(),
            ok ==> final(self).view().state == SessionState::Transferring && final(self).view().approval == Approval::Target,
    {
        proof { use_type_invariant(&*self); }
        if !(matches!(self.role, Role::Target)) || !(matches!(self.state, SessionState::AwaitingConfirmation))
            || self.peer.is_none() { return false; }
        enter_transfer(&mut self.state, &mut self.approval, Approval::Target);
        true
    }
    /// Consume source authorization exactly once, before fallible encryption.
    pub fn payload(&mut self) -> (auth: Option<Authorization>)
        ensures protocol_step(old(self).view(), final(self).view()),
            old(self).invariant() ==> final(self).invariant(),
            auth.is_some() ==> auth.unwrap().valid()
                && auth.unwrap().view().approval == old(self).view().approval
                && auth.unwrap().view().guesses == old(self).view().guesses
                && auth.unwrap().view().code_witness == old(self).view().code_witness
                && auth.unwrap().view().session@ == final(self).view().session@
                && final(self).view().peer.is_some() && final(self).view().peer.unwrap()@ == auth.unwrap().view().peer@
                && final(self).view().state == SessionState::PayloadExchanged,
            old(self).view().state != SessionState::Transferring ==> auth.is_none(),
    {
        proof { use_type_invariant(&*self); }
        if !(matches!(self.role, Role::Source)) || !(matches!(self.state, SessionState::Transferring))
            || self.peer.is_none()
            || !(matches!(self.approval, Approval::Legacy) && !self.code_mode
                || matches!(self.approval, Approval::Code) && self.code_mode && self.issued
                    && self.guesses > 0 && self.guesses <= 5) { return None; }
        self.state = SessionState::PayloadExchanged;
        Some(Authorization { session: self.session, peer: self.peer.unwrap(),
            approval: self.approval, guesses: self.guesses, code_witness: Ghost(self.code_witness@) })
    }
    /// Both target receipt and the existing source reverse-flow receipt.
    pub fn receive_payload(&mut self, peer: Key) -> (ok: bool)
        ensures protocol_step(old(self).view(), final(self).view()),
            old(self).invariant() ==> final(self).invariant(),
            ok ==> final(self).view().state == SessionState::PayloadExchanged && final(self).view().peer.is_some() && final(self).view().peer.unwrap()@ == peer@,
    {
        proof { use_type_invariant(&*self); }
        if !(matches!(self.state, SessionState::Transferring)) || !self.accepts_peer(&peer) { return false; }
        self.state = SessionState::PayloadExchanged;
        true
    }
    pub fn complete(&mut self, peer: Key, success: bool) -> (ok: bool)
        ensures protocol_step(old(self).view(), final(self).view()),
            old(self).invariant() ==> final(self).invariant(),
            ok ==> old(self).view().peer.is_some() && old(self).view().peer.unwrap()@ == peer@
                && final(self).view().peer.is_some() && final(self).view().peer.unwrap()@ == peer@ && old(self).view().state == SessionState::PayloadExchanged
                && (final(self).view().state == SessionState::Completed <==> success),
    {
        proof { use_type_invariant(&*self); }
        if !(matches!(self.state, SessionState::PayloadExchanged)) || !self.accepts_peer(&peer) { return false; }
        self.state = if success { SessionState::Completed } else { SessionState::Aborted };
        true
    }
    /// Revocation is committed before best-effort notification. Terminal states
    /// are absorbing, including when the notification adapter fails.
    /// Only the received source-side success path creates this witness.
    pub fn acknowledge(&mut self, peer: Key) -> (ack: Option<Completion>)
        ensures protocol_step(old(self).view(), final(self).view()),
            old(self).invariant() ==> final(self).invariant(),
            ack.is_some() ==> old(self).view().role == Role::Source
                && old(self).view().state == SessionState::PayloadExchanged
                && old(self).view().peer.is_some() && old(self).view().peer.unwrap()@ == peer@
                && ack.unwrap().view().session == final(self).view().session@
                && ack.unwrap().view().peer == peer@ && final(self).view().state == SessionState::Completed,
    {
        proof { use_type_invariant(&*self); }
        if !matches!(self.role, Role::Source) || !self.complete(peer, true) { return None; }
        Some(Completion { session: self.session, peer })
    }
    pub fn abort(&mut self) -> (changed: bool)
        ensures protocol_step(old(self).view(), final(self).view()),
            old(self).invariant() ==> final(self).invariant(),
            changed ==> final(self).view().state == SessionState::Aborted,
            !changed ==> *final(self) == *old(self),
    {
        proof { use_type_invariant(&*self); }
        if matches!(self.state, SessionState::Completed) || matches!(self.state, SessionState::Aborted) { return false; }
        self.state = SessionState::Aborted;
        true
    }
}

pub fn bytes_eq(a: &[u8], b: &[u8]) -> (equal: bool)
    ensures equal == (a@ == b@),
{
    if a.len() != b.len() { return false; }
    let mut i = 0usize;
    while i < a.len()
        invariant a.len() == b.len(), i <= a.len(),
            forall|j: int| 0 <= j < i ==> a@[j] == b@[j],
        decreases a.len() - i,
    {
        if a[i] != b[i] { return false; }
        i += 1;
    }
    proof { assert(a@ =~= b@); }
    true
}

/// Native-owned freshness, independent of the renderer's display ID.
pub struct Attempt {
    generation: u64,
    human: Key,
    community: Vec<u8>,
}
pub struct AttemptView { pub generation: u64, pub human: Seq<u8>, pub community: Seq<u8> }
impl Attempt {
    pub closed spec fn view(&self) -> AttemptView {
        AttemptView { generation: self.generation, human: self.human@, community: self.community@ }
    }
    pub fn duplicate(&self) -> (a: Self) ensures a.view() == self.view() {
        Self { generation: self.generation, human: self.human, community: self.community.clone() }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Structural)]
pub enum Outcome { Pending, Cancelled, Uncertain, Complete, Rejected, Failed, Expired }

pub struct IdentityBinding { human: Key, community: Vec<u8> }
pub struct IdentityBindingView { pub human: Seq<u8>, pub community: Seq<u8> }
impl IdentityBinding {
    pub closed spec fn view(&self) -> IdentityBindingView { IdentityBindingView { human: self.human@, community: self.community@ } }
    pub fn matches(&self, human: Key, community: &[u8]) -> (ok: bool)
        ensures ok == (self.view().human == human@ && self.view().community == community@),
    { key_eq(&self.human, &human) && bytes_eq(&self.community, community) }
    pub fn duplicate(&self) -> (b: Self) ensures b.view() == self.view() {
        Self { human: self.human, community: self.community.clone() }
    }
}
/// The crypto/serialization adapter seals its exact output with the input's
/// custody binding and the protocol's authorization. Policy checks that tuple.
pub struct PayloadProposal { binding: IdentityBinding, authorization: Authorization, bytes: Vec<u8> }
pub struct PayloadProposalView { pub binding: IdentityBindingView, pub authorization: AuthorizationView, pub bytes: Seq<u8> }
impl PayloadProposal {
    pub closed spec fn valid(&self) -> bool { self.authorization.valid() }
    pub closed spec fn view(&self) -> PayloadProposalView {
        PayloadProposalView { binding: self.binding.view(), authorization: self.authorization.view(), bytes: self.bytes@ }
    }
    pub fn encrypted(binding: IdentityBinding, authorization: Authorization, bytes: Vec<u8>) -> (p: Self)
        ensures p.view().binding == binding.view() && p.view().authorization == authorization.view() && p.view().bytes == bytes@,
    { Self { binding, authorization, bytes } }
}

/// Immutable admitted bytes and provenance, retained for every socket replay.
/// No public constructor and no mutable access to either authorization or bytes.
pub struct Release {
    #[allow(dead_code)] // Erased provenance for the release/replay proof.
    attempt: Ghost<AttemptView>,
    #[allow(dead_code)] // Runtime authorization remains in Native for acknowledgement.
    authorization: Ghost<AuthorizationView>,
    bytes: Vec<u8>,
}
pub struct ReleaseView {
    pub attempt: AttemptView, pub authorization: AuthorizationView, pub bytes: Seq<u8>,
}
impl Release {
    pub closed spec fn view(&self) -> ReleaseView {
        ReleaseView { attempt: self.attempt@, authorization: self.authorization@, bytes: self.bytes@ }
    }
    pub fn frame(&self) -> (bytes: Vec<u8>) ensures bytes@ == self.view().bytes { self.bytes.clone() }
}

/// All admission/revocation operations run under the native registry's mutex.
/// Clock adapter supplies `live` at this operation's linearization point.
pub struct Completion { session: Key, peer: Key }
pub struct CompletionView { pub session: Seq<u8>, pub peer: Seq<u8> }
impl Completion {
    pub closed spec fn view(&self) -> CompletionView { CompletionView { session: self.session@, peer: self.peer@ } }
}

pub struct Native {
    generation: u64,
    closed: bool,
    active: Option<Attempt>,
    revoked: bool,
    released: bool,
    outcome: Outcome,
    authorization: Option<Authorization>,
    session: Option<Key>,
    #[allow(dead_code)]
    admitted_bytes: Ghost<Option<Seq<u8>>>,
}
pub struct NativeView {
    pub generation: u64, pub closed: bool, pub active: Option<AttemptView>,
    pub revoked: bool, pub released: bool, pub outcome: Outcome, pub authorization: Option<AuthorizationView>, pub session: Option<Key>, pub admitted_bytes: Option<Seq<u8>>,
}
/// Proven by every native mutator, including rejection/no-op paths. A generation
/// cannot refund its release right, alter its admitted frame, or reopen revocation.
pub open spec fn native_step(before: NativeView, after: NativeView) -> bool {
    before.generation <= after.generation
    && (before.closed ==> after.closed)
    && (before.generation == after.generation ==> (
        before.active == after.active
        && (before.session.is_some() ==> before.session == after.session)
        && (before.revoked ==> after.revoked)
        && (before.released ==> after.released && before.authorization == after.authorization
            && before.admitted_bytes == after.admitted_bytes)
        && (before.outcome != Outcome::Pending ==> before.outcome == after.outcome)))
}

pub proof fn native_trace_pair(trace: Seq<NativeView>, i: int, j: int)
    requires 0 <= i <= j < trace.len(),
        forall|k: int| 0 <= k < trace.len() - 1 ==> native_step(#[trigger] trace[k], trace[k + 1]),
    ensures trace[i].generation <= trace[j].generation,
        trace[i].closed ==> trace[j].closed,
        trace[i].generation == trace[j].generation && trace[i].released ==>
            trace[j].released && trace[i].authorization == trace[j].authorization
                && trace[i].admitted_bytes == trace[j].admitted_bytes,
        trace[i].generation == trace[j].generation && trace[i].revoked ==> trace[j].revoked,
    decreases j - i,
{
    if i < j {
        native_trace_pair(trace, i, j - 1);
        assert(native_step(trace[j - 1], trace[j]));
    }
}

/// All distinct grants in a production trace satisfy Native::release's
/// postcondition. Two grants for one generation contradict its nonrefundable right.
pub proof fn single_grant(trace: Seq<NativeView>, i: int, j: int)
    requires 0 <= i < j < trace.len() - 1,
        forall|k: int| 0 <= k < trace.len() - 1 ==> native_step(#[trigger] trace[k], trace[k + 1]),
        trace[i].generation == trace[i + 1].generation,
        !trace[i].released, trace[i + 1].released,
        trace[j].generation == trace[i].generation,
    ensures trace[j].released,
{
    native_trace_pair(trace, i + 1, j);
}

impl Native {
    pub closed spec fn view(&self) -> NativeView {
        NativeView { generation: self.generation, closed: self.closed,
            active: match &self.active { Some(a) => Some(a.view()), None => None },
            revoked: self.revoked, released: self.released, outcome: self.outcome,
            authorization: match self.authorization { Some(a) => Some(a.view()), None => None }, session: self.session, admitted_bytes: self.admitted_bytes@ }
    }
    pub closed spec fn invariant(&self) -> bool {
        (self.active.is_some() ==> self.active.unwrap().generation == self.generation && self.generation > 0)
        && (self.released ==> self.active.is_some() && self.authorization.is_some() && self.session.is_some() && self.admitted_bytes@.is_some()
            && self.authorization.unwrap().valid() && self.authorization.unwrap().view().session@ == self.session.unwrap()@)
        && (self.outcome == Outcome::Cancelled ==> !self.released)
        && (self.outcome == Outcome::Complete ==> self.released)
        && (self.closed ==> self.revoked)
    }
    pub fn new() -> (n: Self) ensures n.invariant(), !n.view().closed, n.view().generation == 0 {
        Self { generation: 0, closed: false, active: None, revoked: true,
            released: false, outcome: Outcome::Cancelled, authorization: None, session: None, admitted_bytes: Ghost(None) }
    }
    pub fn admit(&mut self, human: Key, community: Vec<u8>) -> (a: Option<Attempt>)
        ensures native_step(old(self).view(), final(self).view()),
            old(self).invariant() ==> final(self).invariant(),
            a.is_some() ==> !old(self).view().closed
                && a.unwrap().view().generation > old(self).view().generation
                && final(self).view().active == Some(a.unwrap().view())
                && a.unwrap().view().human == human@ && a.unwrap().view().community == community@,
            a.is_none() ==> *final(self) == *old(self),
    {
        if self.closed || self.generation == u64::MAX { return None; }
        self.generation += 1;
        let attempt = Attempt { generation: self.generation, human, community };
        self.active = Some(attempt.duplicate());
        self.revoked = false;
        self.released = false;
        self.authorization = None;
        self.admitted_bytes = Ghost(None);
        self.session = None;
        self.outcome = Outcome::Pending;
        Some(attempt)
    }
    pub fn current(&self, attempt: &Attempt) -> (ok: bool)
        ensures ok == (self.view().active == Some(attempt.view()) && !self.view().revoked && !self.view().closed),
    {
        if self.closed || self.revoked { return false; }
        match &self.active {
            Some(active) => active.generation == attempt.generation
                && key_eq(&active.human, &attempt.human)
                && bytes_eq(&active.community, &attempt.community),
            None => false,
        }
    }
    pub fn bind_session(&mut self, attempt: &Attempt, session: Key) -> (ok: bool)
        ensures native_step(old(self).view(), final(self).view()),
            old(self).invariant() ==> final(self).invariant(),
            ok ==> old(self).view().session.is_none() && final(self).view().session == Some(session),
            !ok ==> *final(self) == *old(self),
    {
        if !self.current(attempt) || self.session.is_some() { return false; }
        self.session = Some(session);
        true
    }
    pub fn has_release(&self) -> (released: bool) ensures released == self.view().released { self.released }
    /// First admission consumes the distinct-transfer right. `authorization`
    /// comes from the actual Protocol; bytes come from its encryption adapter.
    pub fn release(&mut self, attempt: &Attempt, proposal: PayloadProposal,
        session: Key, peer: Key, live: bool) -> (r: Option<Release>)
        ensures native_step(old(self).view(), final(self).view()),
            old(self).invariant() ==> final(self).invariant(),
            r.is_some() ==> !old(self).view().closed && !old(self).view().revoked
                && !old(self).view().released && old(self).view().outcome == Outcome::Pending
                && live && proposal.valid()
                && r.unwrap().view().attempt == attempt.view()
                && old(self).view().active == Some(attempt.view())
                && r.unwrap().view().authorization == proposal.view().authorization
                && old(self).view().session.is_some() && old(self).view().session.unwrap()@ == session@
                && proposal.view().authorization.session@ == session@
                && proposal.view().authorization.peer@ == peer@
                && r.unwrap().view().bytes == proposal.view().bytes
                && proposal.view().binding.human == attempt.view().human
                && proposal.view().binding.community == attempt.view().community && final(self).view().released
                && final(self).view().authorization == Some(r.unwrap().view().authorization)
                && final(self).view().admitted_bytes == Some(r.unwrap().view().bytes),
            r.is_none() ==> *final(self) == *old(self),
    {
        proof { use_type_invariant(&proposal.authorization); }
        let authorization = proposal.authorization;
        let valid = matches!(authorization.approval, Approval::Legacy)
            || matches!(authorization.approval, Approval::Code) && authorization.guesses > 0 && authorization.guesses <= 5;
        if !self.current(attempt) || self.released || !live
            || !matches!(self.outcome, Outcome::Pending) || !valid
            || !key_eq(&attempt.human, &proposal.binding.human)
            || !bytes_eq(&attempt.community, &proposal.binding.community)
            || self.session.is_none() || !key_eq(&self.session.unwrap(), &session)
            || !key_eq(&authorization.session, &session) || !key_eq(&authorization.peer, &peer) { return None; }
        self.released = true;
        self.authorization = Some(authorization);
        self.admitted_bytes = Ghost(Some(proposal.bytes@));
        Some(Release { attempt: Ghost(attempt.view()), authorization: Ghost(authorization.view()), bytes: proposal.bytes })
    }
    pub fn revoke(&mut self) -> (outcome: Outcome)
        ensures native_step(old(self).view(), final(self).view()),
            old(self).invariant() ==> final(self).invariant(),
            final(self).view().revoked, outcome == final(self).view().outcome,
            old(self).invariant() && old(self).view().released ==> outcome != Outcome::Cancelled,
    {
        self.revoked = true;
        if matches!(self.outcome, Outcome::Pending) {
            self.outcome = if self.released { Outcome::Uncertain } else { Outcome::Cancelled };
        }
        self.outcome
    }
    pub fn close(&mut self)
        ensures native_step(old(self).view(), final(self).view()),
            old(self).invariant() ==> final(self).invariant(),
            final(self).view().closed && final(self).view().revoked,
            old(self).invariant() && old(self).view().released ==> final(self).view().outcome != Outcome::Cancelled,
    {
        self.revoke();
        self.closed = true;
    }
    /// A validated completion is bound to the admitted payload's locked peer.
    /// Transport failures and expiry preserve possible delivery.
    pub fn finish(&mut self, attempt: &Attempt, acknowledgement: Option<&Completion>, outcome: Outcome) -> (ok: bool)
        ensures native_step(old(self).view(), final(self).view()),
            old(self).invariant() ==> final(self).invariant(),
            ok && final(self).view().outcome == Outcome::Complete ==> old(self).view().released
                && acknowledgement.is_some() && old(self).view().authorization.is_some()
                && acknowledgement.unwrap().view().session == old(self).view().authorization.unwrap().session@
                && acknowledgement.unwrap().view().peer == old(self).view().authorization.unwrap().peer@,
            old(self).view().outcome != Outcome::Pending ==> !ok,
    {
        if !self.current(attempt) || !matches!(self.outcome, Outcome::Pending) { return false; }
        if matches!(outcome, Outcome::Complete) {
            if !self.released { return false; }
            match (acknowledgement, &self.authorization) {
                (Some(ack), Some(auth)) => {
                    if !key_eq(&auth.session, &ack.session) || !key_eq(&auth.peer, &ack.peer) { return false; }
                }
                _ => return false,
            }
        }
        self.outcome = match outcome {
            Outcome::Complete => Outcome::Complete,
            Outcome::Rejected => Outcome::Rejected,
            _ => if self.released { Outcome::Uncertain } else { outcome },
        };
        self.revoked = true;
        true
    }
    pub fn outcome(&self) -> (o: Outcome) ensures o == self.view().outcome { self.outcome }
}

impl Default for Native {
    fn default() -> (n: Self)
        ensures n.invariant(), !n.view().closed, n.view().generation == 0,
    { Self::new() }
}

/// Identity state owns the key, rather than mirroring another Ready/Closed flag.
/// Store adapters only install a candidate after successful read/parse or persist.
pub enum Custody<K> { Unread, Missing, Ready(K), Closed }
impl<K> Custody<K> {
    pub fn pairing_binding(&self, actual: Key, requested: Key, community: Vec<u8>) -> (binding: Option<IdentityBinding>)
        ensures binding.is_some() ==> matches!(self, Custody::Ready(_))
            && actual@ == requested@ && binding.unwrap().view().human == actual@
            && binding.unwrap().view().community == community@,
    {
        if !matches!(self, Custody::Ready(_)) || !key_eq(&actual, &requested) { return None; }
        Some(IdentityBinding { human: actual, community })
    }
    pub fn restore(&mut self, candidate: Option<K>, valid: bool) -> (ok: bool)
        ensures matches!(old(self), Custody::Closed) ==> !ok && (*final(self) is Closed),
            !valid ==> *final(self) == *old(self),
            ok ==> !(*final(self) is Unread || *final(self) is Closed),
    {
        if !valid || !matches!(self, Custody::Unread) { return false; }
        *self = match candidate { Some(key) => Custody::Ready(key), None => Custody::Missing };
        true
    }
    pub fn save(&mut self, candidate: K, persisted: bool) -> (ok: bool)
        ensures ok ==> persisted && matches!(old(self), Custody::Missing) && (*final(self) is Ready),
            !ok ==> *final(self) == *old(self),
    {
        if !persisted || !matches!(self, Custody::Missing) { return false; }
        *self = Custody::Ready(candidate);
        true
    }
    pub fn close(&mut self) ensures (*final(self) is Closed) { *self = Custody::Closed; }
}
}
