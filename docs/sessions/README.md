# Sessions

Sessions are focused work conversations built on ordinary private channels.

## Current contract

- A session is the work conversation. The Sessions sidebar shows previous topics,
  grouped into sections. **New session** starts an unfiled conversation; a custom
  section’s **+** inherits that section’s defaults. Selecting a saved session opens it.
- Sessions are ordinary private stream channels. Creation, invitations, messages,
  roles, and membership use existing relay behavior. **No relay changes or new
  Sessions protocol are required or planned for this iteration.**
- The description marker `Buzz session (buzz.sessions/v1)` identifies sessions.
  Legacy `parent:<UUID>` metadata remains readable, but Sessions no longer creates
  nested conversations and the Sessions list excludes parent-linked sessions.
  Existing content and signed membership are not changed or deleted.
- The sidebar arranges standalone sessions using the same relay-backed personal
  sections as channels. Moving an existing session changes organization only.
- Each custom section has **Session settings…** and a **+** for a new session
  in that section. Defaults include project folders, optional worktree location
  and base branch, Canvas, and optionally a copy of an existing template's lineup.
  Paths become Canvas instructions for the agent host; saving them does not create
  a worktree or change a running agent's working directory.
- Section overrides are ordinary private template records, keyed by the SHA-256
  of the section ID in the `session-section-` namespace. They use the existing
  community-scoped recipe capability; no sidebar migration or new relay event
  kind is involved. Existing personal-group template defaults are used when there
  is no Sessions override. Templates are copied, not linked for live propagation.
- Creation freezes section defaults in the existing pending-start receipt. The
  session's Canvas, section placement, and template agent invitations must succeed
  before its first message is sent. A retry keeps the same session ID and setup;
  a different existing Canvas blocks replacement. Missing defaults or failed reads
  do not silently create an unconfigured session.
- A saved session's header **⋯ → Session settings…** edits that session's Canvas
  with the existing revision check. Changes do not update the section default or
  sibling sessions. Failed saves retain a local draft and explicit reload flow.
- Saved sessions expose **Rename** in their row and header menus.
  The existing channel-details service verifies owner/admin permissions and the
  loaded revision, then sends a name-only kind-9002 command. Session metadata,
  visibility, and lifetime remain unchanged; uncertain delivery requires checking
  the saved result before another write. Automatic generated titles are not added.
- Row menus offer **Section** destinations and **New section…**, plus **Copy** for
  the session name, ID, and ordinary Buzz channel link. The unfiled Sessions
  destination appears only for sessions currently in a custom section.
- Workspace fields round-trip through a marked block in ordinary Canvas Markdown.
  If another editor changes that block, the settings dialog exposes the full
  Canvas instead of discarding custom text.
- New sessions use the ordinary composer, centered at the bottom, and
  channel-style titles. The avatar-and-name picker opens upward using the same
  popover, search field, and option-row components as the mention picker. It
  searches available agents by name or public key and keeps the draft intact.
  Explicit mentions take precedence over the selected agent. Without a selection,
  a sole agent already in the session is addressed automatically; multiple agents
  require a recipient. Removing a mention avatar clears only its explicit mention
  intent and preserves the draft text; it does not suppress this automatic routing.
- Published replies appear in the main session conversation. Sessions uses normal
  paged channel queries and complete message overlays, without new relay filters.
  Existing thread replies are also presented inline.
- Detailed activity remains private to the agent's owner. Do not build a shared
  activity feed for today's individually owned agents. Shared cloud agents may
  introduce a different visibility model later.
- Use real conversations and agents. No sample activity, fake sends, inferred
  permissions, or new execution/scheduling infrastructure.

## Ownership and protocol

- `src/bundled/sessions` owns the Sessions page and history navigation.
- `src/bundled/channels` retains ordinary channel access to historical sessions.
- `src/features/sessions` owns composition, recipient selection, workspace settings,
  frozen setup, and presentation. Existing relay capabilities own all writes.
- `src/features/relay/work-sessions.ts` uses the existing durable outbox for private
  stream creation (kind 9007), invitations (kind 9000), and receipt recovery.
- `browser-host/session-commands.mjs` restricts the host signing boundary to these exact
  command shapes. No custom relay operation or migration is needed.
- `session-window.ts` loads ordinary channel rows and complete message overlays
  with bounded paging. Signed membership remains the authority for reads.

## Validation and scope

Focused tests cover signed create/invite/send, duplicate-creation recovery,
independent memberships, rejected invitations and retry, parent revocation without
child revocation, flat conversation reads, Enter submission, recipient precedence,
and agent mention rendering. Real-agent creation and replies have been exercised
in the native app.

Archive/completion, sharing snapshots, and richer
prompt-linked activity remain future product work. This implementation keeps
memberships independent and detailed activity private to each agent's owner.

### Interactive section/workspace iteration

Targeted coverage includes section save/restore/retry, hiding parent-linked
sessions, workspace serialization, revision conflicts, and withholding the first
message until inherited setup succeeds. Native UI checks cover the section
workspace dialog and existing session reads. Live cross-device inheritance and
agent execution from the configured paths still require acceptance testing;
the PR remains a draft until those acceptance checks are complete.

Section deletion uses the active grouping store: native legacy sections receive a
section tombstone (including the development broker), while personal groups use the existing revision-checked recipe
writer. Sessions and channels are retained and return to the unfiled list; shared
channel-sidebar sections disappear there as well. Hosts without the removal
capability disable the action. Coverage includes native readback, personal-group
removal, source-change rejection, and UI failure/retry. Live deletion of user
sections has not been exercised. Section expansion uses interruptible 180ms motion,
with immediate keyboard and reduced-motion behavior.

New-session headers expose local draft settings before first send. These overrides
survive reopening, retain section agent defaults, and are frozen into the existing
start receipt. Canvas setup must complete before the first message is sent;
opening or saving the draft settings does not create a remote session.
