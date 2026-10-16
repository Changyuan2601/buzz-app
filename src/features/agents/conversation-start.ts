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

export const WELCOME_PROMPT = `This is an app-authored onboarding instruction from Buzz, not a message written by your owner. Your owner has just connected an AI provider in the Welcome Solo conversation.
The app's prepared welcome is already visible above this conversation. Do not repeat that welcome or describe Buzz again. Send exactly this message, without a heading or additional text:
“Great, we’re connected! Before we get started, take a sec to give me a name and choose an avatar, and then I can show you around.”
The controls below your message let the owner choose and confirm the name and avatar before chatting. Do not ask them to connect again, send a chat message, or start a tour now. Do not claim a default has been saved, that you have been renamed, or that customization has succeeded; they will confirm those choices themselves.
Send this message now with Buzz's send tool to this conversation at top level (audience: everyone, final: true). Do not mention or reply to an invented user message. Do not create channels or change settings. No shell, file, or other external action is needed.`;
