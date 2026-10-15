# Agents “Mesh” type: local inline GDK trial

Agents → New agent → **Mesh** uses this community’s shared compute, with no
alternate provider. Agent mode calls the inline Rust/GDK runtime through Tauri;
there is no ACP helper, process-backed session store or MCP bridge. See the
[trial implementation and limits](native/README.md).

## Source ownership

The plugin registers the Mesh agent type through the shared Agents extension point.
Its Tauri-independent Rust runtime lives in `native/` (`buzz-mesh-agent`).
The desktop bridge in `src-tauri/src/mesh_compute/inline.rs` retains native
identity/community admission, run cancellation and activity/tool callbacks.
This backend is compiled behind the desktop `mesh` feature; colocating its source
does not make it a dynamically installable native extension.

## Modes and admission

- **Chat:** one leased chat completion, no local or Buzz tools. An explicit
  single-sender watch may follow another sender, including an agent. Matched Interest
  instructions apply only to that watched turn; direct mentions do not
  inherit watch instructions.
- **Agent (default):** the inline runtime provides local shell and
  skill-loading tools in the configured workspace (default `~/.buzz`). Local
  tools have the user’s filesystem authority, not a sandbox. This trial does not
  provide tree/image tools, extension installation or delegation.
- **Buzz tools:** Agent mode always offers the full shared Buzz catalog
  with `buzz_` names: send, edit-message, react, read, channels, members,
  users, dm, mem_get, mem_set, canvas and media_get. Calls use the
  existing TypeScript handlers and captured agent handle/native signer. No key
  enters the model. Agent mode includes core-memory guidance; Chat remains tool-free.
  The retired `buzz` config flag is ignored.

Agent mode remains owner-only. A Chat watch may follow a canonical sender only
when its filter requires that author and every other watch condition matches.
Broad watches and non-owner mentions do not grant this permission. No mode triggers itself.

## Quick setup

Settings → Shared compute → Helpers creates Thread summarizer, Translator,
Media converter or Custom agent through the existing Agents creation service.
Chat presets have no tools; Agent presets disclose local shell/files and Buzz
access before creation. Defaults are created directly; edit names, instructions,
mode and workspace afterward in Agents → Settings. Configure Attention and add
the agent to a conversation there. Emoji maker and the shared emoji-publishing
operation are removed; existing agent identities and published emoji are not deleted.

## Conversations and delivery

A DM is one conversation. Otherwise **Thread** scope separates thread roots
(and new top-level mentions), while **Channel** scope orders the whole channel.
Follow-ups queue behind the current turn; they do not steer an active run.
Different conversations may proceed independently.

Every turn reads recent Buzz conversation history as the agent: the thread root
and replies, or the latest channel messages for a whole-channel conversation.
Results are deduplicated, sorted oldest-first and bounded to 50 earlier messages.
History-read failure leaves the latest request available. Agent turns with Buzz
access also read fresh core memory. When enabled, `buzz_read` can retrieve exact
older messages with a small limit, explicit channel and pagination/search.

Final prose is automatically posted as the agent’s reply, independently of any
optional tool sends. A send neither ends the turn nor suppresses that final post;
the send schema omits `final`. No final text produces a visible failure rather
than substituting tool narration. DMs have no thread tags; channel responses
reference the triggering message and retain its thread root.

Cancellation is passed to the inline adapter/native runtime. Disposal cancels
inline work and prevents queued deliveries from starting. Cancelled, retired or
stale-lease results are not posted. Already-published sends and completed local
tool effects are not rolled back or automatically replayed.

## History and host boundary

The transcript view shows up to 50 in-memory trial runs, including partial tool
evidence. Reload/quit discards them. It is not a persisted Goose session database
or cross-turn tool replay. Chat has no tool transcript.

The plugin manifest retains only the `workspace` (`pwd`) and `read` (`base64`)
process capabilities used by workspace resolution and existing adapters. Agent
inference/tool sequencing lives in Rust; Buzz handlers remain TypeScript
callbacks. Native identity, lease and cancellation checks are independent of
frontend delivery checks. This is the existing trusted-main-WebView model, not a
hostile-plugin security boundary.

## Validation boundary

`meshAgent.test.ts` exercises delivery policy, Chat watches, conversation history,
queued follow-ups, final posting and cancellation using a stub inline adapter.
`inlineAgent.test.ts` exercises the Tauri callback adapter and shared Buzz handlers;
Rust tests cover the inference/tool loop. These are complementary boundaries,
not packaged GUI/live Mesh/real-relay acceptance. See the trial README for current
native/build evidence and remaining limitations.
