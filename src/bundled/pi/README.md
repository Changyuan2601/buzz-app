# Pi

Create agents that run Pi on your computer, with any provider Pi supports, and answer you in Buzz. Each conversation continues its own Pi conversation.

## Getting started

1. Turn on **Pi** in **Settings** → **Plugins**. Pi needs Node.js 22.19 or later on this computer.
2. Choose **New agent** → **Create a new agent**, pick **Pi** as the **Harness**, and choose its provider and model.
3. Mention your agent in a conversation to give it work.

---

# Pi for Agents

Agents run on [Pi durable](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md) in one Node
host ([`host.mjs`](host.mjs)). Each agent has its own SQLite storage, and each
Buzz thread or channel is one durable Pi conversation. Agents owns identity,
admission and signing; this plugin owns the turn after handover.

```sh
bin/pnpm exec vitest run src/bundled/pi
PI_DEPS=<installed deps folder> bin/pnpm exec vitest run src/bundled/pi/host.live.test.ts
```

The live test runs the real host on Pi's faux provider.

## Packages

[`launch.mjs`](launch.mjs) installs [`deps/package-lock.json`](deps/package-lock.json)
with `npm ci` (no install scripts) into a per-lock folder under Buzz's app data
`pi/deps/`, shared by every Buzz build. To update Pi, change
[`deps/package.json`](deps/package.json), then:

```sh
cd src/bundled/pi/deps
npm install --package-lock-only --ignore-scripts --omit-lockfile-registry-resolved
```

## Limits

- Pi's `read`, `write`, `edit` and `bash` run in the workspace with no sandbox
  or approvals. Buzz tools are `buzz_<name>`.
- Keys in Pi's `auth.json` must be literal: Buzz runs no `!command` key and
  reads no `$NAME` key. Set up a provider that needs more than a key with
  `pi`. Providers from Pi packages don't run.
- Runs left unfinished when the app quit continue at the next turn. A
  mention's run posts its answer or failure but shows no steps; its thread's
  session controls interrupt it. A watch's or timer's run is ended.
- When the app quits or the host stops during a Buzz tool call, Pi tells the
  model the call may have run, so a `send` it makes again may be posted
  twice. A Stop or Interrupt ends the run instead.
- Pi durable records compaction's usage only in each conversation's totals,
  not per compaction. Usage dates all of it at the newest compaction, so each
  compaction moves the conversation's earlier compaction spend to its day.
- On Windows, Pi's `bash` tool needs Git Bash. Linux and Windows are not yet
  validated.
