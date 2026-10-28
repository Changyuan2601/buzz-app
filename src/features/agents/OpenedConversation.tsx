// The session of the conversation an agent's profile was opened from, set
// apart above the agent's other conversations. Types list their own sessions.
import { useEffect, useId, useRef, useState } from "react";
import { formatItemTimestamp } from "../../shared/datetime";
import styles from "./ActivityLayout.module.css";
import { Button } from "../../shared/design-system/ui/Button";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { usePanelTabHost } from "../panels/PanelWorkspace";
import { type ChannelLabel, channelIcon } from "../channels/channel-icon";
import type { AgentConversation } from "./service";

type Saved = Readonly<
  Partial<ChannelLabel> & {
    channelId: string;
    root?: string;
    at?: number;
  }
>;

type Place = Readonly<{ channelId: string; root?: string }>;

/** The session for `conversation`: its thread's, else its channel's, which is
 * the one session a channel-scoped agent or a DM keeps. This build's saved
 * session comes first; `find` looks in the type's own history for one another
 * build of the app started, since each build saves its own. */
export function useOpenedSession<T extends Saved>(
  saved: readonly T[],
  conversation: AgentConversation | undefined,
  find: (place: Place, signal: AbortSignal) => Promise<T | undefined>,
): { session?: T; searching?: boolean; error?: string } {
  const places: Place[] = conversation
    ? [
        ...(conversation.rootId
          ? [{ channelId: conversation.channelId, root: conversation.rootId }]
          : []),
        { channelId: conversation.channelId },
      ]
    : [];
  const bound = (place: Place) =>
    saved.find(
      (item) => item.channelId === place.channelId && item.root === place.root,
    );
  const exact = places[0] && bound(places[0]);
  const key = conversation
    ? `${conversation.channelId}/${conversation.rootId ?? ""}`
    : "";
  const [found, setFound] = useState<{
    key: string;
    session?: T;
    error?: string;
  }>();
  const latest = useRef({ bound, find });
  latest.current = { bound, find };
  // biome-ignore lint/correctness/useExhaustiveDependencies: places follow key; bound and find are read when it runs.
  useEffect(() => {
    if (!key || exact) return;
    const abort = new AbortController();
    void (async () => {
      for (const place of places) {
        let session: T | undefined;
        try {
          session =
            latest.current.bound(place) ??
            (await latest.current.find(place, abort.signal));
        } catch (reason) {
          if (abort.signal.aborted) return;
          return setFound({
            key,
            error: reason instanceof Error ? reason.message : String(reason),
          });
        }
        if (abort.signal.aborted) return;
        if (session) return setFound({ key, session });
      }
      setFound({ key });
    })();
    return () => abort.abort();
  }, [key, !!exact]);
  if (!conversation) return {};
  if (exact) return { session: exact };
  if (found?.key !== key) return { searching: true };
  // The place found stays; its row is the one saved now, since a type gives
  // each render its channel's current name and kind.
  const { key: _, session, ...result } = found;
  return session ? { ...result, session: bound(session) ?? session } : result;
}

/** The transcript a type's tab shows over itself as a panel subview, titled
 * `title(row)`. It closes when the profile is retargeted to another
 * conversation, and viewing it again brings its tab back in a tabbed host. */
export function useOpenTranscript<T>(
  conversation: AgentConversation | undefined,
  title: (row: T) => string,
) {
  const place = conversation
    ? `${conversation.channelId}/${conversation.rootId ?? ""}`
    : "";
  const [shown, setShown] = useState<{ place: string; row: T }>();
  // Forgotten, not just hidden: returning to the first conversation must not
  // reopen it unasked.
  if (shown && shown.place !== place) setShown(undefined);
  const tabs = usePanelTabHost();
  return {
    open: shown?.place === place ? shown.row : undefined,
    show(row: T) {
      setShown({ place, row });
      tabs?.activate(tabs.owner, title(row));
    },
    back() {
      setShown(undefined);
    },
  };
}

/** A session's channel as the sidebar shows it: its icon and plain name, or
 * the start of its id alone when the community does not list it, since its
 * kind is unknown then. */
export function ConversationName({
  session,
  title,
  className = "",
}: {
  session: Saved;
  /** The hover text; the name alone by default. */
  title?: string;
  className?: string;
}) {
  const Icon = session.name === undefined ? undefined : channelIcon(session);
  return (
    <span
      className={`flex min-w-0 items-center gap-1 overflow-hidden ${className}`}
      title={title ?? (session.name || session.channelId)}
    >
      {Icon && <Icon size={16} className="shrink-0" aria-hidden="true" />}
      <span className="truncate">
        {session.name || session.channelId.slice(0, 8)}
      </span>
    </span>
  );
}

export function OpenedConversation({
  conversation,
  harness,
  session,
  searching,
  error,
  status,
  onView,
}: {
  conversation: AgentConversation;
  /** The type's name for its sessions, e.g. Codex. */
  harness: string;
  session: Saved | undefined;
  /** Still looking for a session another build of the app started. */
  searching?: boolean | undefined;
  /** Why the search failed. */
  error?: string | undefined;
  /** The session's live state, when it is running. */
  status?: string | undefined;
  onView(): void;
}) {
  const id = useId();
  const place = (session ? session.root : conversation.rootId)
    ? "thread"
    : "channel";
  return (
    <section aria-labelledby={id} className={styles.section}>
      <InlineHeader id={id} title={`This ${place}`} />
      <SettingsGroup layout="form">
        <div className={styles.row}>
          {session ? (
            <>
              <span className={styles.copy}>
                <ConversationName session={session} className="text-label-sm" />
                <span className="block text-body-sm text-subtle">
                  {[
                    status,
                    session.at &&
                      `Last active ${formatItemTimestamp(session.at / 1000, { withTime: true })}`,
                  ]
                    .filter(Boolean)
                    .join(" · ") || `${harness} session`}
                </span>
              </span>
              <Button
                variant="subtle"
                size="sm"
                aria-label={`View transcript: ${session.name || session.channelId.slice(0, 8)}`}
                onClick={onView}
              >
                View transcript
              </Button>
            </>
          ) : searching ? (
            <span role="status" className="text-body-sm text-subtle">
              Looking for a {harness} session…
            </span>
          ) : error ? (
            <span role="alert" className="text-body-sm">
              Could not look for a {harness} session: {error}
            </span>
          ) : (
            <span className="grid gap-1">
              <span className="text-label">No {harness} session here yet</span>
              <span className="text-body-sm text-subtle">
                One starts when you mention the agent in this {place}.
              </span>
            </span>
          )}
        </div>
      </SettingsGroup>
    </section>
  );
}
