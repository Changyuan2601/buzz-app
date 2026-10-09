import styles from "./AgentCard.module.css";
import { npubEncode } from "nostr-tools/nip19";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Button } from "../../shared/design-system/ui/Button";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuIcon,
  MenuNote,
  MenuSeparator,
} from "../../shared/design-system/ui/Menu";
import { ChoiceRow } from "../../shared/design-system/ui/ChoiceRow";
import { useAvatarPreview } from "../../features/profiles/use-avatar-preview";
import {
  ArchiveIcon,
  ArchiveOffIcon,
  CopyIcon,
  DotsThreeIcon,
  PencilSimpleIcon,
  TrashIcon,
} from "../../shared/design-system/icons/index";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { AgentAvatar } from "../../features/agents/AgentAvatar";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
  PopoverTitle,
} from "../../shared/design-system/ui/Popover";
import { avatarSource } from "../../shared/avatar-source";
import { usePresenceStatus } from "../../features/presence/react";
import type { AgentLibrary } from "../../features/agents/library";
import type { AgentView } from "../../features/agents/control";
import type { RelaySession } from "../../features/relay/session";

export type ProfileResolver = (
  pubkey: string,
) => ((trigger: HTMLButtonElement) => void) | undefined;

export function AgentCard({
  name,
  avatar,
  identities,
  session,
  media,
  editable = [],
  onEdit,
  onViewProfile,
  onDuplicate,
  onShare,
  onDelete,
  archive,
  archived = false,
  feedback,
  children,
  identityLabel = (identity) => identity.name,
  layout = "tile",
  headingLevel = 3,
  revealControls = false,
  imported = false,
}: {
  children?: ReactNode;
  revealControls?: boolean;
  imported?: boolean;
  identityLabel?: (identity: { pubkey: string; name: string }) => string;
  layout?: "tile" | "row";
  headingLevel?: 3 | 4 | 5;
  name: string;
  avatar?: string | undefined;
  identities: AgentLibrary["identities"];
  session?: RelaySession;
  media?: RelaySession["media"] | undefined;
  editable?: AgentView[];
  onEdit?: ((agent: AgentView, avatar?: string) => void) | undefined;
  onViewProfile?: ((trigger: HTMLButtonElement) => void) | undefined;
  onDuplicate?: ((agent: AgentView) => void) | undefined;
  onShare?: ((agent: AgentView) => void) | undefined;
  onDelete?: ((agent: AgentView) => void) | undefined;
  /** Visibility in the connected community; undefined when it cannot change. */
  archive?:
    | {
        archived: boolean;
        pending: boolean;
        onSelect(): void;
      }
    | undefined;
  archived?: boolean;
  /** Status for a whole-card operation, shown on its own full-width line. */
  feedback?: ReactNode;
}) {
  const tile = layout === "tile";
  const Heading = `h${headingLevel}` as "h3" | "h4" | "h5";
  const trigger = useRef<HTMLButtonElement>(null);
  const review = useRef<HTMLButtonElement>(null);
  const profileHandoff = useRef(false);
  const [managing, setManaging] = useState(false);
  const managementTrigger = useRef<HTMLButtonElement | null>(null);
  const manage = (button: HTMLButtonElement | null) => {
    managementTrigger.current = button;
    setManaging(true);
  };
  const hasControls = tile && !!children;
  useEffect(() => {
    if (!imported) return;
    const target = review.current ?? trigger.current;
    target?.scrollIntoView?.({ block: "nearest" });
    target?.focus();
  }, [imported]);
  const presence = usePresenceStatus(
    session?.presence,
    identities.length === 1 ? identities[0]?.pubkey : undefined,
  );
  const managed = editable.length === 1 ? editable[0] : undefined;
  const status = managed?.status;
  const settled =
    status === "running" ? presence === "online" : presence !== "online";
  useEffect(() => {
    const owner = session?.presence;
    if (
      !owner ||
      !status ||
      status === "waiting" ||
      status === "starting" ||
      settled
    )
      return;
    // The harness publishes presence just after native start/stop confirms,
    // so one read can race it. Re-read at the owner's gate, then resume its
    // normal cadence even if relay evidence never agrees.
    owner.refresh();
    let checks = 0;
    const timer = setInterval(() => {
      owner.refresh();
      if (++checks === 6) clearInterval(timer);
    }, 5000);
    return () => clearInterval(timer);
  }, [session?.presence, status, settled]);
  const source = avatarSource(managed?.picture ?? avatar);
  const managedPicture = useAvatarPreview(
    managed?.picture ?? "",
    managed?.relayUrl,
  );
  const picture =
    managed?.picture != null
      ? managedPicture
      : source?.startsWith("data:")
        ? source
        : source
          ? (media ?? session?.media)?.(source, "small")
          : undefined;
  const model = managed
    ? (managed.launchModel ??
      (managed.launchModelEnv
        ? "Custom model"
        : managed.harness.model || "Default model"))
    : undefined;
  const portrait = (
    <div className={tile ? styles.portrait : "shrink-0"}>
      <AgentAvatar
        session={session}
        agentPubkey={
          identities.length === 1 ? identities[0]?.pubkey : undefined
        }
        alt={name}
        fallback={name}
        src={picture ?? null}
        size={tile ? "fill" : "default"}
        shape="squircle"
        statusBadge={presence === "unknown" ? undefined : presence}
      />
    </div>
  );
  const label = (
    <div className="min-w-0 max-w-full">
      <Heading
        className="m-0 min-w-0 max-w-full truncate text-label-sm"
        title={name}
      >
        {name}
      </Heading>
      {archived && (
        <span className="inline-block max-w-full rounded-full border border-primary px-2 text-caption text-secondary">
          Archived
        </span>
      )}
      {tile && model && (
        <p
          className={`m-0 text-caption text-subtle ${styles.model}`}
          title={model}
        >
          {model}
        </p>
      )}
    </div>
  );
  return (
    <article
      aria-label={`Agent ${name}`}
      data-agent-pubkey={
        identities.length === 1 ? identities[0]?.pubkey : undefined
      }
      className={`relative min-w-0 ${tile ? styles.card : "agent-inventory-row"}`}
    >
      {(onEdit || onViewProfile || archive || hasControls) && (
        <div className="absolute right-2 top-2 z-10">
          <MenuRoot
            onOpenChange={(open) => {
              if (open) profileHandoff.current = false;
            }}
          >
            <MenuTrigger
              ref={trigger}
              render={
                <IconButton
                  aria-label={`Actions for ${name}`}
                  size="compact"
                  icon={<DotsThreeIcon size={18} aria-hidden="true" />}
                />
              }
            />
            <MenuPopup
              align="end"
              size="wide"
              finalFocus={() => !profileHandoff.current}
            >
              {onViewProfile && (
                <MenuItem
                  onClick={() => {
                    const button = trigger.current;
                    if (button) {
                      profileHandoff.current = true;
                      requestAnimationFrame(() => onViewProfile(button));
                    }
                  }}
                >
                  View profile
                </MenuItem>
              )}
              {hasControls && (
                <MenuItem
                  onClick={() => {
                    trigger.current?.focus();
                    profileHandoff.current = true;
                    manage(trigger.current);
                  }}
                >
                  Manage agent
                </MenuItem>
              )}
              {archive && (
                <MenuItem
                  disabled={archive.pending}
                  onClick={() => {
                    trigger.current?.focus();
                    archive.onSelect();
                  }}
                >
                  <MenuIcon>
                    {archive.archived ? (
                      <ArchiveOffIcon size={14} />
                    ) : (
                      <ArchiveIcon size={14} />
                    )}
                  </MenuIcon>
                  {archive.archived ? "Unarchive agent" : "Archive agent"}
                </MenuItem>
              )}
              {(onViewProfile || archive) && onEdit && <MenuSeparator />}
              {onEdit ? (
                editable.length ? (
                  editable.map((agent) => (
                    <Fragment key={agent.id}>
                      <MenuItem
                        onClick={() => {
                          // The menu item unmounts; return from the dialog to the card.
                          trigger.current?.focus();
                          onEdit(agent, source);
                        }}
                      >
                        <MenuIcon>
                          <PencilSimpleIcon size={14} />
                        </MenuIcon>
                        {editable.length === 1 ? (
                          "Edit"
                        ) : (
                          <ChoiceRow
                            label={`Edit ${identityLabel(agent)}`}
                            description={
                              <>
                                <span className="block break-all text-body-sm text-secondary">
                                  {agent.relayUrl}
                                </span>
                                <span className="block break-all text-mono-sm text-secondary">
                                  {npubEncode(agent.pubkey)}
                                </span>
                              </>
                            }
                          />
                        )}
                      </MenuItem>
                      {onDuplicate && (
                        <MenuItem
                          onClick={() => {
                            trigger.current?.focus();
                            onDuplicate(agent);
                          }}
                        >
                          <MenuIcon>
                            <CopyIcon size={14} />
                          </MenuIcon>
                          {editable.length === 1
                            ? "Duplicate"
                            : `Duplicate ${identityLabel(agent)}`}
                        </MenuItem>
                      )}
                      {onShare && (
                        <MenuItem
                          onClick={() => {
                            trigger.current?.focus();
                            onShare(agent);
                          }}
                        >
                          Share
                        </MenuItem>
                      )}
                      {onDelete && (
                        <>
                          <MenuSeparator />
                          <MenuItem
                            tone="danger"
                            onClick={() => {
                              trigger.current?.focus();
                              onDelete(agent);
                            }}
                          >
                            <MenuIcon>
                              <TrashIcon size={14} />
                            </MenuIcon>
                            {editable.length === 1
                              ? "Delete"
                              : `Delete ${identityLabel(agent)}`}
                          </MenuItem>
                        </>
                      )}
                    </Fragment>
                  ))
                ) : (
                  <>
                    <MenuItem disabled>
                      <MenuIcon>
                        <PencilSimpleIcon size={14} />
                      </MenuIcon>
                      Edit
                    </MenuItem>
                    <MenuNote>
                      {identities.length
                        ? "Import this identity to edit in Foundation."
                        : "No linked identity to edit."}
                    </MenuNote>
                  </>
                )
              ) : null}
            </MenuPopup>
          </MenuRoot>
        </div>
      )}
      <div
        className={
          tile
            ? styles.content
            : `flex min-w-0 items-center gap-3 ${onEdit || onViewProfile || archive ? "pr-6" : ""}`
        }
      >
        {portrait}
        {label}
        {tile && (onViewProfile || hasControls) && (
          <button
            type="button"
            className={styles.open}
            aria-label={
              onViewProfile ? `View profile for ${name}` : `Manage ${name}`
            }
            onClick={(event) => {
              if (onViewProfile) onViewProfile(event.currentTarget);
              else manage(event.currentTarget);
            }}
          />
        )}
      </div>
      {hasControls && (
        <>
          {revealControls && (
            <div className="px-4 pb-4">
              <Button
                ref={review}
                size="compact"
                onClick={(event) => manage(event.currentTarget)}
              >
                Review agent status
              </Button>
            </div>
          )}
          <Dialog
            open={managing}
            onOpenChange={setManaging}
            finalFocus={() =>
              managementTrigger.current?.isConnected
                ? managementTrigger.current
                : trigger.current
            }
            title={`Manage ${name}`}
          >
            <div className="flex min-w-0 flex-col gap-3">{children}</div>
          </Dialog>
        </>
      )}
      {!tile && children && (
        <div
          className={`agent-inventory-actions flex min-w-0 flex-wrap items-center gap-2 ${onEdit || onViewProfile || archive ? "pr-8" : ""}`}
        >
          {children}
        </div>
      )}
      {feedback && (
        <div
          className={`agent-card-feedback min-w-0 ${tile ? "px-4 pb-4" : ""}`}
        >
          {feedback}
        </div>
      )}
      {identities.length &&
      !children &&
      !onEdit &&
      !onViewProfile &&
      !archive ? (
        <div className="absolute right-2 top-2">
          <PopoverRoot>
            <PopoverTrigger
              render={
                <IconButton
                  aria-label={`Actions for ${name}`}
                  size="compact"
                  icon={<DotsThreeIcon size={18} aria-hidden="true" />}
                />
              }
            />
            <PopoverPopup align="center">
              <PopoverTitle>{name} identity details</PopoverTitle>
              <ul className="m-0 mt-3 list-none space-y-3 p-0">
                {identities.map((identity) => (
                  <li key={identity.pubkey}>
                    <p className="m-0 select-all break-all text-mono-sm text-subtle">
                      {npubEncode(identity.pubkey)}
                    </p>
                  </li>
                ))}
              </ul>
            </PopoverPopup>
          </PopoverRoot>
        </div>
      ) : !children && !identities.length ? (
        <p className="m-0 mb-6 text-center text-caption text-subtle">
          No linked identity
        </p>
      ) : null}
    </article>
  );
}
