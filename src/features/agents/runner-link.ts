// What the Runner serves the Manager over the agents link. Each name here is
// part of the contract between the two owners, so add to it with care: only
// JSON crosses, and either side may be a page that reloads.
import type { Json, Link, Served } from "./link";
import type { LocalAgentSource, LocalWork } from "./local-activity";

type WorkKey = Pick<LocalWork, "scope" | "agent" | "messageId">;

const workKey = (args: Json): WorkKey => {
  const { scope, agent, messageId } = args as WorkKey;
  return { scope, agent, messageId };
};

/** The Runner's side: the local work its agents report. */
export function serveActivity(source: LocalAgentSource): Served {
  return {
    topics: {
      "activity.work": () => ({
        get: () => source.work() as unknown as Json,
        subscribe: (listener) => source.subscribeWork(listener),
      }),
    },
    commands: {
      "activity.interrupt": async (args) => {
        await source.interrupt?.(workKey(args));
        return null;
      },
      "activity.dismissError": (args) => {
        source.dismissError?.(workKey(args));
        return null;
      },
    },
  };
}

/** The Manager's side: the Runner's local work, as the screens read it. Rows
 * keep their identity until the Runner sends a change. */
export function linkedActivity(runner: Link) {
  let work: readonly LocalWork[] = Object.freeze([]);
  const listeners = new Set<() => void>();
  const stop = runner.watch("activity.work", null, () => {
    const rows = (runner.read("activity.work") ?? []) as unknown as LocalWork[];
    work = Object.freeze(rows.map((row) => Object.freeze(row)));
    for (const listener of [...listeners]) listener();
  });
  const source: LocalAgentSource = {
    work: () => work,
    subscribeWork(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dismissError: (row) =>
      void runner
        .call("activity.dismissError", workKey(row))
        .catch((error: unknown) =>
          console.warn("Could not hide this error", error),
        ),
    interrupt: async (row) => {
      await runner.call("activity.interrupt", workKey(row));
    },
  };
  return { source, stop };
}
