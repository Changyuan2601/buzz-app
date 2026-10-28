// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { GhUnavailable, GitHubError, type GitHubCli } from "./gh";
import {
  createPullStates,
  PUBLIC_READS_PER_POLL,
  PULL_REFRESH_MS,
  PULL_SLOW_REFRESH_MS,
} from "./pull-states";

const pull = "https://github.com/block/buzz-app/pull/7";
const second = "https://github.com/block/buzz/pull/9";
const third = "https://github.com/block/goose/pull/3";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
  let checks = "FAILURE";
  const gh = mockGh(async () => ({
    r0: rollup("OPEN", { mergeStateStatus: "DIRTY" }, checks),
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

  // Only the open one is polled: a merged pull request stays that way, and
  // whoever shows it is not told of a poll that did not touch it.
  checks = "SUCCESS";
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  expect(gh).toHaveBeenCalledTimes(2);
  expect(gh.mock.calls[1]?.[1]).toEqual({ o0: "block", n0: "buzz-app", p0: 7 });
  expect(changed[0]).toHaveBeenCalledTimes(2);
  expect(changed[1]).toHaveBeenCalledTimes(2);
  expect(changed[2]).toHaveBeenCalledOnce();
  expect(states.get(pull)).toMatchObject({ checks: "success" });
  for (const unwatch of stop) unwatch();
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS * 3);
  expect(gh).toHaveBeenCalledTimes(2);
});

it("keeps the state object, and tells no one, when a poll reads the same state", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let checks = "PENDING";
  const gh = mockGh(async () => ({ r0: rollup("OPEN", {}, checks) }));
  const states = createPullStates(gh);
  const changed = vi.fn();
  states.watch(pull, changed);
  await vi.waitFor(() => expect(states.get(pull)).toBeDefined());
  const before = states.get(pull);
  // GitHub answers the same each time, so the links and sidebar rows showing
  // the pull request have nothing to re-render for.
  await vi.advanceTimersByTimeAsync(2 * PULL_REFRESH_MS);
  expect(gh).toHaveBeenCalledTimes(3);
  expect(states.get(pull)).toBe(before);
  expect(changed).toHaveBeenCalledOnce();
  checks = "SUCCESS";
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  expect(states.get(pull)).not.toBe(before);
  expect(states.get(pull)).toMatchObject({ checks: "success" });
  expect(changed).toHaveBeenCalledTimes(2);
});

it("keys a pull request by its canonical URL, so pasted variants share one entry and read", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const gh = mockGh(async () => ({
    r0: rollup("OPEN", {}, "SUCCESS"),
    r1: rollup("MERGED"),
  }));
  const states = createPullStates(gh);
  const changed = [vi.fn(), vi.fn(), vi.fn()] as const;
  // As pasted from a GitHub email, from the address bar, and plain.
  const query = `${pull}?notification_referrer_id=abc&diff=split`;
  const slash = `${pull}/`;
  const stop = [
    states.watch(query, changed[0]),
    states.watch(slash, changed[1]),
    states.watch(second, changed[2]),
  ];
  await vi.waitFor(() => expect(states.get(second)).toBeDefined());
  // One query, with the numbers GitHub needs, not `null` or 0 for the
  // variants, which would fail the whole batch.
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
  const state = { state: "open", checks: "success", conflicts: false };
  expect(states.get(query)).toEqual(state);
  expect(states.get(slash)).toBe(states.get(query));
  expect(states.get(pull)).toBe(states.get(query));
  expect(states.get(second)).toEqual({ state: "merged", conflicts: false });
  for (const unwatch of stop) unwatch();
});

