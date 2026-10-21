import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Combobox as BaseCombobox } from "@base-ui/react/combobox";
import type { RelaySession } from "../../features/relay/session";
import type { Navigation } from "../../features/navigation/controller";
import { sharedSessionNavigationTarget } from "../../features/sessions/shared-session-target";
import { sharedSessionIds } from "../../features/sessions/shared-session-marker";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import type { ChannelSummary } from "../../features/relay/contracts";
import { archiveHides } from "../../features/relay/identity-archives";
import {
  beginSoloShare,
  finishSoloShare,
  soloShareAttempt,
  useSoloShareAttempts,
  type ShareAttempt,
} from "../../features/solo/share-attempt";
import {
  conversionLabel,
  useChatConversions,
} from "../../features/solo/conversion";
import { subscribeView, viewRevision } from "../../shared/view-state";
import {
  readShareHistory,
  saveShareHistory,
  shareHistoryKey,
  type ShareHistory,
} from "../../features/solo/share-history";
import { searchMembers } from "../../features/channel-members/search";
import {
  formatPublicKey,
  publicKeyLabels,
} from "../../shared/identity/public-key";
import { useIdentityNames } from "../../features/identity-names/react";
import {
  canShareConversation,
  destinationShareAudience,
  grantSoloChatAccess,
  publishSoloChatLink,
  soloChatLink,
} from "../../features/solo/share";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { avatarMedia } from "../../shared/avatar-source";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Combobox } from "../../shared/design-system/ui/Combobox";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import {
  ConvertToChannel,
  canConvertToChannel,
} from "../../features/solo/ConvertToChannel";
import {
  HashIcon,
  ShareIcon,
  UsersIcon,
  XIcon,
} from "../../shared/design-system/icons";
import styles from "./SoloShare.module.css";

type Person = { pubkey: string; name: string; isAgent?: true };
type Choice = { id: string; name: string; kind: "person" | "channel" };

/** Unknown classification is not evidence of a private conversation. Only a
 * verified current roster plus a known non-agent profile supplies Shared. */
export function useSharedWithPeople(
  session: RelaySession,
  channel: ChannelSummary | undefined,
) {
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const agents = useSyncExternalStore(
    session.agentChoices.subscribe,
    session.agentChoices.snapshot,
  );
  const roles = useSyncExternalStore(
    session.memberAdministration.subscribe,
    () =>
      channel ? session.memberAdministration.snapshot(channel.id) : undefined,
  );
  const human =
    !channel?.cached &&
    channel?.members?.some((key) => {
      const profile = profiles.get(key);
      return (
        key !== session.viewer &&
        roles?.authority.roles[key] !== "bot" &&
        profile &&
        !profile.isAgent &&
        !profile.nameIsFallback &&
        !agents.identities.some((agent) => agent.pubkey === key)
      );
    });
  return !!human;
}

export function ChatAccessIndicator({
  session,
  channel,
  onClick,
}: {
  session: RelaySession;
  channel: ChannelSummary | undefined;
  onClick(): void;
}) {
  if (!useSharedWithPeople(session, channel)) return null;
  return (
    <IconButton
      aria-label="Shared · Manage access"
      title="Shared · Manage access"
      icon={<UsersIcon size={16} />}
      onClick={onClick}
    />
  );
}

/** Status only: the chat's actions menu owns access management. The row's
 * select button names it through `soloSharedMarkId`. */
export const soloSharedMarkId = (channelId: string) =>
  `solo-shared-${channelId}`;

export function ChatSharedMark({
  session,
  channel,
}: {
  session: RelaySession;
  channel: ChannelSummary | undefined;
}) {
  if (!useSharedWithPeople(session, channel)) return null;
  return (
    <span id={channel && soloSharedMarkId(channel.id)} data-solo-shared="">
      <UsersIcon size={16} aria-hidden="true" />
      <span className="sr-only">Shared</span>
    </span>
  );
}

/** One access modal in Solo and Messages. Submitted work belongs to the relay
 * session; this view does not own persistence, grant retries or link delivery. */
