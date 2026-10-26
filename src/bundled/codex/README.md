# Codex

Create agents that run Codex on your computer and answer you in Buzz. Each agent works in its own **Workspace** folder and can run commands and edit files on its own.

## Getting started

1. Go to **Settings** → **Agent setup** → **Harness defaults** → **Codex** to install Codex and sign in.
2. Choose **New agent** → **Create a new agent**, and pick **Codex** as the **Harness**.
3. Mention your agent in a conversation to give it work.

---

# Codex for Agents

A bundled desktop plugin, on by default on macOS and Linux, using the native process host introduced in #731.
Agents owns the identity, admission, configuration, and signed Buzz actions. This plugin
owns Codex work after delivery handover. It starts one `codex app-server` for all
agents and uses an independent Codex thread for each agent's Buzz conversation.
Each thread carries its agent's workspace, instructions and tools, so one crash
fails every agent's current turn; the next mention reopens the server.

## Try it

From the feature worktree:

```sh
source bin/activate-hermit
BUZZODZ_PROFILE=codex-agents BUZZ_DEV_VIEWER= bin/just desktop
```

1. Codex is on by default; **Settings → Plugins → Manage plugins** turns it off or on. An older
   profile that installed Codex from a folder gets the bundled copy instead, and
   keeps it off if the installed copy was off.
2. Open **Agents → New agent**, choose **Codex** as the **Harness**, and
   optionally pick a model and add instructions. Name the agent and
   click **Create agent**.
3. **Settings → Buzz → Agent setup → Harness defaults → Codex** checks Buzz's copy of Codex and
   its account. If it says Codex is not installed, click **Install Codex**; if
   it needs you to sign in, click **Sign in** and finish in the browser. It also
   manages explicit-save model/thinking defaults. A blank agent choice inherits
   those defaults without changing its saved record. The **Workspace** defaults
   to `~/.buzz`, like Claude. In the agent's
   **Settings** tab, you can set an absolute or `~/…` path instead; clearing it
   restores the default. A disposable directory is useful for the first test.
   Choose model, thinking, session scope, and instructions, then **Save**.
4. Mentions are automatic; **Attention** also lets you add event
   watches. In a channel you can write to, select the agent from the `@` picker
   and add it to the channel if prompted. Send: `@Codex Test create hello.txt containing
   hello in the workspace, read it back, and report what you found`. Use the
   agent's actual name. Expect one reply from that agent in the originating
   thread and the file in your workspace.
5. Reply in the same thread: `@Codex Test read hello.txt and remind me what you
   wrote`. Expect the same Codex session and correct file contents.

While work is active, new mentions steer it, incorporating the follow-up into the
ongoing task. Messages arriving during startup wait for the turn to start and
then steer it; idle conversations continue the saved session. If a turn finishes
while a follow-up is being delivered, the follow-up starts another turn. A
follow-up that picks a model or effort other than the running turn's cannot
steer it, so it waits and runs as the next turn, and later follow-ups wait
behind it to keep their order.
A successful final send stops the request counting as working at once; Codex
still ends its turn with one more model call. Interrupting the turn instead would
leave a `<turn_aborted>` note in the session after every reply.
By default, Buzz tools reply to the latest accepted steering message. The agent can also choose another thread or channel with tool arguments.

There are no special chat commands. The composer's gauge popover offers
immediate Compact session, Start a new session, and Interrupt controls.
Compact and New require an idle session; Interrupt stops active work.
Asking the agent to stop is a steering request
that Codex interprets. Disabling the plugin ends its processes. For settings,
change instructions to require a marker, save, and send another mention after the
current turn finishes. Expect the marker.

Thread scope is the default. Channel scope shares a session across channel
threads; DMs always share a conversation. Workspace changes start a fresh session.
A mention in the owner's Solo chat is one conversation whatever the
scope: the agent continues the channel's session and posts at its top level, and
its tools refuse a reply into a thread there. A turn keeps the routing it started
with, so a mention after the chat is shared waits for it and then threads as
usual. Watch and timer turns have no default destination: their `send` must
name a channel.
Bindings persist locally under the community and agent identity. Earlier bindings without dynamic tools are ignored; new conversations start fresh. Switching
communities does not end an agent's work. Removing the agent, leaving or
disconnecting from its community interrupts its turns and asks Codex to end
shells they left running; the server ends when no
Codex agent that has worked is still running, or when the plugin is disabled.
If a saved Codex thread no longer exists, the next mention starts a fresh one.
Threads live in Buzz's own Codex home; see [Conversation storage](#conversation-storage).
To inspect a saved session, see [View a Codex session](../../../docs/view-codex-session.md).

