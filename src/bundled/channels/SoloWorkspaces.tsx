import { useChatConversions } from "../../features/solo/conversion";
import { ConvertToChannel } from "../../features/solo/ConvertToChannel";
import { SoloShare, ChatAccessIndicator } from "./SoloShare";
import { useChannelNavigation } from "../../features/channel-navigation/ChannelNavigationState";
import { soloDraftTarget } from "../../features/channel-navigation/routes";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { ChannelLifecycleAction } from "../../features/relay/channel-lifecycle-protocol";
import { Collapsible } from "@base-ui/react/collapsible";
import { useDroppable } from "@dnd-kit/core";
import {
  ChannelSidebarDnd,
  DraggableChannel,
} from "../../features/channel-navigation/ChannelSidebarDnd";
import { WorkspaceSettings } from "../../features/solo/WorkspaceSettings";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import { readView, writeView } from "../../shared/view-state";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
} from "../../shared/design-system/ui/Menu";
import {
  CaretDownIcon,
  DotsThreeIcon,
  PlusIcon,
} from "../../shared/design-system/icons";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import type { Navigation } from "../../features/navigation/controller";
import {
  NewWorkspaceDialog,
  SoloChatMenuItems,
  useChatCopy,
} from "./SoloChatMenu";
import styles from "./SoloWorkspaces.module.css";
import channelStyles from "./Channels.module.css";

/** Presentation only. The caller supplies authorized, saved chats. */
export type ChatListItem = Readonly<{ id: string; title: string }>;

