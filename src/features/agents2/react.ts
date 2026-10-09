import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ChannelQueries } from "../relay/contracts";
import type { ChannelChoice } from "./attention";
import type { Agents2 } from "./service";

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