The `buzz` dynamic-tool namespace exposes the same handlers as the Claude plugin:
`send`, `edit`, `react`, `read`, `channels`, `channel`, `members`, `users`, `dm`, `mem_get`,
`mem_set`, `notes_get`, `notes_set`, `notes_rm`, `canvas`, and `media_get`, which saves the file and gives its path, and answers with an image itself. These run inside Buzz through the agent's native-backed
handle; no MCP process or Buzz credentials go to Codex. Shared file tools use the
workspace where the turn started, through the declared `base64` reader. Memory
reads use the owner's encrypted-memory view; writes use the agent handle.

To test these locally, ask the agent to read its thread, react to your message,
remember a fact under `mem/test`, recall it in a follow-up, and send an image from
the workspace. Expect agent-signed actions, correct thread routing, and one final
reply. During a long task, send a new mention and confirm it incorporates the
follow-up before its final reply.

## Conversation storage

When a desktop build inherits Buzz's own `CODEX_HOME` from an agent, the launcher
recovers the shared home from its existing absolute `config.toml` link and
validates the normal settings links. It still refuses a self-reference or a
home without that link, and keeps history in Buzz's isolated home.

Buzz keeps its own Codex home, so its conversations stay out of Codex desktop's history, and desktop, which holds a writer lock on each recent thread it reopens, can't block their turns: `~/Library/Application Support/Buzz/codex-home` on macOS, or `${XDG_DATA_HOME:-$HOME/.local/share}/buzz/codex-home` on Linux. [`codex.sh`](codex.sh) links `config.toml`, `auth.json`, `AGENTS.md`, `rules` and `skills` there from the shared Codex home (`CODEX_HOME`, default `~/.codex`), so settings and file-based sign-in stay shared. Relative paths in `config.toml` resolve against Buzz's home, so use absolute ones. Codex hooks aren't shared: their trust is keyed by the path of `hooks.json`, so Buzz agents run without them. To sign Buzz out, sign out of Codex desktop or the terminal: signing out inside Buzz's home only removes its link, which the next run restores. Signing in there writes the new sign-in in place of the link, because `codex login` signs out first; the next run writes it through to the shared `auth.json`, unless that one is newer, and restores the link. Keyring sign-in is scoped to the home, so it needs a separate Buzz sign-in. The launcher also overrides `sqlite_home`, so a shared setting can't lead back to desktop's database. Any other file in the way of a link stops setup rather than being replaced.

A conversation saved before Buzz had its own home continues from a copy: when its thread isn't in Buzz's home, the runtime has `codex.sh adopt` copy the rollout from `~/.codex` once, then resumes it. The copy never replaces one Buzz already continued, and the original stays in `~/.codex`. If there's no rollout to copy, the runtime starts a new thread.

## Checks

```sh
bin/pnpm exec vitest run src/bundled/codex
bin/node src/bundled/codex/isolation-live.mjs
bin/node src/bundled/codex/live.mjs
```

The isolation check runs the installed Codex through `codex.sh` with disposable homes, a synthetic file-based account and a loopback model. It checks shared sign-in and settings, a private database despite a shared `sqlite_home`, resuming after a restart and a release switch, continuing an older thread from a copy that leaves the original alone, and that neither home lists the other's new threads. It sends no external model or relay requests.

The opt-in live check uses the installed Codex CLI/account in a disposable
workspace and a simulated relay. It sends no Buzz messages. It checks native shell
and file tools, the native coding prompt, conversation context, default steering,
idle follow-ups, process shutdown, saved-thread reuse, changed and cleared
instructions, missing-thread recovery, and disabled inherited MCP tools. It also
checks real dynamic Buzz callbacks, memory, workspace file uploads, normal
final sends without aborted-turn markers, and two agents sharing one server with
their own workspace, instructions and replies. Set
`BUZZ_CODEX_TEST_MODEL` to another available model if needed. It prints only
sanitized outcomes; it does not save raw protocol or session logs.