/** The existing relay preference service owns delivery, rollback and retry. */
export function SoloWorkspaces({
  session,
  navigator: navigationController,
  scope,
  chats,
  renderChat,
  onNew,
  onConverted,
  visit,
}: {
  onConverted?: ((id: string) => void) | undefined;
  visit?: AbortSignal;
  session: RelaySession;
  navigator?: Navigation | undefined;
  scope: string;
  chats: readonly ChatListItem[];
  renderChat: (item: ChatListItem) => ReactNode;
  onNew?: (projectId?: string) => void;
}) {
  useChatConversions(session);
  const handoff = useChannelNavigation();
  const [copy, copyNotice] = useChatCopy();
  const preferences = session.soloPreferences;
  const collapsedKey = "solo:collapsed-projects";
  const snapshot = useSyncExternalStore(
    preferences.subscribe,
    preferences.snapshot,
    preferences.snapshot,
  );
  const channels = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
  );
  useEffect(() => {
    if (channels.status === "ready") void preferences.ensure();
  }, [preferences, channels.status]);
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    const saved = readView<unknown>(scope, collapsedKey, []);
    return Array.isArray(saved)
      ? saved.filter((id): id is string => typeof id === "string")
      : [];
  });
  const [sharing, setSharing] = useState<{
    id: string;
    visit: AbortSignal | undefined;
  }>();
  const sharingChannel = channels.channels.find(
    (channel) => channel.id === sharing?.id,
  );
  const [converting, setConverting] = useState<{
    id: string;
    visit: AbortSignal | undefined;
  }>();
  const currentVisit = useRef(visit);
  currentVisit.current = visit;
  const [chatSettings, setChatSettings] = useState<{
    item: ChatListItem;
    visit: AbortSignal | undefined;
  }>();
  const [deleting, setDeleting] = useState<string>();
  const [projectError, setProjectError] = useState("");
  const [readError, setReadError] = useState<{ id: string; message: string }>();
  const [animate, setAnimate] = useState(false);
  const [rowFocus, setRowFocus] = useState<string>();
  useLayoutEffect(() => {
    if (!rowFocus) return;
    document
      .querySelector<HTMLElement>(`[data-solo-menu-id="${rowFocus}"] button`)
      ?.focus({ preventScroll: true });
    setRowFocus(undefined);
  }, [rowFocus]);
  const [creatingFor, setCreatingFor] = useState<ChatListItem>();
  const [settingsFor, setSettingsFor] = useState<{
    id: string;
    name: string;
  }>();
  const groups = snapshot.data?.sections ?? [];
  const assigned = snapshot.data?.assignments ?? {};
  const ids = new Set(groups.map((group) => group.id));
  const projects = [
    ...groups.map((group) => ({
      ...group,
      rows: chats.filter((item) => assigned[item.id] === group.id),
    })),
    {
      id: "",
      name: "Chats",
      rows: chats.filter((item) => !ids.has(assigned[item.id] ?? "")),
    },
  ];
  const move = (id: string, projectId?: string) => {
    const saving = preferences.assign(id, projectId);
    toggle(projectId ?? "", true);
    setRowFocus(id);
    void saving.catch(() => {
      // A rollback remounts the original row. Do not steal focus if the user moved on.
      if (
        !document.querySelector(`[data-solo-menu-id="${id}"]`) ||
        document.activeElement !== document.body
      )
        return;
      setRowFocus(id);
    });
  };
  // Matches the open chat's own actions menu: leaving the open chat returns to
  // a new Solo draft, unless the user has already moved on.
  const chooseLifecycle = (
    channel: ChannelSummary,
    action: ChannelLifecycleAction,
  ) => {
    const trigger =
      document.querySelector<HTMLElement>(
        `[data-solo-menu-id="${CSS.escape(channel.id)}"] button`,
      ) ?? undefined;
    const current = navigationController?.snapshot();
    const leavesOpenChat =
      action !== "unarchive" &&
      current?.entry.target.kind === "conversation" &&
      current.entry.target.channelId === channel.id;
    // Let the menu restore focus before opening confirmation.
    requestAnimationFrame(() =>
      handoff?.openLifecycle(channel, action, trigger, undefined, {
        close() {
          if (trigger?.isConnected) trigger.focus({ preventScroll: true });
        },
        completed() {
          if (leavesOpenChat && !current.attempt.signal.aborted)
            void navigationController?.open(soloDraftTarget(scope));
        },
      }),
    );
  };
  const toggle = (id: string, open: boolean) => {
    const next = open
      ? collapsed.filter((key) => key !== id)
      : [...collapsed, id];
    setCollapsed(next);
    writeView(scope, collapsedKey, next);
  };
  const moves =
    snapshot.moves?.filter((move) =>
      chats.some((item) => item.id === move.channelId),
    ) ?? [];
  return (
    <>
      {(snapshot.status === "idle" || snapshot.status === "loading") && (
        <p role="status" className={styles.listMessage}>
          Loading workspaces…
        </p>
      )}
      {snapshot.status === "error" && (
        <div role="alert" className={styles.listMessage}>
          <p>{snapshot.error ?? "Workspaces couldn’t load."}</p>
          <Button onClick={() => void preferences.refresh()}>
            Retry workspaces
          </Button>
        </div>
      )}
      {projectError && (
        <p role="alert" className={styles.listMessage}>
          {projectError}
        </p>
      )}
      {readError && (
        <p role="alert" className={styles.listMessage}>
          {readError.message}
        </p>
      )}
      <ChannelSidebarDnd
        writable={preferences.writable}
        onMove={(id, key) => move(id, key.slice(DROP.length) || undefined)}
        // Solo projects keep their saved order; only chats drag.
        onReorder={() => {}}
        overlay={(id) => {
          const item = chats.find((item) => item.id === id);
          return (
            item && (
              <div className={channelStyles.channelDragOverlay}>
                <span>{item.title}</span>
              </div>
            )
          );
        }}
      >
        {projects
          .filter((project) => project.id || project.rows.length)
          .map((project) => (
            <DropProject
              projectKey={DROP + project.id}
              key={project.id}
              className={`${styles.project} ${channelStyles.channelSection}`}
              data-project={project.id ? "" : undefined}
              open={!collapsed.includes(project.id)}
              onOpenChange={(open) => toggle(project.id, open)}
              data-animate={animate || undefined}
            >
              <ChatActionsMenu
                id={`project-${project.id}`}
                title={project.name}
                className={`${channelStyles.sectionHeader} ${styles.projectHeader}`}
                enabled={!!project.id}
                trailing={
                  <div className={channelStyles.sectionActions}>
                    {onNew && (
                      <IconButton
                        size="compact"
                        aria-label={`New chat in ${project.name}`}
                        title="New chat"
                        icon={<PlusIcon size={15} strokeWidth={2.5} />}
                        onClick={() => onNew(project.id || undefined)}
                      />
                    )}
                  </div>
                }
                content={
                  <>
                    <MenuItem onClick={() => setSettingsFor(project)}>
                      Workspace settings…
                    </MenuItem>
                    <MenuItem
                      tone="danger"
                      data-delete-solo-project=""
                      disabled={
                        !preferences.sectionRemovalWritable || !!deleting
                      }
                      onClick={() => {
                        setDeleting(project.id);
                        setProjectError("");
                        void preferences
                          .removeSection(project.id)
                          .catch((error: unknown) => {
                            setProjectError(
                              error instanceof Error
                                ? error.message
                                : "Workspace could not be deleted. Try again.",
                            );
                          })
                          .finally(() => setDeleting(undefined));
                      }}
                    >
                      Delete workspace
                    </MenuItem>
                  </>
                }
              >
                <Collapsible.Trigger
                  type="button"
                  className={`${channelStyles.sidebarSectionHeading} ${styles.projectHeading}`}
                  aria-expanded={!collapsed.includes(project.id)}
                  onClick={(event) => setAnimate(event.detail > 0)}
                >
                  <span className={channelStyles.sectionTitle}>
                    {project.name}
                  </span>
                  <span
                    className={channelStyles.sectionChevron}
                    aria-hidden="true"
                  >
                    <CaretDownIcon size={15} strokeWidth={2.5} />
                  </span>
                </Collapsible.Trigger>
              </ChatActionsMenu>
              <Collapsible.Panel className={styles.projectPanel}>
                {project.rows.map((item) => {
                  const channel = channels.channels.find(
                    (channel) => channel.id === item.id,
                  );
                  return (
                    <ChatActionsMenu
                      key={item.id}
                      id={item.id}
                      title={item.title}
                      indicator={
                        <ChatAccessIndicator
                          session={session}
                          channel={channel}
                          onClick={() => setSharing({ id: item.id, visit })}
                        />
                      }
                      className={styles.organizedRow}
                      content={
                        channel && (
                          <SoloChatMenuItems
                            session={session}
                            channel={channel}
                            onShare={() => setSharing({ id: item.id, visit })}
                            onConvert={() =>
                              setConverting({ id: item.id, visit })
                            }
                            onMove={(projectId) => move(item.id, projectId)}
                            onNewWorkspace={() => setCreatingFor(item)}
                            onCopy={copy}
                            onSettings={() => setChatSettings({ item, visit })}
                            onLifecycle={
                              handoff &&
                              ((action) => chooseLifecycle(channel, action))
                            }
                            onReadResult={(error) =>
                              setReadError((current) =>
                                error
                                  ? { id: item.id, message: error }
                                  : current?.id === item.id
                                    ? undefined
                                    : current,
                              )
                            }
                          />
                        )
                      }
                    >
                      <DraggableChannel
                        channelId={item.id}
                        sectionKey={DROP + project.id}
                      >
                        {renderChat(item)}
                      </DraggableChannel>
                    </ChatActionsMenu>
                  );
                })}
                {!project.rows.length &&
                  project.id &&
                  (onNew ? (
                    // An empty project offers its way out instead of an empty state.
                    <NavigationItem
                      variant="row"
                      label="New chat"
                      aria-label={`New chat in ${project.name}`}
                      title={`New chat in ${project.name}`}
                      icon={
                        <span className="shell-page-icon">
                          <PlusIcon size={16} strokeWidth={2.5} />
                        </span>
                      }
                      onClick={() => onNew(project.id)}
                    />
                  ) : (
                    <p className={styles.listMessage}>
                      No chats in this workspace.
                    </p>
                  ))}
              </Collapsible.Panel>
            </DropProject>
          ))}
      </ChannelSidebarDnd>
      {converting && (
        <ConvertToChannel
          key={converting.id}
          session={session}
          id={converting.id}
          signal={converting.visit}
          onConverted={() => onConverted?.(converting.id)}
          close={() => setConverting(undefined)}
          finalFocus={() =>
            document.querySelector<HTMLElement>(
              `[data-solo-menu-id="${converting.id}"] button`,
            ) ?? false
          }
        />
      )}
      {sharing && sharingChannel && (
        <SoloShare
          key={sharing.id}
          navigator={navigationController}
          session={session}
          channel={sharingChannel}
          signal={sharing.visit}
          onConverted={() => onConverted?.(sharing.id)}
          finalFocus={() =>
            document.querySelector<HTMLElement>(
              `[data-solo-menu-id="${sharing.id}"] button`,
            ) ?? false
          }
          initialOpen
          renderTrigger={() => null}
          onClose={() => setSharing(undefined)}
        />
      )}
      {chatSettings && (
        <WorkspaceSettings
          key={chatSettings.item.id}
          signal={chatSettings.visit}
          finalFocus={() =>
            document.querySelector<HTMLElement>(
              `[data-solo-menu-id="${chatSettings.item.id}"] button`,
            ) ?? false
          }
          session={session}
          scope={scope}
          target={{
            kind: "chat",
            id: chatSettings.item.id,
            name: chatSettings.item.title,
          }}
          close={() => setChatSettings(undefined)}
        />
      )}
      {moves.some((move) => move.pending) && (
        <p role="status" className={styles.listMessage}>
          Saving workspace…
        </p>
      )}
      {moves
        .filter((move) => move.error)
        .map((move) => (
          <div role="alert" key={move.id} className={styles.listMessage}>
            <p>{move.error}</p>
            <Button
              disabled={!preferences.writable}
              onClick={() =>
                void preferences.retryMove(move.channelId).catch(() => {})
              }
            >
              Retry move
            </Button>
            <Button
              onClick={() => preferences.dismissMoveError(move.channelId)}
            >
              Dismiss
            </Button>
          </div>
        ))}
      {copyNotice}
      {settingsFor && (
        <WorkspaceSettings
          key={settingsFor.id}
          session={session}
          scope={scope}
          target={{ kind: "project", ...settingsFor }}
          close={() => setSettingsFor(undefined)}
        />
      )}
      {creatingFor && (
        <NewWorkspaceDialog
          key={creatingFor.id}
          name={creatingFor.title}
          close={() => setCreatingFor(undefined)}
          create={(name) => {
            if (!preferences.writable) return false;
            const id = crypto.randomUUID();
            void preferences
              .createAndAssign(creatingFor.id, { id, name })
              .catch(() => {});
            toggle(id, true);
            setCreatingFor(undefined);
            return true;
          }}
        />
      )}
    </>
  );
}

