// The Buzz tools' guidance, which every agent plugin gives its agents after
// the shared base prompt (features/agent-harness): the posting conventions,
// then how to use the attention tools. Every session lists the attention
// tools, so this never changes with the owner's attention setting.
import { ATTENTION_PROMPT } from "../features/agent-harness/attention-prompt";
import buzzPrompt from "./prompt.md?raw";

export const BUZZ_PROMPT = `${buzzPrompt.trim()}\n\n${ATTENTION_PROMPT}`;

/** The turn instruction for a conversation whose messages stay at the
 * channel's top level; the tools refuse a reply into a thread there. */
export const TOP_LEVEL_PROMPT =
  "This is a continuous personal chat in the current channel. Continue this channel's conversation. Post progress, results and failures at the channel top level: use the current channel and omit `reply`; do not start or continue a thread here. Destinations you are explicitly asked to use elsewhere keep their own routing.";
