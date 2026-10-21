import { createActivityTab } from "./Activity";
import { createSettingsTab } from "./Instructions";
import type { AgentType } from "../../../features/agents/service";
import type { RelayData } from "../../../features/relay/service";
import type { AgentClient } from "../agents/client";
import {
  clearRegistration,
  type RegistrationIntent,
} from "../agents/registration";
import { oauthTarget } from "../oauth/browser";
import type { OAuthSession } from "../oauth/session";

const PREFIX = "buzz.builderlab.adapter-identity.v1:";
type Identity = {
  target: string;
  subject: string;
  id: string;
  registration?: RegistrationIntent;
};

/** Bridge Agents' lifecycle and provider settings to Beekeeper. */
export function builderlabType(
  client: AgentClient,
  session: OAuthSession,
  relay: RelayData,
): AgentType {
  const scope = () => ({
    target: oauthTarget(),
    subject: session.credential().account.subject,
  });
  function remember(
    pubkey: string,
    id: string,
    registration?: RegistrationIntent,
  ) {
    // Retain the backend ID for delete replay, including after backend removal.
    // This contains neither a credential nor an owner proof.
    const saved: Identity = { ...scope(), id };
    if (registration) saved.registration = registration;
    localStorage.setItem(PREFIX + pubkey, JSON.stringify(saved));
    return saved;
  }
  function identity(pubkey: string): Identity | undefined {
    const saved = localStorage.getItem(PREFIX + pubkey);
    if (saved === null) return undefined;
    const value: Identity = JSON.parse(saved);
    if (
      !value ||
      typeof value.target !== "string" ||
      typeof value.subject !== "string" ||
      typeof value.id !== "string" ||
      !value.id.trim()
    )
      throw new Error("Saved Builderlab agent identity is invalid.");
    const current = scope();
    if (value.target !== current.target || value.subject !== current.subject)
      throw new Error(
        "Sign in to the Builderlab account that created this agent.",
      );
    return value;
  }
  /** The agent's saved identity, else the signed-in account's listing of it. */
  async function resolve(pubkey: string, signal: AbortSignal) {
    const saved = identity(pubkey);
    if (saved) return saved;
    const credential = session.credential();
    const agent = (await client.list(signal)).find(
      (row) => row.pubkey === pubkey,
    );
    if (session.credential() !== credential)
      throw new DOMException("Builderlab session changed.", "AbortError");
    if (!agent) throw new Error("Agent not found in this Builderlab account.");
    return remember(pubkey, agent.id);
  }
  return {
    id: "builderlab",
    title: "Builderlab",
    description: "Sign in to Builderlab when creating an agent.",
    defaults: () => ({ config: {} }),
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        splitSettings: true,
        component: createSettingsTab(client, session),
      },
      {
        id: "activity",
        title: "Activity",
        role: "activity",
        component: createActivityTab(relay),
      },
    ],
    remote: {
      async provision({ name, signal, agentType }) {
        await session.ensureSignedIn(signal);
        return client.register(
          name,
          signal,
          ({ pubkey, id }, intent) => remember(pubkey, id, intent),
          agentType,
        );
      },
      async activate({ pubkey, auth, community, signal }) {
        const saved = identity(pubkey);
        // Agents persisted unfinished setup before invoking activation. Until
        // here, a failed setup write must still replay the original provision.
        if (saved?.registration) clearRegistration(saved.registration);
        await client.activate(pubkey, auth, community, signal);
      },
      async profile() {
        // TODO: publish name and picture changes through Beekeeper.
        throw new Error(
          "Builderlab agent profile updates are not supported yet.",
        );
      },
      async interrupt({ pubkey, signal, ...place }) {
        // A stop is urgent: it never waits on an interactive sign-in.
        session.credential();
        return client.cancelTurn(await resolve(pubkey, signal), place, signal);
      },
      async remove({ pubkey, signal }) {
        await session.ensureSignedIn(signal);
        const saved = await resolve(pubkey, signal);
        await client.delete(saved, signal);
        if (saved.registration) clearRegistration(saved.registration);
      },
    },
  };
}
