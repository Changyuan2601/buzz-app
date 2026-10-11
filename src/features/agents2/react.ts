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
import type { Agents2, Models } from "./service";

const noSubscribe = () => () => {};
const none = () => undefined;

/** The selected community's Agents2 agents and the registered types. */
export function useAgents2(agents2: Agents2) {
  const snapshot = useSyncExternalStore(
    agents2.subscribe,
    agents2.snapshot,
    agents2.snapshot,
  );
  const types = useSyncExternalStore(
    agents2.subscribe,
    agents2.types,
    agents2.types,
  );
  return { snapshot, types };
}

/** The Agents2 agent at `pubkey`, with its type when that is registered. A saved
 * agent whose type plugin is disabled or reloading is still an Agents2 agent. */
export function useAgent2(agents2: Agents2 | undefined, pubkey: string) {
  const subscribe = agents2?.subscribe ?? noSubscribe;
  const agent = useSyncExternalStore(
    subscribe,
    agents2 ? () => agents2.find(pubkey) : none,
    agents2 ? () => agents2.find(pubkey) : none,
  );
  const type = useSyncExternalStore(
    subscribe,
    agents2 && agent
      ? () => agents2.types().find((type) => type.key === agent.type)
      : none,
    none,
  );
  return agent ? { agent, type } : undefined;
}

/** The app's Agents2, for surfaces such as the composer that plugins do not own. */
export const Agents2Context = createContext<Agents2 | undefined>(undefined);

export type MentionModelChoice = Models &
  Readonly<{ pubkey: string; name: string; loading?: boolean }>;
/** The mentioned agents, of the viewer's own, whose type offers a choice of
 * model or effort. */
export function useMentionModels(
  pubkeys: readonly string[],
): readonly MentionModelChoice[] {
  const agents2 = useContext(Agents2Context);
  const subscribe = agents2?.subscribe ?? noSubscribe;
  const snapshot = useSyncExternalStore(
    subscribe,
    agents2 ? agents2.snapshot : none,
    none,
  );
  const types = useSyncExternalStore(
    subscribe,
    agents2 ? agents2.types : none,
    none,
  );
  const key = [...new Set(pubkeys)].join(":");
  const [resolved, setResolved] = useState<{
    snapshot: typeof snapshot;
    types: typeof types;
    key: string;
    choices: readonly MentionModelChoice[];
  }>();
  useEffect(() => {
    let current = true;
    void Promise.all(
      key.split(":").map(async (pubkey): Promise<MentionModelChoice[]> => {
        const agent = snapshot?.agents.find((item) => item.pubkey === pubkey);
        const type = agent && types?.find((item) => item.key === agent.type);
        if (!agent || !type?.models) return [];
        try {
          const { current, models } = await type.models(agent);
          return models.length > 1 || models.some((m) => m.efforts.length)
            ? [{ pubkey, name: agent.name, current, models }]
            : [];
        } catch (error) {
          console.warn(
            `Agent type ${type.key} could not list its models`,
            error,
          );
          return [];
        }
      }),
    ).then((choices) => {
      if (current)
        setResolved({ snapshot, types, key, choices: choices.flat() });
    });
    return () => {
      current = false;
    };
  }, [snapshot, types, key]);
  // Never offer a previous agent/config's choices while the new lookup settles.
  return resolved?.snapshot === snapshot &&
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
