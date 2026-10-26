import { useEffect, useSyncExternalStore } from "react";
import { knownAgentPubkeys } from "../agents/known";
import type { ComposerSession } from "../messages/composer-session";
import type { Profile } from "../relay/contracts";
import type { MentionRecipient } from "../messages/mention-draft";

/** Whether a Solo chat has another person in it. Alone, the viewer addresses
 * agents and must tag one; once shared, people can talk without a tag. Only a
 * loaded, non-agent profile counts: a member still loading (or failing to)
 * keeps the tag requirement. */
export function soloHasPeople(
  members: readonly string[] | undefined,
  viewer: string | undefined,
  profiles: ReadonlyMap<string, Profile>,
  agents: ReadonlySet<string>,
): boolean {
  return !!members?.some(
    (key) =>
      key !== viewer &&
      !agents.has(key) &&
      !!profiles.get(key) &&
      !profiles.get(key)?.isAgent,
  );
}

/** Who a saved Solo chat's composer may tag: its people (never the viewer,
 * never an agent it doesn't own) plus the viewer's available agents. */
export function soloRoster(
  members: readonly string[] | undefined,
  viewer: string | undefined,
  profiles: ReadonlyMap<string, Profile>,
  agents: ReadonlySet<string>,
  selectable: readonly MentionRecipient[],
): readonly MentionRecipient[] {
  return [
    ...(members ?? [])
      .filter((pubkey) => pubkey !== viewer && !agents.has(pubkey))
      .map((pubkey) => ({
        pubkey,
        name: profiles.get(pubkey)?.name || pubkey.slice(0, 12),
      })),
    ...selectable,
  ];
}

/** Live soloHasPeople for one chat, from the channel list, profiles and agent
 * library. Subscribes nothing unless enabled (the conversation is a Solo chat). */
export function useSoloHasPeople(
  session: ComposerSession,
  channelId: string,
  enabled: boolean,
): boolean {
  const list = useSyncExternalStore(
    enabled ? session.channels.subscribeList : noSubscription,
    enabled ? session.channels.list : noList,
    enabled ? session.channels.list : noList,
  );
  const profiles = useSyncExternalStore(
    enabled ? session.profiles.subscribe : noSubscription,
    enabled ? session.profiles.snapshot : noProfiles,
    enabled ? session.profiles.snapshot : noProfiles,
  );
  const library = useSyncExternalStore(
    enabled ? session.agentChoices.subscribe : noSubscription,
    enabled ? session.agentChoices.snapshot : noLibrary,
    enabled ? session.agentChoices.snapshot : noLibrary,
  );
  const members = list.channels.find(
    (channel) => channel.id === channelId,
  )?.members;
  // An agent is recognized from its profile, so load members' profiles.
  const memberKeys = members?.join(",") ?? "";
  useEffect(() => {
    if (!enabled || !memberKeys) return;
    void session.profiles
      .ensure(memberKeys.split(","), "background")
      .catch(() => {});
  }, [enabled, memberKeys, session]);
  return (
    enabled &&
    soloHasPeople(
      members,
      session.viewer,
      profiles,
      knownAgentPubkeys(profiles, library),
    )
  );
}

const noSubscription = () => () => {};
const emptyList = { status: "ready" as const, channels: [] };
const noList = () => emptyList;
const emptyProfiles = new Map<string, Profile>();
const noProfiles = () => emptyProfiles;
const noLibrary = () => undefined;
