// @vitest-environment jsdom
import type { Context } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import type { BuzzClient } from "../../buzz-mcp/client";
import { POLL_MS, watchPulls } from "./watcher";
import { pullOf, pullRequest, QUIET_MS } from "./watch";

const agent = "a".repeat(64);
const root = "f".repeat(64);
const url = "https://github.com/block/buzz-app/pull/7";

type Comment = { id: string; login: string; body: string };
type Pull = ReturnType<typeof answer>;
/** A pull request as GitHub holds it. */
const answer = ({
  head = "1111111111",
  checks = [] as { name: string; conclusion: string | null }[],
  comments = [] as Comment[],
  reviews = [] as (Comment & { inline: (Comment & { path: string })[] })[],
  state = "OPEN",
} = {}) => ({ head, checks, comments, reviews, state });

/** What gh answers for `input`, a listing or a text read of `pull`. */
function respond(pull: Pull, input: string) {
  const { variables } = JSON.parse(input) as {
    variables: { ids?: string[] };
  };
  if (variables.ids) {
    const all = [
      ...pull.comments.map((item) => ({ ...item, __typename: "IssueComment" })),
      ...pull.reviews.flatMap(({ inline, ...review }) => [
        { ...review, __typename: "PullRequestReview", state: "COMMENTED" },
        ...inline.map((item) => ({
          ...item,
          __typename: "PullRequestReviewComment",
        })),
      ]),
    ];
    return JSON.stringify({
      data: {
        nodes: variables.ids.map((id) => {
          const found = all.find((item) => item.id === id);
          if (!found) return null;
          const { login, ...node } = found;
          return { ...node, author: { login }, url: `${url}#${id}` };
        }),
      },
    });
  }
  const { checks } = pull;
  return JSON.stringify({
    data: {
      viewer: { login: "baxen" },
      repository: {
        pullRequest: {
          state: pull.state,
          headRefOid: pull.head,
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    state: checks.some((check) => !check.conclusion)
                      ? "PENDING"
                      : "SUCCESS",
                    contexts: {
                      totalCount: checks.length,
                      nodes: checks.map(({ name, conclusion }) => ({
                        __typename: "CheckRun",
                        name,
                        status: conclusion ? "COMPLETED" : "IN_PROGRESS",
                        conclusion,
                      })),
                    },
                  },
                },
              },
            ],
          },
          reviews: {
            nodes: pull.reviews.map((review) => ({
              id: review.id,
              comments: { nodes: review.inline.map(({ id }) => ({ id })) },
            })),
          },
          comments: { nodes: pull.comments.map(({ id }) => ({ id })) },
        },
      },
    },
  });
}

function setup(initial: Pull | null = answer()) {
  let gh = initial;
  let texts = true;
  const runCommand = vi.fn(async (_id: string, input: string) =>
    !gh || (!texts && "ids" in JSON.parse(input).variables)
      ? null
      : respond(gh, input),
  );
  const woke = vi.fn();
  let runs = true;
  const tools: AddedTool[] = [];
  const disposers: (() => void)[] = [];
  const ctx = {
    host: { runCommand },
    agents: {
      addTool: (tool: AddedTool) => tools.push(tool),
      wake: (key: string, wake: unknown) => {
        if (!runs) throw new Error("This copy of Buzz does not run that agent");
        woke(key, wake);
      },
    },
    effect: (fn: () => () => void) => disposers.push(fn()),
  } as unknown as Context;
  watchPulls(ctx);
  const tool = tools[0] as AddedTool;
  const call = (args: Record<string, unknown>, topLevel = false, key = agent) =>
    tool.call(
      { key, pubkey: agent } as BuzzClient,
      topLevel ? { channel: "c", topLevel } : { channel: "c", root },
      args,
    );
  return {
    call,
    tool,
    woke,
    /** The text of each wake, in order. */
    texts: () =>
      woke.mock.calls.map(([, wake]) => (wake as { text: string }).text),
    runCommand,
    gh: (value: Pull | null) => {
      gh = value;
    },
    /** Whether reads of feedback text succeed, as a too-long answer cannot. */
    readsText: (value: boolean) => {
      texts = value;
    },
    runs: (value: boolean) => {
      runs = value;
    },
    dispose: () => {
      for (const dispose of disposers) dispose();
    },
  };
}

