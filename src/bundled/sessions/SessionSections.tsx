import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { RenameSession } from "../../features/sessions/RenameSession";
import { Collapsible } from "@base-ui/react/collapsible";
import { WorkspaceSettings } from "../../features/sessions/WorkspaceSettings";
import {
  useEffect,
  useId,
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
}: {
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
  const preferences = session.sidebarPreferences;
  const snapshot = useSyncExternalStore(
    preferences.subscribe,
    preferences.snapshot,
    preferences.snapshot,
  );
  useEffect(() => {
    void preferences.ensure();
  }, [preferences]);
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    const saved = readView<unknown>(scope, "sessions:collapsed-sections", []);
    return Array.isArray(saved)
      ? saved.filter((id): id is string => typeof id === "string")
      : [];
  });
  const [renaming, setRenaming] = useState<SessionListItem>();
  const [deleting, setDeleting] = useState<string>();
  const [deleteError, setDeleteError] = useState("");
  const [animate, setAnimate] = useState(false);
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
      name: "Sessions",
      rows: sessions.filter((item) => !ids.has(assigned[item.id] ?? "")),
    },
  ];
  const move = (id: string, sectionId?: string) => {
    void preferences.assign(id, sectionId).catch(() => {});
    if (sectionId) toggle(sectionId, true);
  };
  const toggle = (id: string, open: boolean) => {
    const next = open
      ? collapsed.filter((key) => key !== id)
      : [...collapsed, id];
    setCollapsed(next);
    writeView(scope, "sessions:collapsed-sections", next);
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
            <span>New session</span>
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
      {sections.map((section) => (
        <Collapsible.Root
          key={section.id}
          className={styles.section}
          open={!collapsed.includes(section.id)}
          onOpenChange={(open) => toggle(section.id, open)}
          data-animate={animate || undefined}
        >
          <div className={styles.sectionHeader}>
            <Collapsible.Trigger
              type="button"
              className={styles.sectionHeading}
              aria-expanded={!collapsed.includes(section.id)}
              onClick={(event) => setAnimate(event.detail > 0)}
            >
              {section.id && (
                <span className={styles.sectionIcon} aria-hidden="true">
                  <FolderSimpleIcon className={styles.folderGlyph} size={15} />
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
              {section.id && (
                <MenuRoot>
                  <MenuTrigger
                    render={(props) => (
                      <IconButton
                        {...props}
                        data-session-row-action=""
                        size="compact"
                        aria-label={`Actions for ${section.name}`}
                        icon={<DotsThreeIcon size={15} strokeWidth={2.5} />}
                      />
                    )}
                  />
                  <MenuPopup
                    aria-label={`Actions for ${section.name}`}
                    align="end"
                  >
                    <MenuItem onClick={() => setSettingsFor(section)}>
                      Session settings…
                    </MenuItem>
                    <MenuItem
                      tone="danger"
                      data-delete-session-section=""
                      disabled={
                        !preferences.sectionRemovalWritable || !!deleting
                      }
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
                  </MenuPopup>
                </MenuRoot>
              )}
            </div>
          </div>
          <Collapsible.Panel className={styles.sectionPanel}>
            {section.rows.map((item) => (
              <div key={item.id} className={styles.organizedRow}>
                {renderSession(item)}
                <MenuRoot>
                  <MenuTrigger
                    render={(props) => (
                      <IconButton
                        {...props}
                        data-session-row-action=""
                        size="compact"
                        aria-label={`Actions for ${item.title}`}
                        icon={<DotsThreeIcon size={15} strokeWidth={2.5} />}
                      />
                    )}
                  />
                  <MenuPopup
                    aria-label={`Actions for ${item.title}`}
                    align="end"
                  >
                    <MenuItem
                      disabled={!session.channelDetails?.available}
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
                        Section
                      </MenuSubmenuTrigger>
                      <MenuSubmenuPopup aria-label="Session section">
                        {section.id && (
                          <MenuItem onClick={() => move(item.id)}>
                            Sessions
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
                          New section…
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
                          onClick={() => void copy(item.title, "Session name")}
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
                  </MenuPopup>
                </MenuRoot>
              </div>
            ))}
            {!section.rows.length && section.id && (
              <p className={styles.listMessage}>No sessions in this section.</p>
            )}
          </Collapsible.Panel>
        </Collapsible.Root>
      ))}
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
          target={{ kind: "section", ...settingsFor }}
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
