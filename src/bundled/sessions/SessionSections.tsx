import { SessionShare } from "./SessionShare";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { RenameSession } from "../../features/sessions/RenameSession";
import { Collapsible } from "@base-ui/react/collapsible";
import { WorkspaceSettings } from "../../features/sessions/WorkspaceSettings";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import { readView, writeView } from "../../shared/view-state";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Input } from "../../shared/design-system/ui/Input";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuIcon,
  MenuSubmenu,
  MenuSubmenuTrigger,
  MenuSubmenuPopup,
} from "../../shared/design-system/ui/Menu";
import {
  CaretDownIcon,
  DotsThreeIcon,
  FolderSimpleIcon,
  PlusIcon,
  PencilSimpleIcon,
  CopyIcon,
  GearIcon,
} from "../../shared/design-system/icons";
import type { SessionListItem } from "./SessionsWorkspace";
import styles from "./SessionsWorkspace.module.css";
import channelStyles from "../channels/Channels.module.css";

/** The existing relay preference service owns delivery, rollback and retry. */
export function SessionSections({
  session,
  scope,
  sessions,
  renderSession,
  onNew,
  personal = false,
  onShared,
  visit,
}: {
  personal?: boolean;
  onShared?: (id: string) => void;
  visit?: AbortSignal;
  session: RelaySession;
  scope: string;
  sessions: readonly SessionListItem[];
  renderSession: (item: SessionListItem) => ReactNode;
  onNew?: (sectionId?: string) => void;
}) {
  const [copyNotice, setCopyNotice] = useState<{
    text: string;
    error: boolean;
  }>();
  const copying = useRef(false);
  const copy = async (value: string, label: string) => {
    if (copying.current) return;
    copying.current = true;
    setCopyNotice(undefined);
    try {
      await navigator.clipboard.writeText(value);
      setCopyNotice({ text: `${label} copied`, error: false });
    } catch {
      setCopyNotice({
        text: "Couldn’t copy. Try again from the session menu.",
        error: true,
      });
    } finally {
      copying.current = false;
    }
  };
  const preferences = personal
    ? session.mePreferences
    : session.sidebarPreferences;
  const collapsedKey = `${personal ? "me" : "sessions"}:collapsed-sections`;
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
    if (!personal || channels.status === "ready") void preferences.ensure();
  }, [preferences, personal, channels.status]);
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
  const currentVisit = useRef(visit);
  currentVisit.current = visit;
  const [sessionSettings, setSessionSettings] = useState<SessionListItem>();
  const [renaming, setRenaming] = useState<SessionListItem>();
  const [deleting, setDeleting] = useState<string>();
  const [deleteError, setDeleteError] = useState("");
  const [animate, setAnimate] = useState(false);
  const [rowFocus, setRowFocus] = useState<string>();
  useLayoutEffect(() => {
    if (!rowFocus) return;
    document
      .querySelector<HTMLElement>(`[data-session-menu-id="${rowFocus}"] button`)
      ?.focus({ preventScroll: true });
    setRowFocus(undefined);
  }, [rowFocus]);
  const [creatingFor, setCreatingFor] = useState<SessionListItem>();
  const [settingsFor, setSettingsFor] = useState<{
    id: string;
    name: string;
  }>();
  const groups = snapshot.data?.sections ?? [];
  const assigned = snapshot.data?.assignments ?? {};
  const ids = new Set(groups.map((group) => group.id));
  const sections = [
    ...groups.map((group) => ({
      ...group,
      rows: sessions.filter((item) => assigned[item.id] === group.id),
    })),
    {
      id: "",
      name: personal ? "Conversations" : "Sessions",
      rows: sessions.filter((item) => !ids.has(assigned[item.id] ?? "")),
    },
  ];
  const move = (id: string, sectionId?: string) => {
    const saving = preferences.assign(id, sectionId);
    toggle(sectionId ?? "", true);
    setRowFocus(id);
    void saving.catch(() => {
      // A rollback remounts the original row. Do not steal focus if the user moved on.
      if (
        !document.querySelector(`[data-session-menu-id="${id}"]`) ||
        document.activeElement !== document.body
      )
        return;
      setRowFocus(id);
    });
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
      sessions.some((item) => item.id === move.channelId),
    ) ?? [];
  return (
    <>
      {onNew && (
        <div className={`${styles.section} ${styles.sectionHeader}`}>
          <button
            type="button"
            className={`${styles.sectionHeading} ${styles.newSessionHeading}`}
            onClick={() => onNew(undefined)}
          >
            <span className={styles.sectionIcon} aria-hidden="true">
              <PlusIcon size={15} strokeWidth={2.5} />
            </span>
            <span>{personal ? "New conversation" : "New session"}</span>
          </button>
        </div>
      )}
      {(snapshot.status === "idle" || snapshot.status === "loading") && (
        <p role="status" className={styles.listMessage}>
          Loading sections…
        </p>
      )}
      {snapshot.status === "error" && (
        <div role="alert" className={styles.listMessage}>
          <p>{snapshot.error ?? "Sections couldn’t load."}</p>
          <Button onClick={() => void preferences.refresh()}>
            Retry sections
          </Button>
        </div>
      )}
      {deleteError && (
        <p role="alert" className={styles.listMessage}>
          {deleteError}
        </p>
      )}
      {sections
        .filter((section) => !personal || section.id || section.rows.length)
        .map((section) => (
          <Collapsible.Root
            key={section.id}
            className={styles.section}
            open={!collapsed.includes(section.id)}
            onOpenChange={(open) => toggle(section.id, open)}
            data-animate={animate || undefined}
          >
            <SessionActionsMenu
              id={`section-${section.id}`}
              title={section.name}
              className={styles.sectionHeader}
              enabled={!!section.id}
              content={
                <>
                  <MenuItem onClick={() => setSettingsFor(section)}>
                    Session settings…
                  </MenuItem>
                  <MenuItem
                    tone="danger"
                    data-delete-session-section=""
                    disabled={!preferences.sectionRemovalWritable || !!deleting}
                    onClick={() => {
                      setDeleting(section.id);
                      setDeleteError("");
                      void preferences
                        .removeSection(section.id)
                        .catch((error: unknown) => {
                          setDeleteError(
                            error instanceof Error
                              ? error.message
                              : "Section could not be deleted. Try again.",
                          );
                        })
                        .finally(() => setDeleting(undefined));
                    }}
                  >
                    Delete section
                  </MenuItem>
                </>
              }
            >
              <Collapsible.Trigger
                type="button"
                className={styles.sectionHeading}
                aria-expanded={!collapsed.includes(section.id)}
                onClick={(event) => setAnimate(event.detail > 0)}
              >
                {section.id && (
                  <span className={styles.sectionIcon} aria-hidden="true">
                    <FolderSimpleIcon
                      className={styles.folderGlyph}
                      size={15}
                    />
                    <span className={styles.chevronGlyph}>
                      <CaretDownIcon size={15} strokeWidth={2.5} />
                    </span>
                  </span>
                )}
                <span>{section.name}</span>
                {!section.id && (
                  <span
                    className={`${channelStyles.sectionChevron} ${styles.genericChevron}`}
                    aria-hidden="true"
                  >
                    <CaretDownIcon size={15} strokeWidth={2.5} />
                  </span>
                )}
              </Collapsible.Trigger>
              <div className={styles.sectionActions}>
                {onNew && section.id && (
                  <IconButton
                    data-session-row-action=""
                    size="compact"
                    aria-label={`New session in ${section.name}`}
                    title="New session"
                    icon={<PlusIcon size={15} strokeWidth={2.5} />}
                    onClick={() => onNew(section.id || undefined)}
                  />
                )}
              </div>
            </SessionActionsMenu>
            <Collapsible.Panel className={styles.sectionPanel}>
              {section.rows.map((item) => (
                <SessionActionsMenu
                  key={item.id}
                  id={item.id}
                  title={item.title}
                  className={styles.organizedRow}
                  content={
                    <>
                      {personal && (
                        <MenuItem
                          onClick={() => setSharing({ id: item.id, visit })}
                        >
                          Share…
                        </MenuItem>
                      )}
                      <MenuItem
                        disabled={
                          !session.channelDetails?.available ||
                          !!channels.channels.find(
                            (channel) => channel.id === item.id,
                          )?.readOnly
                        }
                        onClick={() => setRenaming(item)}
                      >
                        <MenuIcon>
                          <PencilSimpleIcon size={16} />
                        </MenuIcon>
                        Rename
                      </MenuItem>
                      <MenuSubmenu>
                        <MenuSubmenuTrigger disabled={!preferences.writable}>
                          <MenuIcon>
                            <FolderSimpleIcon size={16} />
                          </MenuIcon>
                          {personal ? "Move to" : "Section"}
                        </MenuSubmenuTrigger>
                        <MenuSubmenuPopup aria-label="Session section">
                          {section.id && (
                            <MenuItem onClick={() => move(item.id)}>
                              {personal ? "Conversations" : "Sessions"}
                            </MenuItem>
                          )}
                          {groups.map((group) => (
                            <MenuItem
                              key={group.id}
                              onClick={() => move(item.id, group.id)}
                            >
                              {group.name}
                            </MenuItem>
                          ))}
                          <MenuItem onClick={() => setCreatingFor(item)}>
                            {personal ? "New group…" : "New section…"}
                          </MenuItem>
                        </MenuSubmenuPopup>
                      </MenuSubmenu>
                      <MenuSubmenu>
                        <MenuSubmenuTrigger>
                          <MenuIcon>
                            <CopyIcon size={16} />
                          </MenuIcon>
                          Copy
                        </MenuSubmenuTrigger>
                        <MenuSubmenuPopup aria-label="Copy session">
                          <MenuItem
                            onClick={() =>
                              void copy(item.title, "Session name")
                            }
                          >
                            Copy session name
                          </MenuItem>
                          <MenuItem
                            onClick={() => void copy(item.id, "Session ID")}
                          >
                            Copy session ID
                          </MenuItem>
                          <MenuItem
                            onClick={() =>
                              void copy(
                                `buzz://channel/${encodeURIComponent(item.id)}`,
                                "Session link",
                              )
                            }
                          >
                            Copy link to session
                          </MenuItem>
                        </MenuSubmenuPopup>
                      </MenuSubmenu>

                      {personal && (
                        <MenuItem
                          disabled={
                            !session.canvas.available ||
                            !!channels.channels.find(
                              (channel) => channel.id === item.id,
                            )?.readOnly
                          }
                          onClick={() => setSessionSettings(item)}
                        >
                          <MenuIcon>
                            <GearIcon size={16} />
                          </MenuIcon>
                          Session settings…
                        </MenuItem>
                      )}
                    </>
                  }
                >
                  {renderSession(item)}
                </SessionActionsMenu>
              ))}
              {!section.rows.length && section.id && (
                <p className={styles.listMessage}>
                  No sessions in this section.
                </p>
              )}
            </Collapsible.Panel>
          </Collapsible.Root>
        ))}
      {sharing && sharingChannel && (
        <SessionShare
          key={sharing.id}
          session={session}
          channel={sharingChannel}
          finalFocus={() =>
            document.querySelector<HTMLElement>(
              `[data-session-menu-id="${sharing.id}"] button`,
            ) ?? false
          }
          direct
          initialOpen
          renderTrigger={() => null}
          onClose={() => setSharing(undefined)}
          onShared={() => {
            const id = sharing.id;
            const sameVisit =
              sharing.visit === currentVisit.current && !sharing.visit?.aborted;
            setSharing(undefined);
            if (sameVisit) onShared?.(id);
          }}
        />
      )}
      {sessionSettings && (
        <WorkspaceSettings
          session={session}
          scope={scope}
          target={{
            kind: "session",
            id: sessionSettings.id,
            name: sessionSettings.title,
          }}
          close={() => setSessionSettings(undefined)}
        />
      )}
      {moves.some((move) => move.pending) && (
        <p role="status" className={styles.listMessage}>
          Saving section…
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
      {copyNotice && (
        <ToastNotice
          title={copyNotice.text}
          tone={copyNotice.error ? "error" : "success"}
          timeout={copyNotice.error ? 0 : 4000}
          onDismiss={() => setCopyNotice(undefined)}
        />
      )}
      {settingsFor && (
        <WorkspaceSettings
          key={settingsFor.id}
          session={session}
          scope={scope}
          target={{ kind: "section", ...settingsFor, personal }}
          close={() => setSettingsFor(undefined)}
        />
      )}
      {renaming && (
        <RenameSession
          key={renaming.id}
          session={session}
          id={renaming.id}
          name={renaming.title}
          close={() => setRenaming(undefined)}
        />
      )}
      {creatingFor && (
        <NewSection
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

function NewSection({
  name,
  create,
  close,
}: {
  name: string;
  create: (name: string) => boolean;
  close: () => void;
}) {
  const [value, setValue] = useState("");
  const [blocked, setBlocked] = useState(false);
  const form = useId();
  const input = useRef<HTMLInputElement>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title="Create new section"
      description={`Move ${name} into a personal section that syncs across Buzz.`}
      initialFocus={input}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            form={form}
            type="submit"
            variant="prominent"
            disabled={!value.trim()}
          >
            Create and move
          </Button>
        </>
      }
    >
      <form
        id={form}
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim()) setBlocked(!create(value.trim()));
        }}
      >
        <Input
          ref={input}
          aria-label="Section name"
          placeholder="Section name"
          required
          maxLength={80}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </form>
      {blocked && (
        <p role="alert">
          Sections are unavailable. Close this dialog and retry sections.
        </p>
      )}
    </Dialog>
  );
}

/** Both entry points use one action list; right-click never selects the row. */
function SessionActionsMenu({
  id,
  title,
  className,
  children,
  content,
  enabled = true,
}: {
  id: string;
  title: string;
  className: string | undefined;
  children: ReactNode;
  content: ReactNode;
  enabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement>();
  const restoreFocus = () =>
    document.querySelector<HTMLElement>(
      `[data-session-menu-id="${id}"] button`,
    ) ?? false;
  if (!enabled) return <div className={className}>{children}</div>;
  return (
    <ContextMenuRoot
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setAnchor(undefined);
      }}
    >
      <ContextMenuTrigger
        render={<div className={className} data-session-menu-id={id} />}
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
        <MenuRoot>
          <MenuTrigger
            render={(props) => (
              <IconButton
                {...props}
                data-session-row-action=""
                size="compact"
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
