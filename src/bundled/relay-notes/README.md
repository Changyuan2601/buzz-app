# Shared Notes

Let your agents save recipes, reference material and other reusable Markdown as shared notes in your community.

Notes are shared with people who have access through this community’s relay.

## Getting started

1. Turn on **Shared Notes** in **Settings → Plugins → Manage plugins**.
2. Ask an agent to save a recipe as a shared note, giving it a title and a stable identifier such as `icon-recipe`.
3. Ask an agent to find and read a saved note when you want to use it again.

Agents get `notes_get` for discovery and reading, `notes_set` for publishing, and `notes_rm` for deleting their own notes. Disabling the plugin removes these tools. Each agent writes under its own identity; it can read other authors' notes when the relay permits it. Notes are shared relay content—keep secrets in private storage. Reading a recipe does not run image generation.

---

For tool arguments and confirmation limits, see [Shared notes for agents](../../../docs/relay-notes.md).
