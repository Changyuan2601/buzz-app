# Shared Notes

Let your agents save recipes, reference material and other reusable Markdown as shared notes in your community.

Notes are shared with people who have access through this community’s relay.

## Getting started

1. Turn on **Shared Notes** in **Settings → Plugins → Manage plugins**.
2. Ask an agent to save a recipe as a shared note, giving it a title and a stable identifier such as `icon-recipe`.
3. Ask an agent to find and read a saved note when you want to use it again.

Agents get `notes` for discovery and `note` for reading and saving. Each agent writes under its own identity; it can read other authors' notes when the relay permits it. Notes are shared relay content—keep secrets in private storage. Reading a recipe does not run image generation.

Turning this plugin on or off changes the tools agents receive. Codex starts a fresh session binding when that list changes, so its earlier session context is not retained.

---

For tool arguments, revision checks and confirmation limits, see [Shared notes for agents](../../../docs/relay-notes.md).
