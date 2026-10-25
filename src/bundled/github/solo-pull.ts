// A Solo chat's pull request: one link per chat, kept as a NIP-AR artifact in
// the chat so every device and agent in it sees the same one, and the state
// of every linked pull request, read together and kept current while shown.
import {
  ARTIFACT_KIND,
  uuidv5,
} from "../../features/agents/agent-config-artifacts";
import type { EventData } from "../../features/relay/events";
import type { RelaySession } from "../../features/relay/session";
import { loadGitHubDetails } from "./data";
import { GhUnavailable, GitHubError, type GitHubCli } from "./gh";
import { parseGitHubReference } from "./references";

export const SOLO_PULL_TYPE = "buzz.solo.pr";
/** How often shown chats read their links and pull requests again. */
export const SOLO_REFRESH_MS = 60_000;
/** Without `gh`, GitHub allows 60 public reads an hour. A pull request `gh`
 * could not read is tried again alone this often too. */
const PUBLIC_REFRESH_MS = 5 * 60_000;
/** Links change rarely and only by hand, so shown chats read them again when
 * the window comes back, at most this often. */
const LINKS_AGAIN_MS = 5 * 60_000;
/** Chats per link read. Each has one link artifact, so a read of 500, the
 * session reader's cap, leaves room for concurrent revisions. */
const CHANNELS_PER_READ = 100;
const LINKS_PER_READ = 500;

export type PullState = Readonly<{
  state: "open" | "draft" | "merged" | "closed";
  /** The head commit's combined checks, when read with `gh`. */
  checks?: "success" | "failure" | "pending" | undefined;
  conflicts?: boolean | undefined;
}>;
/** A chat's linked pull request, and its state once read. */
export type SoloPull = Readonly<{
  url: string;
  state?: PullState | undefined;
  /** It could not be read. */
  failed?: boolean | undefined;
}>;

const tag = (event: EventData, name: string) =>
  event.tags.find((t) => t[0] === name)?.[1];

/** The pull request a current revision links: a URL, `null` once unlinked, or
 * undefined when it is not a Solo pull request link. */
export function linkOf(event: EventData): string | null | undefined {
  if (event.kind !== ARTIFACT_KIND || tag(event, "type") !== SOLO_PULL_TYPE)
    return undefined;
  try {
    const { url } = JSON.parse(event.content) as { url?: unknown };
    if (url === null) return null;
    const reference =
      typeof url === "string" ? parseGitHubReference(url) : undefined;
    return reference?.kind === "pull" ? reference.url : undefined;
  } catch {
    return undefined;
  }
}

/** Each chat's link artifact `d`, worked out once. */
const linkIds = new Map<string, Promise<string>>();
const linkId = (channel: string) => {
  let id = linkIds.get(channel);
  if (!id) {
    id = uuidv5(channel, SOLO_PULL_TYPE);
    linkIds.set(channel, id);
  }
  return id;
};

async function readLinks(
  session: RelaySession,
  channels: readonly string[],
  signal: AbortSignal,
) {
  const read = session.snapshotRead;
  const links = new Map<string, string | null>();
  if (!read) return links;
  for (let at = 0; at < channels.length; at += CHANNELS_PER_READ) {
    const page = channels.slice(at, at + CHANNELS_PER_READ);
    // Only the chats' link artifacts, not their other artifacts.
    const ids = await Promise.all(page.map(linkId));
    const events = await read(
      [
        {
          kinds: [ARTIFACT_KIND],
          "#h": page,
          "#d": ids,
          artifact: "current",
          limit: LINKS_PER_READ,
        },
      ],
      { signal },
    );
    for (const channel of page) links.set(channel, null);
    for (const event of events) {
      const channel = tag(event, "h");
      const url = linkOf(event);
      if (channel && links.get(channel) === null && url)
        links.set(channel, url);
    }
  }
  return links;
}

/** Links `url` to the Solo chat `channel`, or unlinks it with `null`, as the
 * signed-in person. */
export async function writeLink(
  session: RelaySession,
  channel: string,
  url: string | null,
  signal = AbortSignal.timeout(20_000),
) {
  const read = session.snapshotRead;
  const writer = session.configArtifactWriter;
  if (!read || !writer)
    throw new Error("This community connection can't save pull request links.");
  const d = await linkId(channel);
  const [head] = await read(
    [
      {
        kinds: [ARTIFACT_KIND],
        "#h": [channel],
        "#d": [d],
        artifact: "current",
        limit: 1,
      },
    ],
    { signal },
  );
  if (head ? linkOf(head) === url : url === null) return;
  const event = await writer.sign(
    {
      kind: ARTIFACT_KIND,
      created_at: Math.floor(Date.now() / 1000),
      content: JSON.stringify({ version: 1, url }),
      tags: [
        ["ar", "1"],
        ["d", d],
        ["h", channel],
        ["type", SOLO_PULL_TYPE],
        ["title", "Pull request"],
        ["op", head ? "update" : "create"],
        ...(head ? [["prev", head.id]] : []),
      ],
    },
    signal,
  );
  await writer.publish(event, signal);
}

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

/** All of `urls` in one GitHub request: each one's state, or undefined for
 * one GitHub could not read. Throws when it answered for none. */
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

export type SoloPulls = Readonly<{
  /** Keeps `channel`'s link and pull request current while subscribed. */
  watch(channel: string, listener: () => void): () => void;
  get(channel: string): SoloPull | undefined;
  /** Shows a link this device just wrote, without reading it back. */
  linked(channel: string, url: string | null): void;
}>;

