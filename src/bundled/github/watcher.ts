// The `github_watch_pr` agent tool and the loop that serves it. While the app is open
// it reads each watched pull request through `gh` once a minute and, when
// `step` finds something, wakes the agent in the conversation where it asked
// (`ctx.agents.wake`): no message is sent, and the agent is told the wake is
// the plugin's, its text data.
import type { Context } from "@deepseek-ai/cordis";
import {
  FEEDBACK_READ,
  feedbackRequest,
  parseFeedback,
  parsePull,
  pullOf,
  pullRequest,
  step,
  WAKE_LIMIT,
  type Step,
  type Watch,
} from "./watch";

export const POLL_MS = 60_000;
const STORAGE_KEY = "buzz.github.pull-watches.v1";
/** Failed polls in a row, a minute apart, that end a watch. */
const FAILURE_LIMIT = 30;

const keyOf = (watch: Pick<Watch, "agent" | "url">) =>
  `${watch.agent} ${watch.url}`;

function load(): Map<string, Watch> {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "[]",
    );
    if (!Array.isArray(value)) return new Map();
    return new Map(
      value
        .filter(
          (watch): watch is Watch =>
            !!watch &&
            typeof watch.agent === "string" &&
            typeof watch.url === "string" &&
            typeof watch.channel === "string" &&
            typeof watch.wakes === "number",
        )
        .map((watch) => [keyOf(watch), watch]),
    );
  } catch {
    return new Map();
  }
}

/** Adds `github_watch_pr` and polls the watches it saved, for this scope's life. */
export function watchPulls(ctx: Context) {
  const watches = load();
  // Set when this scope ends, so a read still in flight then neither wakes
  // anyone nor overwrites the watches a replacement saved.
  let disposed = false;
  const save = () => {
    if (!disposed)
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...watches.values()]));
  };
  /** The pull request at `url`, with the text of feedback not in `seen`. */
  const read = async (url: string, seen?: readonly string[]) => {
    const pull = pullOf(url);
    if (!pull) return undefined;
    const output = await ctx.host.runCommand("pull", pullRequest(pull));
    const snapshot = output === null ? undefined : parsePull(output);
    if (!snapshot || !seen) return snapshot;
    const known = new Set(seen);
    const asked = snapshot.ids
      .filter((id) => !known.has(id))
      .slice(0, FEEDBACK_READ);
    if (!asked.length) return snapshot;
    // Text is read apart, so CI results still arrive when it cannot be.
    const text = await ctx.host.runCommand("pull", feedbackRequest(asked));
    const feedback = text === null ? undefined : parseFeedback(text);
    // What was not read stays unseen, to be read on a later poll.
    const got = new Set(feedback ? asked : []);
    return {
      ...snapshot,
      ids: snapshot.ids.filter((id) => known.has(id) || got.has(id)),
      feedback: feedback ?? [],
    };
  };
  /** Wakes the agent in the watch's conversation. Throws when this copy of
   * the app cannot run it now. */
  const wake = (watch: Watch, text: string) => {
    if (disposed) throw new Error("The GitHub plugin has stopped");
    ctx.agents.wake(watch.agent, {
      channel: watch.channel,
      ...(watch.root ? { root: watch.root } : {}),
      text,
    });
  };
  const settle = (key: string, { watch, ended }: Step) => {
    if (ended) watches.delete(key);
    else watches.set(key, watch);
    save();
  };

  /** Counts a poll that failed; after FAILURE_LIMIT in a row the watch ends,
   * telling the agent if it still can. */
  const failed = (key: string, watch: Watch, error: unknown) => {
    if (disposed) return;
    console.warn(`GitHub watch failed for ${watch.url}`, error);
    const failures = (watch.failures ?? 0) + 1;
    if (failures < FAILURE_LIMIT) {
      watches.set(key, { ...watch, failures });
      return save();
    }
    watches.delete(key);
    save();
    try {
      wake(
        watch,
        `Stopped watching ${watch.url}: it could not be read with gh, or you could not be woken, for ${FAILURE_LIMIT} minutes. Call github_watch_pr again to retry.`,
      );
    } catch {}
  };

  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      for (const [key, watch] of [...watches]) {
        try {
          const snapshot = await read(watch.url, watch.seen);
          if (disposed) return;
          // Removed or replaced while it was read.
          if (watches.get(key) !== watch) continue;
          if (!snapshot) {
            failed(key, watch, "gh could not read it");
            continue;
          }
          const next = step(watch, snapshot, Date.now());
          if (next.wake)
            wake(
              watch,
              next.ended === "limit"
                ? `${next.wake}\n\nThat is ${WAKE_LIMIT} wakes, so this watch has ended; call github_watch_pr again to keep watching.`
                : next.wake,
            );
          settle(key, { ...next, watch: { ...next.watch, failures: 0 } });
        } catch (error) {
          // Unsent news stays unseen, so the next read finds it again.
          if (watches.get(key) === watch) failed(key, watch, error);
        }
      }
    } finally {
      polling = false;
    }
  };

  ctx.agents.addTool({
    name: "github_watch_pr",
    description:
      "Wakes you in this conversation when CI finishes on a GitHub pull request's latest commit, or when someone reviews or comments on it. Comments of the signed-in GitHub account that start with 🤖 are taken as yours and wake nobody, so start your own with 🤖. One call covers later pushes. The watch ends when the pull request merges or closes, after " +
      `${WAKE_LIMIT} wakes, or when you call it with stop: true. Works with attention off. Needs the gh CLI signed in.`,
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The pull request's https://github.com/… URL",
        },
        stop: { type: "boolean", description: "Stop watching it" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    async call(client, context, args) {
      const pull = typeof args.url === "string" ? pullOf(args.url) : undefined;
      if (!pull) throw new Error("url must be a GitHub pull request URL");
      const key = keyOf({ agent: client.key, url: pull.url });
      if (args.stop === true) {
        const had = watches.delete(key);
        save();
        return had
          ? `Stopped watching ${pull.url}.`
          : `${pull.url} was not watched.`;
      }
      // A wake answers in a thread, or at the top of a Solo chat.
      if (!context.channel || !(context.root || context.topLevel))
        throw new Error(
          "github_watch_pr needs a thread or a Solo chat to wake you in",
        );
      const snapshot = await read(pull.url, watches.get(key)?.seen);
      if (disposed) throw new Error("The GitHub plugin has stopped");
      if (!snapshot)
        throw new Error(
          "Could not read the pull request with gh. Check that gh is installed, signed in, and can see it.",
        );
      const prior = watches.get(key);
      const watch: Watch = {
        ...(prior ?? { wakes: 0 }),
        agent: client.key,
        url: pull.url,
        channel: context.channel,
        root: context.topLevel ? undefined : context.root,
        failures: 0,
      };
      const moved =
        prior && (prior.channel !== watch.channel || prior.root !== watch.root);
      // What is already there is answered now rather than by a wake.
      const first = step(watch, snapshot, Date.now());
      if (first.ended && first.ended !== "limit")
        return `${pull.url} is ${first.ended}; nothing to watch.`;
      watches.set(key, { ...first.watch, wakes: watch.wakes });
      save();
      return [
        `Watching ${pull.url}. You will be woken here${moved ? ", no longer in the conversation that asked before," : ""} when CI finishes on its latest commit or new feedback arrives.`,
        ...(first.wake ? ["", "Already there:", first.wake] : []),
      ].join("\n");
    },
  });

  ctx.effect(() => {
    const timer = setInterval(() => void poll(), POLL_MS);
    void poll();
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  });
}
