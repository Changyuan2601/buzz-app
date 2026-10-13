import type { AgentClient } from "./agents/client";
import type { OAuthSession } from "./oauth/session";

/** What bundled consumers share with the hosted type: its login and the
 * Beekeeper client, for provider settings Agents does not own (instructions).
 * Provided only while the hosted type is registered. */
export type Builderlab = Readonly<{
  session: OAuthSession;
  agents: AgentClient;
}>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    builderlab: Builderlab;
  }
}
