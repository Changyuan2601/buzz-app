import type { ChannelSummary } from "../relay/contracts";
import type { SidebarPreferences } from "../relay/sidebar-preferences";
import { ownSolo } from "../solo/labels";

/** Membership permits opening; only deliberate filing puts a shared Solo chat in Team navigation. */
export function inTeamInventory(
  channel: ChannelSummary,
  viewer: string | undefined,
  preferences: SidebarPreferences | undefined,
): boolean {
  if (channel.channelType !== "solo") return true;
  if (ownSolo(channel, viewer)) return false;
  return !!(
    preferences?.starred.includes(channel.id) ||
    preferences?.sections.some(
      (section) => section.id === preferences.assignments[channel.id],
    )
  );
}
