import { useCallback, useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import type { ComposerSession } from "../../features/messages/composer-session";
import type { ChannelSummary } from "../../features/relay/contracts";
import { allowsOutsideMentions } from "../../features/messages/mention-admission";

type Person = Awaited<
  ReturnType<ComposerSession["directMessages"]["people"]>
>["people"][number];
type Page = { people: readonly Person[]; more: boolean };
const empty: readonly Person[] = [];
/** Typing pause before an uncached query reaches the network. */
export const MENTION_DIRECTORY_DELAY_MS = 200;
const CACHE_LIMIT = 100;

// Successful non-empty first pages, per session (community/viewer) and query.
// Session lifetime bounds staleness; errors are not cached, so Retry reads
// again. Empty results are not cached: `exhausted` owns that evidence, and a
// fresh search for the same query reads again.
const pages = new WeakMap<ComposerSession, Map<string, Page>>();
function cached(session: ComposerSession, query: string) {
  return pages.get(session)?.get(query);
}
function remember(session: ComposerSession, query: string, page: Page) {
  let queries = pages.get(session);
  if (!queries) {
    queries = new Map();
    pages.set(session, queries);
  }
  queries.delete(query);
  queries.set(query, page);
  if (queries.size > CACHE_LIMIT)
    queries.delete(queries.keys().next().value ?? "");
}
// The last settled page per chooser lifetime. Inline completion remounts its
// provider on every keystroke, so a component-local copy would be lost.
const settled = new WeakMap<ComposerSession, Map<string, Page>>();
const LIFETIME_LIMIT = 20;
function settle(session: ComposerSession, lifetime: string, page: Page) {
  let lifetimes = settled.get(session);
  if (!lifetimes) {
    lifetimes = new Map();
    settled.set(session, lifetimes);
  }
  if (lifetimes.get(lifetime) === page) return;
  lifetimes.delete(lifetime);
  lifetimes.set(lifetime, page);
  if (lifetimes.size > LIFETIME_LIMIT)
    lifetimes.delete(lifetimes.keys().next().value ?? "");
}
// Last complete, empty word-prefix search; queries strictly extending it
// cannot match anyone. Re-entering the same query searches afresh.
const exhausted = new WeakMap<ComposerSession, string>();
const refutedPage: Page = { people: empty, more: false };

/**
 * Directory pages belong to this menu and community, not the global profile
 * cache. While a new query waits or loads, the last settled page stays visible
 * so callers can keep its still-matching people instead of blanking the list.
 * `lifetime` names one chooser opening (one picker, or one inline `@` token)
 * and must outlive provider remounts within it.
 */
export function useMentionDirectory(
  session: ComposerSession,
  channel: ChannelSummary | undefined,
  query: string,
  enabled: boolean,
  lifetime: string,
) {
  const active =
    enabled &&
    allowsOutsideMentions(channel) &&
    !channel?.archived &&
    !channel?.readOnly;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    session: ComposerSession;
    query: string;
    attempt: number;
    /** The chooser opening this result belongs to. */
    lifetime: string;
    /** A settled page that is not cached (an empty result), for this opening only. */
    page?: Page;
    error?: string;
  }>();
  const own =
    state?.session === session &&
    state.query === query &&
    state.attempt === attempt &&
    state.lifetime === lifetime
      ? state
      : undefined;
  // An exact key is an author lookup, which name-prefix evidence cannot refute.
  const exactKey = /^[0-9a-f]{64}$/.test(query.trim());
  const prefix = exhausted.get(session);
  const refuted =
    attempt === 0 &&
    !exactKey &&
    prefix !== undefined &&
    query.length > prefix.length &&
    query.startsWith(prefix);
  const hit = active
    ? (cached(session, query) ??
      own?.page ??
      (refuted ? refutedPage : undefined))
    : undefined;
  const searching = active && !hit;
  useEffect(() => {
    if (!searching) return;
    const controller = new AbortController();
    const current = { session, query, attempt, lifetime };
    const timer = setTimeout(() => {
      exhausted.delete(session);
      void session.directMessages.people(query, 1, controller.signal).then(
        ({ people, hasMore }) => {
          if (controller.signal.aborted) return;
          const page = { people, more: hasMore };
          // The user is waiting on this page; render it in the response task
          // rather than behind other queued rendering work.
          if (people.length) {
            remember(session, query, page);
            flushSync(() => setState(current));
            return;
          }
          // The relay ignores non-word text, so it only refutes word prefixes.
          if (!hasMore && !exactKey && /[\p{L}\p{N}]/u.test(query))
            exhausted.set(session, query);
          flushSync(() => setState({ ...current, page }));
        },
        () => {
          if (!controller.signal.aborted)
            setState({
              ...current,
              error: "Could not search community people. Retry to refresh.",
            });
        },
      );
    }, MENTION_DIRECTORY_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [session, query, searching, exactKey, attempt, lifetime]);
  if (hit) settle(session, lifetime, hit);
  const error = active && !hit ? own?.error : undefined;
  const shown = hit ?? settled.get(session)?.get(lifetime);
  const retry = useCallback(() => {
    pages.get(session)?.delete(query);
    setAttempt((value) => value + 1);
  }, [session, query]);
  return useMemo(
    () => ({
      /** The current query's page, or the last settled page while it loads. */
      people: (active && shown?.people) || empty,
      loading: active && !hit && !error,
      error,
      more: !!hit?.more,
      retry,
    }),
    [active, shown, hit, error, retry],
  );
}