it("neither watches nor throws for a URL that is not a pull request's", async () => {
  const gh = mockGh(async () => ({}));
  const states = createPullStates(gh);
  const unwatch = states.watch(
    "https://github.com/block/buzz-app/issues/7",
    () => {},
  );
  states.watch("not a url", () => {})();
  await vi.waitFor(() => expect(states.get(pull)).toBeUndefined());
  expect(gh).not.toHaveBeenCalled();
  expect(states.get("https://github.com/block/buzz-app/issues/7")).toBe(
    "failed",
  );
  expect(states.get("not a url")).toBe("failed");
  unwatch();
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

it("tries unreadable pull requests again every 5 minutes, in the one query with the rest", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  // GitHub answers the pull requests it can read and an error for the rest.
  const gh = mockGh(
    async (_query: string, variables: Record<string, unknown>) => {
      const data: Record<string, unknown> = {};
      let missing = false;
      for (let i = 0; `n${i}` in variables; i++)
        if (variables[`n${i}`] === "buzz-app")
          data[`r${i}`] = rollup("OPEN", { isDraft: true }, "PENDING");
        else {
          data[`r${i}`] = null;
          missing = true;
        }
      if (missing) throw new GitHubError("Not found", "NOT_FOUND", data);
      return data;
    },
  );
  const states = createPullStates(gh);
  for (const url of [pull, second, third]) states.watch(url, () => {});
  await vi.waitFor(() => expect(states.get(third)).toBe("failed"));
  expect(gh).toHaveBeenCalledOnce();
  expect(states.get(second)).toBe("failed");
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
  // Four minutes of polls: only the readable one, once a minute.
  await vi.advanceTimersByTimeAsync(4 * PULL_REFRESH_MS);
  expect(repositories().slice(1)).toEqual(
    Array.from({ length: 4 }, () => ["buzz-app"]),
  );
  // The fifth also tries both missing ones, in the same query: one gh run.
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  expect(repositories().slice(5)).toEqual([["buzz-app", "buzz", "goose"]]);
  expect(states.get(second)).toBe("failed");
});

it("tries again in a minute, not at once, when GitHub answers for none", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const gh = mockGh(async () => {
    throw new GitHubError("API rate limit exceeded", "RATE_LIMITED");
  });
  const states = createPullStates(gh);
  const changed = vi.fn();
  states.watch(pull, changed);
  states.watch(second, changed);
  await vi.waitFor(() => expect(gh).toHaveBeenCalledOnce());
  // Nothing was learnt, so nothing is shown as unavailable, and the next
  // try waits the poll interval rather than spinning while GitHub refuses.
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS / 2);
  expect(gh).toHaveBeenCalledOnce();
  expect(changed).not.toHaveBeenCalled();
  expect(states.get(pull)).toBeUndefined();
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS / 2);
  expect(gh).toHaveBeenCalledTimes(2);
  expect(gh.mock.calls[1]?.[1]).toEqual(gh.mock.calls[0]?.[1]);
});

it("leaves a read in flight alone when another pull request is watched, reading it next", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let answer: (value: unknown) => void = () => {};
  const signals: (AbortSignal | undefined)[] = [];
  const gh = mockGh(
    (
      _query: string,
      variables: Record<string, unknown>,
      signal?: AbortSignal,
    ) => {
      signals.push(signal);
      if ("p1" in variables || variables.n0 === "buzz")
        return Promise.resolve({ r0: rollup("MERGED") });
      return new Promise((resolve) => {
        answer = resolve;
      });
    },
  );
  const states = createPullStates(gh);
  states.watch(pull, () => {});
  await vi.waitFor(() => expect(gh).toHaveBeenCalledOnce());
  // A row mounting mid-read neither restarts the read nor loses its result.
  states.watch(second, () => {});
  await vi.advanceTimersByTimeAsync(0);
  expect(gh).toHaveBeenCalledOnce();
  expect(signals[0]?.aborted).toBe(false);
  answer({ r0: rollup("OPEN", {}, "SUCCESS") });
  await vi.waitFor(() => expect(states.get(second)).toBeDefined());
  expect(states.get(pull)).toMatchObject({ checks: "success" });
  expect(states.get(second)).toMatchObject({ state: "merged" });
  expect(gh).toHaveBeenCalledTimes(2);
  expect(gh.mock.calls[1]?.[1]).toEqual({ o0: "block", n0: "buzz", p0: 9 });
});

it("looks again later rather than reading while the window is hidden", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const gh = mockGh(async () => ({ r0: rollup("OPEN", {}, "SUCCESS") }));
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("hidden");
  const states = createPullStates(gh);
  states.watch(pull, () => {});
  await vi.waitFor(() => expect(states.get(pull)).toBeDefined());
  await vi.advanceTimersByTimeAsync(2 * PULL_REFRESH_MS);
  expect(gh).toHaveBeenCalledOnce();
  visibility.mockReturnValue("visible");
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  expect(gh).toHaveBeenCalledTimes(2);
});

it("reads what became due while the window was hidden as soon as it comes back", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const gh = mockGh(async () => ({ r0: rollup("OPEN", {}, "SUCCESS") }));
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("hidden");
  const states = createPullStates(gh);
  const unwatch = states.watch(pull, () => {});
  await vi.waitFor(() => expect(states.get(pull)).toBeDefined());
  await vi.advanceTimersByTimeAsync(2 * PULL_REFRESH_MS);
  expect(gh).toHaveBeenCalledOnce();
  // Back after two minutes: the overdue read is now, not at the next look.
  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(gh).toHaveBeenCalledTimes(2);
  // Back after half a minute, with nothing due: the poll keeps its time.
  visibility.mockReturnValue("hidden");
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS / 2);
  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(gh).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS / 2);
  expect(gh).toHaveBeenCalledTimes(3);
  // Nothing watched, nothing to read on return.
  unwatch();
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  expect(gh).toHaveBeenCalledTimes(3);
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

