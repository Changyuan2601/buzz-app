# Apple Foundation Model

Create agents that answer you in Buzz with Apple's on-device Foundation Model. The model runs on your Mac, so it needs no account, key or internet connection.

## Getting started

1. Turn on **Apple Foundation Model** in **Settings** → **Plugins**. It needs macOS 26 or later with Apple Intelligence turned on.
2. Choose **New agent** → **Create a new agent** and pick **Apple Foundation Model** as the **Harness**.
3. Mention your agent in a conversation. It reads the conversation and answers there.

---

# Apple Foundation Model for Agents

A desktop plugin that ships with Buzz, off until turned on in **Settings →
Plugins**. Its agents answer with the `fm` command that comes with macOS 26
and later (`/usr/bin/fm`), which runs Apple's Foundation Model on this
computer. Agents owns the identity, admission and signed Buzz actions. This
plugin turns each mention into one `fm respond` run and posts the answer.

## How a turn runs

1. Only the owner's mentions, or ones the owner delegated, start a turn, as
   for the other harnesses.
2. [`runtime.ts`](runtime.ts) reads the conversation from the community: the
   whole thread for a mention in a thread (a DM's too), the latest 30
   messages for one at a DM's or Solo chat's top level, and nothing more for
   a mention that starts a thread in a channel.
3. [`prompt.ts`](prompt.ts) builds the model's instructions (the agent's
   name, its owner, what it can't do, and the owner's **Instructions**) and a
   prompt with as many of the newest earlier messages as fit, then the
   message to answer. The model's context holds about 8K tokens for all of
   it and the answer, so the prompt keeps to about 12,000 characters of
   earlier messages, and the instructions to their first 2,000.
4. It runs `fm respond --no-stream --instructions=…` with the prompt on stdin.
   When `fm` says the conversation exceeded the model's context, it asks
   again with the latest message alone, then with its first 1,500
   characters.
5. It posts the answer as the agent in the thread, or at a Solo chat's top
   level. A run that fails posts `⚠️ I couldn't finish that: …` and tags the
   owner, as does a turn still running at its 3-minute deadline. **Stop** on
   the turn's activity kills `fm` and posts nothing.

Nothing is saved between turns: the conversation in Buzz is the agent's
memory, so quitting Buzz loses nothing.

## Offline

`fm` talks to the model over local system services, not the network. With
network access denied to it, it still answers:

```sh
sandbox-exec -p '(version 1)(allow default)(deny network*)' \
  fm respond --no-stream 'Reply with the single word OK.'
```

Buzz itself still needs to reach the agent's community. To work with no
internet connection, use a community on this computer or local network.

## Try it

```sh
source bin/activate-hermit
BUZZODZ_PROFILE=fm-agents BUZZ_DEV_VIEWER= bin/just desktop
```

Turn the plugin on, create an agent with the **Apple Foundation Model**
harness, and mention it: `@Agent what is the capital of France?`. Reply in
the same thread with `@Agent and of Spain?`. It answers in context, because
the thread is its conversation.

## Checks

```sh
bin/pnpm exec vitest run src/bundled/fm
```

The tests cover the prompt and its budget, and the runtime against a fake
`fm` and community: who may start a turn, what the model is shown, where the
answer goes, the retry after a context overflow, failures and Stop.

## Limits

- The agents have no Buzz tools. `fm serve`'s chat completions do not return
  the model's tool calls, so an agent can only answer the message it was
  mentioned in. It can't read other channels, send elsewhere, remember, or
  use watches and timers. The host still shows its Attention tab, but its
  watches and timers start no turns.
- A long thread is cut to its newest messages, and the model may still
  refuse or fail on content its guardrails block. Both say so in the thread.
- The plugin runs the first `fm` on the app's search path, which starts
  with `~/.local/bin`. Another program named `fm` there, or in a folder
  ahead of `/usr/bin` on the path, runs instead.
- There is no model choice: macOS has one system model.
- Linux, Windows and Macs without Apple Intelligence can turn the plugin on,
  but its agents fail with `fm`'s reason. The Settings tab says why.
