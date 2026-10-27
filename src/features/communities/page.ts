// FOUNDATION: Communities as a page that shows nothing follows them. The
// page that shows them owns the device's record: its memberships, selection
// and viewer. It sends them here each time they change. This page connects
// to the joined communities for its agents with sessions of its own that
// keep nothing on the device, so the other page stays the one owner of what
// the device saves, shows and clears.
import { Context } from "@deepseek-ai/cordis";
import type { LocalAgentSource } from "../agents/local-activity";
import type { LocalAgents } from "../agents/local";
import type { IdentityNames } from "../identity-names/service";
import { provideRelay, type RelayData } from "../relay/service";
import type { ReadTransport } from "../relay/transport";
import { communityDestination } from "./destination";

/** What this page follows of the communities. */
export type FollowedCommunities = Readonly<{
  viewer?: string;
  /** The joined communities' ids. */
  memberships: readonly string[];
  selected: string | null;
}>;

export function pageCommunities(
  ctx: Context,
  connect: (id: string, signal: AbortSignal) => Promise<ReadTransport>,
  options: Readonly<{
    identityNames?: IdentityNames;
    agentChoices?: LocalAgents;
    localAgents?: LocalAgentSource;
  }> = {},
) {
  let state: FollowedCommunities = Object.freeze({
    memberships: [],
    selected: null,
  });
  let disposed = false;
  const listeners = new Set<() => void>();
  // Each session owns a scope so leaving can dispose exactly that one.
  const sessions = new Map<
    string,
    Readonly<{ relay: RelayData; scope: Context }>
  >();
  const release = (id: string) => {
    const session = sessions.get(id);
    sessions.delete(id);
    return session?.scope.fiber.dispose().catch((error: unknown) => {
      console.warn(`Couldn't dispose the agents' session for ${id}`, error);
    });
  };
  const idOf = (id: string) => {
    try {
      return communityDestination(id).id;
    } catch {
      return undefined;
    }
  };
  ctx.effect(() => () => {
    disposed = true;
    listeners.clear();
    return Promise.all([...sessions.keys()].map(release)).then(() => {});
  });
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** A joined community's session, for the viewer that joined it; it lives
     * until the community is left or the viewer changes. */
    open(id: string): RelayData | undefined {
      const key = idOf(id);
      if (disposed || !key || !state.viewer || !state.memberships.includes(key))
        return undefined;
      let session = sessions.get(key);
      if (!session) {
        const scope = new Context();
        session = Object.freeze({
          scope,
          relay: provideRelay(
            scope,
            (signal) => connect(key, signal),
            undefined,
            options.identityNames,
            options.agentChoices,
            undefined,
            options.localAgents,
            { ephemeral: true },
          ),
        });
        sessions.set(key, session);
      }
      return session.relay;
    },
    /** What the page that shows the communities has now. */
    follow(next: FollowedCommunities) {
      if (disposed) return;
      const memberships = [
        ...new Set(next.memberships.flatMap((id) => idOf(id) ?? [])),
      ];
      const selected =
        next.selected === null ? null : (idOf(next.selected) ?? null);
      const followed: FollowedCommunities = Object.freeze({
        ...(next.viewer !== undefined && { viewer: next.viewer }),
        memberships: Object.freeze(memberships),
        selected: selected && memberships.includes(selected) ? selected : null,
      });
      if (
        followed.viewer === state.viewer &&
        followed.selected === state.selected &&
        followed.memberships.length === state.memberships.length &&
        followed.memberships.every(
          (id, index) => state.memberships[index] === id,
        )
      )
        return;
      const viewerChanged = followed.viewer !== state.viewer;
      state = followed;
      for (const id of [...sessions.keys()])
        if (viewerChanged || !memberships.includes(id)) void release(id);
      for (const listener of [...listeners]) listener();
    },
  };
}
export type PageCommunities = ReturnType<typeof pageCommunities>;
