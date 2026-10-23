import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import {
  listSharedChats,
  type SharedChatEntry,
  type SharedChatPage,
} from "../../features/shared-chats/shared-chats";
import { sharedChatIds } from "../../features/shared-chats/shared-chat-marker";
import { useChannelIdentityNames } from "../../features/identity-names/react";
import { FileTextIcon } from "../../shared/design-system/icons";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { avatarMedia } from "../../shared/avatar-source";
import { formatPublicKey } from "../../shared/identity/public-key";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import styles from "./SharedChats.module.css";

/** One destination's presentation. Verified reads and permissions stay feature-owned. */
export function SharedChats({
  session,
  channelId,
  open,
  view,
  focusRequest,
}: {
  session: RelaySession;
  channelId: string;
  open(id: string): void;
  view?: { query: string; scrollTop: number; focusedEntry?: string };
  focusRequest?: string | undefined;
}) {
  const [query, setQuery] = useState(view?.query ?? "");
  const [page, setPage] = useState<SharedChatPage>();
  const [pending, setPending] = useState(true);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const request = useRef<AbortController>(undefined);
  const retained = useRef<SharedChatPage>(undefined);
  const loader = useRef<(more?: boolean) => void>(() => {});
  const region = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (page && view && scroller.current)
      scroller.current.scrollTop = view.scrollTop;
  }, [view, page]);
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const name = useChannelIdentityNames(session, channelId);

  useEffect(() => {
    const requested = focusRequest && view?.focusedEntry !== focusRequest;
    if (requested) {
      // A retained tab is selected after navigation commits. Let the tab host
      // finish its own focus handoff before focusing the explicitly opened view.
      const frame = requestAnimationFrame(() => {
        if (region.current?.closest('[inert], [aria-hidden="true"]')) return;
        region.current?.focus({ preventScroll: true });
        if (view && focusRequest && document.activeElement === region.current)
          view.focusedEntry = focusRequest;
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [focusRequest, view]);

  // Restore focus only when an update removes the control the person was using.
  const focused = useRef<Element | null>(null);
  useLayoutEffect(() => {
    if (
      focused.current &&
      !focused.current.isConnected &&
      document.activeElement === document.body
    )
      region.current?.focus({ preventScroll: true });
  });

  useEffect(() => {
    let closed = false;
    let depth = 1;
    let retryMore = false;
    const revoked = new Set<string>();
    const readable = (id: string) => {
      const channel = session.channels
        .list()
        .channels.find((item) => item.id === id);
      return (
        !!channel &&
        !channel.cached &&
        (channel.visibility === "public" ||
          (!!session.viewer && !!channel.members?.includes(session.viewer)))
      );
    };
    // Include access transitions for hidden sources, without rendering their identities.
    const fingerprint = () =>
      JSON.stringify(
        session.channels
          .list()
          .channels.map((channel) => [
            channel.id,
            channel.id === channelId ||
            retained.current?.entries.some((entry) => entry.id === channel.id)
              ? channel.name
              : undefined,
            channel.cached,
            channel.visibility === "public" ||
              (!!session.viewer && !!channel.members?.includes(session.viewer)),
          ])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      );
    let knownChannels = new Set(
      session.channels.list().channels.map(({ id }) => id),
    );
    let evidence = fingerprint();
    const load = async (more = false) => {
      const controller = new AbortController();
      request.current = controller;
      setPending(true);
      setLoadingMore(more);
      retryMore = more;
      try {
        const entries = new Map(
          (more ? (retained.current?.entries ?? []) : []).map((entry) => [
            entry.id,
            entry,
          ]),
        );
        let cursor = more ? retained.current?.cursor : undefined;
        let result: SharedChatPage = {
          entries: [],
          complete: false,
          errors: [],
        };
        const errors: string[] = [];
        for (let index = 0; index < (more ? 1 : depth); index++) {
          result = await listSharedChats(session, channelId, {
            ...(cursor ? { cursor } : {}),
            signal: controller.signal,
          });
          if (closed || controller.signal.aborted) return;
          errors.push(...result.errors);
          for (const entry of result.entries) {
            const previous = entries.get(entry.id);
            const shares = new Map(
              [...(previous?.shares ?? []), ...entry.shares].map((share) => [
                share.id,
                share,
              ]),
            );
            entries.set(entry.id, {
              ...entry,
              sharedAt: Math.max(previous?.sharedAt ?? 0, entry.sharedAt),
              shares: [...shares.values()].sort(
                (a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id),
              ),
            });
          }
          // Failed batches must remain reachable by Retry and Load more, even
          // when the core returned useful rows alongside an advanced cursor.
          if (errors.length) break;
          cursor = result.cursor;
          if (!cursor) break;
        }
        const { cursor: continuation, ...details } = result;
        const nextCursor = errors.length ? cursor : continuation;
        const next: SharedChatPage = {
          ...details,
          ...(nextCursor ? { cursor: nextCursor } : {}),
          complete: !errors.length && result.complete,
          errors,
          entries: [...entries.values()]
            .filter((entry) => readable(channelId) && !revoked.has(entry.id))
            .sort(
              (a, b) => b.sharedAt - a.sharedAt || a.id.localeCompare(b.id),
            ),
        };
        if (more && !errors.length) depth++;
        retained.current = next;
        evidence = fingerprint();
        setPage(next);
        setError(errors.length > 0);
        void session.profiles
          .ensure([
            ...new Set(
              next.entries.flatMap((entry) =>
                entry.shares.map((share) => share.pubkey),
              ),
            ),
          ])
          .catch(() => {});
      } catch {
        if (!closed && !controller.signal.aborted) setError(true);
      } finally {
        if (!closed && !controller.signal.aborted) setPending(false);
      }
    };
    let pendingRead = false;
    let refreshQueued = false;
    let explicitRead = false;
    let queuedAction: boolean | undefined;
    loader.current = (more) => {
      if (explicitRead || queuedAction !== undefined) return;
      const action = more ?? retryMore;
      if (pendingRead) {
        // A person can queue recovery/history work during a silent refresh;
        // continuous live traffic must not starve that explicit action.
        queuedAction ??= action;
        setLoadingMore(action);
      } else void run(action, true);
    };
    const run = async (more = false, explicit = false) => {
      if (pendingRead) {
        refreshQueued = true;
        return;
      }
      pendingRead = true;
      explicitRead = explicit;
      try {
        await load(more);
      } finally {
        pendingRead = false;
        explicitRead = false;
        if (!closed && queuedAction !== undefined) {
          const action = queuedAction;
          queuedAction = undefined;
          void run(action, true);
        } else if (!closed && refreshQueued) {
          refreshQueued = false;
          void run();
        }
      }
    };
    const stopRoster = session.channels.subscribeList(() => {
      const current = fingerprint();
      if (current === evidence) return;
      evidence = current;
      const previous = retained.current;
      if (previous) {
        const currentChannels = new Set(
          session.channels.list().channels.map(({ id }) => id),
        );
        for (const id of revoked) if (readable(id)) revoked.delete(id);
        for (const entry of previous.entries) {
          if (readable(entry.id)) revoked.delete(entry.id);
          else if (knownChannels.has(entry.id)) revoked.add(entry.id);
        }
        const entries = readable(channelId)
          ? previous.entries.filter(
              (entry) =>
                (!knownChannels.has(entry.id) &&
                  !currentChannels.has(entry.id)) ||
                readable(entry.id),
            )
          : [];
        retained.current = { ...previous, entries };
        setPage(retained.current);
      }
      knownChannels = new Set(
        session.channels.list().channels.map(({ id }) => id),
      );
      void run();
    });
    const stopLive = session.subscribeLive(
      ({ events, channelId: attributedChannel }) => {
        const targets = new Set(
          retained.current?.entries.flatMap((entry) =>
            entry.shares.map((share) => share.id),
          ) ?? [],
        );
        if (
          events.some((event) => {
            const destination =
              attributedChannel === channelId ||
              event.tags.some(
                ([key, value]) => key === "h" && value === channelId,
              );
            const mutation = [5, 9005, 40003].includes(event.kind);
            return (
              (mutation && !attributedChannel) ||
              (destination && (mutation || sharedChatIds(event).length > 0)) ||
              (mutation &&
                event.tags.some(
                  ([key, value]) =>
                    key === "e" && !!value && targets.has(value),
                ))
            );
          })
        )
          void run();
      },
      { replay: true },
    );
    void run();
    return () => {
      closed = true;
      request.current?.abort();
      retained.current = undefined;
      stopRoster();
      stopLive();
    };
  }, [session, channelId]);

  const personName = (id: string) =>
    name(id, profiles.get(id)?.name ?? formatPublicKey(id) ?? "Unknown person");
  const search = query.trim().toLocaleLowerCase();
  const entries =
    page?.entries.filter((entry) =>
      [
        entry.title || entry.id.slice(0, 8),
        ...entry.shares.map((share) => personName(share.pubkey)),
      ].some((value) => value.toLocaleLowerCase().includes(search)),
    ) ?? [];
  return (
    <section
      ref={region}
      onFocusCapture={(event) => {
        focused.current = event.target;
      }}
      onBlurCapture={(event) => {
        if (
          event.relatedTarget &&
          !event.currentTarget.contains(event.relatedTarget as Node)
        )
          focused.current = null;
      }}
      tabIndex={-1}
      data-tab-focus=""
      aria-label="Shared chats"
      className={styles.root}
    >
      <div className={styles.search}>
        <SearchField
          label="Search shared chats"
          placeholder="Search titles or people"
          value={query}
          onValueChange={(value) => {
            if (view) view.query = value;
            setQuery(value);
          }}
        />
      </div>
      <div
        ref={scroller}
        onScroll={(event) => {
          if (view) view.scrollTop = event.currentTarget.scrollTop;
        }}
        className={styles.scroll}
        data-message-scroller=""
      >
        {error && (
          <div className={styles.feedback}>
            <p role="status">Some shared chats couldn’t be loaded.</p>
            <Button
              size="compact"
              aria-disabled={pending && (!page || loadingMore)}
              onClick={() => loader.current()}
            >
              Retry
            </Button>
          </div>
        )}
        {page && (
          <p role="status" aria-live="polite" className="sr-only">
            {entries.length} {entries.length === 1 ? "chat" : "chats"}
            {page.cursor ? " shown, more available" : ""}
          </p>
        )}
        {entries.length > 0 && (
          <ul className={styles.list} aria-label="Shared chat list">
            {entries.map((entry) => (
              <ChatRow
                key={entry.id}
                entry={entry}
                session={session}
                profiles={profiles}
                personName={personName}
                open={open}
              />
            ))}
          </ul>
        )}
        {pending && (!page || loadingMore) && (
          <p role="status" className={styles.status}>
            Loading shared chats…
          </p>
        )}
        {page && !error && !entries.length && !search && !page.cursor && (
          <EmptyState
            icon={<FileTextIcon size={24} aria-hidden="true" />}
            title="No shared chats to show"
            description="Chats shared in this channel appear here. Agents here can use them to answer questions."
          />
        )}
        {page && !entries.length && search && (
          <div className={styles.feedback}>
            <p>
              No titles or sharers match “{query}”
              {page.cursor ? " in loaded chats" : ""}.
            </p>
            {page.cursor && <p>Load more to search older chats.</p>}
            <Button
              size="compact"
              onClick={() => {
                if (view) view.query = "";
                setQuery("");
              }}
            >
              Clear search
            </Button>
          </div>
        )}
        {page?.cursor && !entries.length && !search && !error && (
          <p className={styles.status}>
            No shared chats to show in the messages checked. Older messages
            remain.
          </p>
        )}
        {page?.cursor && (
          <div className={styles.feedback}>
            <Button
              size="compact"
              aria-disabled={pending && (!page || loadingMore)}
              onClick={() => loader.current(true)}
            >
              {page.entries.length ? "Load more" : "Search older messages"}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

function ChatRow({
  entry,
  session,
  profiles,
  personName,
  open,
}: {
  entry: SharedChatEntry;
  session: RelaySession;
  profiles: ReturnType<RelaySession["profiles"]["snapshot"]>;
  personName(id: string): string;
  open(id: string): void;
}) {
  const description = useId();
  const sharers = [...new Set(entry.shares.map((share) => share.pubkey))];
  const latest = sharers[0] ?? "";
  const profile = profiles.get(latest);
  const sender = personName(latest);
  const people =
    sharers.length > 1
      ? `${sender} and ${sharers.length - 1} ${sharers.length === 2 ? "other" : "others"}`
      : sender;
  const title = entry.title || entry.id.slice(0, 8);
  const date = relativeTimestamp(entry.sharedAt);
  return (
    <li className={styles.row}>
      <NavigationItem
        aria-label={`${title}, shared by ${people}, ${date}`}
        aria-describedby={description}
        onClick={() => open(entry.id)}
        icon={
          <Avatar
            alt=""
            fallback={sender}
            shape={profile?.isAgent ? "squircle" : "circle"}
            src={avatarMedia(profile?.picture, session.media)}
          />
        }
        label={
          <span className={styles.content}>
            <span className={`${styles.title} text-label-sm text-standard`}>
              {title}
            </span>
            <span className={`${styles.metadata} text-caption text-subtle`}>
              <span>{people}</span>
              <span className={styles.shortId}>
                <span aria-hidden="true"> · </span>
                <time dateTime={new Date(entry.sharedAt * 1000).toISOString()}>
                  {date}
                </time>
              </span>
              {title !== entry.id.slice(0, 8) && (
                <span className={styles.shortId}>
                  <span aria-hidden="true"> · </span>
                  {entry.id.slice(0, 8)}
                </span>
              )}
            </span>
            <span className="sr-only" id={description}>
              Chat ID {entry.id.slice(0, 8)}
            </span>
          </span>
        }
      />
    </li>
  );
}
