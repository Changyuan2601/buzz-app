import { invoke, isTauri } from "@tauri-apps/api/core";
import type { RelayEvent } from "../relay/events";

/** A plugin agent's identity as native custody reports it; never the key. The
 * saved identities are the agent list. */
export type AgentIdentity = Readonly<{
  pubkey: string;
  /** The canonical `wss://` community origin it was created for. */
  relay: string;
  owner: string;
  /** The agent type's key, `pluginId/typeId`, fixed at create. */
  type: string;
  name: string;
  /** Its key is gone; its community still has to drop it from its channels and
   * archive it, after which `forget` removes it. */
  deleted: boolean;
}>;
export type AgentEventTemplate = Readonly<{
  kind: number;
  content: string;
  tags?: readonly (readonly string[])[];
}>;
export type AgentsNative = {
  list(): Promise<readonly AgentIdentity[]>;
  /** Generates a key, has the signed-in owner attest it, and saves both. */
  create(
    destination: string,
    owner: string,
    type: string,
    name: string,
  ): Promise<AgentIdentity>;
  rename(pubkey: string, name: string): Promise<void>;
  /** Deletes the key and marks the identity deleted. */
  remove(pubkey: string): Promise<void>;
  /** Drops a deleted identity. */
  forget(pubkey: string): Promise<void>;
  /** Signs one event as the agent (kinds 5, 7, 9, 40003 only) with its owner
   * attestation and posts it to the agent's community. */
  publish(pubkey: string, event: AgentEventTemplate): Promise<RelayEvent>;
  /** Publishes its name as its profile unless the community already has it. */
  publishProfile(pubkey: string): Promise<void>;
};

export const nativeAgents = (): AgentsNative | undefined =>
  isTauri()
    ? {
        list: () => invoke("app_agent_list"),
        create: (destination, owner, agentType, name) =>
          invoke("app_agent_create", { destination, owner, agentType, name }),
        rename: (pubkey, name) => invoke("app_agent_rename", { pubkey, name }),
        remove: (pubkey) => invoke("app_agent_delete", { pubkey }),
        forget: (pubkey) => invoke("app_agent_forget", { pubkey }),
        publish: (pubkey, event) =>
          invoke("app_agent_publish", {
            pubkey,
            event: {
              kind: event.kind,
              content: event.content,
              tags: event.tags ?? [],
            },
          }),
        publishProfile: (pubkey) =>
          invoke("app_agent_publish_profile", { pubkey }),
      }
    : undefined;
