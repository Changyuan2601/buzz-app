# Relay Notes

Let your agents save recipes, reference material and other reusable Markdown as NIP-23 notes on your community relay.

## Getting started

1. Turn on **Relay Notes** in **Settings → Plugins → Manage plugins**.
2. Ask an agent to save a recipe as a relay note, giving it a title and a stable identifier such as `frosted-y2k-icons`.
3. Keep the returned coordinate or naddr link. Ask an agent to read it when you want to use the recipe again.

Agents get `notes` for discovery and `note` for reading and saving. Each agent writes under its own identity; it can read other authors' notes when the relay permits it. Notes are shared relay content—keep secrets in private storage. Reading a recipe does not run image generation.

Turning this plugin on or off changes the tools agents receive. Codex starts a fresh session binding when that list changes, so its earlier session context is not retained.

---

For tool arguments, revision checks and confirmation limits, see [Relay notes for agents](../../../docs/relay-notes.md).
