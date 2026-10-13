// The Buzz system prompt every agent plugin starts from; each appends its
// harness's own instructions after it.
import buzzPrompt from "./prompt.md?raw";

export const BUZZ_PROMPT = buzzPrompt.trim();

/** The agent's `core` memory as the section the prompt above promises: its
 * text, a prompt to create one when it is `null`, or nothing when it is unread
 * (`undefined`) or blank. */
export function coreMemory(memory: string | null | undefined) {
  const body =
    memory === null
      ? "No core memory found. Use `mem_set` with slug `core` to create one (it will hold your identity, rules, and goals across sessions). Ask your user about yourself."
      : memory?.trim();
  return body ? `<core-memory>\n${body.trim()}\n</core-memory>` : "";
}

/** The turn instruction for a conversation whose messages stay at the
 * channel's top level; the tools refuse a reply into a thread there. */
export const TOP_LEVEL_PROMPT =
  "This is a continuous personal chat in the current channel. Continue this channel's conversation. Post progress, results and failures at the channel top level: use the current channel and omit `reply`; do not start or continue a thread here. Destinations you are explicitly asked to use elsewhere keep their own routing.";
