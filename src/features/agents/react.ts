import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { ChannelQueries } from "../relay/contracts";
import type { ChannelChoice } from "./attention";
import type { Agents, Models } from "./service";

const noSubscribe = () => () => {};
const none = () => undefined;

/** The selected community's agents and the registered types. */
export function useAgents(agents: Agents) {
  const snapshot = useSyncExternalStore(
    agents.subscribe,
    agents.snapshot,
    agents.snapshot,
  );
  const types = useSyncExternalStore(
    agents.subscribe,
    agents.types,
    agents.types,
  );
  return { snapshot, types };
}

/** Agents' snapshot, or undefined without it. */
export function useAgentsSnapshot(agents: Agents | undefined) {
  const subscribe = agents?.subscribe ?? noSubscribe;
  const snapshot = agents?.snapshot ?? none;
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
const noTeams: readonly never[] = Object.freeze([]);
/** The owner's teams on this device, or none without Agents. */
export const useTeams = (agents: Agents | undefined) =>
  useAgentsSnapshot(agents)?.teams ?? noTeams;

/** The agent at `pubkey`, with its type when that is registered. A saved
 * agent whose type plugin is disabled or reloading is still an agent. */
export function useAgent(agents: Agents | undefined, pubkey: string) {
  const subscribe = agents?.subscribe ?? noSubscribe;
  const agent = useSyncExternalStore(
    subscribe,
    agents ? () => agents.find(pubkey) : none,
    agents ? () => agents.find(pubkey) : none,
  );
  const type = useSyncExternalStore(
    subscribe,
    agents && agent
      ? () => agents.types().find((type) => type.key === agent.type)
      : none,
    none,
  );
  return agent ? { agent, type } : undefined;
}

/** The app's Agents, for surfaces such as the composer that plugins do not own. */
export const AgentsContext = createContext<Agents | undefined>(undefined);

export const MentionModelsContext = createContext<
  | ((pubkeys: readonly string[]) => Promise<readonly MentionModelChoice[]>)
  | undefined
>(undefined);

export type MentionModelChoice = Models &
  Readonly<{ pubkey: string; name: string; loading?: boolean }>;
/** The mentioned agents, of the viewer's own, whose type offers a choice of
 * model or effort. */
export function useMentionModels(
  pubkeys: readonly string[],
): readonly MentionModelChoice[] {
  const remote = useContext(MentionModelsContext);
  const agents = useContext(AgentsContext);
  const subscribe = agents?.subscribe ?? noSubscribe;
  const snapshot = useSyncExternalStore(
    subscribe,
    agents ? agents.snapshot : none,
    none,
  );
  const types = useSyncExternalStore(
    subscribe,
    agents ? agents.types : none,
    none,
  );
  const key = [...new Set(pubkeys)].join(":");
  const [resolved, setResolved] = useState<{
    remote: typeof remote;
    snapshot: typeof snapshot;
    types: typeof types;
    key: string;
    choices: readonly MentionModelChoice[];
  }>();
  useEffect(() => {
    let current = true;
    void (
      remote
        ? remote(key ? key.split(":") : []).catch(() => [])
        : Promise.all(
            key
              .split(":")
              .map(async (pubkey): Promise<MentionModelChoice[]> => {
                const agent = snapshot?.agents.find(
                  (item) => item.pubkey === pubkey,
                );
                const type =
                  agent && types?.find((item) => item.key === agent.type);
                if (!agent || !type?.models) return [];
                try {
                  const { current, models, sendDefaults } =
                    await type.models(agent);
                  return models.length > 1 ||
                    models.some((m) => m.efforts.length)
                    ? [
                        {
                          pubkey,
                          name: agent.name,
                          current,
                          models,
                          ...(sendDefaults ? { sendDefaults: true } : {}),
                        },
                      ]
                    : [];
                } catch (error) {
                  console.warn(
                    `Agent type ${type.key} could not list its models`,
                    error,
                  );
                  return [];
                }
              }),
          ).then((choices) => choices.flat())
    ).then((choices) => {
      if (current) setResolved({ remote, snapshot, types, key, choices });
    });
    return () => {
      current = false;
    };
  }, [snapshot, types, key, remote]);
  // Never offer a previous agent/config's choices while the new lookup settles.
  return resolved?.remote === remote &&
    resolved?.snapshot === snapshot &&
    resolved?.types === types &&
    resolved?.key === key
    ? resolved.choices
    : key.split(":").flatMap((pubkey) => {
        const agent = snapshot?.agents.find((item) => item.pubkey === pubkey);
        const type = agent && types?.find((item) => item.key === agent.type);
        return agent && type?.models
          ? [
              {
                pubkey,
                name: agent.name,
                current: "",
                models: [],
                loading: true,
              },
            ]
          : [];
      });
}

const noList = () => undefined;
/** Channels a watch can be scoped to, by name, from the viewer's joined roster. */
export function useChannelChoices(
  queries: ChannelQueries | undefined,
): readonly ChannelChoice[] {
  useEffect(() => queries?.ensureList(), [queries]);
  const list = useSyncExternalStore(
    queries?.subscribeList ?? noSubscribe,
    queries?.list ?? noList,
    queries?.list ?? noList,
  );
  return useMemo(
    () =>
      (list?.channels ?? [])
        .filter((channel) => !channel.readOnly)
        .map(({ id, name }) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [list],
  );
}