Automated component tests cover provider defaults and precedence, model/effort
choices, unavailable saved choices, workspace validation, pending saves, and
cancelling a provider check during disposal.
Protocol tests cover chunking, request correlation, interactive request rejection,
malformed output, and consumer exception containment. Runtime tests cover
conversation routing, ordinary message delivery, persistence, defaults, failures,
and cleanup.

## Buzz's copy of Codex

The plugin never runs the `codex` on PATH. It runs Buzz's own copy from
`~/Library/Application Support/Buzz/codex/<version>/bin/codex`, or
`${XDG_DATA_HOME:-~/.local/share}/buzz/codex` on Linux; a `current` file names
the version in use. Sign-in and settings are the same as in the terminal, but
conversations are not ([Conversation storage](#conversation-storage)). [`codex.sh`](codex.sh) is the launcher and installer;
the plugin runs each step through the one declared `bash -c` process.

Releases come from OpenAI's channel, `releases.openai.com/codex/channels/latest`,
as `codex-package-<target>.tar.gz` with the sha256 the channel lists. After the
checksum check, Buzz runs `--version` and checks that `app-server` lists models;
only then does it switch `current`. A release that fails is skipped and the
previous copy stays in use. Switching takes a lock shared by every Buzz build,
which the system releases when the build holding it stops, and checks the copy
again once it holds the lock. It keeps the new copy, the previous one and any
newer one another build may be testing. A mention sent before Buzz has found a
copy, or while it downloads the first one, waits for it. If that download
failed, a mention tries it again.
Buzz checks when the agents load and every 6 hours; the first download (about
130 MB) waits until a Codex agent is running, or **Install Codex** is clicked.

## Limits and boundaries

- Only the owner's mentions start conversation work. The agent always has the
  attention tools, loaded on search, with their guidance in their descriptions.
  Each turn ends with the attention review, a line that there are no Interests,
  or, when attention is off, a note that those tools refuse. Its watches and timers run
  as one-off turns on an ephemeral Codex thread of their own, queued per
  Interest by the Agents runner; a watch's event can come from
  anyone and is framed as observed data. These turns save no binding, have no
  default `send` destination, stop after 5 minutes, and do not run when their
  watch or timer, or attention, changed while they waited.
- Replies use Agents' host signer. Codex receives no Buzz agent key and does not
  publish through the Buzz CLI. The shared Buzz base prompt, custom instructions
  and the agent's `core` memory are supplied as developer instructions, preserving
  Codex’s native coding prompt. Each turn reads `core` fresh through the shared
  `features/agent-harness` reader, as Claude does for each new session.
- Codex runs with sandbox `danger-full-access` and approval policy `never`, matching
  Claude's `bypassPermissions`: it can write outside its workspace, reach the
  network, and use git and `gh`. Web search, inherited MCP servers, Apps, and plugins
  are disabled.
- Shared Agent Activity integration is deferred because this Agents delivery
  contract has no live-activity API. The agent's Activity tab shows
  conversation status and the latest command/output.
  Messages and uploads use the shared Buzz tools. Codex assistant text is not automatically posted. After `buzz.send` with `final: true`, Codex finishes normally and consumes pending steering. A turn that has nothing new to say ends without posting. Final sends preserve background processes, such as a dev server it started.
- Turns have a 29-minute deadline;
  RPC acknowledgements have a 30-second deadline. Local bindings retain 200 sessions.
- Uses experimental app-server APIs for dynamic tools, model discovery, application context, and terminal
  cleanup. The live check was exercised with `codex-cli 0.162.0` on macOS.
- Linux and Windows native behavior, packaged app behavior, full relay signing,
  and human acceptance require separate validation. A forced native kill can
  depend on the platform's descendant-cleanup support; this plugin adds no host
  process implementation.

Keep the PR in draft until the agent and human exercise the native mention/reply
flow, including signer behavior and process shutdown. Do not add
`buzz-review-completed` before the repository's review checklist holds.
