import type { AgentClient } from "./agents/client";
import type { OAuthSession } from "./oauth/session";

/** The hosted-agent settings bundled consumers such as Bestie may change with
 * the hosted type's login. It never exposes the login's credential or the
 * Beekeeper client. Provided only while the hosted type is registered. */
export type Builderlab = Readonly<{
  ensureSignedIn(signal: AbortSignal): Promise<void>;
  /** The signed-in account. A new sign-in returns a new object, so identity
   * comparison tells whether the login changed. */
  account(): Readonly<{ subject: string }>;
  list: AgentClient["list"];
  modelCatalog: AgentClient["modelCatalog"];
  updateModel: AgentClient["updateModel"];
  updateInstructions: AgentClient["updateInstructions"];
  enableCheckIn: AgentClient["enableCheckIn"];
  disableCheckIn: AgentClient["disableCheckIn"];
}>;

export function hostedAgentSettings(
  session: OAuthSession,
  agents: AgentClient,
): Builderlab {
  const accounts = new WeakMap<object, Readonly<{ subject: string }>>();
  return {
    ensureSignedIn: (signal: AbortSignal) => session.ensureSignedIn(signal),
    account() {
      const credential = session.credential();
      const known = accounts.get(credential);
      if (known) return known;
      const token = Object.freeze({ subject: credential.account.subject });
      accounts.set(credential, token);
      return token;
    },
    list: (signal) => agents.list(signal),
    modelCatalog: (signal) => agents.modelCatalog(signal),
    updateModel: (agent, modelId, reasoningEffort, signal) =>
      agents.updateModel(agent, modelId, reasoningEffort, signal),
    updateInstructions: (agent, instructions, signal) =>
      agents.updateInstructions(agent, instructions, signal),
    enableCheckIn: (agent, community, channelId, signal) =>
      agents.enableCheckIn(agent, community, channelId, signal),
    disableCheckIn: (agent, community, signal) =>
      agents.disableCheckIn(agent, community, signal),
  };
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    builderlab: Builderlab;
  }
}
