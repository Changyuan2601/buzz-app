import { useEffect, useState, useSyncExternalStore } from "react";
import { SoloInventory } from "../../features/channel-navigation/SoloInventory";
import { soloDraft } from "../../features/channel-navigation/routes";
import { RecoveryNotice } from "../../features/relay/RecoveryNotice";
import { ChannelInventory } from "../../features/channel-navigation/ChannelInventory";
import { SidebarList } from "../../features/channel-navigation/SidebarList";
import { SidebarUnread } from "../channels/SidebarUnread";
import { Button } from "../../shared/design-system/ui/Button";
import type { RelayData } from "../../features/relay/service";
import type { Agents } from "../../features/agents/service";
import type { Navigation } from "../../features/navigation/controller";
import type { OpenTarget } from "../../features/navigation/targets";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import styles from "./MessagesInventory.module.css";

import { useRelayConnection } from "../../features/relay/react";
import { relayPartition } from "../../features/relay/partition";
import { targetKey } from "../../features/navigation/targets";
import { readView, writeView } from "../../shared/view-state";
import type { ChannelList } from "../../features/relay/contracts";
import type { ContributionReader } from "../../features/conversation/contracts";
import type { ChatIcon } from "../../features/conversation/service";

const noSubscription = () => () => {};

type Filter = "all" | "solo" | "team";
const filters = [
  { value: "all", label: "All", panelId: "sidebar-all" },
  { value: "solo", label: "Solo", panelId: "sidebar-solo" },
  { value: "team", label: "Team", panelId: "sidebar-team" },
] as const;

export type MessagesInventoryProps = {
  relay: RelayData;
  navigator: Navigation;
  agents?: Agents | undefined;
  chatIcons?: ContributionReader<ChatIcon> | undefined;
  target: OpenTarget;
};

/** The Messages navigation view: Solo and Team inventories with their filter. */
export function MessagesInventory(props: MessagesInventoryProps) {
  const connection = useRelayConnection(props.relay);
  const scope = connection.scope ?? "disconnected";
  return (
    <ScopedInventory
      {...props}
      key={scope}
      scope={scope}
      connection={connection}
    />
  );
}

function ScopedInventory({
  scope,
  connection,
  ...props
}: MessagesInventoryProps & {
  scope: string;
  connection: ReturnType<typeof useRelayConnection>;
}) {
  const attempt = useSyncExternalStore(
    props.navigator.subscribe,
    () => props.navigator.snapshot().attempt.id,
  );
  const [observedAttempt, setObservedAttempt] = useState(attempt);
  const [view, setView] = useState(() => {
    const saved = readView<{ filter?: unknown; location?: unknown } | null>(
      scope,
      "navigation-scope",
      null,
    );
    return {
      filter:
        saved?.filter === "solo"
          ? "solo"
          : saved?.filter === "team"
            ? "team"
            : ("all" as Filter),
      location:
        typeof saved?.location === "string" ? saved.location : undefined,
    };
  });
  const target = props.target;
  const local =
    "scope" in target &&
    target.scope &&
    relayPartition(target.scope.communityOrigin, target.scope.viewer) === scope;
  // The conversation's own Solo label, not the opening page, says which
  // inventory owns it; an unlisted conversation waits until it is known.
  const channels = connection.session?.channels;
  const channelList = useSyncExternalStore(
    channels?.subscribeList ?? noSubscription,
    () => channels?.list(),
  );
  const preferences = connection.session?.soloPreferences;
  const soloPreferences = useSyncExternalStore(
    preferences?.subscribe ?? noSubscription,
    () => preferences?.snapshot(),
  );
  // A cached startup session has no Solo capabilities yet; its unavailable
  // placeholders still change height when the live inventories arrive.
  const soloReady =
    (connection.status === "ready" || connection.status === "error") &&
    soloPreferences?.status !== "idle" &&
    soloPreferences?.status !== "loading";
  const destination = local
    ? target.kind === "conversation"
      ? conversationDestination(channelList, target.channelId)
      : target.kind === "page" && target.pluginId === "buzz.channels"
        ? soloDraft(target.route?.params)
          ? "solo"
          : "team"
        : undefined
    : undefined;
  const location = destination ? targetKey(target) : undefined;
  // A deliberate filter change leaves the pane alone; only a new destination reveals its inventory.
  if (attempt !== observedAttempt) setObservedAttempt(attempt);
  if (
    destination &&
    location &&
    (view.location !== location || attempt !== observedAttempt)
  ) {
    setView({ filter: view.filter === "all" ? "all" : destination, location });
  }
  useEffect(() => {
    writeView(scope, "navigation-scope", view);
  }, [scope, view]);
  const filter = view.filter;
  const setFilter = (filter: Filter) => setView({ filter, location });
  const panelId = `sidebar-${filter}`;
  const controls = (
    <div className={styles.sidebarControls}>
      <div className={styles.sidebarScope}>
        <Tabs
          label="Navigation scope"
          variant="segmented"
          value={filter}
          items={filters}
          onValueChange={setFilter}
        />
      </div>
    </div>
  );
  const label = (title: string) =>
    filter === "all" && (
      <div className={styles.sidebarScopeLabel}>
        <InlineHeader title={<span className="text-standard">{title}</span>} />
      </div>
    );
  const panel = {
    className: styles.panel,
    id: panelId,
    role: "tabpanel",
    "aria-labelledby": `${panelId}-tab`,
  };
  return connection.session &&
    (connection.status === "ready" || connection.cached) ? (
    <ChannelInventory
      key={`${scope}:${connection.generation}`}
      relay={props.relay}
      navigator={props.navigator}
      agents={props.agents}
      target={props.target}
      queries={connection.session}
      scope={scope}
      viewer={connection.viewer}
      cached={!!connection.cached}
      layoutReady={filter === "team" || soloReady}
      connectionError={connection.error}
      render={({
        sidebar,
        dmPreviews,
        frame,
        before,
        content,
        after,
        dialogs,
      }) => (
        <div
          className={styles.view}
          aria-busy={frame.busy}
          data-buzz-launch-pending={frame.launchPending}
        >
          {controls}
          <div {...panel}>
            {/* Relay outages for every inventory recover through one
                automatic owner; its notice is the single Retry. */}
            {!connection.cached && (
              <RecoveryNotice recovery={connection.session.recovery} />
            )}
            {before}
            <SidebarUnread listRef={sidebar.list} dmPreviews={dmPreviews}>
              <section
                aria-label="Solo"
                className={styles.sidebarGroup}
                hidden={filter === "team"}
              >
                <SoloInventory
                  key={`${scope}:${connection.generation}`}
                  session={connection.session}
                  scope={scope}
                  navigator={props.navigator}
                  target={props.target}
                  chatIcons={props.chatIcons}
                />
              </section>
              <div className={styles.sidebarGroup} hidden={filter === "solo"}>
                {filter === "all" && (
                  <div className={styles.teamHeading}>{label("Team")}</div>
                )}
                {content}
              </div>
            </SidebarUnread>
            {after}
          </div>
          {dialogs}
        </div>
      )}
    />
  ) : (
    <div
      className={styles.view}
      data-buzz-launch-pending={
        connection.status === "connecting" ? "required" : undefined
      }
    >
      {controls}
      <div {...panel}>
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
      </div>
    </div>
  );
}

/** Unknown until the channel list can say; a channel outside it is Team's. */
function conversationDestination(list: ChannelList | undefined, id: string) {
  const channel = list?.channels.find((item) => item.id === id);
  if (!channel && list?.status !== "ready") return undefined;
  return channel?.channelType === "solo" ? "solo" : "team";
}