export function SoloShare({
  session,
  navigator: navigationController,
  channel,
  signal,
  renderTrigger,
  initialOpen = false,
  onClose,
  finalFocus,
  onConvert,
  onConverted,
}: {
  session: RelaySession;
  navigator?: Navigation | undefined;
  channel: ChannelSummary;
  initialOpen?: boolean;
  onConverted?: (() => void) | undefined;
  /** A host whose header changes type owns conversion outside that header. */
  onConvert?: (trigger: HTMLElement | null) => void;
  onClose?: () => void;
  finalFocus?: () => HTMLElement | false;
  renderTrigger?: (open: () => void, disabled: boolean) => ReactNode;
  signal?: AbortSignal | undefined;
}) {
  const notify = useToastNotification();
  useChatConversions(session);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const visible = () => mounted.current && !signal?.aborted;
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
  );
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const agents = useSyncExternalStore(
    session.agentChoices.subscribe,
    session.agentChoices.snapshot,
  );
  const [open, setOpen] = useState(initialOpen);
  const [converting, setConverting] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [destination, setDestination] = useState("");
  const [expandedChannel, setExpandedChannel] = useState("");
  const [expandedShares, setExpandedShares] = useState<string[]>([]);
  const [historyError, setHistoryError] = useState("");
  const historyRevision = useSyncExternalStore(
    useCallback(
      (notify) => subscribeView(session.scope, notify),
      [session.scope],
    ),
    () => viewRevision(session.scope, shareHistoryKey(channel.id)),
  );
  let history: ShareHistory = { version: 1, channels: [], people: [] };
  let historyReadError = "";
  try {
    history = readShareHistory(historyRevision);
  } catch (reason) {
    historyReadError =
      reason instanceof Error
        ? reason.message
        : "Sharing history is unavailable on this device.";
  }
  const [destinationRoster, setDestinationRoster] = useState<{
    id: string;
    status: "loading" | "ready" | "error";
  }>();
  const [destinationReload, setDestinationReload] = useState(0);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Person[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [reload, setReload] = useState(0);
  const [rosterState, setRosterState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [rosterError, setRosterError] = useState("");
  const [rosterReload, setRosterReload] = useState(0);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [pendingAction, setPendingAction] = useState<"share" | "retry">();
  const busy = pendingAction !== undefined;
  const [copyStatus, setCopyStatus] = useState("");
  const [frozen, setFrozen] = useState<ShareAttempt | undefined>(() =>
    soloShareAttempt(session, channel.id),
  );
  const attempts = useSoloShareAttempts(session);
  const saved = frozen ?? attempts.get(channel.id);
  const source = list.channels.find((item) => item.id === channel.id);
  const eligible = canShareConversation(session, source);
  const chosenId = saved ? saved.intent.destination : destination;
  const liveChosen = list.channels.find(
    (item) => item.id === chosenId && item.id !== channel.id,
  );
  const submittedAudience = saved?.audienceKeys !== undefined;
  const chosen = submittedAudience
    ? (saved.channelSnapshot ?? liveChosen ?? { id: chosenId, name: chosenId })
    : liveChosen;
  const destinationMembers = submittedAudience
    ? (saved.channelSnapshot?.members ?? saved.audienceKeys)
    : liveChosen &&
        destinationRoster?.id === liveChosen.id &&
        destinationRoster.status === "ready" &&
        !liveChosen.cached &&
        liveChosen.members
      ? [...new Set(liveChosen.members)]
      : undefined;
  const shownKeys =
    saved?.intent.chatPeople ?? people.map((person) => person.pubkey);
  const input = useRef<HTMLInputElement>(null);
  const [pickerBoundary, setPickerBoundary] = useState<Element | undefined>();
  useEffect(() => {
    void rosterReload;
    if (!open) return;
    const controller = new AbortController();
    const cancelled = () => controller.abort();
    signal?.addEventListener("abort", cancelled, { once: true });
    if (signal?.aborted) controller.abort();
    setRosterState("loading");
    setRosterError("");
    void (
      session.channels.refreshRoster
        ? session.channels.refreshRoster(channel.id, {
            consistency: "strong",
            signal: controller.signal,
          })
        : Promise.reject(
            new Error("Current access is unavailable on this connection."),
          )
    )
      .then((fresh) => {
        if (controller.signal.aborted) return;
        const current = session.channels
          .list()
          .channels.find((item) => item.id === channel.id);
        if (!fresh || current?.cached || !current?.members)
          throw new Error("Current access could not be confirmed.");
        setRosterState("ready");
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setRosterState("error");
          setRosterError(
            reason instanceof Error
              ? reason.message
              : "Current access could not be confirmed.",
          );
        }
      });
    return () => {
      controller.abort();
      signal?.removeEventListener("abort", cancelled);
    };
  }, [open, session, channel.id, rosterReload, signal]);
  const chosenChannelId = chosen?.id;
  useEffect(() => {
    void destinationReload;
    if (!open || !chosenChannelId || submittedAudience) return;
    const controller = new AbortController();
    const active = AbortSignal.any([
      controller.signal,
      ...(signal ? [signal] : []),
    ]);
    setDestinationRoster({ id: chosenChannelId, status: "loading" });
    void (async () => {
      try {
        const fresh = await session.channels.refreshRoster?.(chosenChannelId, {
          consistency: "strong",
          signal: active,
        });
        const current = session.channels
          .list()
          .channels.find((item) => item.id === chosenChannelId);
        if (!fresh || current?.cached || !current?.members)
          throw new Error("Current participants are unavailable.");
        if (!active.aborted)
          setDestinationRoster({ id: chosenChannelId, status: "ready" });
      } catch {
        if (!active.aborted)
          setDestinationRoster({ id: chosenChannelId, status: "error" });
      }
    })();
    return () => controller.abort();
  }, [
    open,
    chosenChannelId,
    submittedAudience,
    session,
    signal,
    destinationReload,
  ]);
  const memberKeys =
    open && rosterState === "ready" && !source?.cached
      ? source?.members?.join(":")
      : "";
  useEffect(() => {
    if (!memberKeys) return;
    void session.profiles
      .ensure(memberKeys.split(":"), "foreground")
      .catch(() => {});
    // Reuse the existing verified role reader; unknown owner/agent classification
    // stays unlabeled rather than being represented as private.
    void session.memberAdministration.refresh(channel.id).catch(() => {});
  }, [session, channel.id, memberKeys]);
  const destinationProfileKeys =
    open && expandedChannel === chosen?.id ? destinationMembers?.join(":") : "";
  useEffect(() => {
    if (destinationProfileKeys)
      void session.profiles
        .ensure(destinationProfileKeys.split(":"), "foreground")
        .catch(() => {});
  }, [session, destinationProfileKeys]);
  useEffect(() => {
    void reload;
    const text = query.trim();
    if (!open || !text) {
      setResults([]);
      setSearching(false);
      setSearchError("");
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    setResults([]);
    setSearchError("");
    const timer = setTimeout(() => {
      void searchMembers(session, text, 1, controller.signal).then(
        (page) => {
          if (!controller.signal.aborted) {
            setResults(page.people);
            setSearching(false);
          }
        },
        (reason: unknown) => {
          if (!controller.signal.aborted) {
            setSearchError(
              reason instanceof Error ? reason.message : "Search failed.",
            );
            setSearching(false);
          }
        },
      );
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [session, query, open, reload]);
  const knownAgent = (key: string) =>
    !!(
      agents.identities.some((item) => item.pubkey === key) ||
      profiles.get(key)?.isAgent ||
      results.find((person) => person.pubkey === key)?.isAgent
    );
  const resolveName = useIdentityNames(session.names);
  const displayFacts = [...results, ...people];
  const displayKeys = [
    ...new Set([
      ...(source?.members ?? []),
      ...(destinationMembers ?? []),
      ...shownKeys,
      ...results.map((person) => person.pubkey),
    ]),
  ];
  const labels = new Map(
    displayKeys.map((key) => [
      key,
      resolveName(
        key,
        profiles.get(key)?.name ??
          people.find((person) => person.pubkey === key)?.name ??
          results.find((person) => person.pubkey === key)?.name ??
          formatPublicKey(key) ??
          "Member",
        displayKeys,
        displayFacts,
      ).trim(),
    ]),
  );
  // A naming policy is optional. Transient search results must still be distinct
  // before granting history access; unique names never need a key subtitle.
  const groups = new Map<string, string[]>();
  for (const [key, label] of labels)
    groups.set(label, [...(groups.get(label) ?? []), key]);
  for (const keys of groups.values()) {
    if (keys.length < 2) continue;
    const qualifiers = publicKeyLabels(keys);
    for (const key of keys)
      labels.set(key, `${labels.get(key)} · ${qualifiers.get(key)}`);
  }
  const names = (key: string) => labels.get(key) ?? "Member";
  const ungrouped =
    source?.members?.filter(
      (key) =>
        key !== session.viewer &&
        !shownKeys.includes(key) &&
        !history.channels.some(
          (item) =>
            item.members.includes(key) &&
            (item.id !== chosen?.id || destinationMembers?.includes(key)),
        ),
    ) ?? [];
  const otherAccess = ungrouped.filter(
    (key) => !history.people.includes(key) && !knownAgent(key),
  );
  const candidates: Choice[] = results
    .filter(
      (person) =>
        !knownAgent(person.pubkey) &&
        !archiveHides(session.archives, person.pubkey, session.viewer) &&
        !source?.members?.includes(person.pubkey) &&
        !shownKeys.includes(person.pubkey),
    )
    .map((person) => ({
      id: person.pubkey,
      name: person.name,
      kind: "person",
    }));
  const channels: Choice[] = destination
    ? []
    : list.channels
        .filter(
          (item) =>
            item.id !== channel.id &&
            !item.huddle &&
            !item.metadataPending &&
            !item.readOnly &&
            !item.cached &&
            !item.archived &&
            ["stream", "forum"].includes(item.channelType ?? "") &&
            item.members?.includes(session.viewer ?? "") &&
            item.name
              .toLowerCase()
              .includes(query.trim().toLowerCase().replace(/^#/, "")),
        )
        .map((item) => ({ id: item.id, name: item.name, kind: "channel" }));
  const choices = [...channels, ...candidates];
  const reset = () => {
    setPeople([]);
    setDestination("");
    setExpandedChannel("");
    setExpandedShares([]);
    setHistoryError("");
    setQuery("");
    setError("");
    setProgress("");
    setCopyStatus("");
    setFrozen(soloShareAttempt(session, channel.id));
  };
  const close = () => {
    setOpen(false);
    reset();
    onClose?.();
  };
  const openShare = () => {
    trigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setOpen(true);
  };
  const startOver = () => {
    if (!visible() || busy || !saved) return;
    if (saved.running) {
      setError("This share is already in progress in another view.");
      return;
    }
    if (soloShareAttempt(session, channel.id) !== saved) {
      setError(
        "This share finished or changed. Close and reopen to start a new share.",
      );
      return;
    }
    finishSoloShare(session, channel.id);
    reset();
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(soloChatLink(channel.id));
      setCopyStatus("Link copied");
    } catch {
      setCopyStatus("Couldn’t copy the link.");
    }
  };
  const choose = (choice: Choice | null) => {
    if (!choice || busy || saved || !eligible) return;
    if (choice.kind === "channel") {
      if (!destination) setDestination(choice.id);
    } else if (
      !knownAgent(choice.id) &&
      !archiveHides(session.archives, choice.id, session.viewer) &&
      !source?.members?.includes(choice.id) &&
      !people.some((person) => person.pubkey === choice.id)
    )
      setPeople([...people, { pubkey: choice.id, name: choice.name }]);
    setQuery("");
    input.current?.focus();
  };
  const submit = async () => {
    if (!visible() || busy) return;
    if (!saved && !destination && !people.length) {
      close();
      return;
    }
    if (!eligible) {
      setError(
        "Chat access changed. Close and reopen to check current access before retrying.",
      );
      return;
    }
    if (saved && soloShareAttempt(session, channel.id) !== saved) {
      setError(
        "This share finished or changed. Close and reopen to start a new share.",
      );
      return;
    }
    if (!saved && people.some((person) => knownAgent(person.pubkey))) {
      setError("Add agents from their own chat controls instead.");
      return;
    }
    const exact = beginSoloShare(session, channel.id, {
      destination: destination || channel.id,
      chatPeople: people.map((person) => person.pubkey),
    });
    setFrozen(exact);
    if (exact.running) {
      setError("This share is already in progress in another view.");
      return;
    }
    exact.running = true;
    setPendingAction(saved ? "retry" : "share");
    setError("");
    const controller = new AbortController();
    const remember = () => {
      const confirmed = (key: string) => !!exact.grants.get(key)?.confirmed;
      const direct = exact.intent.chatPeople.filter(confirmed);
      const snapshot = exact.channelSnapshot;
      const recipients =
        snapshot?.members.filter(
          (key) => key !== session.viewer && confirmed(key),
        ) ?? [];
      if (!direct.length && !recipients.length) return true;
      try {
        saveShareHistory(
          session.scope,
          channel.id,
          direct,
          snapshot && recipients.length && session.viewer
            ? { ...snapshot, members: [session.viewer, ...recipients] }
            : undefined,
        );
        if (visible()) setHistoryError("");
        return true;
      } catch (reason) {
        if (visible())
          setHistoryError(
            reason instanceof Error
              ? reason.message
              : "Sharing history couldn’t be saved on this device. Access is unchanged.",
          );
        return false;
      }
    };
    const progress = (text: string) => {
      if (visible()) setProgress(text);
    };
    try {
      const target = exact.intent.destination;
      if (exact.intent.chatPeople.some(knownAgent))
        throw new Error("Add agents from their own chat controls instead.");
      if (target !== channel.id && !exact.audienceKeys) {
        progress("Checking current channel members…");
        const audience = await destinationShareAudience(
          session,
          target,
          controller.signal,
        );
        const selected = session.channels
          .list()
          .channels.find((item) => item.id === target);
        if (selected && session.viewer)
          exact.channelSnapshot = {
            id: target,
            name: selected.name,
            members: [session.viewer, ...audience],
          };
        exact.audienceKeys = [
          ...new Set([...exact.intent.chatPeople, ...audience]),
        ];
      }
      const keys = exact.audienceKeys ?? exact.intent.chatPeople;
      if (target !== channel.id && !keys.length && !exact.messageId)
        throw new Error(
          "This channel has no other current members to share with.",
        );
      if (keys.length > 100 || new Set(keys).size !== keys.length)
        throw new Error("Choose at most 100 distinct recipients.");
      progress("Confirming chat access…");
      // A confirmed grant is never replayed, even if its recipient later leaves.
      const directKeys = exact.intent.chatPeople;
      await grantSoloChatAccess(
        session,
        channel.id,
        directKeys.filter((key) => !exact.grants.get(key)?.confirmed),
        exact.grants,
        controller.signal,
        () => {},
        false,
        source?.channelType === "solo",
      );
      await grantSoloChatAccess(
        session,
        channel.id,
        keys.filter(
          (key) =>
            !directKeys.includes(key) && !exact.grants.get(key)?.confirmed,
        ),
        exact.grants,
        controller.signal,
        () => {},
        true,
        source?.channelType === "solo",
      );
      const historySaved = remember();
      if (target !== channel.id) {
        progress("Posting chat link…");
        const messageId = await publishSoloChatLink(
          session,
          channel.id,
          target,
          exact.messageId,
          controller.signal,
          (id) => {
            exact.messageId = id;
          },
        );
        // Optional discovery feedback must not turn a confirmed share into a failed operation.
        try {
          const confirmed = await session.read(
            [
              {
                kinds: [9],
                ids: [messageId],
                "#h": [target],
                limit: 1,
                consistency: "strong",
              },
            ],
            { signal: controller.signal, fresh: true },
          );
          if (
            visible() &&
            confirmed.some((event) =>
              sharedSessionIds(event).includes(channel.id),
            )
          ) {
            const destination = sharedSessionNavigationTarget(
              target,
              session.scope,
              session.viewer,
            );
            const destinationName = session.channels
              .list()
              .channels.find((item) => item.id === target)?.name;
            notify(
              destinationName
                ? `Added to #${destinationName}’s Shared sessions`
                : "Added to Shared sessions",
              "success",
              destination && navigationController
                ? {
                    label: "View",
                    onClick: () => {
                      void navigationController.open(destination);
                    },
                  }
                : undefined,
            );
          }
        } catch {
          /* Sharing is already confirmed; the tab can be opened from its launcher. */
        }
      }
      finishSoloShare(session, channel.id);
      if (visible()) {
        if (historySaved) close();
        else {
          // Completed access/link work must not be retried for a display-save failure.
          setFrozen(undefined);
          setPeople([]);
          setDestination("");
          setExpandedChannel("");
          setProgress("");
        }
      }
    } catch (reason) {
      remember();
      if (!visible()) return;
      const count = [...exact.grants.values()].filter(
        (intent) => intent.confirmed,
      ).length;
      setProgress("");
      setError(
        `${reason instanceof Error ? reason.message : "Couldn’t share this chat."}${count ? ` Access confirmed for ${count} recipient${count === 1 ? "" : "s"}; it is not revoked.` : ""}${exact.messageId ? " Link posting is not confirmed; retry keeps the same message." : ""}`,
      );
    } finally {
      delete exact.running;
      if (visible()) setPendingAction(undefined);
    }
  };
  const identity = (key: string) => (
    <Avatar
      size="small"
      shape={knownAgent(key) ? "squircle" : "circle"}
      alt=""
      fallback={names(key)}
      src={avatarMedia(profiles.get(key)?.picture, session.media)}
    />
  );
  const row = (key: string, selected: boolean) => (
    <div key={key} className={styles.row}>
      {identity(key)}
      <span className={styles.name}>
        <span>{names(key)}</span>
      </span>
      {selected && (
        <IconButton
          aria-label={`Remove ${names(key)}`}
          disabled={busy || !!saved}
          icon={<XIcon size={16} />}
          onClick={() => {
            setPeople(people.filter((person) => person.pubkey !== key));
            input.current?.focus();
          }}
        />
      )}
    </div>
  );
  return (
    <>
      {renderTrigger ? (
        renderTrigger(openShare, !eligible)
      ) : (
        <IconButton
          aria-label="Share"
          title="Share"
          disabled={!eligible}
          icon={<ShareIcon size={16} />}
          onClick={openShare}
        />
      )}
      {!renderTrigger && source && (
        <ChatAccessIndicator
          session={session}
          channel={source}
          onClick={openShare}
        />
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && !busy) close();
        }}
        title="Share chat"
        height="stable"
        description="People with access can read the full history and participate in new messages."
        preventClose={busy}
        finalFocus={finalFocus}
        initialFocus={busy || saved || !eligible ? true : input}
        leadingActions={
          canConvertToChannel(session, source) && (
            <Button
              disabled={busy || !!saved || !!signal?.aborted}
              onClick={() => {
                if (
                  !visible() ||
                  busy ||
                  saved ||
                  soloShareAttempt(session, channel.id)
                )
                  return;
                setOpen(false);
                if (onConvert) {
                  reset();
                  onConvert(trigger.current);
                } else setConverting(true);
              }}
            >
              {conversionLabel(session, channel.id)}
            </Button>
          )
        }
        actions={
          <>
            <Tooltip content="Copying a link does not grant access.">
              <Button onClick={() => void copy()}>
                <span aria-live="polite">
                  {copyStatus === "Link copied" ? "Link copied" : "Copy link"}
                </span>
              </Button>
            </Tooltip>
            {/* A new receipt is not recovery UI. Keep the existing action set on submit. */}
            {saved && pendingAction !== "share" && (
              <Button disabled={busy} onClick={startOver}>
                Start over
              </Button>
            )}
            <Button
              variant="prominent"
              title={
                destination && !saved
                  ? "Sharing grants access and posts a link in the selected channel."
                  : undefined
              }
              loading={busy}
              disabled={
                !eligible && (!!saved || !!destination || !!people.length)
              }
              onClick={() => void submit()}
            >
              {busy
                ? pendingAction === "retry"
                  ? "Retry share"
                  : "Share"
                : saved
                  ? "Retry share"
                  : destination || people.length
                    ? "Share"
                    : "Done"}
            </Button>
          </>
        }
      >
        <div className={styles.form}>
          <Combobox.Root
            items={choices}
            filteredItems={choices}
            value={null}
            inputValue={query}
            onInputValueChange={(next, details) => {
              // This action picker owns selection/reset; dismissal must keep the query.
              if (details.reason === "input-change") setQuery(next);
            }}
            itemToStringLabel={(choice: Choice) => choice.name}
            onValueChange={choose}
            onOpenChange={(next) => {
              if (next)
                setPickerBoundary(
                  input.current?.closest('[role="dialog"]') ?? undefined,
                );
            }}
            autoHighlight
          >
            <Combobox.Control
              ref={input}
              label="People or channel"
              triggerLabel="Browse people and channels"
              placeholder="Search people or channels…"
              disabled={busy || !!saved || !eligible}
              loading={searching}
            />
            <Combobox.Popup
              collisionBoundary={pickerBoundary}
              empty={
                searching
                  ? "Searching people…"
                  : "No matching people or channels."
              }
            >
              <Combobox.List>
                <BaseCombobox.Group items={channels}>
                  {!!channels.length && (
                    <BaseCombobox.GroupLabel className="buzz-select-group-label text-caption text-subtle">
                      Channels
                    </BaseCombobox.GroupLabel>
                  )}
                  {channels.map((choice) => (
                    <Combobox.Item key={choice.id} value={choice}>
                      <span className={styles.choice}>
                        <HashIcon size={20} />
                        {choice.name}
                      </span>
                    </Combobox.Item>
                  ))}
                </BaseCombobox.Group>
                <BaseCombobox.Group items={candidates}>
                  {!!candidates.length && (
                    <BaseCombobox.GroupLabel className="buzz-select-group-label text-caption text-subtle">
                      People
                    </BaseCombobox.GroupLabel>
                  )}
                  {candidates.map((choice) => (
                    <Combobox.Item key={choice.id} value={choice}>
                      <span className={styles.choice}>
                        {identity(choice.id)}
                        {names(choice.id)}
                      </span>
                    </Combobox.Item>
                  ))}
                </BaseCombobox.Group>
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Root>
          {searchError && (
            <div role="alert">
              {searchError}
              <Button onClick={() => setReload((value) => value + 1)}>
                Retry search
              </Button>
            </div>
          )}
          <section aria-label="People or channel">
            {!!shownKeys.length && (
              <section aria-label="Selected people">
                {shownKeys.map((key) => row(key, true))}
              </section>
            )}
            {chosen && (
              <section aria-label="Selected channel" className={styles.row}>
                <div className={styles.name}>
                  <Accordion
                    key={chosen.id}
                    variant="form"
                    onValueChange={(value) =>
                      setExpandedChannel(value.length ? chosen.id : "")
                    }
                    items={[
                      {
                        value: "channel-participants",
                        title: (
                          <span className={styles.choice}>
                            <HashIcon size={24} />
                            <span className={styles.name}>
                              <span>#{chosen.name}</span>
                              <span className="text-body-sm text-subtle">
                                {destinationMembers
                                  ? `${destinationMembers.length} member${destinationMembers.length === 1 ? "" : "s"}${submittedAudience ? " · Submitted audience" : ""}`
                                  : destinationRoster?.id !== chosen.id ||
                                      destinationRoster.status === "loading"
                                    ? "Loading participants…"
                                    : "Participants unavailable"}
                              </span>
                            </span>
                          </span>
                        ),
                        content: destinationMembers ? (
                          destinationMembers.map((key) => row(key, false))
                        ) : (
                          <div>
                            <p role="status">
                              {destinationRoster?.id !== chosen.id ||
                              destinationRoster.status === "loading"
                                ? "Loading participants…"
                                : "Current participants are unavailable."}
                            </p>
                            {destinationRoster?.id === chosen.id &&
                              destinationRoster.status === "error" && (
                                <Button
                                  onClick={() =>
                                    setDestinationReload((value) => value + 1)
                                  }
                                >
                                  Retry participants
                                </Button>
                              )}
                          </div>
                        ),
                      },
                    ]}
                  />
                </div>
                <IconButton
                  aria-label={`Remove #${chosen.name}`}
                  disabled={busy || !!saved}
                  icon={<XIcon size={16} />}
                  onClick={() => {
                    setDestination("");
                    setExpandedChannel("");
                  }}
                />
              </section>
            )}
            {rosterState === "error" ? (
              <div role="alert">
                {rosterError}
                <Button onClick={() => setRosterReload((value) => value + 1)}>
                  Retry access
                </Button>
              </div>
            ) : rosterState === "loading" ||
              source?.cached ||
              !source?.members ? (
              <p role="status">Loading current access…</p>
            ) : (
              <>
                <Accordion
                  variant="form"
                  value={expandedShares}
                  onValueChange={setExpandedShares}
                  items={[
                    ...history.channels.flatMap((item) => {
                      const members = item.members.filter((key) =>
                        source.members?.includes(key),
                      );
                      if (
                        item.id === chosen?.id ||
                        !members.some((key) => key !== session.viewer)
                      )
                        return [];
                      return [
                        {
                          value: item.id,
                          title: (
                            <span className={styles.choice}>
                              <HashIcon size={24} />
                              <span className={styles.name}>
                                <span>
                                  #
                                  {list.channels.find(
                                    (current) => current.id === item.id,
                                  )?.name ?? item.name}
                                </span>
                                <span className="text-body-sm text-subtle">
                                  {members.length} member
                                  {members.length === 1 ? "" : "s"}
                                </span>
                              </span>
                            </span>
                          ),
                          content: members.map((key) => row(key, false)),
                        },
                      ];
                    }),
                    ...(otherAccess.length
                      ? [
                          {
                            value: "other-access",
                            title: (
                              <span className={styles.name}>
                                <span>Other access</span>
                                <span className="text-body-sm text-subtle">
                                  {otherAccess.length} member
                                  {otherAccess.length === 1 ? "" : "s"}
                                </span>
                              </span>
                            ),
                            content: otherAccess.map((key) => row(key, false)),
                          },
                        ]
                      : []),
                  ]}
                />
                <section aria-label="Individual access">
                  {source.members
                    .filter(
                      (key) =>
                        key !== session.viewer &&
                        !shownKeys.includes(key) &&
                        (history.people.includes(key) ||
                          (ungrouped.includes(key) && knownAgent(key))),
                    )
                    .map((key) => row(key, false))}
                </section>
              </>
            )}
          </section>
          {(historyError || historyReadError) && (
            <p role="alert" className="text-body-sm text-subtle">
              {historyError || historyReadError}
            </p>
          )}
          {copyStatus && copyStatus !== "Link copied" && (
            <p role="alert" className="text-body-sm text-subtle">
              {copyStatus}
            </p>
          )}
          {!eligible ? (
            <p role="alert">
              Chat access changed. Close and reopen to check current access
              before retrying.
            </p>
          ) : error ? (
            <p role="alert">{error}</p>
          ) : progress ? (
            <p role="status" className="text-body-sm text-subtle">
              {progress}
            </p>
          ) : null}
        </div>
      </Dialog>
      {converting && (
        <ConvertToChannel
          session={session}
          id={channel.id}
          signal={signal}
          onConverted={onConverted}
          close={() => {
            setConverting(false);
            close();
          }}
          finalFocus={
            finalFocus ??
            (() => (trigger.current?.isConnected ? trigger.current : false))
          }
        />
      )}
    </>
  );
}