const DROP = "project:";

/** A drop reports only its destination, so it saves exactly like Move to. */
function DropProject({
  projectKey,
  ...props
}: ComponentProps<typeof Collapsible.Root> & { projectKey: string }) {
  const { setNodeRef, isOver, active } = useDroppable({ id: projectKey });
  return (
    <Collapsible.Root
      {...props}
      ref={setNodeRef}
      data-drop-target={
        (isOver && active?.data.current?.sectionKey !== projectKey) || undefined
      }
    />
  );
}

/** Both entry points use one action list; right-click never selects the row. */
function ChatActionsMenu({
  id,
  title,
  className,
  children,
  content,
  indicator,
  enabled = true,
  trailing,
}: {
  id: string;
  title: string;
  className: string | undefined;
  children: ReactNode;
  content: ReactNode;
  indicator?: ReactNode;
  enabled?: boolean;
  /** Follows the overflow action, preserving header action keyboard order. */
  trailing?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement>();
  const restoreFocus = () =>
    document.querySelector<HTMLElement>(`[data-solo-menu-id="${id}"] button`) ??
    false;
  if (!enabled)
    return (
      <div className={className}>
        {children}
        {trailing}
      </div>
    );
  return (
    <ContextMenuRoot
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setAnchor(undefined);
      }}
    >
      <ContextMenuTrigger
        render={<div className={className} data-solo-menu-id={id} />}
        onKeyDown={(event) => {
          if (
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          ) {
            event.preventDefault();
            event.stopPropagation();
            setAnchor(event.currentTarget);
            setOpen(true);
          }
        }}
      >
        {children}
        {indicator}
        <MenuRoot>
          <MenuTrigger
            render={(props) => (
              <IconButton
                {...props}
                data-solo-row-action=""
                variant="bare"
                size="compact"
                data-solo-overflow-action=""
                aria-label={`Actions for ${title}`}
                icon={<DotsThreeIcon size={15} strokeWidth={2.5} />}
              />
            )}
          />
          <MenuPopup
            aria-label={`Actions for ${title}`}
            align="end"
            finalFocus={restoreFocus}
          >
            {content}
          </MenuPopup>
        </MenuRoot>
        {trailing}
      </ContextMenuTrigger>
      <MenuPopup
        aria-label={`Actions for ${title}`}
        anchor={anchor}
        finalFocus={restoreFocus}
      >
        {content}
      </MenuPopup>
    </ContextMenuRoot>
  );
}
