import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import type { ChannelSummary, Profile } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { avatarMedia } from "../../shared/avatar-source";
import styles from "./SidebarChatArtwork.module.css";

/** Conversation identity comes from its members; icons are the last fallback. */
export function SidebarChatArtwork({
  channel,
  profile,
  session,
  icon,
  presence,
}: {
  channel: ChannelSummary;
  profile?: Profile | undefined;
  session: RelaySession;
  icon: ReactNode;
  presence?: "online" | "away" | "offline" | undefined;
}) {
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const choices = useSyncExternalStore(
    session.agentChoices.subscribe,
    session.agentChoices.snapshot,
  );
  const agents = new Map(
    choices.identities.map((agent) => [agent.pubkey, agent]),
  );
  const roster = [...new Set(channel.members ?? channel.participants ?? [])];
  const others = roster.filter((id) => id !== session.viewer);
  const members = others.length ? others : roster;
  // Prefer recognizable portraits already available; cap demand to four profiles.
  const shown = [...members]
    .sort(
      (a, b) =>
        Number(!!profiles.get(b)?.picture) -
          Number(!!profiles.get(a)?.picture) || a.localeCompare(b),
    )
    .slice(0, 4);
  const keys = shown.join(":");
  useEffect(() => {
    if (keys)
      void session.profiles
        .ensure(keys.split(":"), "background")
        .catch(() => {});
  }, [session, keys]);
  const avatar = (id: string, single = false) => {
    const person = profiles.get(id) ?? (single ? profile : undefined);
    const agent = agents.get(id);
    return (
      <Avatar
        src={avatarMedia(person?.picture, session.media)}
        alt=""
        fallback={
          person?.name ?? agent?.name ?? (single ? channel.name : "Member")
        }
        size="fill"
        shape={person?.isAgent || agent ? "squircle" : "circle"}
        statusBadge={single ? presence : undefined}
      />
    );
  };
  return (
    <span
      className={styles.artwork}
      aria-hidden="true"
      data-fallback={!shown.length || undefined}
    >
      {shown.length === 1 ? (
        avatar(shown[0] ?? "", true)
      ) : shown.length > 1 ? (
        <span className={styles.group} data-count={shown.length}>
          {shown.map((id) => (
            <span key={id}>{avatar(id)}</span>
          ))}
        </span>
      ) : (
        icon
      )}
    </span>
  );
}
