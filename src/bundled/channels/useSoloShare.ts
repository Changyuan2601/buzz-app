import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import type { Navigation } from "../../features/navigation/controller";
import { sharedSessionNavigationTarget } from "../../features/sessions/shared-session-target";
import { sharedSessionIds } from "../../features/sessions/shared-session-marker";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import {
  beginSoloShare,
  finishSoloShare,
  soloShareAttempt,
  useSoloShareAttempts,
  type ShareAttempt,
} from "../../features/solo/share-attempt";
import { useChatConversions } from "../../features/solo/conversion";
import { subscribeView, viewRevision } from "../../shared/view-state";
import {
  readShareHistory,
  saveShareHistory,
  shareHistoryKey,
  type ShareHistory,
} from "../../features/solo/share-history";
import {
  formatPublicKey,
  publicKeyLabels,
} from "../../shared/identity/public-key";
import { useIdentityNames } from "../../features/identity-names/react";
import {
  accessFailureNotice,
  canShareConversation,
  destinationShareAudience,
  grantSoloChatAccess,
  publishSoloChatLink,
} from "../../features/solo/share";

export type ShareChannel = { id: string; name: string };

/** Sharing a Solo chat to a channel, inside the access dialog. People are added
 * one at a time like any member; a channel share freezes its audience, grants
 * each member and posts a link. Submitted work belongs to the relay session;
 * this view does not own persistence, grant retries or link delivery. */