it("tries a public read that failed again every few minutes, until it is read", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 502 }))
    .mockResolvedValue(new Response(JSON.stringify({ state: "closed" })));
  vi.stubGlobal("fetch", fetch);
  const states = createPullStates(undefined);
  states.watch(pull, () => {});
  await vi.waitFor(() => expect(states.get(pull)).toBe("failed"));
  // One bad moment, GitHub's or the network's, is not for good.
  await vi.advanceTimersByTimeAsync(PULL_SLOW_REFRESH_MS - PULL_REFRESH_MS);
  expect(fetch).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  await vi.waitFor(() => expect(states.get(pull)).toEqual({ state: "closed" }));
  await vi.advanceTimersByTimeAsync(3 * PULL_SLOW_REFRESH_MS);
  expect(fetch).toHaveBeenCalledTimes(2);
});

const pulls = Array.from(
  { length: PUBLIC_READS_PER_POLL + 2 },
  (_, i) => `https://github.com/block/repo-${i}/pull/1`,
);
const limited = (resetAt?: number) =>
  new Response(null, {
    status: 403,
    headers: resetAt ? { "x-ratelimit-reset": String(resetAt / 1000) } : {},
  });

it("reads a few public pull requests at a time, the rest a minute later", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const fetch = vi.fn(
    async () => new Response(JSON.stringify({ state: "open" })),
  );
  vi.stubGlobal("fetch", fetch);
  const states = createPullStates(undefined);
  for (const url of pulls) states.watch(url, () => {});
  await vi.waitFor(() =>
    expect(states.get(pulls[PUBLIC_READS_PER_POLL - 1] ?? "")).toBeDefined(),
  );
  // A channel of links does not spend the hour's public reads at once.
  expect(fetch).toHaveBeenCalledTimes(PUBLIC_READS_PER_POLL);
  expect(states.get(pulls.at(-1) ?? "")).toBeUndefined();
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS / 2);
  expect(fetch).toHaveBeenCalledTimes(PUBLIC_READS_PER_POLL);
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS / 2);
  expect(fetch).toHaveBeenCalledTimes(pulls.length);
  expect(states.get(pulls.at(-1) ?? "")).toEqual({ state: "open" });
  // Each read once, none again.
  await vi.advanceTimersByTimeAsync(3 * PULL_SLOW_REFRESH_MS);
  expect(fetch).toHaveBeenCalledTimes(pulls.length);
});

it.each([
  ["when GitHub says it resets", 30 * 60_000],
  ["for an hour when it does not say", undefined],
])(
  "holds every public read once GitHub refuses one, %s",
  async (_, resetIn) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const hold = resetIn ?? 60 * 60_000;
    const resetAt = resetIn && Date.now() + resetIn;
    let refusals = 2;
    const fetch = vi.fn(async () =>
      refusals-- > 0
        ? limited(resetAt)
        : new Response(JSON.stringify({ state: "open" })),
    );
    vi.stubGlobal("fetch", fetch);
    const states = createPullStates(undefined);
    const changed = vi.fn();
    states.watch(pull, changed);
    states.watch(second, changed);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    // Over the limit, nothing is learnt or shown as unavailable, and neither
    // these nor a link shown meanwhile is tried until the limit resets.
    states.watch(third, changed);
    await vi.advanceTimersByTimeAsync(hold - PULL_REFRESH_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(changed).not.toHaveBeenCalled();
    expect(states.get(pull)).toBeUndefined();
    expect(states.get(third)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
    expect(fetch).toHaveBeenCalledTimes(5);
    for (const url of [pull, second, third])
      expect(states.get(url)).toEqual({ state: "open" });
  },
);

it("tries gh again before GitHub's public limit resets, when there is one", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => limited(Date.now() + 60 * 60_000)),
  );
  let signedIn = false;
  const gh = mockGh(async () => {
    if (!signedIn) throw new GhUnavailable();
    return { r0: rollup("OPEN", {}, "SUCCESS") };
  });
  const states = createPullStates(gh);
  states.watch(pull, () => {});
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  signedIn = true;
  await vi.advanceTimersByTimeAsync(PULL_SLOW_REFRESH_MS - PULL_REFRESH_MS);
  expect(gh).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  expect(gh).toHaveBeenCalledTimes(2);
  expect(states.get(pull)).toMatchObject({ checks: "success" });
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
  const stop = [states.watch(pull, () => {}), states.watch(second, () => {})];
  await vi.waitFor(() => expect(started).toBe(2));
  try {
    deadline.abort(new DOMException("Timed out", "TimeoutError"));
    await vi.waitFor(() => expect(states.get(second)).toBe("failed"));
    expect(states.get(pull)).toEqual({ state: "open" });
  } finally {
    for (const unwatch of stop) unwatch();
  }
});
