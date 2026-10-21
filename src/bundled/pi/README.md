# Pi

Create agents that run Pi on your computer, with any provider Pi supports, and answer you in Buzz. Each conversation continues its own Pi conversation.

## Getting started

1. Turn on **Pi** in **Settings** → **Plugins**. Pi needs Node.js 22.19 or later on this computer.
2. Choose **New agent** → **Create a new agent**, pick **Pi** as the **Harness**, and choose its provider and model.
3. Mention your agent in a conversation to give it work.

---

# Pi for Agents

A desktop plugin that ships with Buzz on macOS, Linux and Windows, off until
turned on in **Settings → Plugins**. Its agents run on
[Pi durable](https://earendil.com/posts/pi-1-0/) (`@earendil-works/pi-durable`),
not the Pi coding agent, with any provider Pi supports.
Agents owns the identity, admission, configuration, and signed Buzz actions. This
plugin owns Pi work after delivery handover. One Pi host process ([`host.mjs`](host.mjs))
runs every Pi agent here. Each agent has its own SQLite storage, and each Buzz
conversation the agent is in is one durable Pi conversation.

## Try it

From the feature worktree:

```sh
source bin/activate-hermit
BUZZODZ_PROFILE=pi-agents BUZZ_DEV_VIEWER= bin/just desktop
```

Pi needs Node.js 22.19 or later on this computer (`node:sqlite`). On macOS and
Linux the app's PATH is searched first, then an interactive login shell's, so
Homebrew, nvm, fnm and similar installs work. On Windows, `node` must be on the PATH Buzz
starts with.

1. Turn on **Pi** in **Settings → Plugins**. Then open **Agents → New agent**
   and choose **Pi** as the **Harness**. Its **Model** starts on **Pi default**:
   the `defaultProvider` and `defaultModel` in `~/.pi/agent/settings.json`, as
   the `pi` command sets them. The first time Buzz asks Pi anything, it
   installs Pi's packages (a few seconds).
2. Click the model (marked with Pi, and with the provider when Buzz has its
   mark) and choose a provider. A provider Pi has no key for shows an
   **API key** field; **Save to Pi** stores it in
   `~/.pi/agent/auth.json`, shared with the `pi` command. A provider that signs
   in some other way (OAuth, cloud credentials) says to run `pi`, then `/login`.
   Choose a model, click **Test connection**, then **Use**. Name the agent and
   click **Create agent**. Its library card shows the same control.
3. Open the agent. Its **Identity** tab has the **Provider**, **Model**,
   **Thinking** level (Pi's default, or one the model has) and
   **Instructions**. Its **Settings** tab has the provider's key with **Test
   connection**, the **Workspace** (default `~/.buzz`), and thread or channel
   **Conversations**.
4. In a channel, send: `@Pi create hello.txt containing hello in the workspace,
   read it back, and report what you found` (use the agent's actual name).
   Expect steps under your message, one reply in the thread, and the file in the
   workspace. Then reply in the same thread: `@Pi what did you write?`. It
   remembers, because the thread is the same Pi conversation.
5. While it works, send another mention in the thread. It steers the running
   turn: Pi reads it at its next step. The activity moves to the newer message.
6. Quit Buzz during a long turn, start it again, and mention the agent in that
   thread. Pi continues the interrupted run from its storage, and the new
   mention steers it.
7. Choose **View activity** on one of its messages in that thread, or open the
   agent's **Activity** tab from there. **This thread** is its Pi conversation,
   with the agent's other recent ones below. **View transcript** shows each
   turn's prompt, thinking, tool calls with their output, and what it sent,
   read from Pi's storage.

The composer's model picker offers the agent's provider's models, and each
model's thinking levels, for one turn. Without a pick, a turn runs the
agent's saved model and Thinking level.

## Checks

```sh
bin/pnpm exec vitest run src/bundled/pi
PI_DEPS="$HOME/Library/Application Support/Buzz/pi/deps/<sum>" bin/pnpm exec vitest run src/bundled/pi/host.live.test.ts
```

The unit tests cover the stdio protocol (`pi.ts`), the runtime against a fake
host, the install script in a throwaway home, and the New agent and Settings
fields. The opt-in live test runs the real `host.mjs` on Pi durable, using Pi's
faux provider as the model. It checks that a final `send` ends the run, that the
model reads what a Buzz tool answered, that a plain answer comes back as text,
that a request steers a working run, that a run cut off by a stop continues in
the next host, that aborting a run leaves it unanswered, and that a deferred
Buzz tool is offered once `tool_search` finds it. `PI_DEPS` is any folder
the launcher installed Pi's packages in.

## Buzz's copy of Pi's packages

[`launch.mjs`](launch.mjs) runs the host on this computer's Node. On macOS and
Linux, [`pi.sh`](pi.sh) finds that Node and starts the launcher on it; Windows,
which has no bash, starts `node` itself. The launcher's first line on stdin
carries the host source and the packages to install, since together they pass
Windows' 32 KB command line. On first use it runs `npm ci` with
[`deps/package-lock.json`](deps/package-lock.json), which pins every package and
its integrity hash. Install scripts are off, and npm uses the registry it is
configured for. Each lock gets its own folder under
`~/Library/Application Support/Buzz/pi/deps/`
(`${XDG_DATA_HOME:-~/.local/share}/buzz/pi/deps/` on Linux,
`%LOCALAPPDATA%\Buzz\pi\deps\` on Windows). The folder appears
whole or not at all, and is shared by every Buzz build. An install removes the
folders no build has started for 30 days. Agents' storage is in `agents/<pubkey>.sqlite`
beside it. A lock on each agent's storage keeps a second Buzz build from opening
it; that build's turns fail and say so. It also keeps Pi's `auth.json` writes
from colliding with the `pi` command's.

To update Pi, change the versions in [`deps/package.json`](deps/package.json),
then regenerate the lock without registry URLs:

```sh
cd src/bundled/pi/deps
npm install --package-lock-only --ignore-scripts --omit-lockfile-registry-resolved
```

## Limits and boundaries

- Only the owner's events, or ones the owner delegated, start work. Watches,
  timers and catch-ups run as standalone turns, each a one-off Pi
  conversation, in the lanes and with the 5-minute deadline Buzz's agent
  runner gives every harness.
- Pi has the coding tools `read`, `write`, `edit` and `bash`, in the workspace,
  with no sandbox or approvals, like Claude's `bypassPermissions`. Buzz's tools
  are offered as `buzz_<name>` (`buzz_send`, `buzz_read`, …), since `read` and
  `edit` would collide. They run inside Buzz through the agent's native-held
  handle, so the host holds no Buzz key. A final `buzz_send` ends the run.
  The Buzz tools Claude and Codex load on search (the attention tools, and
  those plugins add) are deferred: Pi's `tool_search` loads them when the
  model looks for them, and they stay loaded in that conversation.
- **Stop** on a turn's activity aborts the Pi run it is in, and posts
  nothing.
- A turn that answered in text and never called `buzz_send` has its answer
  posted in the thread, as goose does. A turn that fails posts `⚠️ I couldn't
  finish that: …` and tags the owner.
- A Buzz tool call that a stop cuts off runs again when the run continues, so a
  `send` may be posted twice.
- Pi's storage keeps every conversation, including each one-off watch or timer
  turn; nothing prunes it. The Activity tab lists thread and channel
  conversations only, and rereads an open transcript when its turn ends, not
  as it streams.
- A host that stops while a turn waits is started again once and waits for it
  there. A run resumed that way shows no steps.
- Runs left unfinished when the app quit continue at the first turn after it
  starts again, in whatever thread. A mention's run shows as working and its
  answer or failure is posted where it would have been, but it shows no steps
  and Stop does not reach it. A watch's or timer's run is ended instead, as
  quitting ends other harnesses' turns: continued, it would have no deadline.
- Pi durable records some requests that have no answer, such as compaction's,
  only in its totals. Usage counts each model's share of those as one more
  request, at the newest compaction.
- A provider that needs more than a key, such as Bedrock or Vertex, is set up
  with the `pi` command. Signing in from Buzz is not supported.
- A `!command` or `$NAME` key in `auth.json`, which the `pi` command runs or
  reads from its environment to get the key, is not used: one host serves
  every agent, and a command would hold them all, and the desktop app often
  lacks the shell's environment. Its turns fail and say so; enter the key in
  Buzz instead.
- Only Pi's built-in providers run. One that a Pi package adds (`packages` in
  Pi's settings), such as databricks, is not loaded: the provider field, the
  New agent Model field and a turn's error say so, and Use and Save wait for another.
- On Windows, Pi's `bash` tool needs a bash, such as Git for Windows'; the
  other tools work without one.
- Windows, Linux, packaged-app behavior, and human acceptance need separate
  validation.
