// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { GhUnavailable, GitHubError, type GitHubCli } from "./gh";
import {
  createPullStates,
  PULL_REFRESH_MS,
  PULL_SLOW_REFRESH_MS,
} from "./pull-states";

const pull = "https://github.com/block/buzz-app/pull/7";
const second = "https://github.com/block/buzz/pull/9";
const third = "https://github.com/block/goose/pull/3";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const rollup = (
  state: string,
  extra: Record<string, unknown> = {},
  checks?: string,
) => ({
  pullRequest: {
    state,
    isDraft: false,
    mergeStateStatus: "CLEAN",
    commits: {
      nodes: [
        { commit: { statusCheckRollup: checks ? { state: checks } : null } },
      ],
    },
    ...extra,
  },
});
const mockGh = (implementation: (...args: never[]) => unknown) =>
  vi.fn(implementation) as unknown as GitHubCli & ReturnType<typeof vi.fn>;

it("reads every watched pull request together, once, then again each minute while watched", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const gh = mockGh(async () => ({
    r0: rollup("OPEN", { mergeStateStatus: "DIRTY" }, "FAILURE"),
    r1: rollup("MERGED"),
  }));
  const states = createPullStates(gh);
  const changed = [vi.fn(), vi.fn(), vi.fn()] as const;
  const stop = [
    states.watch(pull, changed[0]),
    states.watch(pull, changed[1]),
    states.watch(second, changed[2]),
  ];
  await vi.waitFor(() => expect(states.get(second)).toBeDefined());
  // Two links to one pull request cost one read, and both hear of it.
  expect(gh).toHaveBeenCalledOnce();
  expect(gh.mock.calls[0]?.[1]).toEqual({
    o0: "block",
    n0: "buzz-app",
    p0: 7,
    o1: "block",
    n1: "buzz",
    p1: 9,
  });
  for (const listener of changed) expect(listener).toHaveBeenCalledOnce();
  expect(states.get(pull)).toEqual({
    state: "open",
    checks: "failure",
    conflicts: true,
  });
  expect(states.get(pull)).toBe(states.get(pull));
  expect(states.get(second)).toEqual({ state: "merged", conflicts: false });

  // Only the open one is polled: a merged pull request stays that way.
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  expect(gh).toHaveBeenCalledTimes(2);
  expect(gh.mock.calls[1]?.[1]).toEqual({ o0: "block", n0: "buzz-app", p0: 7 });
  for (const unwatch of stop) unwatch();
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS * 3);
  expect(gh).toHaveBeenCalledTimes(2);
});

it("keeps what it read for a pull request watched again within the minute", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const gh = mockGh(async () => ({ r0: rollup("OPEN", {}, "SUCCESS") }));
  const states = createPullStates(gh);
  const unwatch = states.watch(pull, () => {});
  await vi.waitFor(() => expect(states.get(pull)).toBeDefined());
  unwatch();
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS / 2);
  // A row that scrolls out and back shows its state at once, unread.
  states.watch(pull, () => {});
  await vi.advanceTimersByTimeAsync(0);
  expect(states.get(pull)).toEqual({
    state: "open",
    checks: "success",
    conflicts: false,
  });
  expect(gh).toHaveBeenCalledOnce();
  // The poll keeps its original time.
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS / 2);
  expect(gh).toHaveBeenCalledTimes(2);
});

it("leaves an unreadable pull request out of the shared query, trying it alone every 5 minutes", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  // GitHub answers the pull requests it can read and an error for the rest.
  const gh = mockGh(
    async (_query: string, variables: Record<string, unknown>) => {
      const data: Record<string, unknown> = {};
      let missing = false;
      for (let i = 0; `n${i}` in variables; i++)
        if (variables[`n${i}`] === "buzz") {
          data[`r${i}`] = null;
          missing = true;
        } else data[`r${i}`] = rollup("OPEN", { isDraft: true }, "PENDING");
      if (missing) throw new GitHubError("Not found", "NOT_FOUND", data);
      return data;
    },
  );
  const states = createPullStates(gh);
  for (const url of [pull, second, third]) states.watch(url, () => {});
  await vi.waitFor(() => expect(states.get(second)).toBe("failed"));
  expect(gh).toHaveBeenCalledOnce();
  expect(states.get(pull)).toEqual({
    state: "draft",
    checks: "pending",
    conflicts: false,
  });
  const repositories = () =>
    gh.mock.calls.map(([, variables]) =>
      Object.entries(variables as Record<string, unknown>)
        .filter(([key]) => key.startsWith("n"))
        .map(([, name]) => name),
    );
  // Four minutes of polls: the two readable ones together, once a minute.
  await vi.advanceTimersByTimeAsync(4 * PULL_REFRESH_MS);
  expect(repositories().slice(1)).toEqual(
    Array.from({ length: 4 }, () => ["buzz-app", "goose"]),
  );
  // The fifth also tries the missing one, alone.
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  expect(repositories().slice(5)).toEqual([["buzz-app", "goose"], ["buzz"]]);
  expect(states.get(second)).toBe("failed");
});

