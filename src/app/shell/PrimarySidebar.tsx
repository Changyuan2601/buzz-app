import type { ContributionReader } from "../../features/conversation/contracts";
import type { ChatIcon } from "../../features/conversation/service";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import type { ReactNode } from "react";
import { RecoveryNotice } from "../../features/relay/RecoveryNotice";
import { ChannelInventory } from "../../features/channel-navigation/ChannelInventory";
import { SidebarBoundary } from "../../features/channel-navigation/SidebarBoundary";
import { SidebarFrame } from "../../features/channel-navigation/SidebarFrame";
import { SidebarList } from "../../features/channel-navigation/SidebarList";
import { ResizableSidebar } from "../../features/channel-navigation/ResizableSidebar";
import { SidebarUnread } from "../../bundled/channels/SidebarUnread";
import { Button } from "../../shared/design-system/ui/Button";
import type { RelayData } from "../../features/relay/service";
import type { Agents } from "../../features/agents/service";
import type { Navigation } from "../../features/navigation/controller";
import type { OpenTarget } from "../../features/navigation/targets";
import { useRelayConnection } from "../../features/relay/react";
import styles from "./PrimarySidebar.module.css";

type Props = {
  relay: RelayData;
  navigator: Navigation;
  agents?: Agents | undefined;
  chatIcons?: ContributionReader<ChatIcon> | undefined;
  target: OpenTarget;
  children: ReactNode;
  creationAction?: ReactNode;
};

/** One inventory for all conversations, with user-owned sections. */
export function PrimarySidebar(props: Props) {
  const connection = useRelayConnection(props.relay);
  const scope = connection.scope ?? "disconnected";
  return (
    <ScopedSidebar
      {...props}
      key={scope}
      scope={scope}
      connection={connection}
    />
  );
}

function ScopedSidebar({
  scope,
  connection,
  ...props
}: Props & {
  scope: string;
  connection: ReturnType<typeof useRelayConnection>;
}) {
  const panelHeader = (
    <PanelHeader divider="full" title={<PanelHeaderLabel title="Messages" />} />
  );
  const header = (
    <>
      <div className={styles.sidebarControls}>{props.creationAction}</div>
      {props.children && (
        <div className={styles.destinations}>{props.children}</div>
      )}
    </>
  );
  return (
    <SidebarBoundary
      key={`${scope}:${connection.generation}`}
      header={header}
      panelHeader={panelHeader}
    >
      {connection.session &&
      (connection.status === "ready" || connection.cached) ? (
        <ChannelInventory
          flatSidebar
          relay={props.relay}
          navigator={props.navigator}
          agents={props.agents}
          chatIcons={props.chatIcons}
          target={props.target}
          queries={connection.session}
          scope={scope}
          viewer={connection.viewer}
          cached={!!connection.cached}
          connectionError={connection.error}
          render={({
            sidebar,
            filterAction,
            dmPreviews,
            frame,
            before,
            content,
            after,
            dialogs,
          }) => (
            <ResizableSidebar scope={scope} className="shell-sidebar" rail>
              <SidebarFrame
                label="Sidebar"
                header={
                  <>
                    <div className={styles.railControls}>
                      {props.creationAction}
                    </div>
                    <div className={styles.expandedControls}>{header}</div>
                  </>
                }
                panelHeader={
                  <div className={styles.expandedControls}>
                    <PanelHeader
                      divider="full"
                      title={<PanelHeaderLabel title="Messages" />}
                      actions={filterAction}
                    />
                  </div>
                }
                {...frame}
              >
                {/* Relay outages for every inventory recover through one
                    automatic owner; its notice is the single Retry. */}
                {!connection.cached && (
                  <RecoveryNotice recovery={connection.session.recovery} />
                )}
                {before}
                <SidebarUnread listRef={sidebar.list} dmPreviews={dmPreviews}>
                  {content}
                </SidebarUnread>
                {after}
              </SidebarFrame>
              {dialogs}
            </ResizableSidebar>
          )}
        />
      ) : (
        <div className="shell-sidebar-default">
          <SidebarFrame
            label="Sidebar"
            header={header}
            panelHeader={panelHeader}
            launchPending={
              connection.status === "connecting" ? "required" : undefined
            }
          >
            <SidebarList>
              <p className={styles.connectionMessage}>
                {connection.status === "connecting"
                  ? "Connecting to your relay…"
                  : (connection.error ?? "Choose a community to see channels.")}
              </p>
              {connection.status === "error" && (
                <Button onClick={props.relay.retry}>Retry channels</Button>
              )}
            </SidebarList>
          </SidebarFrame>
        </div>
      )}
    </SidebarBoundary>
  );
}
