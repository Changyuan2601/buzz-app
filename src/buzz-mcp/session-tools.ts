// What one agent session gets of the Buzz tools, whatever harness runs it:
// the tools to list, the guidance for its system prompt, a note for the end of
// each turn, and the handler for every call. The attention tools are among
// them, and so are any tools plugins add. A harness passes all of this
// on without knowing what is in it.
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

/** A tool a plugin adds to every agent session in the app, listed
 * after the Buzz tools under the same server. */
export type AddedTool = Readonly<{
  name: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
  /** Runs it as the agent working in `context`. A throw is a tool error for
   * the agent to correct. */
  call(
    client: BuzzClient,
    context: Context,
    args: Record<string, unknown>,
  ): Promise<Reply>;
}>;
type Listed = Pick<AddedTool, "name" | "description" | "inputSchema">;

export type BuzzSession = Readonly<{ tools: readonly Tool[] }>;

/** What every session of an agent in the app gets. It never changes with
 * the owner's attention setting, so a session (and its cached prompt prefix)
 * never needs replacing when attention is turned on or off: the attention
 * tools refuse calls while it is off, and `turnNote` says which it is. */
export const BUZZ_SESSION: BuzzSession = Object.freeze({
  tools: [
    ...TOOLS,
    ...ATTENTION_TOOLS,
    {
      name: "propose_instructions",
      description:
        "Only available after the owner explicitly sends Finish setting up this agent in their Get started chat. Offers one complete editable instructions draft, never saves. Unavailable elsewhere. The owner must Apply to draft then Save in the agent profile.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
  ],
});

const listed = ({ name, description, inputSchema }: AddedTool): Listed => ({
  name,
  description,
  inputSchema,
});

/** The tools a session lists: the Buzz tools, then those plugins add. */
export const sessionTools = (
  added: readonly AddedTool[] = [],
): readonly Listed[] => [...BUZZ_SESSION.tools, ...added.map(listed)];

/** Changes when the added tools change, so a session that keeps the list it
 * started with can be replaced; empty while plugins add none. A short hash,
 * since Codex saves it with each binding. Sorted by name, so the order
 * plugins start in does not change it. */
export function addedKey(added: readonly AddedTool[]) {
  if (!added.length) return "";
  const text = JSON.stringify(
    added.map(listed).sort((a, b) => (a.name < b.name ? -1 : 1)),
  );
  // FNV-1a.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++)
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(36);
}

/** Text for the end of a turn's prompt, as the agent's attention is now. */
export const turnNote = (client?: Pick<BuzzClient, "attention">) =>
  client?.attention
    ? client.attention.enabled()
      ? ATTENTION_REVIEW
      : ATTENTION_OFF
    : undefined;

/** Answers one tool call. Throws when the tool cannot run now; the message
 * is for the agent. Without a client, no tool can be called yet. `added`
 * are the tools plugins add now. */
export async function callSessionTool(
  client: BuzzClient | undefined,
  context: Context,
  name: string,
  args: Record<string, unknown>,
  added: readonly AddedTool[] = [],
): Promise<Reply> {
  if (!client) throw new Error("Buzz is not ready yet. Try again.");
  const tool = added.find((tool) => tool.name === name);
  if (tool) return tool.call(client, context, args);
  if (name === "propose_instructions") {
    if (
      !client.proposeInstructions ||
      !context.channel ||
      typeof args.text !== "string"
    )
      throw new Error(
        "Instruction proposals are unavailable here. Use the agent's profile to edit instructions manually.",
      );
    client.proposeInstructions(args.text, context.channel);
    return "Proposed for review in the agent's profile. Nothing was saved. The owner must choose Apply to draft, review/edit, then Save.";
  }
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