/** One session's Solo pull requests, read with `gh` when there is one.
 *
 * Links are read once per shown chat, batched for rows that appear together,
 * and again when the window comes back after a while; never on a timer.
 * Pull requests are polled only while a shown chat links one that can still
 * change. One that GitHub cannot read leaves the shared query and is tried
 * alone every few minutes. */
export function createSoloPulls(
  session: RelaySession,
  gh: GitHubCli | undefined,
): SoloPulls {
  const listeners = new Map<string, Set<() => void>>();
  const links = new Map<string, string | null>();
  const states = new Map<string, PullState | "failed">();
  /** Shown chats whose link is still to be read. */
  const unread = new Set<string>();
  /** Pull requests GitHub could not read, and when to try each alone again. */
  const retryAt = new Map<string, number>();
  /** Until when to read public data instead, after `gh` was unavailable. */
  let publicUntil = 0;
  const readsPublic = () => !gh || Date.now() < publicUntil;
  let linksReadAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let scheduled = false;
  /** What `get` answered since the last change, so it answers the same. */
  const views = new Map<string, SoloPull | undefined>();
  const notify = () => {
    views.clear();
    for (const set of listeners.values())
      for (const listener of set) listener();
  };
  const shown = () => [
    ...new Set(
      [...listeners.keys()]
        .map((channel) => links.get(channel))
        .filter((url): url is string => !!url),
    ),
  ];
  /** A merged pull request stays that way; a closed one can reopen. */
  const settled = (url: string) => {
    const state = states.get(url);
    return !!state && state !== "failed" && state.state === "merged";
  };
  /** The next poll, while a shown chat's link is unread or links a pull
   * request that can change. */
  const later = () => {
    clearTimeout(timer);
    timer = undefined;
    if (
      ![...unread].some((channel) => listeners.has(channel)) &&
      !shown().some((url) => !settled(url))
    )
      return;
    timer = setTimeout(
      () =>
        document.visibilityState === "visible" ? void refresh(true) : later(),
      readsPublic() ? PUBLIC_REFRESH_MS : SOLO_REFRESH_MS,
    );
  };
  /** Reads the links still unread, then pull requests: on a poll, every one
   * that can change and is due; otherwise only those not read yet. */
  async function refresh(poll: boolean) {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    clearTimeout(timer);
    timer = undefined;
    const signal = AbortSignal.any([
      current.signal,
      AbortSignal.timeout(30_000),
    ]);
    try {
      const channels = [...unread].filter((channel) => listeners.has(channel));
      if (channels.length) {
        const read = await readLinks(session, channels, signal);
        // A refresh that was stopped or replaced changes nothing.
        if (current.signal.aborted) return;
        for (const [channel, url] of read) {
          links.set(channel, url);
          unread.delete(channel);
        }
        notify();
      }
      const now = Date.now();
      const due = shown().filter((url) =>
        poll ? !settled(url) : !states.has(url),
      );
      const together = due.filter((url) => !retryAt.has(url));
      const alone = due.filter((url) => (retryAt.get(url) ?? Infinity) <= now);
      const [found, retried] = await Promise.all([
        readAll(together, signal),
        Promise.all(
          alone.map((url) =>
            readAll([url], signal).then(
              ([state]) => state,
              () => undefined,
            ),
          ),
        ),
      ]);
      // One that timed out still records what it read, and what it could not.
      if (current.signal.aborted) return;
      const read = (url: string, state: PullState | undefined) => {
        states.set(url, state ?? "failed");
        if (state) retryAt.delete(url);
        else retryAt.set(url, now + PUBLIC_REFRESH_MS);
      };
      for (const [i, url] of together.entries()) read(url, found[i]);
      for (const [i, url] of alone.entries()) read(url, retried[i]);
      notify();
    } catch {
      // Keep what is shown; the next refresh tries again.
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
    if (!urls.length) return [];
    if (gh && !readsPublic())
      try {
        return await readStates(gh, urls, signal);
      } catch (error) {
        // Offline or signed out for now; gh is tried again next public read.
        if (!(error instanceof GhUnavailable)) throw error;
        publicUntil = Date.now() + PUBLIC_REFRESH_MS;
      }
    return Promise.all(
      urls.map((url) => readPublicState(url, signal).catch(() => undefined)),
    );
  }
  /** Reads soon, once for every row that starts watching together. */
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (listeners.size) void refresh(false);
    });
  }
  /** Back in the window after a while: shown chats read their links again. */
  const returned = () => {
    if (
      document.visibilityState !== "visible" ||
      Date.now() - linksReadAt < LINKS_AGAIN_MS
    )
      return;
    linksReadAt = Date.now();
    for (const channel of listeners.keys()) unread.add(channel);
    schedule();
  };
  return {
    watch(channel, listener) {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        if (!listeners.size) {
          linksReadAt = Date.now();
          document.addEventListener("visibilitychange", returned);
        }
        listeners.set(channel, set);
        const url = links.get(channel);
        if (!links.has(channel)) unread.add(channel);
        if (!links.has(channel) || (url && !states.has(url))) schedule();
        else if (!controller && timer === undefined) later();
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size) return;
        listeners.delete(channel);
        if (listeners.size) return;
        document.removeEventListener("visibilitychange", returned);
        clearTimeout(timer);
        timer = undefined;
        controller?.abort();
        controller = undefined;
      };
    },
    get(channel) {
      if (!views.has(channel)) {
        const url = links.get(channel);
        const state = url ? states.get(url) : undefined;
        views.set(
          channel,
          !url
            ? undefined
            : state === "failed"
              ? { url, failed: true }
              : { url, state },
        );
      }
      return views.get(channel);
    },
    linked(channel, url) {
      links.set(channel, url);
      unread.delete(channel);
      notify();
      if (url && !states.has(url)) schedule();
      else if (listeners.size && !controller) later();
    },
  };
}
