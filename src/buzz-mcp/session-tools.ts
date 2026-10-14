// What one agent session gets of the Buzz tools, whatever harness runs it:
// the tools to list, the guidance for its system prompt, a note for the end of
// each turn, and the handler for every call. The attention tools are among
// them. A harness passes all of this on without knowing what is in it.
import {
  ATTENTION_OFF,
  ATTENTION_REVIEW,
} from "../features/agent-harness/attention-prompt";
import {
  ATTENTION_TOOLS,
  callAttentionTool,
  isAttentionTool,
} from "./attention";
import type { BuzzClient, Context } from "./client";
import { callTool, type Reply, TOOLS, type Tool } from "./tools";

export type BuzzSession = Readonly<{ tools: readonly Tool[] }>;

/** What every session of an agent in the app gets. It never changes with
 * the owner's attention setting, so a session (and its cached prompt prefix)
 * never needs replacing when attention is turned on or off: the attention
 * tools refuse calls while it is off, and `turnNote` says which it is. */
export const BUZZ_SESSION: BuzzSession = Object.freeze({
  tools: [...TOOLS, ...ATTENTION_TOOLS],
});

/** Text for the end of a turn's prompt, as the agent's attention is now. */
export const turnNote = (client?: Pick<BuzzClient, "attention">) =>
  client?.attention
    ? client.attention.enabled()
      ? ATTENTION_REVIEW
      : ATTENTION_OFF
    : undefined;

/** Answers one tool call. Throws when the tool cannot run now; the message
 * is for the agent. Without a client, no tool can be called yet. */
export async function callSessionTool(
  client: BuzzClient | undefined,
  context: Context,
  name: string,
  args: Record<string, unknown>,
): Promise<Reply> {
  if (!client) throw new Error("Buzz is not ready yet. Try again.");
  if (!isAttentionTool(name)) return callTool(client, context, name, args);
  const { attention } = client;
  if (!attention) throw new Error(`No tool ${name}`);
  // The owner can turn attention off while the session runs.
  if (!attention.enabled())
    throw new Error(
      `Attention is off for you: your owner turned it off, so these tools do nothing now.\n(classifier: ${attention.classifier()})`,
    );
  return callAttentionTool(attention, name, args);
}
