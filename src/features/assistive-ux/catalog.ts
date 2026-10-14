import type { ChannelSummary } from "../relay/contracts";

/** Each experience declares its own facts; no universal UI or flow context. */
export type AssistiveFacts = {
  "threads.new-thread-placement": Readonly<{
    surface: "new-channel-thread" | "other";
    channelType?: ChannelSummary["channelType"];
    /** Me can also be a stream; absent means its classification is unknown. */
    isMe?: boolean | undefined;
  }>;
};
export type AssistiveExperienceId = keyof AssistiveFacts;

/** Auditable product rules, not copy, components, actions, or access authority. */
export const ASSISTIVE_EXPERIENCES: {
  readonly [Id in AssistiveExperienceId]: Readonly<{
    purpose: string;
    eligible(facts: AssistiveFacts[Id]): boolean;
  }>;
} = {
  "threads.new-thread-placement": {
    purpose: "Explain where a new channel thread appears and who can read it.",
    eligible: (facts) =>
      facts.surface === "new-channel-thread" &&
      facts.isMe === false &&
      (facts.channelType === "stream" || facts.channelType === "forum"),
  },
};
