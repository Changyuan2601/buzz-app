// The state of every pull request shown somewhere in the app, read together
// and kept current while shown.
import { loadGitHubDetails } from "./data";
import { GhUnavailable, GitHubError, type GitHubCli } from "./gh";
import { parseGitHubReference } from "./references";

/** How often shown pull requests that can change are read again. */
export const PULL_REFRESH_MS = 60_000;
/** Without `gh`, GitHub allows 60 public reads an hour. A pull request that
 * could not be read is tried again this often, and a closed one, which rarely
 * reopens, is read again this often too. */
export const PULL_SLOW_REFRESH_MS = 5 * 60_000;

export type PullState = Readonly<{
  state: "open" | "draft" | "merged" | "closed";
  /** The head commit's combined checks, when read with `gh`. */
  checks?: "success" | "failure" | "pending" | undefined;
  conflicts?: boolean | undefined;
}>;

export type PullStates = Readonly<{
  /** Keeps `url`'s state current while subscribed. A URL that is not a pull
   * request's is not watched. */
  watch(url: string, listener: () => void): () => void;
  /** Its state, `"failed"` when it could not be read or `url` is not a pull
   * request's, or undefined before the first read. */
  get(url: string): PullState | "failed" | undefined;
}>;

type Rollup = "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED";
type StateData = {
  pullRequest?: {
    state: "OPEN" | "CLOSED" | "MERGED";
    isDraft: boolean;
    mergeStateStatus?: string;
    commits?: {
      nodes?: ({
        commit?: { statusCheckRollup?: { state?: Rollup } | null };
      } | null)[];
    };
  } | null;
} | null;

const checksOf = (rollup: Rollup | undefined): PullState["checks"] =>
  rollup === "SUCCESS"
    ? "success"
    : rollup === "FAILURE" || rollup === "ERROR"
      ? "failure"
      : rollup
        ? "pending"
        : undefined;

/** All of `urls`, canonical pull request URLs, in one GitHub request: each
 * one's state, or undefined for one GitHub could not read. Throws when it
 * answered for none. */
async function readStates(
  gh: GitHubCli,
  urls: readonly string[],
  signal: AbortSignal,
) {
  const variables: Record<string, string | number> = {};
  const fields = urls.map((url, i) => {
    const reference = parseGitHubReference(url);
    const [owner = "", name = ""] = reference?.repository.split("/") ?? [];
    variables[`o${i}`] = owner;
    variables[`n${i}`] = name;
    variables[`p${i}`] = Number(url.split("/").at(-1));
    return `r${i}:repository(owner:$o${i},name:$n${i}){pullRequest(number:$p${i}){
      state isDraft mergeStateStatus commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}`;
  });
  const declared = urls
    .map((_, i) => `$o${i}:String!,$n${i}:String!,$p${i}:Int!`)
    .join(",");
  let data: Record<string, StateData>;
  try {
    data = await gh<Record<string, StateData>>(
      `query(${declared}){${fields.join("\n")}}`,
      variables,
      signal,
    );
  } catch (error) {
    // A missing pull request is an error for its alias alone; GitHub still
    // answers the rest.
    if (!(error instanceof GitHubError) || typeof error.data !== "object")
      throw error;
    data = error.data as Record<string, StateData>;
  }
  return urls.map((_, i): PullState | undefined => {
    const pull = data[`r${i}`]?.pullRequest;
    if (!pull) return undefined;
    return {
      state:
        pull.state === "MERGED"
          ? "merged"
          : pull.state === "CLOSED"
            ? "closed"
            : pull.isDraft
              ? "draft"
              : "open",
      checks: checksOf(
        pull.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state,
      ),
      conflicts: pull.mergeStateStatus === "DIRTY",
    };
  });
}

async function readPublicState(
  url: string,
  signal: AbortSignal,
): Promise<PullState | undefined> {
  const reference = parseGitHubReference(url);
  if (!reference) return undefined;
  const { state } = await loadGitHubDetails(reference, signal);
  return {
    state:
      state === "Merged"
        ? "merged"
        : state === "closed"
          ? "closed"
          : state === "Draft"
            ? "draft"
            : "open",
  };
}

/** The pull request `url` names, as the store keys it: its canonical URL, so
 * a link pasted with a query string or trailing slash shares the entry, and
 * the read, of the plain one. Undefined for a URL that is not a pull request's. */
const keyOf = (url: string) => {
  const reference = parseGitHubReference(url);
  return reference?.kind === "pull" ? reference.url : undefined;
};

