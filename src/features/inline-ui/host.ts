import { createContext } from "react";

export type AgentProfile = Readonly<{ name: string; picture: string }>;

/** What the surrounding surface lets patterns do beyond replying. A profile
 * pattern is live only where a host saves it; the host owns validation, the
 * save and what follows it. */
export type InlineUiHostValue = Readonly<{
  saveProfile?(agent: string, profile: AgentProfile): Promise<void>;
  /** The profile was saved here, so its pattern freezes on what was chosen. */
  profileSaved?: boolean;
}>;

export const InlineUiHost = createContext<InlineUiHostValue>({});
