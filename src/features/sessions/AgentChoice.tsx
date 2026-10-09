import "../../shared/design-system/styles/scrollbars.css";
import { useRef, useState } from "react";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { useIdentityNames } from "../identity-names/react";
import { Button } from "../../shared/design-system/ui/Button";
import {
  ArrowClockwiseIcon,
  RobotIcon,
  CaretUpIcon,
} from "../../shared/design-system/icons/index";
import { useAgentChoices } from "../agents/use-choices";
import { Avatar as ChoiceAvatar } from "../../shared/design-system/ui/Avatar";
import type { RelaySession } from "../relay/session";
import { Avatar } from "../../shared/Avatar";
import { avatarMedia } from "../../shared/avatar-source";
import { usePresenceStatus } from "../presence/react";
import type { PresenceStatus } from "../presence/presence";
import styles from "./Sessions.module.css";

export function agentAdmission(
  pubkey: string,
  allowed?: readonly string[] | undefined,
  sessionMembers?: readonly string[] | undefined,
  parentMembers?: readonly string[] | undefined,
) {
  if (sessionMembers === undefined)
    return allowed !== undefined && !allowed.includes(pubkey)
      ? ("channel" as const)
      : undefined;
  if (sessionMembers.includes(pubkey)) return undefined;
  return parentMembers !== undefined && !parentMembers.includes(pubkey)
    ? ("session-and-channel" as const)
    : ("session" as const);
}

function AgentStatusAvatar({
  name,
  src,
  presence,
}: {
  name: string;
  src: string | undefined;
  presence: PresenceStatus;
}) {
  return (
    <Avatar
      name={name}
      src={src}
      className={styles.agentAvatar ?? ""}
      shape="squircle"
      statusBadge={presence === "unknown" ? undefined : presence}
    />
  );
}

function AgentName({
  name,
  qualifier,
}: {
  name: string;
  qualifier?: string | undefined;
}) {
  const suffix = qualifier ? ` · ${qualifier}` : "";
  if (!suffix || !name.endsWith(suffix)) return <>{name}</>;
  return (
    <>
      {name.slice(0, -suffix.length)}{" "}
      <span className={styles.agentIdentifier}>{qualifier}</span>
    </>
  );
}

function AgentChoiceOption({
  session,
  agent,
  src,
  admission,
  selected,
  disabled,
  select,
}: {
  session: RelaySession;
  agent: { pubkey: string; name: string; qualifier?: string | undefined };
  src: string | undefined;
  admission: ReturnType<typeof agentAdmission>;
  selected: boolean;
  disabled: boolean;
  select(): void;
}) {
  const presence = usePresenceStatus(session.presence, agent.pubkey);
  const admissionLabel =
    admission === "channel"
      ? " — adds to channel"
      : admission === "session-and-channel"
        ? " — adds to session and channel"
        : "";
  return (
    <NavigationItem
      variant="option"
      data-agent-choice=""
      selected={selected}
      aria-pressed={selected}
      disabled={disabled}
      onClick={select}
      aria-label={`${agent.name}${presence === "unknown" ? "" : `, ${presence}`}${admissionLabel}`}
      icon={
        <ChoiceAvatar
          alt=""
          fallback={agent.name}
          src={src}
          size="large"
          shape="squircle"
          statusBadge={presence === "unknown" ? undefined : presence}
        />
      }
      label={
        <span className={styles.agentOptionLabel}>
          <span>
            <AgentName name={agent.name} qualifier={agent.qualifier} />
          </span>
          {admissionLabel && (
            <small>{`${admissionLabel[3]?.toUpperCase()}${admissionLabel.slice(4)}`}</small>
          )}
        </span>
      }
    />
  );
}