describe("github_watch_pr", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });
  afterEach(() => vi.useRealTimers());

  it("wakes the agent in its thread when CI finishes, naming the failed checks", async () => {
    const app = setup();
    app.gh(answer({ checks: [{ name: "unit", conclusion: null }] }));
    expect(await app.call({ url })).toMatch(/^Watching https:/);
    app.gh(answer({ checks: [{ name: "unit", conclusion: "FAILURE" }] }));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.woke.mock.calls).toEqual([
      [
        agent,
        {
          channel: "c",
          root,
          text: `CI failed on 111111111 for ${url}: 1 check failed, as GitHub names them:\n> unit`,
        },
      ],
    ]);
    // Reported once per head commit.
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.woke).toHaveBeenCalledTimes(1);
    app.dispose();
  });

  it("wakes the community whose membership set the watch, apart from the agent's other one", async () => {
    const other = `${agent}@other.example`;
    const app = setup();
    app.gh(answer({ checks: [{ name: "unit", conclusion: null }] }));
    await app.call({ url });
    await app.call({ url }, false, other);
    app.gh(answer({ checks: [{ name: "unit", conclusion: "FAILURE" }] }));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.woke.mock.calls.map(([key]) => key).sort()).toEqual(
      [agent, other].sort(),
    );
    // Stopping one leaves the other's.
    await app.call({ url, stop: true }, false, other);
    expect(
      JSON.parse(
        localStorage.getItem("buzz.github.pull-watches.v1") ?? "[]",
      ).map((watch: { agent: string }) => watch.agent),
    ).toEqual([agent]);
    app.dispose();
  });

  it("answers what is already there instead of waking, and wakes a Solo chat with what is new", async () => {
    const app = setup();
    app.gh(
      answer({
        checks: [{ name: "unit", conclusion: "SUCCESS" }],
        comments: [{ id: "I1", login: "wes", body: "body-old" }],
      }),
    );
    expect(await app.call({ url }, true)).toContain(
      "Already there:\nCI passed on 111111111",
    );
    app.gh(
      answer({
        checks: [{ name: "unit", conclusion: "SUCCESS" }],
        comments: [
          { id: "I1", login: "wes", body: "body-old" },
          { id: "I2", login: "wes", body: "body-new" },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.woke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(QUIET_MS + POLL_MS);
    expect(app.woke.mock.calls).toEqual([
      [
        agent,
        {
          channel: "c",
          text: `New feedback on ${url}, quoted from GitHub:\n- comment by wes ${url}#I2:\n  > body-new`,
        },
      ],
    ]);
    app.dispose();
  });

  it("keeps news it could not send, and survives a restart", async () => {
    const app = setup();
    await app.call({ url });
    app.runs(false);
    app.gh(answer({ checks: [{ name: "unit", conclusion: "SUCCESS" }] }));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.woke).not.toHaveBeenCalled();
    app.dispose();
    // The restarted app reads at once.
    const next = setup(
      answer({ checks: [{ name: "unit", conclusion: "SUCCESS" }] }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(next.woke).toHaveBeenCalledTimes(1);
    next.dispose();
  });

  it("stops on request, when merged, and refuses unreadable pull requests", async () => {
    const app = setup();
    await app.call({ url });
    expect(await app.call({ url, stop: true })).toBe(
      `Stopped watching ${url}.`,
    );
    app.gh(null);
    await expect(app.call({ url })).rejects.toThrow(/gh/);
    await expect(app.call({ url: "https://example.com/x" })).rejects.toThrow(
      /pull request URL/,
    );
    app.gh(answer());
    await app.call({ url });
    app.gh(answer({ state: "MERGED" }));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(
      JSON.parse(localStorage.getItem("buzz.github.pull-watches.v1") ?? ""),
    ).toEqual([]);
    expect(app.woke).not.toHaveBeenCalled();
    app.dispose();
  });

  it("ends a watch it cannot read for half an hour, telling the agent", async () => {
    const app = setup();
    await app.call({ url });
    app.gh(null);
    await vi.advanceTimersByTimeAsync(29 * POLL_MS);
    expect(app.woke).not.toHaveBeenCalled();
    // A good read in between starts the count again.
    app.gh(answer());
    await vi.advanceTimersByTimeAsync(POLL_MS);
    app.gh(null);
    await vi.advanceTimersByTimeAsync(29 * POLL_MS);
    expect(app.woke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.texts()).toEqual([
      expect.stringContaining(`Stopped watching ${url}`),
    ]);
    expect(
      JSON.parse(localStorage.getItem("buzz.github.pull-watches.v1") ?? ""),
    ).toEqual([]);
    app.dispose();
  });

  it("lets a read still in flight when the plugin stops do nothing", async () => {
    const old = setup();
    await old.call({ url });
    let finish: (value: string) => void = () => {};
    old.runCommand.mockImplementationOnce(
      () => new Promise<string>((resolve) => (finish = resolve)),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    old.dispose();
    // Its replacement takes over the saved watch, then the agent stops it.
    const next = setup();
    await vi.advanceTimersByTimeAsync(0);
    await next.call({ url, stop: true });
    finish(
      respond(
        answer({ checks: [{ name: "unit", conclusion: "SUCCESS" }] }),
        pullRequest(pullOf(url) as NonNullable<ReturnType<typeof pullOf>>),
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(old.woke).not.toHaveBeenCalled();
    expect(
      JSON.parse(localStorage.getItem("buzz.github.pull-watches.v1") ?? ""),
    ).toEqual([]);
    next.dispose();
  });

  it("still reports CI while feedback text cannot be read, and tells the feedback once it can", async () => {
    const app = setup();
    await app.call({ url });
    app.readsText(false);
    app.gh(
      answer({
        checks: [{ name: "unit", conclusion: "SUCCESS" }],
        comments: [{ id: "I1", login: "wes", body: "x".repeat(22_000) }],
      }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.texts()).toEqual([`CI passed on 111111111 for ${url}.`]);
    app.readsText(true);
    await vi.advanceTimersByTimeAsync(2 * POLL_MS + QUIET_MS);
    expect(app.texts()).toHaveLength(2);
    expect(app.texts()[1]).toMatch(
      new RegExp(`^New feedback on .+\\n- comment by wes ${url}#I1:`),
    );
    expect(app.woke).toHaveBeenCalledTimes(2);
    app.dispose();
  });

  it("wakes for a reply on an older thread, which comes with its own review", async () => {
    const old = Array.from({ length: 40 }, (_, i) => ({
      id: `R${i}`,
      login: "wes",
      body: "",
      inline: [
        { id: `C${i}`, login: "wes", body: `old ${i}`, path: "src/a.ts" },
      ],
    }));
    const app = setup(answer({ reviews: old }));
    await app.call({ url });
    app.gh(
      answer({
        reviews: [
          ...old,
          {
            id: "R40",
            login: "wes",
            body: "",
            inline: [
              {
                id: "C40",
                login: "wes",
                body: "Still broken",
                path: "src/a.ts",
              },
            ],
          },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(2 * POLL_MS + QUIET_MS);
    expect(app.texts()).toEqual([
      [
        `New feedback on ${url}, quoted from GitHub:`,
        `- inline comment by wes ${url}#C40, on:`,
        "  > src/a.ts",
        "  > Still broken",
      ].join("\n"),
    ]);
    // Only the new review and its comment were read in full.
    expect(
      app.runCommand.mock.calls
        .map(([, input]) => JSON.parse(input).variables.ids)
        .filter(Boolean),
    ).toEqual([["R40", "C40"]]);
    app.dispose();
  });

  it("needs a thread or a Solo chat to wake in", async () => {
    const app = setup();
    await expect(
      app.tool.call(
        { key: agent, pubkey: agent } as BuzzClient,
        { channel: "c" },
        { url },
      ),
    ).rejects.toThrow(/thread or a Solo chat/);
    app.dispose();
  });

  it("says when a watch moves to another conversation", async () => {
    const app = setup();
    await app.call({ url });
    expect(await app.call({ url }, true)).toContain(
      "no longer in the conversation that asked before",
    );
    app.dispose();
  });
});