it("reads a closed pull request, which can reopen, again every few minutes rather than every minute", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const gh = vi
    .fn()
    .mockResolvedValueOnce({ r0: rollup("CLOSED") })
    .mockResolvedValue({
      r0: rollup("OPEN", {}, "SUCCESS"),
    }) as unknown as GitHubCli & ReturnType<typeof vi.fn>;
  const states = createPullStates(gh);
  states.watch(pull, () => {});
  await vi.waitFor(() =>
    expect(states.get(pull)).toMatchObject({ state: "closed" }),
  );
  await vi.advanceTimersByTimeAsync(PULL_SLOW_REFRESH_MS - PULL_REFRESH_MS);
  expect(gh).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  expect(gh).toHaveBeenCalledTimes(2);
  expect(states.get(pull)).toMatchObject({ state: "open" });
  // Open again, it is polled every minute.
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  expect(gh).toHaveBeenCalledTimes(3);
});

it("reads public data once without gh, never on a timer", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const fetch = vi.fn(
    async () => new Response(JSON.stringify({ title: "A", state: "open" })),
  );
  vi.stubGlobal("fetch", fetch);
  const states = createPullStates(undefined);
  states.watch(pull, () => {});
  await vi.waitFor(() => expect(states.get(pull)).toEqual({ state: "open" }));
  expect(fetch).toHaveBeenCalledWith(
    "https://api.github.com/repos/block/buzz-app/pulls/7",
    expect.anything(),
  );
  await vi.advanceTimersByTimeAsync(3 * PULL_SLOW_REFRESH_MS);
  expect(fetch).toHaveBeenCalledOnce();
});

it("reads public data while gh is unavailable, and goes back to gh once it is available again", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ state: "open" }))),
  );
  let signedIn = false;
  const gh = mockGh(async () => {
    if (!signedIn) throw new GhUnavailable();
    return { r0: rollup("OPEN", {}, "SUCCESS") };
  });
  const states = createPullStates(gh);
  states.watch(pull, () => {});
  await vi.waitFor(() => expect(states.get(pull)).toEqual({ state: "open" }));
  // Public reads are sparse: the next one, with gh back, is in five minutes.
  signedIn = true;
  await vi.advanceTimersByTimeAsync(PULL_SLOW_REFRESH_MS - PULL_REFRESH_MS);
  expect(gh).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  expect(gh).toHaveBeenCalledTimes(2);
  expect(states.get(pull)).toMatchObject({ checks: "success" });
});

it("keeps a refresh that was given up on from marking pull requests unavailable", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let answer: (value: unknown) => void = () => {};
  const gh = mockGh(
    (_query: string, _variables: unknown, signal?: AbortSignal) =>
      new Promise((resolve, reject) => {
        answer = resolve;
        signal?.addEventListener("abort", () => reject(signal.reason));
      }),
  );
  const states = createPullStates(gh);
  const unwatch = states.watch(pull, () => {});
  await vi.waitFor(() => expect(gh).toHaveBeenCalledOnce());
  // The last row goes away mid-read, then comes back.
  unwatch();
  await vi.advanceTimersByTimeAsync(0);
  states.watch(pull, () => {});
  expect(states.get(pull)).toBeUndefined();
  await vi.waitFor(() => expect(gh).toHaveBeenCalledTimes(2));
  answer({ r0: rollup("OPEN", {}, "SUCCESS") });
  await vi.waitFor(() =>
    expect(states.get(pull)).toMatchObject({ checks: "success" }),
  );
});

it("keeps what a timed-out refresh read, and marks what it could not", async () => {
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  let started = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      started++;
      if (input.includes("/buzz-app/"))
        return new Response(JSON.stringify({ state: "open" }));
      // The other never answers before the deadline.
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        ),
      );
    }),
  );
  const states = createPullStates(undefined);
  states.watch(pull, () => {});
  states.watch(second, () => {});
  await vi.waitFor(() => expect(started).toBe(2));
  try {
    deadline.abort(new DOMException("Timed out", "TimeoutError"));
    await vi.waitFor(() => expect(states.get(second)).toBe("failed"));
    expect(states.get(pull)).toEqual({ state: "open" });
  } finally {
    vi.restoreAllMocks();
  }
});