/** The app's pull request states, read with `gh` when there is one.
 *
 * Every shown pull request that is due is read in one request, once for every
 * subscriber that appears together, then polled only while shown, visible and
 * able to change: a merged one is never read again, a closed one or one GitHub
 * could not read every few minutes. Without `gh`, each is read from the
 * public API once, tried again every few minutes until it is; the panel has
 * the live view. */
export function createPullStates(gh: GitHubCli | undefined): PullStates {
  const listeners = new Map<string, Set<() => void>>();
  const states = new Map<string, PullState | "failed">();
  /** When each read pull request is read again; never for a settled one. */
  const nextRead = new Map<string, number>();
  /** Until when to read public data instead, after `gh` was unavailable. */
  let publicUntil = 0;
  const readsPublic = () => !gh || Date.now() < publicUntil;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let scheduled = false;
  /** Tells whoever shows `urls` that their states were recorded. */
  const notify = (urls: readonly string[]) => {
    for (const url of urls)
      for (const listener of listeners.get(url) ?? []) listener();
  };
  const dueAt = (url: string) => nextRead.get(url) ?? 0;
  /** When `state`, read now, is read again. */
  const again = (state: PullState | undefined, now: number) => {
    if (state?.state === "merged" || (!gh && state)) return Infinity;
    return !state || state.state === "closed" || readsPublic()
      ? now + PULL_SLOW_REFRESH_MS
      : now + PULL_REFRESH_MS;
  };
  /** The next poll, when a shown pull request is next due. A hidden window
   * looks again later rather than reading. */
  const later = (atLeast = 0) => {
    clearTimeout(timer);
    timer = undefined;
    const due = Math.min(...[...listeners.keys()].map(dueAt));
    if (due === Infinity) return;
    timer = setTimeout(
      () =>
        document.visibilityState === "visible"
          ? void refresh()
          : later(PULL_REFRESH_MS),
      Math.max(atLeast, due - Date.now()),
    );
  };
  /** Reads every shown pull request that is due. A read in flight is left to
   * finish; it picks up what became due meanwhile. */
  async function refresh() {
    if (controller) return;
    const current = new AbortController();
    controller = current;
    clearTimeout(timer);
    timer = undefined;
    const signal = AbortSignal.any([
      current.signal,
      AbortSignal.timeout(30_000),
    ]);
    const now = Date.now();
    const due = [...listeners.keys()].filter((url) => dueAt(url) <= now);
    try {
      if (!due.length) return;
      const found = await readAll(due, signal);
      // One that timed out still records what it read, and what it could not.
      if (current.signal.aborted) return;
      for (const [i, url] of due.entries()) {
        const state = found[i];
        states.set(url, state ?? "failed");
        nextRead.set(url, again(state, now));
      }
      notify(due);
    } catch {
      // GitHub answered for none, or not in time: keep what is shown and try
      // again in a minute rather than at once.
      if (current.signal.aborted) return;
      for (const url of due) nextRead.set(url, now + PULL_REFRESH_MS);
    } finally {
      if (controller === current) {
        controller = undefined;
        if (listeners.size) later();
      }
    }
  }
  async function readAll(
    urls: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly (PullState | undefined)[]> {
    if (gh && !readsPublic())
      try {
        return await readStates(gh, urls, signal);
      } catch (error) {
        // Offline or signed out for now; gh is tried again next public read.
        if (!(error instanceof GhUnavailable)) throw error;
        publicUntil = Date.now() + PULL_SLOW_REFRESH_MS;
      }
    return Promise.all(
      urls.map((url) => readPublicState(url, signal).catch(() => undefined)),
    );
  }
  /** Reads soon, once for every subscriber that starts watching together. */
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (listeners.size) void refresh();
    });
  }
  return {
    watch(raw, listener) {
      const url = keyOf(raw);
      if (!url) return () => {};
      let set = listeners.get(url);
      if (!set) {
        set = new Set();
        listeners.set(url, set);
        // One read within the poll window keeps what it read.
        if (dueAt(url) <= Date.now()) schedule();
        else if (!controller) later();
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size) return;
        listeners.delete(url);
        if (listeners.size) return;
        clearTimeout(timer);
        timer = undefined;
        controller?.abort();
        controller = undefined;
      };
    },
    get(url) {
      const key = keyOf(url);
      return key ? states.get(key) : "failed";
    },
  };
}
