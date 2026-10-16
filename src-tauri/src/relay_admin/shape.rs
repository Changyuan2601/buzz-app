//! Success shapes per route, mirroring beta's admin DTOs (`contract.ts`
//! `StaffResults`). A 2xx is only a success if its body has the shape that
//! route's handler returns; extra fields are tolerated, missing or unknown
//! values are not.

#![allow(dead_code)] // Fields exist to be checked, not read.

use super::route::{FeedbackStatus, ReportAction, ReportStatus, Role, StaffRequest};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Source {
    Config,
    OwnerFallback,
    Db,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum AuthMode {
    Nip98,
    Disabled,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum ProbeStatus {
    Ok,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Probe {
    status: ProbeStatus,
    auth_mode: AuthMode,
    role: Option<Role>,
    source: Option<Source>,
    can_act: bool,
    can_staff: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum ActionStatus {
    Pending,
    Enforcing,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActionRecord {
    id: String,
    request_id: String,
    actor_pubkey: String,
    actor_role: Role,
    action: ReportAction,
    status: ActionStatus,
    reason: Option<String>,
    expires_at: Option<String>,
    error_message: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    id: String,
    community_id: String,
    community_host: String,
    report_event_id: String,
    reporter_pubkey: String,
    target_kind: String,
    target: String,
    report_type: String,
    target_author_pubkey: Option<String>,
    channel_id: Option<String>,
    note: Option<String>,
    status: ReportStatus,
    resolved_by: Option<String>,
    resolved_at: Option<String>,
    action_id: Option<String>,
    active_action: Option<ActionRecord>,
    created_at: String,
    /// Only on `GET /reports/{id}`; checked whenever present.
    message: Option<ReportMessage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReportMessage {
    author_pubkey: String,
    content: String,
    created_at: String,
    deleted_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Resolution {
    status: ReportStatus,
    active_action: Option<ActionRecord>,
}

/// Cancelling a failed enforcement reopens the report and returns the
/// cancelled record.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cancelled {
    status: Reopened,
    active_action: ActionRecord,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Reopened {
    Open,
}

#[derive(Deserialize)]
struct Reopen {
    status: Reopened,
}

#[derive(Deserialize)]
struct FeedbackState {
    status: FeedbackStatus,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FeedbackSummary {
    id: String,
    community_id: Option<String>,
    community_host: Option<String>,
    submitter_pubkey: String,
    category: Option<String>,
    body_summary: String,
    status: FeedbackStatus,
    received_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Feedback {
    id: String,
    community_id: Option<String>,
    community_host: Option<String>,
    event_id: String,
    submitter_pubkey: String,
    category: Option<String>,
    body: String,
    status: FeedbackStatus,
    event_created_at: String,
    received_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Operator {
    pubkey: String,
    effective_role: Role,
    sources: Vec<Source>,
}

#[derive(Deserialize)]
struct Deleted {
    deleted: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Restriction {
    pubkey: String,
    banned: bool,
    ban_expires_at: Option<String>,
    ban_reason: Option<String>,
    muted_until: Option<String>,
    mute_reason: Option<String>,
    actor_pubkey: String,
    updated_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page<T> {
    items: Vec<T>,
    next_cursor: Option<String>,
}

#[derive(Deserialize)]
struct Items<T> {
    items: Vec<T>,
}

#[derive(Deserialize)]
struct Community {
    id: String,
    host: String,
    icon: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Member {
    pubkey: String,
    display_name: Option<String>,
    nip05: Option<String>,
    avatar_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    display_name: Option<String>,
    nip05: Option<String>,
    avatar_url: Option<String>,
    about: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum CommunityRole {
    Owner,
    Admin,
    Member,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemberDetail {
    pubkey: String,
    profile: Option<Profile>,
    role: Option<CommunityRole>,
    banned: bool,
    muted_until: Option<String>,
    is_staff: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventPreview {
    id: String,
    author_pubkey: String,
    kind: u64,
    content: String,
    created_at: String,
    deleted_at: Option<String>,
    channel_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "state", rename_all = "lowercase")]
enum DirectAction {
    #[serde(rename_all = "camelCase")]
    Succeeded { action_id: String, replayed: bool },
    #[serde(rename_all = "camelCase")]
    Pending { action_id: String, replayed: bool },
}

fn is<T: DeserializeOwned>(value: &Value) -> bool {
    T::deserialize(value).is_ok()
}

/// Whether `body` (`None` when empty) is a success for `request`.
pub(super) fn valid(request: &StaffRequest, status: u16, body: Option<&Value>) -> bool {
    use StaffRequest as R;
    let Some(v) = body else {
        // Only lifting a restriction answers 204 No Content.
        return matches!(request, R::LiftRestriction { .. });
    };
    match request {
        R::Probe {} => is::<Probe>(v),
        R::ListReports { .. } => is::<Vec<Report>>(v),
        R::GetReport { .. } => is::<Report>(v),
        R::ResolveReport { .. } => is::<Resolution>(v),
        R::CancelReport { .. } => is::<Cancelled>(v),
        R::ReopenReport { .. } => is::<Reopen>(v),
        R::ListFeedback {} => is::<Vec<FeedbackSummary>>(v),
        R::GetFeedback { .. } => is::<Feedback>(v),
        R::SetFeedbackStatus { .. } => is::<FeedbackState>(v),
        R::ListOperators {} => is::<Vec<Operator>>(v),
        R::PutOperator { .. } => is::<Operator>(v),
        R::DeleteOperator { .. } => is::<Deleted>(v),
        R::ListRestrictions { .. } => is::<Page<Restriction>>(v),
        R::LiftRestriction { .. } => false,
        R::DirectAction { .. } => matches!(
            (status, DirectAction::deserialize(v)),
            (200, Ok(DirectAction::Succeeded { .. })) | (202, Ok(DirectAction::Pending { .. }))
        ),
        R::ListCommunities { .. } => is::<Page<Community>>(v),
        R::SearchMembers { .. } => is::<Items<Member>>(v),
        R::GetMember { .. } => is::<MemberDetail>(v),
        R::GetEvent { .. } => is::<EventPreview>(v),
    }
}

/// beta's `ErrorEnvelope`: exactly `{"error":{"code","message","requestId"}}`
/// with a snake_case code and a UUID request ID. A 401 must also carry the
/// `WWW-Authenticate: Nostr` challenge and code `unauthorized`, a 403 code
/// `forbidden`. Anything else is not the relay's answer.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    error: ErrorBody,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ErrorBody {
    code: String,
    message: String,
    request_id: uuid::Uuid,
}

/// `(code, message)` when `body` is the relay's own rejection for `status`.
pub(super) fn rejection(status: u16, challenge: bool, body: &[u8]) -> Option<(String, String)> {
    let ErrorBody { code, message, .. } = serde_json::from_slice::<Envelope>(body).ok()?.error;
    let well_formed = !code.is_empty() && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_');
    let matches_status = match status {
        401 => challenge && code == "unauthorized",
        403 => code == "forbidden",
        _ => true,
    };
    (well_formed && matches_status).then_some((code, message))
}
