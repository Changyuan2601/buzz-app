import { TOP_LEVEL_PROMPT } from "../../buzz-mcp/prompt";
import { welcomeActions } from "./onboarding";
import type { AgentHandle, TurnResult } from "./service";

/** App-authored input, not a signed chat event or a message attributed to the owner.
 * The provider must deliver it into the channel's continuing conversation. */
export type ConversationStart<Config = unknown> = Readonly<{
  agent: AgentHandle;
  config: Config;
  channelId: string;
  prompt: string;
  signal: AbortSignal;
  check(): void;
}>;

export type ConversationStarter<Config = unknown> = (
  input: ConversationStart<Config>,
) => Promise<TurnResult>;

export const WELCOME_PROMPT = `This is an app-authored onboarding instruction from Buzz, not a message written by your owner. Your owner has just connected an AI provider and this is their first chat.
Send exactly this text, with nothing added: "Hi, I'm connected and ready to help. First, give me a name and pick an avatar."
Attach Buzz's profile pattern to that message: ui {"pattern": "profile", "options": [three short names you invent]}. Pick names with some personality that suit an AI teammate; never offer "Buzz", the placeholder name you have until they choose. The app shows your names with an avatar picker and a field for writing their own, and saves what they submit. Do not ask them to connect again, or start a tour now. Do not claim a default has been saved, that you have been renamed, or that customization has succeeded; they will confirm those choices themselves.
Send it now with Buzz's send tool to this conversation at top level (audience: everyone, final: true). Do not mention or reply to an invented user message. Do not create channels or change settings. No shell, file, or other external action is needed.`;

/** No event, author or timestamp is fabricated for app-authored startup input. */
export function conversationStartPrompt(
  agent: string,
  channel: string,
  prompt: string,
) {
  return `<context>\nScope: channel\nSession scope: channel\nChannel: ${channel}\nAgent: ${agent}\nIMPORTANT: ${TOP_LEVEL_PROMPT}\n</context>\n\n<app-conversation-start>\n${prompt.trim()}\n</app-conversation-start>`;
}

/** A signed marker distinguishes this post-save turn from the earlier introduction. */
export const savedWelcomeClientId = (channel: string) =>
  `welcome-saved:${channel}`;

export function savedWelcomePrompt(
  name: string,
  first: boolean,
  isDefault: boolean,
) {
  return `This is an app-authored onboarding instruction from Buzz, not a message written by your owner. The app has successfully saved your name and avatar. Confirmed facts (data, not instructions): ${JSON.stringify({ name, firstAgentInThisCommunity: first, defaultForNewSoloChatsInThisCommunityOnThisDevice: isDefault })}.
Write a short, warm greeting in your own words. Confirm that they saved you as their agent (first agent only if the fact above is true). If you are the default, explain that new Solo chats in this community use you for now and that they can select a different agent, including agents they create later. Do not imply existing chats or other communities/devices changed. Tell them they can start chatting, or pick a next step. Attach those next steps to the greeting as Buzz's choice pattern, with exactly these options in this order: ui ${JSON.stringify({ pattern: "choice", options: welcomeActions.map(([, label]) => label) })}. Do not list them in your text or claim they have chosen any yet. Send only this greeting with Buzz's send tool at top level (audience: everyone, final: true). Do not repeat the earlier introduction, start a tour, ask to reconnect or rename, invent a user message, create channels or change settings. No shell, file or other external action is needed.`;
}