export function useSoloShare({
  session,
  navigator: navigationController,
  channelId,
  enabled,
  signal,
  query,
  setQuery,
  input,
  close,
}: {
  session: RelaySession;
  navigator?: Navigation | undefined;
  channelId: string;
  /** Only Solo chats share; channels keep every effect idle. */
  enabled: boolean;
  signal?: AbortSignal | undefined;
  query: string;
  setQuery(query: string): void;
  input: RefObject<HTMLElement | null>;
  close(): void;
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
  const [destination, setDestination] = useState("");
  const [expandedChannel, setExpandedChannel] = useState("");
  const [expandedShares, setExpandedShares] = useState<string[]>([]);
  const [historyError, setHistoryError] = useState("");
  const historyRevision = useSyncExternalStore(
    useCallback(
      (notify) => subscribeView(session.scope, notify),
      [session.scope],
    ),
    () => viewRevision(session.scope, shareHistoryKey(channelId)),
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
  const [rosterState, setRosterState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [rosterError, setRosterError] = useState("");
  const [rosterReload, setRosterReload] = useState(0);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [pendingAction, setPendingAction] = useState<"share" | "retry">();
  const busy = pendingAction !== undefined;
  const [frozen, setFrozen] = useState<ShareAttempt | undefined>(() =>
    soloShareAttempt(session, channelId),
  );
  const attempts = useSoloShareAttempts(session);
  const saved = frozen ?? attempts.get(channelId);
  const source = list.channels.find((item) => item.id === channelId);
  const eligible = canShareConversation(session, source);
  const chosenId = saved ? saved.intent.destination : destination;
  const liveChosen = list.channels.find(
    (item) => item.id === chosenId && item.id !== channelId,
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
  useEffect(() => {
    void rosterReload;
    if (!enabled) return;
    const controller = new AbortController();
    const cancelled = () => controller.abort();
    signal?.addEventListener("abort", cancelled, { once: true });
    if (signal?.aborted) controller.abort();
    setRosterState("loading");
    setRosterError("");
    void (
      session.channels.refreshRoster
        ? session.channels.refreshRoster(channelId, {
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
          .channels.find((item) => item.id === channelId);
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
  }, [enabled, session, channelId, rosterReload, signal]);
  const chosenChannelId = chosen?.id;
  useEffect(() => {
    void destinationReload;
    if (!enabled || !chosenChannelId || submittedAudience) return;
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
    enabled,
    chosenChannelId,
    submittedAudience,
    session,
    signal,
    destinationReload,
  ]);
  const memberKeys =
    enabled && rosterState === "ready" && !source?.cached
      ? source?.members?.join(":")
      : "";
  useEffect(() => {
    if (!memberKeys) return;
    void session.profiles
      .ensure(memberKeys.split(":"), "foreground")
      .catch(() => {});
    // Reuse the existing verified role reader; unknown owner/agent classification
    // stays unlabeled rather than being represented as private.
    void session.memberAdministration.refresh(channelId).catch(() => {});
  }, [session, channelId, memberKeys]);
  const destinationProfileKeys =
    enabled && expandedChannel === chosen?.id
      ? destinationMembers?.join(":")
      : "";
  useEffect(() => {
    if (destinationProfileKeys)
      void session.profiles
        .ensure(destinationProfileKeys.split(":"), "foreground")
        .catch(() => {});
  }, [session, destinationProfileKeys]);
  const resolveName = useIdentityNames(session.names);
  const displayKeys = [
    ...new Set([...(source?.members ?? []), ...(destinationMembers ?? [])]),
  ];
  const labels = new Map(
    displayKeys.map((key) => [
      key,
      resolveName(
        key,
        profiles.get(key)?.name ?? formatPublicKey(key) ?? "Member",
        displayKeys,
      ).trim(),
    ]),
  );
  // A naming policy is optional. Audience names must still be distinct before
  // granting history access; unique names never need a key subtitle.
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
  const channels: ShareChannel[] = destination
    ? []
    : list.channels
        .filter(
          (item) =>
            item.id !== channelId &&
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
        .map((item) => ({ id: item.id, name: item.name }));
  const reset = () => {
    setDestination("");
    setExpandedChannel("");
    setExpandedShares([]);
    setHistoryError("");
    setQuery("");
    setError("");
    setProgress("");
    setFrozen(soloShareAttempt(session, channelId));
  };
  const startOver = () => {
    if (!visible() || busy || !saved) return;
    if (saved.running) {
      setError("This share is already in progress in another view.");
      return;
    }
    if (soloShareAttempt(session, channelId) !== saved) {
      setError(
        "This share finished or changed. Close and reopen to start a new share.",
      );
      return;
    }
    finishSoloShare(session, channelId);
    reset();
  };
  const choose = (channel: ShareChannel) => {
    if (busy || saved || !eligible || destination) return;
    setDestination(channel.id);
    setQuery("");
    input.current?.focus();
  };
  const submit = async () => {
    if (!visible() || busy) return;
    if (!saved && !destination) {
      close();
      return;
    }
    if (!eligible) {
      setError(
        "Chat access changed. Close and reopen to check current access before retrying.",
      );
      return;
    }
    if (saved && soloShareAttempt(session, channelId) !== saved) {
      setError(
        "This share finished or changed. Close and reopen to start a new share.",
      );
      return;
    }
    const exact = beginSoloShare(session, channelId, {
      destination,
      chatPeople: [],
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
      const snapshot = exact.channelSnapshot;
      const recipients =
        snapshot?.members.filter(
          (key) => key !== session.viewer && !!exact.grants.get(key)?.confirmed,
        ) ?? [];
      if (!snapshot || !recipients.length || !session.viewer) return true;
      try {
        saveShareHistory(session.scope, channelId, [], {
          ...snapshot,
          members: [session.viewer, ...recipients],
        });
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
      if (!exact.audienceKeys) {
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
        exact.audienceKeys = [...new Set(audience)];
      }
      const keys = exact.audienceKeys;
      if (!keys.length && !exact.messageId)
        throw new Error(
          "This channel has no other current members to share with.",
        );
      if (keys.length > 100 || new Set(keys).size !== keys.length)
        throw new Error("Choose at most 100 distinct recipients.");
      progress("Confirming chat access…");
      // A confirmed grant is never replayed, even if its recipient later leaves.
      const failed = await grantSoloChatAccess(
        session,
        channelId,
        keys.filter((key) => !exact.grants.get(key)?.confirmed),
        exact.grants,
        controller.signal,
        () => {},
        true,
        source?.channelType === "solo",
        true,
      );
      // Nothing granted keeps Retry; a partial share posts and reports who was missed.
      if (
        failed[0] &&
        ![...exact.grants.values()].some((intent) => intent.confirmed)
      )
        throw new Error(failed[0].error);
      const historySaved = remember();
      progress("Posting chat link…");
      const messageId = await publishSoloChatLink(
        session,
        channelId,
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
          confirmed.some((event) => sharedSessionIds(event).includes(channelId))
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
      finishSoloShare(session, channelId);
      if (failed.length) notify(accessFailureNotice(failed, names), "error");
      if (visible()) {
        if (historySaved) close();
        else {
          // Completed access/link work must not be retried for a display-save failure.
          setFrozen(undefined);
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
  return {
    eligible,
    saved,
    busy,
    pendingAction,
    destination,
    chosen,
    destinationMembers,
    destinationRoster,
    retryDestination: () => setDestinationReload((value) => value + 1),
    submittedAudience,
    removeDestination: () => {
      setDestination("");
      setExpandedChannel("");
    },
    setExpandedChannel,
    expandedShares,
    setExpandedShares,
    history,
    historyError: historyError || historyReadError,
    source,
    rosterState,
    rosterError,
    reloadRoster: () => setRosterReload((value) => value + 1),
    names,
    channels,
    choose,
    submit,
    startOver,
    error,
    progress,
  };
}