export function AgentChoice({
  session,
  value,
  onChange,
  disabled = false,
  allowed,
  sessionMembers,
  parentMembers,
  parentName,
  emptyLabel = "Choose an agent",
  side = "top",
}: {
  session: RelaySession;
  value: string;
  onChange: (key: string) => void;
  disabled?: boolean;
  allowed?: readonly string[] | undefined;
  sessionMembers?: readonly string[] | undefined;
  parentMembers?: readonly string[] | undefined;
  parentName?: string | undefined;
  emptyLabel?: string;
  side?: "top" | "bottom";
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const searchInput = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const select = (key: string) => {
    if (!disabled) {
      onChange(key);
      setOpen(false);
    }
  };
  const resolveName = useIdentityNames(session.names);
  const library = session.agentChoices;
  // Adding grants access, so known-archived agents are not offered.
  const agents = useAgentChoices(session, true, true);
  const candidates = agents.selectable.map((agent) => agent.pubkey);
  const identities = agents.selectable.map((agent) => ({
    ...agent,
    name: resolveName(agent.pubkey, agent.name, candidates),
    qualifier: session.names?.lookup(agent.pubkey, candidates)?.qualifier,
  }));
  const query = search.trim().toLowerCase();
  const matches = identities.filter((agent) =>
    `${agent.name} ${agent.pubkey}`.toLowerCase().includes(query),
  );
  const selected = identities.find((agent) => agent.pubkey === value);
  const selectedPresence = usePresenceStatus(
    session.presence,
    selected?.pubkey,
  );
  const picture = (avatar?: string) => avatarMedia(avatar, session.media);
  const label = selected
    ? `Change agent: ${selected.name}`
    : value
      ? "Change selected agent"
      : "Choose an agent";
  const accessibleLabel =
    selectedPresence === "unknown" ? label : `${label}, ${selectedPresence}`;
  return (
    <PopoverRoot
      open={open && !disabled}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setSearch("");
      }}
    >
      <span className={styles.agentTrigger}>
        <PopoverTrigger
          render={
            <Button
              ref={trigger}
              variant="ghost"
              shape="control"
              size="sm"
              data-agent-picker=""
              style={{ maxWidth: "100%" }}
            >
              {selected ? (
                <AgentStatusAvatar
                  name={selected.name}
                  src={picture(selected.avatar)}
                  presence={selectedPresence}
                />
              ) : (
                <span className={styles.agentAvatar}>
                  <ChoiceAvatar
                    alt=""
                    fallback=""
                    size="fill"
                    shape="squircle"
                    fallbackContent={<RobotIcon size={16} aria-hidden="true" />}
                  />
                </span>
              )}
              <span className={styles.agentName}>
                {selected ? (
                  <AgentName
                    name={selected.name}
                    qualifier={selected.qualifier}
                  />
                ) : (
                  emptyLabel
                )}
              </span>
              <CaretUpIcon size={12} aria-hidden="true" />
            </Button>
          }
          aria-label={accessibleLabel}
          title="Change agent"
          disabled={disabled}
        />
      </span>
      <PopoverPopup
        side={side}
        sideOffset={4}
        anchor={trigger}
        align="end"
        collisionAvoidance={{
          side: "none",
          align: "shift",
          fallbackAxisSide: "none",
        }}
        padding="none"
        initialFocus={searchInput}
        style={{
          width: 380,
          height: "min(360px, var(--available-height))",
          overflow: "hidden",
          display: "flex",
        }}
        aria-label="Choose an agent"
        onKeyDown={(event) => {
          if (
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229 ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey
          )
            return;
          const fromSearch = event.target === searchInput.current;
          if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
          const rows = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>(
              "[data-agent-choice]:not(:disabled)",
            ),
          );
          if (event.key === "Enter") {
            if (fromSearch) {
              event.preventDefault();
              event.stopPropagation();
              rows[0]?.click();
            }
          } else {
            if (
              !fromSearch &&
              !rows.includes(event.target as HTMLButtonElement)
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            const current = rows.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            const next =
              current < 0
                ? event.key === "ArrowDown"
                  ? 0
                  : rows.length - 1
                : (current +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    rows.length) %
                  rows.length;
            rows[next]?.focus();
          }
        }}
      >
        <div className={styles.agentPickerContent}>
          <SearchField
            variant="capsule"
            inputRef={searchInput}
            label="Search agents"
            value={search}
            onValueChange={setSearch}
            disabled={disabled}
          />
          <div className={`${styles.agentPickerChoices} buzz-thin-scrollbar`}>
            {matches.map((agent) => {
              const admission = agentAdmission(
                agent.pubkey,
                allowed,
                sessionMembers,
                parentMembers,
              );
              return (
                <AgentChoiceOption
                  key={agent.pubkey}
                  session={session}
                  agent={agent}
                  src={picture(agent.avatar)}
                  admission={admission}
                  selected={value === agent.pubkey}
                  disabled={disabled}
                  select={() => select(agent.pubkey)}
                />
              );
            })}
            {query && !matches.length && (
              <p role="status">No matching agents.</p>
            )}
          </div>
          {allowed !== undefined &&
            sessionMembers === undefined &&
            agents.selectable.some(
              (agent) => !allowed.includes(agent.pubkey),
            ) && (
              <p>
                Adding an agent also adds it to{" "}
                {parentName ?? "the parent channel"}, with access to its
                history.
              </p>
            )}
          {agents.status === "loading" && <p role="status">Loading agents…</p>}
          {agents.status === "ready" && !agents.selectable.length && (
            <p role="status">No agents available in this community.</p>
          )}
          {agents.status === "unavailable" && (
            <p role="status">
              Your agent library isn’t available on this connection.
            </p>
          )}
          {agents.archives.status === "error" && (
            <p role="status">
              Couldn’t check which agents are archived, so archived agents may
              appear.
            </p>
          )}
          {(agents.status === "error" ||
            !!agents.error ||
            agents.archives.status === "error") && (
            <Button onClick={() => void library.refresh()}>
              <ArrowClockwiseIcon size={14} />
              Retry agent list
            </Button>
          )}
        </div>
      </PopoverPopup>
    </PopoverRoot>
  );
}
