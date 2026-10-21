import type { ChannelSummary } from "../../features/relay/contracts";
import type { SidebarPreferences } from "../../features/relay/sidebar-preferences";

export function isChannelSectionKey(key: string) {
  return key === "channels" || key.startsWith("group:");
}

export function isChannelDropSectionKey(key: string) {
  return key === "starred" || isChannelSectionKey(key);
}

/** Preferences only arrange the supplied authorized roster; they never add channels. */
export function sidebarSections<T extends ChannelSummary>(
  channels: readonly T[],
  preferences?: SidebarPreferences,
  hiddenDms: ReadonlySet<string> = new Set(),
) {
  const active = channels.filter(
    (channel) =>
      !channel.archived && (!channel.hidden || channel.channelType === "dm"),
  );
  const movable = active.filter(
    (channel) => channel.channelType !== "dm" || !hiddenDms.has(channel.id),
  );
  const stars = new Set(preferences?.starred);
  const groups = preferences?.sections ?? [];
  const ids = new Set(groups.map((group) => group.id));
  const assignment = (id: string) => preferences?.assignments[id];
  const compareName = (a: ChannelSummary, b: ChannelSummary) =>
    a.name.toLowerCase() < b.name.toLowerCase()
      ? -1
      : a.name.toLowerCase() > b.name.toLowerCase()
        ? 1
        : a.id.localeCompare(b.id);
  const sort = (rows: readonly ChannelSummary[]) =>
    [...rows].sort((a, b) => {
      if (
        a.lastActivityAt !== undefined &&
        b.lastActivityAt !== undefined &&
        a.lastActivityAt !== b.lastActivityAt
      )
        return b.lastActivityAt - a.lastActivityAt;
      if (a.lastActivityAt !== undefined && b.lastActivityAt === undefined)
        return -1;
      if (a.lastActivityAt === undefined && b.lastActivityAt !== undefined)
        return 1;
      return compareName(a, b);
    });
  return [
    {
      key: "starred",
      title: "Starred",
      icon: undefined,
      rows: sort(movable.filter((channel) => stars.has(channel.id))),
    },
    ...groups.map((group) => ({
      key: `group:${group.id}`,
      title: group.name,
      icon: group.icon,
      rows: sort(
        movable.filter(
          (channel) =>
            !stars.has(channel.id) && assignment(channel.id) === group.id,
        ),
      ),
    })),
    {
      key: "channels",
      title: "Recent",
      icon: undefined,
      rows: sort(
        movable.filter(
          (channel) =>
            !stars.has(channel.id) && !ids.has(assignment(channel.id) ?? ""),
        ),
      ),
    },
  ].filter(
    (section) => isChannelSectionKey(section.key) || section.rows.length,
  );
}
