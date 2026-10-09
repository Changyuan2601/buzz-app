import { SidebarFrame } from "../../features/channel-navigation/SidebarFrame";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import { readChannelSidebarWidth } from "../channels/useSidebarView";

/** Me's list is deliberately empty until its contents are defined. */
export function MeSidebar({ relay }: { relay: RelayData }) {
  const connection = useRelayConnection(relay);
  const width = readChannelSidebarWidth(connection.scope ?? "disconnected");
  return (
    <div className="shell-sidebar-default" style={{ width }}>
      <SidebarFrame label="Me sidebar" />
    </div>
  );
}
